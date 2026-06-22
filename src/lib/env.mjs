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
//
// Two doors apply these layers (ADR-0022):
//   loadEnv()       applies the *user* layer. The CLI entry point (s3cab.mjs)
//                   calls it once before dispatching any command, and a library
//                   consumer calls it once before using the API — so the user
//                   layer is always already in process.env. Commands don't call it.
//   loadSet(name)   resolves a set *and* applies its *set* layer on top. Every
//                   command that takes a set argument routes through it.
// Because the user layer is loaded up front, `loadSet` only adds the set layer —
// precedence (set > user) still holds because user went on first. The old
// "load env before any S3 op" precondition is thereby satisfied by construction,
// not enforced per command. `loadEnv` also drops an ambient `__S3CAB_ENV_LOADED`
// breadcrumb on process.env that `s3.mjs`'s `client()` asserts — a development
// tripwire catching a lib consumer who forgot to call `loadEnv`, not load-bearing
// for correct use (ADR-0022).

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
 * file keeps precedence correct across the user/set loads: a later call must not
 * re-apply a lower layer over a higher one set by an earlier call.
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
 * Apply the per-**user** env layer (`~/.s3cab/env`) to process.env. This is the
 * single up-front load: the CLI entry point (src/s3cab.mjs) calls it once before
 * dispatching any command, and a library consumer calls it once before using the
 * API. **Commands do not call it** — the entry point has already run it by the
 * time any command body executes.
 *
 * Loading env files only reads small files into process.env; it does *not* build
 * an AWS client (that stays lazy in s3.mjs), so calling this up front does not
 * force credentials on the local commands. Idempotent per file.
 *
 * Set env is applied separately, by {@link loadSet}, so this takes no set.
 */
export function loadEnv() {
  const userPath = userEnvPath();
  applyEnvLayer(userPath, parseEnvFile(userPath));
  // Drop the development tripwire `s3.mjs`'s `client()` asserts (ADR-0022) —
  // unconditionally, so an absent/empty user file (nothing applied) still counts:
  // "loadEnv ran", not "a file existed", is the precondition. `__`-prefixed: an
  // internal debug flag, not a real config var.
  process.env.__S3CAB_ENV_LOADED = "1";
}

/**
 * Resolve a backup set *and* apply its env layer — the door every set-accepting
 * command routes through. `resolveSet` (sets.mjs) picks the set (sole-set
 * default), then this applies that set's `~/.s3cab/sets/<set>/env` on top.
 *
 * Only the *set* layer is applied here: the user layer is already in process.env
 * (loaded at the entry point, or by a consumer's one-call contract), so precedence
 * (set > user) holds because user went on first. Re-applying the user layer would
 * just be the redundant guard this design removes.
 *
 * Reading the set env file is not an AWS client build, so routing the local
 * commands (`snapshot`/`compare`/`tree`/`list`) through this keeps them cred-free
 * — they still never construct a client (see docs/adr/0022).
 * @param {string} [setName] - Backup set (default: the only set)
 * @returns {BackupSet}
 */
export function loadSet(setName) {
  const set = resolveSet(setName);
  applyEnvLayer(set.envPath, parseEnvFile(set.envPath));
  return set;
}
