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
  - create ~/.s3cab/env with AWS_* variables (or AWS_PROFILE)
  - use an existing AWS profile and set AWS_PROFILE
    (for AWS IAM Identity Center, run \`aws sso login\` first —
    s3cab picks the session up automatically)

Run 's3cab help auth' for details.`,
    { cause },
  );
};

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
