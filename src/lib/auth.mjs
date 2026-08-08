import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { parseKnownFiles } from "@smithy/shared-ini-file-loader";
import { customEndpoint, loadedSet, profileSource } from "./env.mjs";
import { tildeify } from "./home.mjs";
import {
  createSession,
  isRolesAnywhereMode,
  machineIdentityDir,
  readSigningIdentity,
} from "./roles-anywhere.mjs";

/** @import { AwsCredentialIdentity, AwsCredentialIdentityProvider, MetadataBearer } from "@aws-sdk/types" */

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
 * Whether the standard chain failed because the sign-in it found had *expired*,
 * rather than because there was nothing to find. The resolve-time twin of
 * {@link isExpiredCredentials} (request-time, matched on the server's response
 * code) — and matched differently by necessity: the SDK throws the same
 * `TokenProviderError` / `CredentialsProviderError` for an expired session as for
 * a missing profile or a malformed `sso_session`, so only the message
 * discriminates (ADR-0075). Both texts AWS ships for expiry carry the word —
 * `Token is expired. …` (`@aws-sdk/token-providers`) and `The SSO session
 * associated with this profile has expired. …`
 * (`@aws-sdk/credential-provider-sso`) — so one word covers both, and if AWS ever
 * rewords, this stops matching and the caller falls back to the generic "no
 * credentials" frame: today's message, never a wrong instruction.
 * @param {unknown} error
 */
const isExpiredSignIn = (error) =>
  Error.isError(error) && /\bexpired\b/i.test(error.message);

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
 * The actionable "no credentials" error. Three shapes:
 *   - **an expired sign-in** ({@link isExpiredSignIn}), whichever of the two
 *     below it arrived through: the chain *did* find credentials, they had just
 *     run out, so the "looked in" frame would misdiagnose a configured set as an
 *     unconfigured one — hand off to {@link expiredCredentialsError} (ADR-0075);
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
  if (isExpiredSignIn(cause)) {
    return expiredCredentialsError(cause, { set, profile, reason });
  }
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
 * The actionable "your credentials ran out" error — the one message for both
 * moments a stale sign-in surfaces (ADR-0075), because the remedy is the same
 * either way:
 *   - **at request time**, an expired token the chain handed back without
 *     validating, which the *server* then rejects. By then `auth.mjs` is off the
 *     stack, so it is detected and thrown at the SDK boundary (`src/lib/s3.mjs`);
 *   - **at resolve time**, the chain itself refusing to hand anything back —
 *     routed here by {@link noCredentialsError}, which passes the chain's own
 *     words as `reason` (there is no equivalent at request time: the server just
 *     rejects a signature, and the raw code says nothing a user can act on).
 * A plain-`Error` factory, not a subclass, because nothing catches it by type —
 * it flows to the CLI's top-level catch, which only prints `message` (unless
 * S3CAB_DEBUG; `cause` is kept for that debug path). Follows ADR-0030:
 * goal-framed, constructive, with copy-pasteable fixes.
 * @param {unknown} cause - The AWS error that triggered it.
 * @param {{ set?: { name: string }, profile?: string, reason?: string }} [ctx] -
 *   The set in play, the effective `AWS_PROFILE`, and the chain's own message
 *   (pre-indented by `reasonFrom`) — all resolve-time only.
 */
