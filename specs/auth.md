# `s3cab` Authentication and Credential Resolution Spec

## Status

Draft / implementation-ready.

## Purpose

Define the authentication and credential-resolution model for `s3cab`, a customer-run CLI that uploads backups to AWS S3 and S3-compatible object stores.

This design must:

* support existing AWS-native credential setups on the machine through the AWS SDK for JavaScript v3 default Node.js credential chain, which checks supported sources in precedence order and stops at the first valid source, including environment variables, SSO/token cache, shared config/credentials, and other standard providers. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* support an `s3cab login` convenience flow for users who do not have AWS CLI installed, using AWS SDK IAM Identity Center / SSO capabilities and local cached login state. The AWS SDK v3 supports IAM Identity Center authentication and the IAM Identity Center / SSO APIs expose operations such as role credential retrieval and logout. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)
* support `.env`-based credentials for backward compatibility and for some S3-compatible providers that still rely on access-key / secret-key environment variables. Environment variables are a standard credential source in the AWS SDK v3 Node.js provider chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* avoid automatic modification of `~/.aws/config` and `~/.aws/credentials`. The SDK can read those files if the user already has them, but `s3cab` should not write them itself. AWS documents shared config/credentials support and process-based credentials configured via shared config. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

***

## Design Principles

1. **Respect existing AWS setup first.** If the machine already has valid AWS credentials, `s3cab` should use them via the SDK’s standard credential resolution rather than inventing a parallel mechanism. AWS documents that the Node.js SDK already has a default credential provider chain and that applications generally do not need to provide a custom provider explicitly in the common case. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

2. **Treat `.env` as an explicit user signal.** If a `.env` file exists and `s3cab` loads it, the resulting `AWS_*` variables are allowed to win in normal SDK precedence. Environment variables are a standard high-precedence credential source in the AWS SDK provider chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

3. **Do not automatically edit AWS shared config files.** `s3cab` must not create or rewrite `~/.aws/config` or `~/.aws/credentials`. If the user already has profiles or `credential_process`, the AWS SDK should use them directly. AWS documents shared config support and `credential_process` integration via shared config. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

4. **Use app-managed SSO login as a convenience path.** `s3cab login` exists to help users bootstrap IAM Identity Center / SSO access without requiring AWS CLI. AWS documents IAM Identity Center support in the JS SDK and the supporting APIs for obtaining role credentials. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)

5. **Expose `credential-process` as an advanced/manual integration surface.** AWS supports process credentials via an external command that writes credential JSON to `stdout`, and the AWS JS credential providers package supports process-based providers. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

***

## Terminology

### Standard AWS credential chain

The AWS SDK for JavaScript v3 Node.js default credential provider chain. It checks standard sources in precedence order and stops at the first valid credentials source. Documented sources include environment variables, SSO/token cache, shared config/credentials, web identity, and instance/container metadata. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

### App-managed login cache

`s3cab`’s own cached login/session state created by `s3cab login`.

This is **not** the same thing as AWS shared-config `credential_process`. AWS shared-config `credential_process` specifically means an external command declared in shared AWS config that writes credential JSON to `stdout`. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

### Temporary AWS role credentials

The short-lived AWS credentials actually used to call S3: `accessKeyId`, `secretAccessKey`, optional `sessionToken`, and expiration. IAM Identity Center / SSO exposes `GetRoleCredentials` for obtaining these short-term role credentials.

### Compatibility `.env` mode

`s3cab` loads a `.env` file into process environment variables before constructing AWS clients. The AWS SDK then resolves those values through its normal environment-variable provider. Environment variables are part of the standard SDK credential chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

***

## Credential Resolution Order

`s3cab` must resolve credentials in the following order.

### Step 0: Load `.env` if present

If `.env` exists, load it before constructing AWS SDK clients.

This is intentional. The presence of `.env` is treated as an explicit user choice to provide credentials or profile selection through environment variables. Once loaded, those variables participate in the SDK’s normal credential resolution, and environment variables are one of the standard high-precedence sources in the provider chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

### Step 1: Try the standard AWS credential chain

After `.env` loading, attempt standard AWS SDK credential resolution first.

This should allow all of the following to work with no `s3cab` special-casing:

