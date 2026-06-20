# `s3cab` Authentication and Credential Resolution Spec

## Status

Implemented (see `src/lib/auth.mjs`).

> **History:** earlier revisions of this spec also defined a bespoke `s3cab login`
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

3. **Do not automatically edit AWS shared config files.** `s3cab` must not create or rewrite `~/.aws/config` or `~/.aws/credentials`. If the user already has profiles or `credential_process`, the AWS SDK uses them directly.

4. **Interactive sign-in is not s3cab's job.** SSO / IAM Identity Center users sign in with `aws sso login` (or any tool that feeds the standard chain); s3cab picks the session up via Step 1. s3cab implements no login flow and stores no tokens of its own.

## Credential Resolution Order

`s3cab` resolves credentials in the following order.

### Step 0: Load s3cab's env files if present

Before constructing AWS SDK clients, s3cab loads its own **layered env files** into `process.env` (implemented as `loadEnv` in `src/lib/env.mjs`; the set-family commands reach it through `prepareRemoteSet`, see [ADR-0022](../docs/adr/0022-prepare-remote-set-front-door.md)). It deliberately does **not** read a `.env` from the current working directory, and never reads or writes `~/.aws/*`.

The layers, **highest precedence first** (a file value always wins over the shell environment — "Model A", files authoritative):

| Layer | Path | Purpose |
| --- | --- | --- |
| set | `~/.s3cab/sets/<set>/env` | per-backup-set: which bucket this set backs up to (`S3CAB_BUCKET`, written by `setup`), the pinned identity namespace + any per-set override |
| bucket | `~/.s3cab/env.<bucket>` | per-bucket: how to authenticate to that bucket (`AWS_PROFILE` / region / endpoint / keys) — the bucket is the natural auth boundary |
| user | `~/.s3cab/env` | per-user defaults |
| shell | `process.env` | the real environment (lowest) |

The per-bucket file cannot name its own bucket (that would be circular): the bucket is resolved from an explicit name (e.g. a CLI `<bucket>` arg) or the set/user/shell layers first, then `~/.s3cab/env.<bucket>` is loaded. Files are parsed with the built-in `util.parseEnv` (no dotenv dependency), so the per-key precedence above is enforced by s3cab rather than by any one loader's fixed override semantics.

> **History:** the top layer was originally specified as a per-backup-folder file,
> `<dir>/.s3cab/env`. It was implemented and tested but never wired to a command, and
> the backup-set model ([backup.md](backup.md), 2026-06) replaced it with the per-set
> layer above before it ever shipped — same layering machinery, only the path changed.
> The bucket-scoped plumbing commands (`hashes`/`upload`) pass no set scope, using the
> explicit bucket scope; the set layer is consumed by the set-first commands.

This is intentional: the presence of a value in an s3cab env file is treated as an explicit user choice to provide credentials, a profile, an endpoint, or a default bucket. Once loaded, those variables participate in the SDK's normal credential resolution.

### Step 1: Try the standard AWS credential chain

After env-file loading, attempt standard AWS SDK credential resolution.

This allows all of the following to work with no `s3cab` special-casing:

* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from the process environment or an s3cab env file
* `AWS_PROFILE` pointing to an existing shared AWS profile
* existing shared profiles with IAM Identity Center / SSO configuration (after `aws sso login`)
* existing shared profiles that use `credential_process`

### Step 2: If standard resolution fails, stop with a clear auth error

`s3cab` stops and instructs the user to do one of the following:

* provide credentials via an s3cab env file / environment variables,
* use an existing AWS profile (running `aws sso login` first for SSO profiles).

## Security Model

* never log credentials or tokens;
* prefer temporary credentials with expiration (profile/SSO-based setups) over long-lived static keys whenever feasible — the SDK refreshes expiration-aware providers automatically;
* long-lived keys, where unavoidable (most S3-compatible providers), live in s3cab env files or the user's own AWS shared config — s3cab stores no credential material of its own.

**Future work:** an optional OS-secure-storage layer (Windows DPAPI / macOS Keychain / libsecret) for users stuck with long-lived keys, slotting into `resolveCredentials` as another source. Not designed yet; noted so the resolver stays pluggable.

## Non-Goals

`s3cab` must **not**:

* implement an interactive sign-in flow or cache login sessions/tokens (see History above — tried and removed);
* accept raw AWS access keys via CLI flags, because that leaks into shell history and process lists and is weaker practice than using supported SDK credential sources;
* invent a custom AWS credential file format that competes with AWS profiles, shared config, or standard environment-variable handling;
* write `~/.aws/config` or `~/.aws/credentials` automatically. Shared AWS config remains user-managed.

## Authentication error

The credential chain's own message is embedded (the chain reports a *missing*
setup and a *misconfigured* one — a typo'd profile, a broken
`credential_process` — through the same error type, so s3cab shows the specific
reason rather than trying to classify):

```text
No AWS credentials found.

s3cab tried:
  1. s3cab env files / environment variables
  2. The standard AWS SDK credential chain, which reported:
     <the chain's own error message>

To continue, do one of the following:
  - create ~/.s3cab/env with AWS_* variables (or AWS_PROFILE)
  - use an existing AWS profile and set AWS_PROFILE
    (for AWS IAM Identity Center, run `aws sso login` first —
    s3cab picks the session up automatically)

Run 's3cab help auth' for details.
```

## Acceptance Criteria

* if an s3cab env file exists and defines `AWS_*` variables, those values are loaded before AWS clients are created and are eligible to win through normal SDK precedence;
* if the machine already has working standard AWS credentials (for example `AWS_PROFILE`, shared SSO config, or existing shared `credential_process`), S3-touching commands succeed with no s3cab-specific configuration;
* if nothing is configured, s3cab emits the clear, actionable authentication error above;
* `s3cab` never automatically modifies `~/.aws/config` or `~/.aws/credentials`.
