import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { s3cabDir } from "./home.mjs";
import { parseEnv } from "node:util";
import { isENOENT } from "./error.mjs";
import { setEnvPath } from "./sets.mjs";

// AWS authentication / credential resolution. This is the single source of truth
// for *how* s3cab obtains AWS credentials; the S3 SDK boundary (`src/lib/s3.mjs`)
// hands `resolveCredentials` to its client. The model is specified in
// specs/auth.md. Resolution order:
//
//   0. load s3cab's layered env files if present (see `loadEnv`) — an explicit
//      user signal that may carry AWS_* vars, a profile, an endpoint, a bucket
//   1. the standard AWS SDK credential chain (env, SSO/token cache, shared
//      config/credentials, web identity, instance metadata, …)
//   2. otherwise, stop with a clear, actionable error
//
// s3cab never writes ~/.aws/config or ~/.aws/credentials — that stays user-owned.
// Interactive SSO sign-in is deliberately *not* s3cab's job: `aws sso login`
// (or any other tool that feeds the standard chain) handles it, and s3cab picks
// the session up via step 1.

// ── Environment-file loading ───────────────────────────────────────────────
//
// s3cab reads its own layered env files into process.env before any AWS client
// is built — never the cwd `.env`, and never `~/.aws/*`. This lets AWS_* vars, a
// profile, a custom endpoint, or a default bucket be configured per-user,
// per-bucket, or per-backup-set. The layers, highest precedence first:
//
//   set    ~/.s3cab/sets/<set>/env  per-backup-set — which bucket this set backs
//                                  up to (S3CAB_BUCKET, written by `setup`), the
//                                  pinned namespace + any per-set override
//   bucket ~/.s3cab/env.<bucket>  per-bucket — how to authenticate to a bucket
//                                  (AWS_PROFILE / region / endpoint / keys); the
//                                  bucket is the natural auth boundary
//   user   ~/.s3cab/env           per-user defaults
//   shell  process.env            the real environment (lowest — files win)
//
// Files are authoritative over the shell: a value you put in a file always wins.
// Parsed with the built-in `util.parseEnv` — no dotenv dep (#5) — so the per-key
// precedence above is enforced by *us*, independent of any one loader's fixed
// override semantics. The per-bucket file can't name its own bucket (circular):
// the bucket is resolved from an explicit name or the set/user/shell layers
// first, then its env file is loaded.

const userEnvPath = () => join(s3cabDir(), "env");
/**
 * The per-bucket env file `~/.s3cab/env.<bucket>`. The bucket name must be a
 * single path segment — it is interpolated into the filename — so reject one
 * carrying a path separator: otherwise a hostile set env's `S3CAB_BUCKET`
 * (e.g. `a/../../../etc/passwd`) could traverse out of `~/.s3cab` and make
 * `loadEnv` read an arbitrary file. `basename` uses the same platform path
 * semantics as the `join` below, so it catches exactly the separators that could
 * traverse here; a clean single-segment name is its own basename (dots are fine).
 * @param {string} bucket
 */
const bucketEnvPath = (bucket) => {
  if (basename(bucket) !== bucket) {
    throw new Error(
      `Invalid bucket name (contains a path separator): ${bucket}`,
    );
  }
  return join(s3cabDir(), `env.${bucket}`);
};

/**
 * Parse an env file into a plain object, or `{}` if it doesn't exist. Synchronous
 * because `loadEnv` runs on the synchronous client-construction path.
 * @param {string} path
 * @returns {NodeJS.Dict<string>}
 */
function parseEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (isENOENT(error)) return {};
    throw error;
  }
}

/** Absolute paths of env files already merged into process.env this run. */
const appliedEnvFiles = new Set();

/**
 * Merge one parsed env layer into process.env, once. Skipping an already-applied
 * file is what keeps precedence correct across multiple `loadEnv` calls: a later
 * call must not re-apply a lower layer over a higher one set by an earlier call.
 *
 * A missing/empty file (`{}`) is *not* recorded as applied — there was nothing to
 * apply, so a file created later in the same process (e.g. by a future `setup`)
 * still loads on a subsequent call instead of being skipped forever.
 * @param {string} path
 * @param {NodeJS.Dict<string>} values
 */
function applyEnvLayer(path, values) {
  if (appliedEnvFiles.has(path)) return;
  if (Object.keys(values).length === 0) return;
  appliedEnvFiles.add(path);
  Object.assign(process.env, values);
}

/**
 * Load s3cab's layered env files into process.env (see the layer table above).
 * Must run before any AWS client is built so the resolved AWS_* / endpoint /
 * region values are in place. Idempotent per file.
 *
 * Called with no scope it applies only the per-user layer; the per-bucket file is
 * loaded only when there is an authoritative bucket — an explicit name, or one
 * resolved from a backup set — so a no-scope call never pulls in some default
 * bucket's auth file by accident.
 *
 * @param {object} [scope]
 * @param {string} [scope.set] - A backup set name, enabling its `~/.s3cab/sets/<set>/env`.
 * @param {string} [scope.bucket] - A known bucket name (e.g. a CLI `<bucket>` arg),
 *   used to load `~/.s3cab/env.<bucket>` directly instead of deriving it.
 * @returns {{ bucket: string | undefined }} The bucket this scope resolves to, if any.
 */
export function loadEnv({ set, bucket } = {}) {
  const user = parseEnvFile(userEnvPath());
  // setEnvPath guards against a name carrying a path separator, so a hostile
  // set name can't point this read outside ~/.s3cab/sets.
  const setPath = set ? setEnvPath(set) : undefined;
  const setLayer = setPath ? parseEnvFile(setPath) : {};

  // Apply the user layer first so higher layers (bucket, then set) overwrite it.
  applyEnvLayer(userEnvPath(), user);

  // Resolve the operation's bucket only from authoritative signals — an explicit
  // name or a backup set. A bare user/shell S3CAB_BUCKET default is not enough to
  // justify loading a specific bucket's auth file from a no-scope safety call.
  let resolvedBucket = bucket;
  if (!resolvedBucket && set) {
    resolvedBucket =
      setLayer.S3CAB_BUCKET ?? user.S3CAB_BUCKET ?? process.env.S3CAB_BUCKET;
  }

  if (resolvedBucket) {
    const path = bucketEnvPath(resolvedBucket);
    applyEnvLayer(path, parseEnvFile(path));
  }
  if (setPath) applyEnvLayer(setPath, setLayer);

  return { bucket: resolvedBucket };
}

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
