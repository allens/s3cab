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
      s3cab profile --profile <name>
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
 * `ExpiredTokenException`, and a token the SDK couldn't refresh in time as
 * `TokenRefreshRequired` — all three share the one remedy (`aws sso login` /
 * request a fresh set), so they share this predicate. Matched on `error.name`,
 * as the s3.mjs NotFound/NoSuchKey/PreconditionFailed guards are.
 * @param {unknown} error
 */
export const isExpiredCredentials = (error) =>
  Error.isError(error) &&
  ["ExpiredToken", "ExpiredTokenException", "TokenRefreshRequired"].includes(
    error.name,
  );

// ---------------------------------------------------------------------------
// Request-time credential rejections, beyond expiry (ADR-0037).
//
// When the resolved credentials work at startup but the *server* rejects a
// request, the family splits by the *remedy* we can offer — and we match the
// AWS error *code* (`error.name`), never HTTP status, because only the code
// maps ~1:1 to a user action (403 alone spans permission, signature and clock
// skew). The relay (src/lib/s3.mjs) walks these predicate→factory pairs; only
// codes we can fix or commonly advise on are caught, everything else falls
// through to the raw `ERROR:` dump. Wording follows ADR-0030 (goal-framed,
// polite, constructive); headlines stay provider-neutral (the codes are the
// de-facto S3-compatibility surface), and only the AccessDenied *remedy*
// branches on AWS-vs-not.
// ---------------------------------------------------------------------------

/**
 * The raw AWS rejection, code first (so it's googleable) then its message,
 * indented to sit under a label — the same 5-space inset `noCredentialsError`
 * uses for the chain's own message.
 * @param {unknown} cause
 */
const rawAwsError = (cause) => {
  if (!Error.isError(cause)) return String(cause).trim();
  const code = cause.name && cause.name !== "Error" ? `${cause.name}: ` : "";
  return `${code}${cause.message}`.trim().replaceAll("\n", "\n     ");
};

/**
 * Whether an AWS error is the server refusing the request for lack of
 * permission — the credentials are valid and signed in, they just aren't
 * allowed. `AccessDenied` is a modeled SDK class with `readonly name`, and the
 * code every S3-compatible provider returns for an authorization failure.
 * @param {unknown} error
 */
export const isAccessDenied = (error) =>
  Error.isError(error) && error.name === "AccessDenied";

/**
 * The actionable "signed in, but not allowed" error. The credentials resolved
 * and authenticated fine — this is a *permissions* problem, so the remedy is
 * the bucket's access policy, not the credentials. On AWS that's the exact
 * least-privilege policy `s3cab aws <bucket>` prints; off AWS (a custom
 * endpoint) the IAM JSON is meaningless, so we point at the provider's own
 * bucket/token permissions instead. A plain-`Error` factory (nothing catches it
 * by type); keeps `cause` for the S3CAB_DEBUG path. ADR-0030 wording.
 * @param {unknown} cause - The AWS error that triggered it.
 * @param {{ bucket?: string, endpoint?: string }} [ctx] - Request bucket and the
 *   custom endpoint, if any (its presence means "not AWS").
 */
export const accessDeniedError = (cause, { bucket, endpoint } = {}) => {
  const target = bucket ? `the bucket "${bucket}"` : "that bucket";
  const remedy = endpoint
    ? `Check that your provider's bucket and token permissions allow listing
and read/write access to ${target}.`
    : `To see the exact least-privilege policy your identity needs, run:
  s3cab aws ${bucket ?? "<bucket>"}`;
  return new Error(
    `You're signed in, but you don't have permission to use ${target}.

Your sign-in worked — this is a permissions problem, not a credentials one.
${remedy}

Run 's3cab help auth' for details.`,
    { cause },
  );
};

/**
 * Shared builder for the rejections that have no single-command fix — the
 * secret/profile/SSO/endpoint could live anywhere s3cab is source-agnostic
 * about (ADR-0015) — so each recognized *cause* supplies its own plain-language
 * headline + advice, and we embed the raw AWS error (code-first, for googling)
 * and point at `s3cab help auth` for the per-source depth. ADR-0030 wording.
 * @param {unknown} cause
 * @param {{ headline: string, advice: string }} copy
 */
const credentialAdviceError = (cause, { headline, advice }) =>
  new Error(
    `${headline}

${advice}

The server reported:
     ${rawAwsError(cause)}

Run 's3cab help auth' for details.`,
    { cause },
  );

/**
 * Whether an AWS error is the server rejecting the credentials themselves as
 * invalid/malformed (as opposed to *expired* — `isExpiredCredentials`).
 * `InvalidToken`/`InvalidSecurity` are STS session-token codes; `InvalidAccessKeyId`
 * is portable (every S3 provider returns it for an unknown key).
 * @param {unknown} error
 */
export const isInvalidCredentials = (error) =>
  Error.isError(error) &&
  ["InvalidToken", "InvalidAccessKeyId", "InvalidSecurity"].includes(
    error.name,
  );

/** The "your credentials were rejected as invalid" error. @param {unknown} cause */
export const invalidCredentialsError = (cause) =>
  credentialAdviceError(cause, {
    headline: "Your credentials were rejected as invalid.",
    advice: `The server wouldn't accept the credentials s3cab is using. This usually
means a key, secret, or session token is wrong, incomplete, or no longer
valid — replace the ones for whichever source you're using (an env file,
a profile, or an SSO session).`,
  });

/**
 * Whether an AWS error is a request-signature mismatch — `SignatureDoesNotMatch`,
 * part of SigV4 signing every S3-compatible provider implements (and *more*
 * common off-AWS, where a wrong endpoint/region is the classic R2/B2 trap).
 * @param {unknown} error
 */
export const isBadSignature = (error) =>
  Error.isError(error) && error.name === "SignatureDoesNotMatch";

/** The "request signature didn't match" error. @param {unknown} cause */
export const badSignatureError = (cause) =>
  credentialAdviceError(cause, {
    headline: "Your credentials couldn't be verified (signature mismatch).",
    advice: `The request signature didn't match. This almost always means a wrong
secret key, or a region or endpoint that doesn't match your provider —
for non-AWS S3 providers, a wrong endpoint or region is the usual cause.`,
  });

/**
 * Whether an AWS error is the server rejecting the request because the client
 * clock drifted too far — `RequestTimeTooSkewed`, a portable SigV4 code.
 * @param {unknown} error
 */
export const isClockSkew = (error) =>
  Error.isError(error) && error.name === "RequestTimeTooSkewed";

/** The "your clock is out of sync" error. @param {unknown} cause */
export const clockSkewError = (cause) =>
  credentialAdviceError(cause, {
    headline: "Your computer's clock is too far out of sync.",
    advice: `S3 rejects requests whose timestamp drifts too far from its own, and
yours did. Sync your system clock, then run the command again.`,
  });

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
