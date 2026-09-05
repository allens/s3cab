# `s3cab` Authentication and Credential Resolution Design

## Status

Implemented ([ADR-0055](../adr/0055-per-set-credentials-one-mode.md); see `src/lib/auth.mjs`).

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

2. **Treat a set's env file as an explicit user signal.** The `AWS_*` variables a set's env file sets (Step 0) are loaded into the environment and allowed to win in normal SDK precedence.

3. **Do not automatically edit AWS shared config files.** `s3cab` must not create or rewrite `~/.aws/config` or `~/.aws/credentials`. If the user already has profiles or `credential_process`, the AWS SDK uses them directly. **Reading** them is permitted: `s3cab provider --profile <name>` validates the name against the profiles defined there (read-only, advisory — see [ADR-0031](../adr/0031-aws-profile-config-door.md)). What's forbidden is *writing* shared AWS config; the `provider` command writes only s3cab's own env files.

4. **Interactive sign-in is not s3cab's job.** SSO / IAM Identity Center users sign in with `aws sso login` (or any tool that feeds the standard chain); s3cab picks the session up via Step 1. s3cab implements no login flow and stores no tokens of its own.

## Credential Resolution Order

`s3cab` resolves credentials in the following order.

### Step 0: Load the set's env file

Before constructing AWS SDK clients, s3cab loads the active set's env file (`~/.s3cab/sets/<set>/env`) into `process.env` (in `src/lib/env.mjs`). A set-accepting command routes through the `loadSet` door — the only door there is (see [ADR-0022](../adr/0022-prepare-remote-set-front-door.md), as amended). A command addressed by a **bucket** rather than a set (`upload --bucket`, `hashes`, `verify`, `cleanup`, `delete`) applies no s3cab layer at all and runs on the ambient AWS setup. s3cab deliberately does **not** read a `.env` from the current working directory, and never reads or writes `~/.aws/*`.

There is **one** s3cab layer, applied over the ambient shell (a file value always wins over the shell — files authoritative):

| Layer | Path | Purpose |
| --- | --- | --- |
| set | `~/.s3cab/sets/<set>/env` | which bucket this set backs up to (`S3CAB_BUCKET`, written by `setup`) + how to reach it (`AWS_PROFILE` / region / endpoint / keys) |
| shell | `process.env` | the ambient environment (lowest) |

The machine-wide default is the **ambient AWS setup itself** (`~/.aws`, a default profile, exported `AWS_*`, an instance role) — not a parallel s3cab file. An earlier per-**user** layer (`~/.s3cab/env`) was dropped in [ADR-0055](../adr/0055-per-set-credentials-one-mode.md) as a mechanism competing with the standard chain (Principle 1); the single genuinely s3cab-specific variable is `S3CAB_BUCKET`. Files are parsed with the built-in `util.parseEnv` (no dotenv dependency), so the set-over-shell precedence is enforced by s3cab.

