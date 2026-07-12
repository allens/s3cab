# `s3cab` Authentication and Credential Resolution Design

## Status

Implemented (see `src/lib/auth.mjs`) — **but the layering model is changing.**

> **Direction (target vs built): [ADR-0055](../adr/0055-per-set-credentials-one-mode.md)** drops
> the **user** env layer (leaving **set > shell**), makes each set exactly **one credential mode**
> (profile XOR keys XOR ambient), and restructures the resolve-time error around the named set.
> Everything below describes what is **built today** (the user + set layers, the four-state
> `credentialGuidance`); it will be rewritten to the 0055 model when that lands. Read it as
> current behaviour, not the target.

> **History:** earlier revisions of this design also defined a bespoke `s3cab login`
> (IAM Identity Center / SSO device-authorization flow), an app-managed session
> cache at `~/.s3cab/auth.json`, and a `credential-process` helper command built
> on it. All three were **removed** in 2026-06. Rationale: the only user they
> served — an SSO user *without* the AWS CLI — barely exists (SSO implies an
> organization, which hands you the CLI; `aws configure sso` is how SSO profiles
> are created at all), the standard SDK chain already picks up `aws sso login`
> sessions with zero s3cab code, and the cache made s3cab the owner of a
> plaintext refresh-token file. Interactive sign-in is the AWS CLI's job; s3cab
> consumes the result through the standard chain.

## Purpose

Define the authentication and credential-resolution model for `s3cab`, a customer-run CLI that uploads backups to AWS S3 and S3-compatible object stores.

This design must:

* support existing AWS-native credential setups on the machine through the AWS SDK for JavaScript v3 default Node.js credential chain, which checks supported sources in precedence order and stops at the first valid source, including environment variables, SSO/token cache, shared config/credentials, and other standard providers. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* support env-file-based credentials for backward compatibility and for S3-compatible providers that rely on access-key / secret-key environment variables. Environment variables are a standard credential source in the AWS SDK v3 Node.js provider chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3)
* avoid automatic modification of `~/.aws/config` and `~/.aws/credentials`. The SDK can read those files if the user already has them, but `s3cab` must not write them itself.

## Design Principles

1. **Respect existing AWS setup first.** If the machine already has valid AWS credentials, `s3cab` uses them via the SDK's standard credential resolution rather than inventing a parallel mechanism.

2. **Treat s3cab's env files as an explicit user signal.** If s3cab's layered env files (Step 0) exist, the `AWS_*` variables they set are loaded into the environment and allowed to win in normal SDK precedence.

3. **Do not automatically edit AWS shared config files.** `s3cab` must not create or rewrite `~/.aws/config` or `~/.aws/credentials`. If the user already has profiles or `credential_process`, the AWS SDK uses them directly. **Reading** them is permitted: `s3cab provider --profile <name>` validates the name against the profiles defined there (read-only, advisory — see [ADR-0031](../adr/0031-aws-profile-config-door.md)). What's forbidden is *writing* shared AWS config; the `provider` command writes only s3cab's own env files.

4. **Interactive sign-in is not s3cab's job.** SSO / IAM Identity Center users sign in with `aws sso login` (or any tool that feeds the standard chain); s3cab picks the session up via Step 1. s3cab implements no login flow and stores no tokens of its own.

## Credential Resolution Order

`s3cab` resolves credentials in the following order.

### Step 0: Load s3cab's env files if present

Before constructing AWS SDK clients, s3cab loads its own **layered env files** into `process.env` (in `src/lib/env.mjs`). The **user** layer is applied once at the CLI entry point by `loadEnv()` — before any command runs — and a set-accepting command adds its **set** layer through the `loadSet` door it routes through (see [ADR-0022](../adr/0022-prepare-remote-set-front-door.md)). It deliberately does **not** read a `.env` from the current working directory, and never reads or writes `~/.aws/*`.

The layers, **highest precedence first** (a file value always wins over the shell environment — "Model A", files authoritative):

| Layer | Path | Purpose |
| --- | --- | --- |
| set | `~/.s3cab/sets/<set>/env` | per-backup-set: which bucket this set backs up to (`S3CAB_BUCKET`, written by `setup`) + any per-set auth override |
| user | `~/.s3cab/env` | per-user defaults — auth (`AWS_PROFILE` / region / endpoint / keys) for the common single-bucket case lives here |
| shell | `process.env` | the real environment (lowest) |

Files are parsed with the built-in `util.parseEnv` (no dotenv dependency), so the per-key precedence above is enforced by s3cab rather than by any one loader's fixed override semantics.