* `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` from process environment or `.env`. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* `AWS_PROFILE` pointing to an existing shared AWS profile. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[docs.amazonaws.cn\]](https://docs.amazonaws.cn/en_us/aws-backup/latest/devguide/s3-backups.html)
* existing shared profiles with IAM Identity Center / SSO configuration. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)
* existing shared profiles that use `credential_process`. AWS documents `credential_process` in shared config, and the AWS JS credential providers support process credentials and shared config/INI resolution. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

### Step 2: If standard resolution fails, use the app-managed login cache

If Step 1 fails because no standard AWS credentials were found, fall back to `s3cab`’s own cached login/session state created by `s3cab login`.

This fallback is an internal `s3cab` credential source and should be described as an **app-managed credential provider**, not as shared-config AWS `credential_process`. The AWS SDK supports IAM Identity Center / SSO authentication and exposes IAM Identity Center / SSO APIs for obtaining temporary role credentials. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)

### Step 3: If neither exists, stop with a clear auth error

If standard AWS resolution fails and no app-managed login cache exists, `s3cab` should stop and instruct the user to do one of the following:

* provide credentials via `.env` / environment variables,
* use an existing AWS profile,
* or run `s3cab login`.

This matches the credential sources supported by the AWS SDK and the intended role of `s3cab login` as a convenience bootstrap path. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

***

## Commands

## `s3cab login`

### Purpose

Interactive bootstrap/sign-in command for users who do not already have working AWS credentials configured and may not have AWS CLI installed.

### Requirements

`s3cab login` must:

* use AWS SDK IAM Identity Center / SSO capabilities rather than shelling out to AWS CLI. AWS documents IAM Identity Center support in the JS SDK and the relevant IAM Identity Center / SSO service APIs. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)
* store app-managed cached login/session state in an `s3cab`-owned location.
* avoid writing `~/.aws/config` or `~/.aws/credentials`. AWS shared config remains user-owned. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

### Terminology note

`s3cab login` should be described as creating or refreshing **app-managed IAM Identity Center / SSO login state**, not as storing long-lived AWS credentials.

The actual AWS credentials ultimately used against S3 should remain temporary role credentials with expiration. IAM Identity Center / SSO role credential APIs return short-term credentials.

***

## `s3cab run`

### Purpose

Perform the backup/upload operation using the credential resolution model defined in this spec.

### Runtime behavior

`s3cab run` must:

1. load `.env` if present;
2. construct AWS clients using normal SDK configuration first;
3. attempt standard AWS SDK credential resolution first;
4. if that fails, obtain credentials from the internal app-managed provider backed by `s3cab login`;
5. if that also fails, emit a clear, actionable authentication error.

This preserves standard AWS-native behavior while still providing a no-AWS-CLI fallback path. The AWS SDK’s default provider chain supports standard credential resolution, and IAM Identity Center / SSO APIs support the app-managed fallback for obtaining temporary role credentials. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

***

## `s3cab credential-process`

### Purpose

Advanced/manual integration point for users who want to configure `s3cab` as a standard AWS shared-config `credential_process` helper.

AWS documents `credential_process` as a shared config setting that points to an external command which writes credential JSON to `stdout`, and the JS SDK credential providers package supports this model. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

### Requirements

`s3cab credential-process` must:

* call the same internal credential-resolution function used by the `s3cab run` app-managed fallback;
* write process-credential JSON to `stdout`;
* never write secrets or tokens to `stderr`. AWS warns that SDKs and tools may capture or log `stderr` for process credential helpers. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

### Standard output contract

The command must emit JSON with the standard process-credential fields:

* `Version`
* `AccessKeyId`
* `SecretAccessKey`
* optional `SessionToken`
* optional `Expiration`

AWS documents this shape for process credentials. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

### Example manual user configuration

If a user wants to wire `s3cab` into AWS shared config themselves, a profile can look like:

```ini
[profile s3cab]
credential_process = "/path/to/s3cab" credential-process
region = eu-west-1
```

AWS documents this configuration style for process credentials in shared config. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

## Internal Architecture

## Single internal credential resolver

Implement a single internal async function with a shape conceptually like:

```text
resolveAppManagedAwsCredentials(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}>
```

This function must:

* read `s3cab`’s cached login/session state;
* obtain or refresh temporary AWS role credentials;
* return expiration-aware credentials whenever possible.

This internal function should be the single source of truth used by:

* `s3cab run` fallback;
* `s3cab credential-process`.

