import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { assertPathSegment, s3cabDir } from "./home.mjs";
import { isENOENT } from "./error.mjs";
import { setEnvPath } from "./sets.mjs";

// s3cab's layered environment-file loading. This is the single source of truth
// for *what configuration applies* to an operation — which bucket, region,
// endpoint, profile, or default bucket — distinct from *how credentials are
// obtained* (the standard AWS chain in src/lib/auth.mjs). The model is
// specified in specs/auth.md.
//
// s3cab reads its own env files into process.env before any AWS client is
// built — never the cwd `.env`, and never `~/.aws/*`. This lets AWS_* vars, a
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
 * The per-bucket env file `~/.s3cab/env.<bucket>`. The bucket name is
 * interpolated into the filename, so it is guarded as a single path segment —
 * otherwise a hostile set env's `S3CAB_BUCKET` (e.g. `a/../../../etc/passwd`)
 * could traverse out of `~/.s3cab` and make `loadEnv` read an arbitrary file
 * (see `assertPathSegment`).
 * @param {string} bucket
 */
const bucketEnvPath = (bucket) =>
  join(s3cabDir(), `env.${assertPathSegment(bucket, "bucket name")}`);

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