The **`provider` command** (né `auth`, né `profile` — [ADR-0047](../adr/0047-provider-command-neutral-config-door.md)/0041) is the discoverable door for populating these files — every connection knob, not just the profile: `--profile <name>` writes `AWS_PROFILE` (validated read-only against the shared config, advisory — see [ADR-0031](../adr/0031-aws-profile-config-door.md)), `--endpoint <url>` writes `AWS_ENDPOINT_URL_S3` (any S3-compatible provider), `--region <r>` writes `AWS_REGION`, and `--keys` writes `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — read from a terminal prompt (secret hidden) or two stdin lines, never flags. Each writes the user layer by default or a set override with a set name; `--unset <knob>` removes one; no flags shows the scope's current settings (key *presence* only, never the secret). It writes only s3cab's *own* env files, never `~/.aws`.

The user scope is labelled **"the default"** (query-noun "Default AWS profile"), not "all backups" — per-set settings override it, so a set with its own profile does *not* use it. The **show** path (`s3cab provider [<set>]`) prints legible `noun: value` status lines and runs the same `~/.aws` cross-check as the set path, so *looking* also flags a profile that isn't in the config (`Not in your AWS config — no credentials to use.` + the `aws configure --profile <name>` fix) — closing the asymmetry where only the set path warned.

> **History:** the layering once had a fourth, per-bucket layer (`~/.s3cab/env.<bucket>`,
> "how to authenticate to that bucket"). It was dropped in
> [ADR-0025](../adr/0025-drop-per-bucket-env-layer.md): auth is no longer treated as a
> property of the bucket but of the user (single-bucket common case) or the set (overrides),
> which also removes the circular bucket-resolution dance the per-bucket file forced (resolve
> the bucket from set/user/shell, *then* load its env). The top layer was originally
> specified as a per-backup-directory file, `<dir>/.s3cab/env`. It was implemented and tested
> but never wired to a command, and the backup-set model ([backup.md](backup.md), 2026-06)
> replaced it with the per-set layer above before it ever shipped — same layering machinery,
> only the path changed. The bucket-scoped plumbing commands (`hashes`/`upload`) pass no
> scope, taking auth from the user layer; the set layer is consumed by the set-first commands.

This is intentional: the presence of a value in an s3cab env file is treated as an explicit user choice to provide credentials, a profile, an endpoint, or keys. Once loaded, those variables participate in the SDK's normal credential resolution.

### Step 1: Try the standard AWS credential chain

After env-file loading, attempt standard AWS SDK credential resolution.

This allows all of the following to work with no `s3cab` special-casing:

* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from the process environment or an s3cab env file
* `AWS_PROFILE` pointing to an existing shared AWS profile
* existing shared profiles with IAM Identity Center / SSO configuration (after `aws sso login`)
* existing shared profiles that use `credential_process`

### Step 2: If standard resolution fails, stop with a clear auth error

`s3cab` stops with a **configuration-aware** error (see [Authentication
error](#authentication-error) for the exact branches): when no profile is set it
advises providing credentials or pointing at a profile; when a profile *is* set
it diagnoses why it yielded nothing (missing from `~/.aws`, or present but
producing no credentials) instead of telling the user to set a profile they
already have.

## Security Model

* never log credentials or tokens;
* prefer temporary credentials with expiration (profile/SSO-based setups) over long-lived static keys whenever feasible — the SDK refreshes expiration-aware providers automatically;
* long-lived keys, where unavoidable (most S3-compatible providers), live in s3cab env files or the user's own AWS shared config — s3cab stores no credential material of its own. s3cab writes its env files owner-only (mode `0600`, directories `0700` — `src/lib/env-file.mjs`);
* the endorsed way to keep a long-lived key out of plaintext altogether is a **`credential_process` profile backed by a secret manager** — the standard chain already supports it, so it costs s3cab zero credential code; the user-facing recipe is in [guide/aws.md](../../guide/aws.md#keeping-the-secret-out-of-plaintext).

**Future work — deliberately deferred:** a built-in OS-secure-storage layer (Windows DPAPI / macOS Keychain / libsecret). Its *security* properties are already reachable through the `credential_process` pattern above (every OS store has a CLI that can print the credential JSON); what a built-in layer would add is convenience — one `provider --keys`-style built-in (now built, ADR-0047 — the remaining gap is only the OS-store backend) instead of editing `~/.aws/config` — not a new security property, since an unlocked store is readable by any process running as the user on most platforms anyway. So it waits for real demand rather than being built speculatively. If built, it slots into `resolveCredentials` as another source; the resolver stays pluggable.

## Non-Goals

`s3cab` must **not**:

* implement an interactive sign-in flow or cache login sessions/tokens (see History above — tried and removed);
* accept raw AWS access keys (secrets) via CLI flags, because that leaks into shell history and process lists and is weaker practice than using supported SDK credential sources. (A *profile name*, *endpoint*, or *region* is not a secret: `s3cab provider` takes those by flag. The key pair itself goes through `provider --keys` — a terminal prompt with the secret hidden, or two stdin lines — which touches argv not at all; ADR-0047.)
* invent a custom AWS credential file format that competes with AWS profiles, shared config, or standard environment-variable handling;
* write `~/.aws/config` or `~/.aws/credentials` automatically. Shared AWS config remains user-managed.

## Authentication error

The credential chain's own message is embedded (the chain reports a *missing*
setup and a *misconfigured* one — a typo'd profile, a broken
`credential_process` — through the same error type, so s3cab shows the specific
reason rather than trying to classify), under a common frame:

```text
No AWS credentials found.