This aligns with the AWS credential-provider model, where providers are async functions that return the AWS credential object shape and may include `expiration` for refresh behavior. AWS documents that the JS credential providers return this shape and that SDK clients cache credentials and refresh them near expiry. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

***

## Credential Refresh and Caching

When used with an AWS SDK client, credentials from supported providers are cached until shortly before expiration, at which point the provider is called again and new credentials are cached. AWS documents refresh behavior for the standard credential provider ecosystem in the JS SDK. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

Therefore:

* the app-managed credential resolver should return expiration-aware temporary credentials whenever possible, so the SDK can refresh correctly. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
* `s3cab credential-process` should emit `Expiration` whenever possible, because the standard process-credential format supports it. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

## Security Model

### Preferred path

Prefer temporary AWS role credentials derived from IAM Identity Center / SSO login state whenever possible.

AWS’s standardized credential guidance emphasizes the use of provider chains and short-lived, refreshable credentials rather than embedding long-lived credentials directly in code. [\[stackoverflow.com\]](https://stackoverflow.com/questions/69469369/using-the-aws-javascript-sdk-v3-is-there-a-credentials-provider-chain-equivale), [\[github.com\]](https://github.com/aws/aws-sdk-js-v3)

### Supported compatibility path

Support `.env` and plain environment variables for backward compatibility and for S3-compatible providers that still require access-key / secret-key configuration.

The AWS SDK supports environment variables as a normal credential source. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

### Operational requirements

* never log credentials or tokens;
* never write secrets or tokens to `stderr` in `credential-process`; AWS explicitly warns against this for process credential helpers. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)
* store app-managed login/session material in an OS-appropriate private location with restrictive permissions;
* prefer temporary credentials with expiration over long-lived static credentials whenever feasible. AWS’s standardized guidance emphasizes refreshable providers and temporary credentials. [\[stackoverflow.com\]](https://stackoverflow.com/questions/69469369/using-the-aws-javascript-sdk-v3-is-there-a-credentials-provider-chain-equivale), [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

## Non-Goals

`s3cab` must **not**:

* accept raw AWS access keys via CLI flags, because that leaks into shell history and process lists and is weaker practice than using supported SDK credential sources. The AWS SDK already supports environment variables, shared config, SSO, process credentials, and other standard providers. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md), [\[stackoverflow.com\]](https://stackoverflow.com/questions/69469369/using-the-aws-javascript-sdk-v3-is-there-a-credentials-provider-chain-equivale)
* invent a custom AWS credential file format that competes with AWS profiles, shared config, or standard environment-variable handling. AWS already standardizes these sources and supports custom integrations through process credentials. [\[stackoverflow.com\]](https://stackoverflow.com/questions/69469369/using-the-aws-javascript-sdk-v3-is-there-a-credentials-provider-chain-equivale), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
* write `~/.aws/config` or `~/.aws/credentials` automatically. Shared AWS config remains user-managed. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

## Copilot Implementation Brief

### Objective

Implement credential resolution for `s3cab` with the following precedence:

1. load `.env` if present;
2. try normal AWS SDK v3 credential resolution first;
3. if that fails, fall back to `s3cab`’s app-managed IAM Identity Center / SSO login cache;
4. if that fails, emit a clear authentication error.

The AWS SDK v3 Node.js default provider chain already checks standard credential sources in precedence order and stops at the first valid source. Documented sources include environment variables, SSO/token cache, shared config/credentials, web identity, and instance or container metadata. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

### Required commands

#### `s3cab login`

* interactive sign-in/bootstrap command;
* uses AWS SDK IAM Identity Center / SSO capabilities rather than AWS CLI;
* stores app-managed cached login/session state in an `s3cab`-owned location;
* does **not** modify `~/.aws/config` or `~/.aws/credentials`. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3)

#### `s3cab run`

* load `.env` if present;
* try standard AWS SDK credential resolution first;
* if missing credentials, call the internal app-managed credential resolver;
* if that succeeds, use explicit returned credentials for the client;
* if it fails, emit a user-friendly auth error. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)

#### `s3cab credential-process`

* call the same internal app-managed credential resolver used by the `run` fallback;
* print standard process-credential JSON to `stdout`;
* never write secrets to `stderr`. AWS explicitly warns against writing sensitive data to `stderr` for process credential helpers. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

### Implementation constraints

