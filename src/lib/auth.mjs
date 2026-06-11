import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseEnv } from "node:util";

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
// per-bucket, or per-backup-folder. The layers, highest precedence first:
//
//   dir    <dir>/.s3cab/env       per-backup-folder — which bucket this folder
//                                  backs up to (S3CAB_BUCKET) + any local override
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
// the bucket is resolved from an explicit name or the dir/user/shell layers
// first, then its env file is loaded.

/** s3cab's own config/state dir, `~/.s3cab` (never `~/.aws`, which stays user-owned). */
const s3cabDir = () => join(homedir(), ".s3cab");
const userEnvPath = () => join(s3cabDir(), "env");
/**
 * The per-bucket env file `~/.s3cab/env.<bucket>`. The bucket name must be a
 * single path segment — it is interpolated into the filename — so reject one
 * carrying a path separator: otherwise a hostile folder env's `S3CAB_BUCKET`
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
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return {};
    }
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
 * resolved from a backup dir — so a no-scope call never pulls in some default
 * bucket's auth file by accident.
 *
 * @param {object} [scope]
 * @param {string} [scope.dir] - A backup directory, enabling its `<dir>/.s3cab/env`.
 * @param {string} [scope.bucket] - A known bucket name (e.g. a CLI `<bucket>` arg),
 *   used to load `~/.s3cab/env.<bucket>` directly instead of deriving it.
 * @returns {{ bucket: string | undefined }} The bucket this scope resolves to, if any.
 */
export function loadEnv({ dir, bucket } = {}) {
  const user = parseEnvFile(userEnvPath());
  // resolve() (not join()) so the guard key is canonical/absolute even when a
  // caller passes a relative dir — keeps the dedup robust and the comment honest.
  const folderPath = dir ? resolve(dir, ".s3cab", "env") : undefined;
  const folder = folderPath ? parseEnvFile(folderPath) : {};

  // Apply the user layer first so higher layers (bucket, then dir) overwrite it.
  applyEnvLayer(userEnvPath(), user);

  // Resolve the operation's bucket only from authoritative signals — an explicit
  // name or a backup dir. A bare user/shell S3CAB_BUCKET default is not enough to
  // justify loading a specific bucket's auth file from a no-scope safety call.
  let resolvedBucket = bucket;
  if (!resolvedBucket && dir) {
    resolvedBucket =
      folder.S3CAB_BUCKET ?? user.S3CAB_BUCKET ?? process.env.S3CAB_BUCKET;
  }

  if (resolvedBucket) {
    const path = bucketEnvPath(resolvedBucket);
    applyEnvLayer(path, parseEnvFile(path));
  }
  if (folderPath) applyEnvLayer(folderPath, folder);

  return { bucket: resolvedBucket };
}

const NO_CREDENTIALS_MESSAGE = `No AWS credentials found.

s3cab tried:
  1. s3cab env files / environment variables
  2. Standard AWS SDK credential resolution

To continue, do one of the following:
  - create ~/.s3cab/env with AWS_* variables (or AWS_PROFILE)
  - use an existing AWS profile and set AWS_PROFILE
    (for AWS IAM Identity Center, run \`aws sso login\` first —
    s3cab picks the session up automatically)

Run 's3cab help auth' for details.`;

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
    throw new Error(NO_CREDENTIALS_MESSAGE, { cause: error });
  }
};
