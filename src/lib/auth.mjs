import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { parseKnownFiles } from "@smithy/shared-ini-file-loader";
import { customEndpoint, loadedSet } from "./env.mjs";
import { tildeify } from "./home.mjs";
import {
  createSession,
  isRolesAnywhereMode,
  machineIdentityDir,
  readSigningIdentity,
} from "./roles-anywhere.mjs";

// AWS credential resolution. This is the single source of truth for *how* s3cab
// obtains AWS credentials; the S3 SDK boundary (`src/lib/s3.mjs`) hands
// `resolveCredentials` to its client. The model is specified in docs/design/auth.md.
// Resolution order:
//
//   0. a set-first command first loads that set's env file (src/lib/env.mjs,
//      `loadSet`) — the one s3cab config layer (ADR-0055), an explicit user
//      signal that may carry AWS_* vars, a profile, an endpoint — over the shell
//   1. the standard AWS SDK credential chain (env, SSO/token cache, shared
//      config/credentials, web identity, instance metadata, …)
//   2. otherwise, stop with a clear, actionable error
//
// s3cab never writes ~/.aws/config or ~/.aws/credentials — that stays user-owned.
// Interactive SSO sign-in is deliberately *not* s3cab's job: `aws sso login`
// (or any other tool that feeds the standard chain) handles it, and s3cab picks
// the session up via step 1.
//
// A fourth source slots in ahead of the chain (ADR-0057): when the loaded set is
// in Roles Anywhere mode (its `S3CAB_RA` marker, merged into the environment by
// `loadSet`), the native SigV4-X509 signer (src/lib/roles-anywhere.mjs) mints
// short-lived STS credentials from the machine's certificate identity instead of
// the standard chain. It returns credentials with an `expiration`, so the SDK's
// own provider-memoization refreshes them before expiry — no caching of our own.

/**
 * The chain's own message, trimmed and indented to sit under a label — the same
 * 5-space inset the request-time rejections use (`rawAwsError`), so the two error
 * families read alike.
 * @param {unknown} cause
 */
const reasonFrom = (cause) =>
  (Error.isError(cause) ? cause.message : String(cause))
    .trim()
    .replaceAll("\n", "\n     ");

/**
 * Classify a set's credential situation into the parts that vary per case — the
 * line-1 annotation, an optional leading diagnosis (the "aha"), an optional
 * `source` (what {@link noCredentialsError}'s "looked in" step 2 names, defaulting
 * to the ambient AWS chain), and the fix block — which drops into a constant frame.
 * The cases are decided by what the *set* declares (ADR-0055), wording per ADR-0030:
 *   - Roles Anywhere marker but the machine identity is missing/broken → set it up / repair it;
 *   - a profile absent from `~/.aws` → the missing "aha": create it / point elsewhere;
 *   - a profile present (or `~/.aws` unreadable) → it produced nothing: SSO sign-in / check keys;
 *   - a custom endpoint (non-AWS) but no keys → save the provider's key pair;
 *   - nothing configured → the generic pick-one menu.
 * There is no keys-present case: keys present means the chain resolves *something*,
 * so a wrong key surfaces later as a request-time rejection, never here.
 * @param {{ name: string }} set - The set in play (for set-scoped fixes).
 * @param {string} [profile] - The effective `AWS_PROFILE`, if any.
 * @param {string[]} [knownProfiles] - Profiles in `~/.aws`; `undefined` when the
 *   config couldn't be read, so we don't claim a profile is absent.
 * @param {string} [endpoint] - The custom S3 endpoint, if any (its presence means "not AWS").
 * @param {boolean} [rolesAnywhere] - The set is in Roles Anywhere mode (the marker
 *   is set) but this machine's certificate identity is absent or incomplete.
 * @returns {{ annotation: string, diagnosis?: string, source?: string, fix: string }}
 */