* do not modify `~/.aws/config` or `~/.aws/credentials`; [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)
* do not require AWS CLI for login or runtime; the SDK can read existing AWS config directly, and `s3cab` supplies its own login convenience path; [\[github.com\]](https://github.com/aws/aws-sdk-js-v3)
* do not bypass `.env` if it exists; loading `.env` is intentional and the resulting env vars may validly take precedence because environment variables are a standard high-precedence source in the SDK chain; [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* prefer temporary credentials with expiration, because the SDK can refresh expiration-aware providers and caches them near expiry. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

***

## Suggested Help Text

## `s3cab help auth`

```text
Authentication

s3cab resolves credentials in this order:

1. If a .env file is present, s3cab loads it first.
   This allows AWS_* environment variables to be used intentionally.

2. s3cab then uses the standard AWS SDK credential chain.
   This includes existing AWS_PROFILE, shared AWS profiles,
   shared credential_process profiles, and AWS_* environment variables.

3. If no standard AWS credentials are available, s3cab falls back
   to credentials from a prior `s3cab login`.

4. If nothing is configured, run:
     s3cab login

Supported options:
  - Existing AWS profile / AWS_PROFILE
  - Existing shared AWS credential_process setup
  - .env / AWS_* environment variables
  - s3cab login

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - .env is supported for compatibility, including some S3-compatible providers.
  - For AWS, temporary credentials from login/profile-based setups are preferred.
```

This help text matches the SDK’s standard credential resolution model and the supported process-credential and IAM Identity Center flows. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

## `s3cab login --help`

```text
Sign in and cache login state for later non-interactive use.

`s3cab login` is a convenience command for users who do not already
have working AWS credentials configured on this machine.

It does not modify ~/.aws/config or ~/.aws/credentials.

After login, future `s3cab run` commands can use the cached login state
to obtain temporary AWS credentials automatically if no standard AWS
credentials are already available.
```

This wording matches the IAM Identity Center / SSO model of cached login/session state leading to temporary role credentials.

## `s3cab credential-process --help`

```text
Emit AWS credentials in standard credential_process JSON format.

This command is intended for advanced users who want to manually
configure an AWS profile that points at s3cab as a credential helper.

s3cab does not create or edit AWS shared config automatically,
but you may configure this yourself.
```

AWS documents process credentials exactly as this sort of external command declared in shared config. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management), [\[docs.aws.amazon.com\]](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)

## Suggested authentication error

```text
No AWS credentials found.

s3cab tried:
  1. .env / environment variables
  2. Standard AWS SDK credential resolution
  3. Cached credentials from `s3cab login`

To continue, do one of the following:
  - create or update a .env file with AWS_* variables
  - use an existing AWS profile and set AWS_PROFILE
  - run: s3cab login

For advanced use, you can also configure an AWS profile manually
with: credential_process = s3cab credential-process
```

This message accurately reflects the intended precedence and the supported AWS process-credential mechanism. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

## Acceptance Criteria

Implementation is complete when all of the following are true:

* if `.env` exists and defines `AWS_*` variables, those values are loaded before AWS clients are created and are eligible to win through normal SDK precedence. Environment variables are a standard provider source in the SDK chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[github.com\]](https://github.com/awsdocs/aws-sdk-for-javascript-v3/blob/main/doc_source/getting-your-credentials.md)
* if the machine already has working standard AWS credentials (for example `AWS_PROFILE`, shared SSO config, or existing shared `credential_process`), `s3cab run` succeeds without requiring `s3cab login`. The SDK supports these sources through the standard Node.js credential chain. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)
* if no standard AWS credentials exist but `s3cab login` has been run, `s3cab run` succeeds using the app-managed login cache and temporary credentials derived from it. IAM Identity Center / SSO APIs support temporary role credential retrieval. [\[devops.aibit.im\]](https://devops.aibit.im/en/article/best-practices-secure-credentials-aws-cli)
* `s3cab credential-process` emits valid process-credential JSON and never writes secrets to `stderr`. AWS documents both the JSON contract and the `stderr` caution. [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)
* `s3cab` never automatically modifies `~/.aws/config` or `~/.aws/credentials`. [\[github.com\]](https://github.com/aws/aws-sdk-js-v3), [\[deepwiki.com\]](https://deepwiki.com/aws/aws-cli/5.2-credentials-management)

***

If you want, I can also turn this into a **shorter `AUTHENTICATION.md`** version for your repo, or a **Copilot prompt** optimized for implementation planning.
