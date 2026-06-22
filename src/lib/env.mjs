import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { s3cabDir } from "./home.mjs";
import { isENOENT } from "./error.mjs";
import { resolveSet } from "./sets.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// s3cab's layered environment-file loading. This is the single source of truth
// for *what configuration applies* to an operation — which bucket, region,
// endpoint, profile, or default bucket — distinct from *how credentials are
// obtained* (the standard AWS chain in src/lib/auth.mjs). The model is
// specified in docs/specs/auth.md.
//
// s3cab reads its own env files into process.env before any AWS client is
// built — never the cwd `.env`, and never `~/.aws/*`. This lets AWS_* vars, a
// profile, a custom endpoint, or a default bucket be configured per-user or
// per-backup-set. The layers, highest precedence first:
//
//   set   ~/.s3cab/sets/<set>/env  per-backup-set — which bucket this set backs
//                                  up to (S3CAB_BUCKET, written by `setup`) + any
//                                  per-set auth override
//   user  ~/.s3cab/env            per-user defaults (auth for the common
//                                  single-bucket case lives here)
//   shell process.env             the real environment (lowest — files win)
//
// Files are authoritative over the shell: a value you put in a file always wins.
// Parsed with the built-in `util.parseEnv` — no dotenv dep (#5) — so the per-key
// precedence above is enforced by *us*, independent of any one loader's fixed
// override semantics.

const userEnvPath = () => join(s3cabDir(), "env");

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
 * Called with no set it applies only the per-user layer; pass a resolved set to
 * also apply its higher-precedence `~/.s3cab/sets/<set>/env`. The set carries
 * its own `envPath` (sets.mjs owns the layout), so this module no longer builds
 * any set path — it just layers the user file (its own) and, when given, the
 * set file at the location the set reports.
 *
 * Typed to the one field it reads (`envPath`) rather than the whole `BackupSet`,
 * so it asks for exactly what it uses — a full set satisfies it structurally
 * (every caller passes one), and a unit test can exercise the layering with a
 * bare `{ envPath }` without standing up a bucket-bound set.
 *
 * @param {{ envPath: string }} [set] - A resolved backup set (only its `envPath` is read).
 */
export function loadEnv(set) {
  // Apply the user layer first so the set layer (higher precedence) overwrites it.
  const userPath = userEnvPath();
  applyEnvLayer(userPath, parseEnvFile(userPath));

  if (set) {
    applyEnvLayer(set.envPath, parseEnvFile(set.envPath));
  }
}

/**
 * Resolve a backup set *and* load its env — the single front door for the
 * commands that touch a set's remote (`backup`, `status`, `restore`,
 * `list --remote`). `resolveSet` (sets.mjs) picks the set (sole-set default),
 * and — since every set is bound to a bucket at setup (ADR-0026) — the resolved
 * set is already cloud-ready; this then loads that set's env layer, so the AWS
 * client picks up the right region/credentials/endpoint.
 *
 * The "load env before any S3 op" precondition lives here, once, instead of
 * being hand-coded at each command (see docs/adr/0022). It is consolidated, not
 * type-enforced: the helper is *called by* each command (so the command stays
 * the library surface), and loading env is a `process.env` side effect — the
 * returned set is a plain `BackupSet`, not a token proving env was loaded.
 * @param {string} [setName] - Backup set (default: the only set)
 * @returns {BackupSet}
 */
export function prepareRemoteSet(setName) {
  const set = resolveSet(setName);
  loadEnv(set);
  return set;
}