const credentialCase = (
  set,
  profile,
  knownProfiles,
  endpoint,
  rolesAnywhere,
) => {
  if (rolesAnywhere) {
    return {
      annotation: "Roles Anywhere",
      diagnosis: `Set '${set.name}' uses Roles Anywhere (keyless), but this machine's
certificate identity is missing, incomplete, or its ARNs were never captured.`,
      source: `your machine's Roles Anywhere identity
     (${tildeify(machineIdentityDir())})`,
      fix: `To set it up (or repair it), generate the identity and emit its template:
  s3cab aws <bucket> --roles-anywhere
then deploy the printed template and capture the stack's ARNs:
  s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>`,
    };
  }
  if (profile) {
    if (knownProfiles && !knownProfiles.includes(profile)) {
      return {
        annotation: `profile '${profile}'`,
        diagnosis: `Set '${set.name}' uses AWS profile '${profile}', but it isn't in your AWS
config — that's why there are no credentials.`,
        fix: `To fix it, either:
  - create the profile:          aws configure --profile ${profile}
    (for AWS IAM Identity Center: aws configure sso)
  - or point the set elsewhere:  s3cab provider --profile <name> ${set.name}`,
      };
    }
    return {
      annotation: `profile '${profile}'`,
      diagnosis: `Set '${set.name}' uses AWS profile '${profile}', but it produced no credentials.`,
      fix: `To fix it:
  - if '${profile}' is an SSO / IAM Identity Center profile, sign in:
      aws sso login --profile ${profile}
  - otherwise, check the profile's access keys in ~/.aws`,
    };
  }
  if (endpoint) {
    return {
      annotation: "endpoint, no keys",
      diagnosis: `Set '${set.name}' points at a custom S3 endpoint
(${endpoint}) but has no access keys.`,
      fix: `To fix it, save the provider's access key + secret:
  s3cab provider --keys ${set.name}`,
    };
  }
  return {
    annotation: "no credentials there",
    fix: `To give set '${set.name}' credentials, pick one:
  - an AWS profile:                 s3cab provider --profile <name> ${set.name}
  - access keys (R2 / B2 / MinIO):  s3cab provider --keys ${set.name}
  (for AWS IAM Identity Center, run \`aws sso login\` first)`,
  };
};

/**
 * The credential error when **no set is loaded** to carry its own auth, so the
 * command runs on ambient credentials — `setup`/`reattach` (the set doesn't
 * exist yet, so there is nothing to configure per-set) and the `upload --bucket`
 * escape hatch (ADR-0055). Skips the set-scoped frame and reports the ambient
 * failure + how to configure it. Note the fix is *ambient* (a profile or exported
 * `AWS_*`), not `s3cab provider` — that writes a set's file, and here there is no
 * set to write to.
 * @param {unknown} cause
 * @param {string} reason - The chain's own message, pre-indented (`reasonFrom`).
 */
const ambientCredentialsError = (cause, reason) =>
  new Error(
    `No AWS credentials found.

s3cab looked in your standard AWS setup (~/.aws/config, ~/.aws/credentials, or
AWS_* in your environment), which reported:
     ${reason}

This command runs on your ambient AWS credentials (no backup set is loaded to
carry its own). Configure them — an AWS profile, or exported AWS_* variables
(add AWS_ENDPOINT_URL_S3 for a non-AWS provider) — then run it again.

Run 's3cab help provider' for details.`,
    { cause },
  );

/**
 * The actionable "no credentials" error. Two shapes:
 *   - **with a set** (every set-first command): names the set, leads with an
 *     optional pinpoint diagnosis, then a constant "looked in" frame — the set's
 *     env file + the ambient chain, embedding the chain's own message — then a
 *     tailored fix ({@link credentialCase});
 *   - **with no set** (`setup`/`reattach`/`upload --bucket`): the shorter
 *     {@link ambientCredentialsError} template.
 * The whole message must be self-contained: the CLI prints only `message` unless
 * S3CAB_DEBUG (`cause` kept for that path). The set and the `~/.aws` cross-check
 * are gathered by the async caller (`resolveCredentials`) and passed in, so this
 * factory stays sync.
 * @param {unknown} cause - The error thrown by the standard chain (or, in RA mode,
 *   the "identity missing/broken" error {@link resolveCredentials} raises).
 * @param {{ set?: { name: string, envPath: string }, profile?: string,
 *   knownProfiles?: string[], endpoint?: string, rolesAnywhere?: boolean }} [ctx]
 */