**One credential mode per set** ([ADR-0055](../adr/0055-per-set-credentials-one-mode.md)). A set signs in one of four ways — a **profile** (`AWS_PROFILE` → `~/.aws`), **keys** (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, long-lived), **Roles Anywhere** (the certificate identity below), or **ambient** (the set declares no credentials; the chain's default profile / instance role / exported `AWS_*` supplies them). Profile and keys are *alternatives*, not layers, so the **`provider` command enforces exactly one**: setting `--keys` clears any profile on that set and `--profile` clears any keys (endpoint and region are orthogonal connection knobs, untouched). This makes the old silent-precedence trap — a profile and static keys both handed to the chain, which prefers the keys — unrepresentable through the front door. Temporary credentials (a session token) belong to a profile (the SDK refreshes it) or the ambient shell, never written to a file where they would rot.

> **A fourth mode, Roles Anywhere** — **built** ([ADR-0057](../adr/0057-roles-anywhere-credential-mode.md)/[0058](../adr/0058-roles-anywhere-cert-generation.md), full design in [roles-anywhere.md](roles-anywhere.md)). An X.509 client certificate mints short-lived STS credentials through a bespoke SigV4-X509 signer, so a set reaches AWS with no long-lived keys. It joins profile/keys/ambient as a mutually-exclusive `provider --roles-anywhere` mode, resolved *ahead of* the standard chain (`resolveRolesAnywhereCredentials` in `src/lib/auth.mjs`) and carrying two `credentialCase`s of its own — a missing/broken identity, and an identity AWS refused a session (see the classifier table below); **AWS-only**, so it cannot combine with a custom endpoint. Its live `CreateSession` path is exercised by the gated [test/integration/roles-anywhere.test.mjs](../../test/integration/roles-anywhere.test.mjs) ([docs/integration-testing.md](../integration-testing.md)).

The **`provider` command** (né `auth`, né `profile` — [ADR-0047](../adr/0047-provider-command-neutral-config-door.md)/0041) is the discoverable door for populating a set's env file — every connection knob, not just the profile: `--profile <name>` writes `AWS_PROFILE` (validated read-only against the shared config — see [ADR-0031](../adr/0031-aws-profile-config-door.md)), `--endpoint <url>` writes `AWS_ENDPOINT_URL_S3` (any S3-compatible provider), `--region <r>` writes `AWS_REGION`, and `--keys` writes the key pair — read from a terminal prompt (secret hidden) or two stdin lines, never flags. Omitting the set name takes the sole-set default for a write (erroring, listing the sets, if several exist) and summarizes every set for a bare show; `--unset <knob>` removes one; a `provider <set>` show prints legible `noun: value` lines (key *presence* only, never the secret) and runs the same `~/.aws` cross-check the write path does, flagging a profile that isn't in the config. It writes only the set's *own* env file, never `~/.aws`.

> **History:** the layering once had more layers. A per-**bucket** layer (`~/.s3cab/env.<bucket>`)
> was dropped in [ADR-0025](../adr/0025-drop-per-bucket-env-layer.md), and a per-**user** layer
> (`~/.s3cab/env`) in [ADR-0055](../adr/0055-per-set-credentials-one-mode.md), leaving the single
> set layer above. The top layer was originally a per-backup-directory file (`<dir>/.s3cab/env`),
> implemented and tested but never wired to a command; the backup-set model
> ([backup.md](backup.md), 2026-06) replaced it with the per-set layer before it ever shipped.
> The `upload --bucket` escape hatch resolves no set and so runs on ambient credentials only.

This is intentional: a value in a set's env file is an explicit user choice to provide a profile, an endpoint, a region, or keys. Once loaded, those variables participate in the SDK's normal credential resolution.

### Step 1: Try the standard AWS credential chain

After env-file loading, attempt standard AWS SDK credential resolution.

This allows all of the following to work with no `s3cab` special-casing:

* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from the process environment or an s3cab env file
* `AWS_PROFILE` pointing to an existing shared AWS profile
* existing shared profiles with IAM Identity Center / SSO configuration (after `aws sso login`)
* existing shared profiles that use `credential_process`

### Step 2: If standard resolution fails, stop with a clear auth error

`s3cab` stops with a **set-scoped** error (see [Authentication
error](#authentication-error)): it names the set, leads with a pinpoint diagnosis
when it can (a profile absent from `~/.aws`, or a non-AWS endpoint with no keys),
shows where it looked (the set's env file + the ambient chain), and offers the
fix. With no set loaded (`setup`/`reattach`, or the `upload --bucket` hatch) it
falls back to a shorter ambient-only message.

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

The resolve-time "no credentials" error is **set-scoped** and built from a
constant frame plus a per-case classifier (`credentialCase` + `noCredentialsError`
in `src/lib/auth.mjs`). It names the set, leads with an optional pinpoint
**diagnosis**, shows a "looked in" frame — the set's env file and the ambient
chain, embedding the chain's own message — then a tailored **fix**:

```text
No credentials found for set 'photos'.

<optional diagnosis: the "aha" when we can pinpoint it>

s3cab looked in:
  1. the set's own settings:  ~/.s3cab/sets/photos/env   (<annotation>)
  2. your standard AWS setup (~/.aws/config, ~/.aws/credentials, or AWS_*
     in your environment), which reported:
     <the chain's own error message>

<tailored fix>

Run 's3cab help provider' for details.
```

**One cause short-circuits the frame: an expired sign-in**
([ADR-0075](../adr/0075-resolve-time-credential-expiry.md)). If the chain's own message says the
session it found had *expired*, the credentials were never missing — so
`noCredentialsError` hands straight over to `expiredCredentialsError` (below), scoped to the set
and quoting the chain, rather than classifying a set that is configured correctly as an
unconfigured one. Expiry is matched on the *message*, not `error.name` — at resolve time the
name is the SDK layer that threw (`TokenProviderError`), which is the same for a missing profile
— and it is the only chain failure read that way; every other one takes the frame below.
(The expiry test is skipped outright in Roles Anywhere mode: "expired" in a `CreateSession`
refusal is AWS talking about the certificate, and `aws sso login` would be the wrong fix.)

**Roles Anywhere takes the same frame** (ADR-0075's
[amendment](../adr/0075-resolve-time-credential-expiry.md#amendment-2026-09-05-the-roles-anywhere-exchange-joins-the-resolve-time-frame)):
both ways the exchange can fail to *produce* credentials — no complete machine identity, or an
identity AWS refused a session (a 403, a non-JSON or credential-less body, a timeout) — are a
credential failure of the set and get the "looked in" frame, with step 2 naming the identity or
the endpoint instead of the ambient chain. The two are told apart by **type**: `createSession`
throws a `RolesAnywhereSessionError` (`src/lib/error.mjs`) for a refusal, and
`resolveRolesAnywhereCredentials` catches only that. A *transport* error from the socket —
`ENOTFOUND`, `ECONNRESET`, a happy-eyeballs `AggregateError` — is rethrown raw, because the
request-time relay below keys its network retry on the errno
([ADR-0037](../adr/0037-aws-auth-error-categorization.md)), and a wrapper would hide it.

The classifier picks one of six cases from what the *set* declares (wording per
[ADR-0030](../adr/0030-error-message-guidelines.md)); when a profile is set,
`resolveCredentials` runs the same read-only `~/.aws` cross-check the `provider`
command uses (`listProfiles`, [ADR-0031](../adr/0031-aws-profile-config-door.md)):

| Case | Diagnosis + fix |
| --- | --- |
| Roles Anywhere, **no complete identity** on this machine | *set 'photos' uses Roles Anywhere, but this machine's certificate identity is missing, incomplete, or its ARNs were never captured.* The three-step recipe (`s3cab aws <bucket> --roles-anywhere`, deploy, `--save --from-stack`), spelled for the set's bucket. |
| Roles Anywhere, identity present, **session refused** | *…and this machine's certificate identity is in place, but AWS would not exchange it for a session*, quoting the endpoint. Check the stack is deployed in the region the identity's env names and re-capture its ARNs; failing that, the recipe. |
| Profile set, **absent** from `~/.aws` | The "aha": *set 'photos' uses profile 'x', but it isn't in your AWS config.* Create it (`aws configure --profile x`, or `aws configure sso`) or point the set elsewhere. |
| Profile set, **present** (or `~/.aws` unreadable) | It produced nothing: sign in if SSO (`aws sso login --profile x`), else check the profile's keys. |
| Custom **endpoint** (non-AWS), no keys | Save the provider's key pair: `s3cab provider --keys <set>`. |
| Nothing configured | The pick-one menu: an AWS profile, or access keys, both `provider`-scoped to the set. |

There is **no keys-present case**: keys present means the chain resolves
*something*, so a wrong key surfaces later as a *request-time* rejection (below),
never here. With **no set** loaded (`setup`/`reattach` — the set doesn't exist
yet — or the `upload --bucket` hatch), a shorter template reports the ambient
failure and steers to ambient credentials (a profile or exported `AWS_*`). The
`~/.aws` lookup is async, so `resolveCredentials` performs it and hands the result
to the (sync) error factory.

### Request-time rejections (credentials resolve, the server rejects)

`noCredentialsError` above fires when the chain resolves *nothing*. When it
resolves credentials that *work at startup* but the **server** rejects a later
request, s3cab translates that rejection at the SDK relay boundary
(`requestErrorRelay` in `src/lib/s3.mjs`, see
[ADR-0037](../adr/0037-aws-auth-error-categorization.md)). The relay walks an
ordered table that matches the AWS error **code** (`error.name`, never HTTP
status) and routes each to one of a few remedies; only codes s3cab can fix or
commonly advise on are caught, and everything else falls through to the raw
`ERROR:` dump unchanged.

| Cause (AWS codes) | Factory (`src/lib/auth.mjs`) | Remedy |
| --- | --- | --- |
| Expired (`ExpiredToken`, `ExpiredTokenException`, `TokenRefreshRequired`) | `expiredCredentialsError` — shared with the resolve-time path above | refresh (`aws sso login` / new session) |
| Invalid (`InvalidToken`, `InvalidAccessKeyId`, `InvalidSecurity`) | `invalidCredentialsError` | replace the credentials (by source) |
| Bad signature (`SignatureDoesNotMatch`) | `badSignatureError` | check secret / region / endpoint |
| Clock skew (`RequestTimeTooSkewed`) | `clockSkewError` | sync the clock |
| Not authorized (`AccessDenied`) | `accessDeniedError` | the bucket policy (`s3cab aws <bucket>` on AWS; the provider's permissions off AWS) |

Headlines stay provider-neutral; only the `AccessDenied` remedy branches on
whether a custom endpoint is set. The per-source/per-provider depth lives in the
`s3cab help provider` guide.

## Acceptance Criteria

* if a set's env file defines `AWS_*` variables, those values are loaded before AWS clients are created and are eligible to win through normal SDK precedence;
* if the machine already has working standard AWS credentials (for example `AWS_PROFILE`, shared SSO config, or existing shared `credential_process`), S3-touching commands succeed with no s3cab-specific configuration;
* if nothing is configured, s3cab emits the clear, actionable authentication error above;
* `s3cab` never automatically modifies `~/.aws/config` or `~/.aws/credentials`.