export const expiredCredentialsError = (cause, ctx = {}) => {
  const { set, profile, reason } = ctx;
  // Naming the profile turns the first bullet into the whole command; without
  // one, `aws sso login` picks up the default profile by itself.
  const login = profile
    ? `aws sso login --profile ${profile}`
    : "aws sso login";
  const message = [
    `Your AWS credentials${set ? ` for set '${set.name}'` : ""} have expired.`,
    reason &&
      `s3cab found your standard AWS setup, but its session is no longer valid:
     ${reason}`,
    `To continue, refresh them and run the command again:
  - for AWS IAM Identity Center, run \`${login}\`
  - for temporary credentials (AWS_SESSION_TOKEN), request new ones
  - for a named profile, renew it (and set AWS_PROFILE)`,
    `Run 's3cab help provider' for details.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return new Error(message, { cause });
};

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
 * Which credentials s3cab actually signed in with — the sentence every
 * request-time rejection below leads its diagnosis with.
 *
 * It exists because the *identity* is the likeliest thing to be wrong and the
 * one thing the user cannot see: the credential chain falls through to the
 * `default` profile when no `AWS_PROFILE` is set, so backing up as the wrong
 * role looks identical to holding no permission at all. Stating what was used
 * turns that into a one-line read. Deliberately a statement of *fact*, not a
 * diagnosis — ADR-0037 rejects guessing a cause from a rejection we cannot
 * decode, and this claims nothing about why the server said no.
 *
 * Reads the environment at call time (like `loadedSet`/`customEndpoint`
 * alongside it), since a set's env layer is applied before any S3 call
 * (ADR-0022/0055). Mirrors `authNotice` in s3.mjs — the same three sources in
 * the same precedence — but worded for an error rather than a progress notice,
 * and with no silent fallback: the no-profile case is the one most worth saying.
 * @returns {string}
 */
export function credentialsUsed() {
  // The four modes docs/design/auth.md describes, in the precedence that
  // actually decides the request: Roles Anywhere short-circuits the chain
  // (`resolveCredentials` checks it first), then the standard chain's own order
  // — explicit keys in the environment, then a named profile, then whatever
  // `default` yields. Never prints the key itself, only that one was used.
  if (isRolesAnywhereMode()) {
    return "s3cab signed in with Roles Anywhere (keyless).";
  }
  if (process.env.AWS_ACCESS_KEY_ID) {
    return "s3cab signed in with the access key saved for this set.";
  }
  const profile = process.env.AWS_PROFILE;
  if (!profile) {
    return "s3cab signed in with your default AWS credentials (no AWS_PROFILE is set).";
  }
  const source = profileSource();
  const via = source ? ` (from ${source})` : "";
  return `s3cab signed in with AWS profile '${profile}'${via}.`;
}

/**
 * The "…and if that identity is wrong, here is how to change it" follow-on to
 * {@link credentialsUsed}. Split out because two factories need it, and because
 * `s3cab provider --profile` is the one *durable* fix: it writes the profile
 * into the set's own env file, so it sticks instead of living in a shell export
 * the next terminal won't have.
 */
const wrongIdentityAdvice = `If that isn't the identity you meant to use, point this set at the right
profile and run the command again:
  s3cab provider --profile <name>`;

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
 * It embeds the raw AWS error like its siblings above, and for a *permission*
 * rejection that is the load-bearing part rather than googling material: AWS
 * names the calling identity in the text ("User: arn:aws:sts::…/SomeRole/…
 * is not authorized to perform: s3:GetObject"). Dropping it — which this factory
 * alone used to do — threw away the one line that distinguishes "my policy is
 * wrong" from "I am signed in as the wrong role", the far likelier of the two.
 * @param {unknown} cause - The AWS error that triggered it.
 * @param {{ bucket?: string, endpoint?: string }} [ctx] - Request bucket and the
 *   custom endpoint, if any (its presence means "not AWS").
 */
export const accessDeniedError = (cause, { bucket, endpoint } = {}) => {
  const target = bucket ? `the bucket "${bucket}"` : "that bucket";
  const remedy = endpoint
    ? `Check that your provider's bucket and token permissions allow listing
and read/write access to ${target}.`
    : `If the identity is right, then it is missing permission on the bucket. To
see the exact least-privilege policy it needs, run:
  s3cab aws ${bucket ?? "<bucket>"}`;
  const message = [
    `You're signed in, but you don't have permission to use ${target}.`,
    `Your sign-in worked — this is a permissions problem, not a credentials one.`,
    `${credentialsUsed()}
The server reported:
     ${rawAwsError(cause)}`,
    // AWS profiles are an AWS concept, so the switch-identity advice is dropped
    // off-provider, where the endpoint branch's own remedy stands alone.
    endpoint ? undefined : wrongIdentityAdvice,
    remedy,
    `Run 's3cab help provider' for details.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return new Error(message, { cause });
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

${credentialsUsed()}
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

/**
 * Whether the server refused the request but sent **no error code at all** —
 * the one case ADR-0037's code-first matching cannot reach, because it assumes
 * a `<Code>` is always there to read.
 *
 * A HEAD response carries no body by definition, so a rejected `HeadObject` has
 * nowhere to put the code: the SDK falls back to a placeholder name and a
 * literal `"UnknownError"` message, which is what reached the terminal before
 * this row existed. `backup`'s first S3 call is exactly that HEAD (the
 * baseline-trust check in lib/upload.mjs `storedHashes`), so a permission
 * problem printed as a bare `ERROR: UnknownError` while the same problem on a
 * GET — `status`, `restore` — reported perfectly. Which verb a command happened
 * to reach for first decided whether its error was legible.
 *
 * The discriminator is the **absence of `Code`**, not the status: an
 * unenumerated but genuine code (`AccountProblem`, `AllAccessDisabled`) still
 * deserializes into `Code` and must keep falling through to the raw dump, per
 * ADR-0037's "no mushy middle". Narrowed to 403 because that is the status this
 * was demonstrated on; a bodiless 400 (`ExpiredToken`'s status) is plausible but
 * unobserved, and speculative rows are what ADR-0037 declined to add.
 * @param {unknown} error
 */
export function isRefusedWithoutReason(error) {
  if (!Error.isError(error)) {
    return false;
  }
  const refusal =
    /** @type {Error & Partial<MetadataBearer> & { Code?: string }} */ (error);
  return (
    refusal.$metadata?.httpStatusCode === 403 && refusal.Code === undefined
  );
}

/**
 * The "refused, with no reason given" error. Unlike every other factory here it
 * **names no single cause**, because the response carried nothing to identify
 * one: a code-less 403 spans `AccessDenied`, `SignatureDoesNotMatch`,
 * `RequestTimeTooSkewed` and `InvalidAccessKeyId` alike. ADR-0037 rejected a
 * status-keyed "coverage net" precisely because one message for that span
 * misdirects — so this one says outright that s3cab cannot tell which it is,
 * and leads with {@link credentialsUsed}, a fact rather than a guess. The
 * ordering is by likelihood for a request that got as far as being signed and
 * refused; a wrong secret or a skewed clock would have failed every request,
 * not this one.
 * @param {unknown} cause - The AWS error that triggered it.
 * @param {{ bucket?: string, endpoint?: string }} [ctx] - Request bucket and the
 *   custom endpoint, if any (its presence means "not AWS").
 */
export const refusedWithoutReasonError = (cause, { bucket, endpoint } = {}) => {
  const target = bucket ? `the bucket "${bucket}"` : "that bucket";
  const requestId = /** @type {Partial<MetadataBearer>} */ (cause)?.$metadata
    ?.requestId;
  const detail = requestId ? `HTTP 403, request ${requestId}` : "HTTP 403";
  const remedy = endpoint
    ? `Check that your provider's bucket and token permissions allow listing
and read/write access to ${target}.`
    : `If the identity is right, it may be missing permission on the bucket. To
see the exact least-privilege policy it needs, run:
  s3cab aws ${bucket ?? "<bucket>"}`;
  const message = [
    `The cloud refused to answer a question about ${target}, and didn't say why (${detail}).`,
    `This kind of request is answered without a reply body, so the refusal
arrived with no reason code in it. s3cab can't tell you which cause it
was — what follows is the likeliest first, not a diagnosis.`,
    credentialsUsed(),
    endpoint ? undefined : wrongIdentityAdvice,
    remedy,
    `Run 's3cab help provider' for details.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return new Error(message, { cause });
};

// The standard AWS SDK Node.js provider chain, built once. The SDK client caches
// the credentials it returns and re-invokes the provider near expiry, so a single
// chain instance is reused across refreshes.
const standardChain = fromNodeProviderChain();

/**
 * Whether a rejection came from the AWS credential/token provider chain rather
 * than from s3cab's own code — matched on `name` across `ProviderError` and its
 * two subclasses (`CredentialsProviderError`, `TokenProviderError`), as the
 * request-time guards above match foreign errors on `name`/`code`.
 *
 * It exists for one caller: the entry point's `unhandledRejection` handler.
 * Within five minutes of expiry the SDK's memoization refreshes credentials in
 * the *background* — `passiveLock = chain(options).then(…).finally(…)`, with no
 * `catch`, which its caller never awaits because it returns the still-valid
 * credentials instead. So a refresh that fails (a blip, a throttle, a laptop
 * waking up) rejects with nobody listening, and Node's default for that is to
 * kill the process: an overnight backup dies hours in, to a hiccup it was
 * already built to survive. That promise is unreachable from any call stack of
 * ours, so the entry point disarms it there and lets the SDK's own retry — every
 * request inside that five-minute window starts a fresh attempt — get on with
 * it. If none of them land, the credentials expire outright and the chain's
 * *awaited* path takes over, so the failure still surfaces here in
 * {@link resolveCredentials} and reads as {@link noCredentialsError} /
 * {@link expiredCredentialsError} like any other.
 * @param {unknown} error
 */
export const isCredentialProviderError = (error) =>
  Error.isError(error) &&
  ["ProviderError", "CredentialsProviderError", "TokenProviderError"].includes(
    error.name,
  );

/**
 * The Roles Anywhere credential source (ADR-0057): read the machine's certificate
 * identity, sign a `CreateSession`, and return the short-lived STS credentials with
 * their `expiration` so the SDK refreshes them before expiry. When the set is in RA
 * mode but the identity is absent or incomplete, raise the actionable
 * "RA identity missing/broken" error (the fifth `credentialCase`) rather than a
 * raw read failure.
 * @returns {Promise<AwsCredentialIdentity>}
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
 * resolution order above: the standard chain, after a set-accepting command's
 * `loadSet` has already merged that set's env file into the environment the chain
 * reads; if it yields nothing, throw an actionable error. Returning a provider (rather than
 * resolving eagerly) lets the SDK cache and refresh expiration-aware credentials
 * itself.
 *
 * @type {AwsCredentialIdentityProvider}
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