export const noCredentialsError = (cause, ctx = {}) => {
  const reason = reasonFrom(cause);
  const { set, profile, knownProfiles, endpoint, rolesAnywhere } = ctx;
  if (!set) {
    return ambientCredentialsError(cause, reason);
  }
  const { annotation, diagnosis, source, fix } = credentialCase(
    set,
    profile,
    knownProfiles,
    endpoint,
    rolesAnywhere,
  );
  // Step 2 of "looked in" is the second place s3cab consulted — the ambient AWS
  // chain by default, or (RA mode) the machine's certificate identity.
  const lookedIn =
    source ??
    `your standard AWS setup (~/.aws/config, ~/.aws/credentials, or AWS_*
     in your environment)`;
  const message = [
    `No credentials found for set '${set.name}'.`,
    diagnosis,
    `s3cab looked in:
  1. the set's own settings:  ${tildeify(set.envPath)}   (${annotation})
  2. ${lookedIn}, which reported:
     ${reason}`,
    fix,
    `Run 's3cab help provider' for details.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return new Error(message, { cause });
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

Run 's3cab help provider' for details.`,
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
  if (!Error.isError(cause)) {
    return String(cause).trim();
  }
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

Run 's3cab help provider' for details.`,
    { cause },
  );
};

/**
 * Shared builder for the rejections that have no single-command fix — the
 * secret/profile/SSO/endpoint could live anywhere s3cab is source-agnostic
 * about (ADR-0015) — so each recognized *cause* supplies its own plain-language
 * headline + advice, and we embed the raw AWS error (code-first, for googling)
 * and point at `s3cab help provider` for the per-source depth. ADR-0030 wording.
 * @param {unknown} cause
 * @param {{ headline: string, advice: string }} copy
 */
const credentialAdviceError = (cause, { headline, advice }) =>
  new Error(
    `${headline}

${advice}

The server reported:
     ${rawAwsError(cause)}

Run 's3cab help provider' for details.`,
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
 * The Roles Anywhere credential source (ADR-0057): read the machine's certificate
 * identity, sign a `CreateSession`, and return the short-lived STS credentials with
 * their `expiration` so the SDK refreshes them before expiry. When the set is in RA
 * mode but the identity is absent or incomplete, raise the actionable
 * "RA identity missing/broken" error (the fifth `credentialCase`) rather than a
 * raw read failure.
 * @returns {Promise<import("@aws-sdk/types").AwsCredentialIdentity>}
 */
const resolveRolesAnywhereCredentials = async () => {
  const identity = readSigningIdentity();
  if (!identity) {
    throw noCredentialsError(
      new Error(
        `No usable Roles Anywhere certificate identity at ${tildeify(machineIdentityDir())}.`,
      ),
      { set: loadedSet(), rolesAnywhere: true },
    );
  }
  const credentials = await createSession(identity);
  // Field names already match AwsCredentialIdentity; only expiration needs a Date.
  return { ...credentials, expiration: new Date(credentials.expiration) };
};

/**
 * The names of every profile defined in the user's AWS shared config files
 * (`~/.aws/config` + `~/.aws/credentials`), sorted — the typo-catcher a command
 * uses to validate a `--profile` name at config time, catching a mistake then
 * rather than as a surprise on the next cloud op. An absent config yields `[]`
 * (the parser tolerates missing files); `undefined` means the files could not be
 * read at all — the signal for the caller to *skip* validation silently rather
 * than wrongly report "no profiles". Validation is advisory and must never block
 * a user from setting their own config.
 *
 * Uses the canonical AWS-family INI parser, which handles the `[profile X]`
 * (config) vs `[X]` (credentials) section-name asymmetry, merges both files, and
 * honours the AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE overrides — so we
 * never hard-code ~/.aws paths or re-implement the INI quirks. Read-only, like
 * everything here (s3cab never *writes* ~/.aws — see the module header).
 * @returns {Promise<string[] | undefined>}
 */
export async function listProfiles() {
  try {
    return Object.keys(await parseKnownFiles({})).sort();
  } catch {
    return undefined;
  }
}

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
  if (isRolesAnywhereMode()) {
    return resolveRolesAnywhereCredentials();
  }
  try {
    return await standardChain(awsIdentityProperties);
  } catch (error) {
    // The `~/.aws` cross-check is async and only needed when a profile is set,
    // so do it here (already async) and hand the result to the sync factory.
    const profile = process.env.AWS_PROFILE;
    const knownProfiles = profile ? await listProfiles() : undefined;
    throw noCredentialsError(error, {
      set: loadedSet(),
      profile,
      knownProfiles,
      endpoint: customEndpoint(),
    });
  }
};
