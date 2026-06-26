import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

// AWS credential resolution. This is the single source of truth for *how* s3cab
// obtains AWS credentials; the S3 SDK boundary (`src/lib/s3.mjs`) hands
// `resolveCredentials` to its client. The model is specified in docs/specs/auth.md.
// Resolution order:
//
//   0. the command first loads s3cab's layered env files (src/lib/env.mjs,
//      `loadEnv`) — an explicit user signal that may carry AWS_* vars, a
//      profile, an endpoint, a bucket — into the environment the chain reads
//   1. the standard AWS SDK credential chain (env, SSO/token cache, shared
//      config/credentials, web identity, instance metadata, …)
//   2. otherwise, stop with a clear, actionable error
//
// s3cab never writes ~/.aws/config or ~/.aws/credentials — that stays user-owned.
// Interactive SSO sign-in is deliberately *not* s3cab's job: `aws sso login`
// (or any other tool that feeds the standard chain) handles it, and s3cab picks
// the session up via step 1.

/**
 * The actionable "no credentials" error, with the credential chain's own
 * message embedded. The chain reports a *missing* setup and a *misconfigured*
 * one (typo'd AWS_PROFILE, broken credential_process, …) through the same
 * error type, so don't try to classify — show the specific reason alongside
 * the setup guidance. It must live in the message itself: the CLI prints only
 * `message` unless S3CAB_DEBUG is set (`cause` is kept for that debug path).
 * @param {unknown} cause - The error thrown by the standard chain.
 */
const noCredentialsError = (cause) => {
  const reason = (Error.isError(cause) ? cause.message : String(cause))
    .trim()
    .replaceAll("\n", "\n     ");
  return new Error(
    `No AWS credentials found.

s3cab tried:
  1. s3cab env files / environment variables
  2. The standard AWS SDK credential chain, which reported:
     ${reason}

To continue, do one of the following:
  - point s3cab at an AWS profile:
      s3cab aws --profile <name>
    (for AWS IAM Identity Center, run \`aws sso login\` first —
    s3cab picks the session up automatically)
  - or set AWS_* variables directly in ~/.s3cab/env

Run 's3cab help auth' for details.`,
    { cause },
  );
};

/**
 * The actionable "credentials resolved fine but had expired by request time"
 * error — an expired SSO/session token the chain handed back without validating,
 * which the *server* then rejects on the request. The request-time twin of
 * `noCredentialsError` (which fires when the chain resolves *nothing*): by the
 * time it surfaces, `auth.mjs` is off the stack, so it is detected and thrown at
 * the SDK boundary (`src/lib/s3.mjs`) rather than here. A plain-`Error` factory,
 * not a subclass, because nothing catches it by type — it flows to the CLI's
 * top-level catch, which only prints `message` (unless S3CAB_DEBUG; `cause` is
 * kept for that debug path). Follows ADR-0030: goal-framed, constructive, with
 * copy-pasteable fixes.
 * @param {unknown} cause - The AWS error that triggered it.
 */
export const expiredCredentialsError = (cause) =>
  new Error(
    `Your AWS credentials have expired.

To continue, refresh them and run the command again:
  - for AWS IAM Identity Center, run \`aws sso login\`
  - for temporary credentials (AWS_SESSION_TOKEN), request a new set
  - for a named profile, renew it (and set AWS_PROFILE)

Run 's3cab help auth' for details.`,
    { cause },
  );

/**
 * Whether an AWS error is the server rejecting a request because the resolved
 * credentials had expired. S3 surfaces it as `ExpiredToken`, STS as
 * `ExpiredTokenException` — matched on `error.name`, as the s3.mjs
 * NotFound/NoSuchKey/PreconditionFailed guards are.
 * @param {unknown} error
 */
export const isExpiredCredentials = (error) =>
  Error.isError(error) &&
  (error.name === "ExpiredToken" || error.name === "ExpiredTokenException");

// The standard AWS SDK Node.js provider chain, built once. The SDK client caches
// the credentials it returns and re-invokes the provider near expiry, so a single
// chain instance is reused across refreshes.
const standardChain = fromNodeProviderChain();

/**
 * The credential provider s3cab hands to its AWS clients. Implements the
 * resolution order above: the standard chain, after the command's `loadEnv` has
 * already merged any s3cab env files into the environment the chain reads; if it
 * yields nothing, throw an actionable error. Returning a provider (rather than
 * resolving eagerly) lets the SDK cache and refresh expiration-aware credentials
 * itself.
 *
 * @type {import("@aws-sdk/types").AwsCredentialIdentityProvider}
 */
export const resolveCredentials = async (awsIdentityProperties) => {
  try {
    return await standardChain(awsIdentityProperties);
  } catch (error) {
    throw noCredentialsError(error);
  }
};