s3cab tried:
  1. s3cab env files / environment variables
  2. The standard AWS SDK credential chain, which reported:
     <the chain's own error message>

<configuration-aware guidance — see below>

Run 's3cab help provider' for details.
```

The **guidance** block is *configuration-aware* (`credentialGuidance` in
`src/lib/auth.mjs`): the common onboarding trap is being told to "set a profile"
when one is already set (`AWS_PROFILE=x` in `~/.s3cab/env`) — it just isn't in
`~/.aws`, so it resolves nothing. When a profile is set, `resolveCredentials`
runs the same read-only `~/.aws` cross-check the `provider` command uses
(`listProfiles`, [ADR-0031](../adr/0031-aws-profile-config-door.md)) and picks
one of four messages:

| State | Guidance |
| --- | --- |
| No `AWS_PROFILE`, custom endpoint set | A non-AWS provider missing its keys — profile advice would assume the AWS CLI. The fix: save the provider's key pair (`s3cab provider --keys`), or set `AWS_*` in `~/.s3cab/env` (ADR-0047). |
| No `AWS_PROFILE` set (no endpoint) | The original advice: point s3cab at a profile (`s3cab provider --profile <name>`, `aws sso login` first for SSO), or set `AWS_*` in `~/.s3cab/env`. |
| Set, but **absent** from `~/.aws` | The missing "aha": *profile 'x' isn't in your AWS config — that's why there are no credentials.* Create it (`aws configure --profile x`, or `aws configure sso`) or point elsewhere. |
| Set and **present** (or `~/.aws` unreadable) | It produced nothing: sign in if SSO (`aws sso login --profile x`), else check the profile's keys. |

This is the **resolve-time** ("found nothing") path only; the request-time
rejections below are separate and already handled. The `~/.aws` lookup is async,
so `resolveCredentials` performs it and hands the result to the (sync) error
factory. Wording follows [ADR-0030](../adr/0030-error-message-guidelines.md).

### Request-time rejections (credentials resolve, the server rejects)

`noCredentialsError` above fires when the chain resolves *nothing*. When it
resolves credentials that *work at startup* but the **server** rejects a later
request, s3cab translates that rejection at the SDK relay boundary
(`credentialErrorRelay` in `src/lib/s3.mjs`, see
[ADR-0037](../adr/0037-aws-auth-error-categorization.md)). The relay walks an
ordered table that matches the AWS error **code** (`error.name`, never HTTP
status) and routes each to one of a few remedies; only codes s3cab can fix or
commonly advise on are caught, and everything else falls through to the raw
`ERROR:` dump unchanged.

| Cause (AWS codes) | Factory (`src/lib/auth.mjs`) | Remedy |
| --- | --- | --- |
| Expired (`ExpiredToken`, `ExpiredTokenException`, `TokenRefreshRequired`) | `expiredCredentialsError` | refresh (`aws sso login` / new session) |
| Invalid (`InvalidToken`, `InvalidAccessKeyId`, `InvalidSecurity`) | `invalidCredentialsError` | replace the credentials (by source) |
| Bad signature (`SignatureDoesNotMatch`) | `badSignatureError` | check secret / region / endpoint |
| Clock skew (`RequestTimeTooSkewed`) | `clockSkewError` | sync the clock |
| Not authorized (`AccessDenied`) | `accessDeniedError` | the bucket policy (`s3cab aws <bucket>` on AWS; the provider's permissions off AWS) |

Headlines stay provider-neutral; only the `AccessDenied` remedy branches on
whether a custom endpoint is set. The per-source/per-provider depth lives in the
`s3cab help provider` guide.

## Acceptance Criteria

* if an s3cab env file exists and defines `AWS_*` variables, those values are loaded before AWS clients are created and are eligible to win through normal SDK precedence;
* if the machine already has working standard AWS credentials (for example `AWS_PROFILE`, shared SSO config, or existing shared `credential_process`), S3-touching commands succeed with no s3cab-specific configuration;
* if nothing is configured, s3cab emits the clear, actionable authentication error above;
* `s3cab` never automatically modifies `~/.aws/config` or `~/.aws/credentials`.
