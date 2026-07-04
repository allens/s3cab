import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { s3cabDir } from "./home.mjs";
import { isENOENT } from "./error.mjs";
import { resolveSet } from "./sets.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// s3cab's layered environment-file loading — *what configuration applies* (the
// set's bucket, region, endpoint, profile), distinct from *how credentials are
// obtained* (the standard AWS chain in src/lib/auth.mjs). The layer model —
// set > user > shell, a file value always beating the shell, never the cwd
// `.env`, never `~/.aws/*` — is specified in docs/design/auth.md; this module
// implements it. Files are parsed with the built-in `util.parseEnv` (no dotenv
// dep, ADR-0005), so the per-key precedence is enforced by *us*, independent of
// any one loader's fixed override semantics.
//
// Two doors apply the layers (ADR-0022):
//   loadEnv()       applies the *user* layer (~/.s3cab/env). The CLI entry point
//                   (s3cab.mjs) calls it once before dispatching, and a library
//                   consumer calls it once up front — commands never call it.
//   loadSet(name)   resolves a set *and* applies its *set* layer
//                   (~/.s3cab/sets/<set>/env) on top. Every command that takes
//                   a set argument routes through it.
// Because the user layer went on first, `loadSet` only adds the set layer and
// precedence (set > user) holds by construction — no per-command "load env
// before S3" guard. `loadEnv` also drops the `__S3CAB_ENV_LOADED` breadcrumb
// that `s3.mjs`'s `client()` asserts — a development tripwire catching a lib
// consumer who forgot the call, not load-bearing for correct use (ADR-0022).

/**
 * The per-user env file, `~/.s3cab/env` — the one place this path is spelled, so
 * the `aws` command writes/reads exactly the file `loadEnv` applies.
 */
export const userEnvPath = () => join(s3cabDir(), "env");

/**
 * Parse an env file into a plain object, or `{}` if it doesn't exist. Synchronous
 * because `loadEnv` runs on the synchronous client-construction path. Exported so
 * the `aws` command's get-mode can read a single scope's file (the value set
 * *there*, before layering).
 * @param {string} path
 * @returns {NodeJS.Dict<string>}
 */
export function parseEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (isENOENT(error)) {
      return {};
    }
    throw error;
  }
}

/** Absolute paths of env files already merged into process.env this run. */
const appliedEnvFiles = new Set();

/**
 * Read one env file and merge its layer into process.env, once. Skipping an
 * already-applied file keeps precedence correct across the user/set loads (a
 * later call must not re-apply a lower layer over a higher one) — and, since the
 * guard is checked *before* the read, also avoids re-parsing the file on a repeat
 * call (e.g. `backup` → `loadSet`, then its `snapshot` → `loadSet` again).
 *
 * A missing/empty file (`{}`) is *not* recorded as applied — there was nothing to
 * apply, so a file created later in the same process (e.g. by `setup`)
 * still loads on a subsequent call instead of being skipped forever.
 * @param {string} path
 */
function applyEnvLayer(path) {
  if (appliedEnvFiles.has(path)) {
    return;
  }
  const values = parseEnvFile(path);
  if (Object.keys(values).length === 0) {
    return;
  }
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
  applyEnvLayer(userEnvPath());
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
  applyEnvLayer(set.envPath);
  return set;
}
