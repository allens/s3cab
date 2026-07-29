import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { isENOENT } from "./error.mjs";
import { s3cabDir } from "./home.mjs";
import { resolveSet } from "./sets.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// s3cab's environment-file loading — *what configuration applies* (the set's
// bucket, region, endpoint, profile), distinct from *how credentials are
// obtained* (the standard AWS chain in src/lib/auth.mjs). There is one s3cab
// layer: a set's own env file, applied over the ambient shell (set > shell, a
// file value always beating the shell, never the cwd `.env`, never `~/.aws/*`) —
// specified in docs/design/auth.md; this module implements it. The machine-wide
// default is the ambient AWS setup itself (~/.aws, a default profile, exported
// AWS_*), not a parallel s3cab file — ADR-0055 dropped the former per-user layer
// as a mechanism competing with the standard chain (ADR-0015). Files are parsed
// with the built-in `util.parseEnv` (no dotenv dep, ADR-0005), so the
// set-over-shell precedence is enforced by *us*.
//
// Two doors (ADR-0022):
//   loadEnv()       marks the environment initialized — the `__S3CAB_ENV_LOADED`
//                   breadcrumb `s3.mjs`'s `client()` asserts, a development
//                   tripwire catching a lib consumer who forgot the up-front
//                   call. The CLI entry point (s3cab.mjs) calls it once before
//                   dispatching; a library consumer calls it once up front;
//                   commands never call it. With the user layer gone it loads no
//                   file — only the set layer carries s3cab config now.
//   loadSet(name)   resolves a set *and* applies its *set* layer
//                   (~/.s3cab/sets/<set>/env) over the ambient shell. Every
//                   command that takes a set argument routes through it.

/**
 * The custom S3 endpoint, if one is configured — present for any S3-compatible
 * provider that isn't AWS (Cloudflare R2, Backblaze B2, MinIO, Wasabi, …). Its
 * presence is the single `targets-AWS?` signal: a set endpoint means "not AWS",
 * which gates the AWS-only behaviours (region redirects, storage class, SSE —
 * `s3.mjs`) and routes onboarding/guidance (`aws`, `credentialGuidance`).
 *
 * Honours the SDK-native `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` variables
 * rather than inventing new surface (ADR-0005/0006); `provider --endpoint`
 * writes the specific `_S3` form (ADR-0047). Lives here — the env module — so
 * every reader shares one spelling of the fallback chain.
 * @param {NodeJS.Dict<string>} [env] - The variables to read: the process
 *   environment by default (the *effective*, post-layering view), or a
 *   `parseEnvFile` dict to ask about one layer in isolation.
 * @returns {string | undefined}
 */
export const customEndpoint = (env = process.env) =>
  env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;

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
 * The set `loadSet` most recently resolved (its name + env-file path), or
 * `undefined` if no set command ran this invocation — e.g. `upload --bucket`
 * resolves no set. Lets the credential error (auth.mjs's `noCredentialsError`)
 * name the set and point at its env file, without threading the set down through
 * the SDK client that calls `resolveCredentials`. Last-writer-wins, like the env
 * layering itself; a single CLI command resolves at most one set.
 * @type {{ name: string, envPath: string } | undefined}
 */
let _loadedSet;

/** The set whose env layer is loaded (name + env-file path), for error messages
 * that name it; `undefined` when no set command ran (see {@link _loadedSet}). */
export const loadedSet = () => _loadedSet;

/**
 * Which env layer last set each key: variable name → human label
 * (`set 'photos' config`). A key present in process.env but *absent* here came
 * from outside s3cab's layering — a shell export, a Node `--env-file`, the parent
 * process — which is exactly what `profileSource` reports as "your environment".
 * Module-level like `appliedEnvFiles`: the set layer is applied over the shell,
 * last writer wins, matching the effective process.env value.
 * @type {Map<string, string>}
 */
const envSources = new Map();

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
 * @param {string} label - Where this layer's values came from, for `profileSource`.
 */
function applyEnvLayer(path, label) {
  if (appliedEnvFiles.has(path)) {
    return;
  }
  const values = parseEnvFile(path);
  if (Object.keys(values).length === 0) {
    return;
  }
  appliedEnvFiles.add(path);
  Object.assign(process.env, values);
  for (const key of Object.keys(values)) {
    envSources.set(key, label);
  }
}

/**
 * Where the effective `AWS_PROFILE` came from — a set's config (the label
 * `envSources` recorded), or "your environment" for anything s3cab didn't set
 * itself: a shell export, a Node `--env-file`, the parent process, all
 * indistinguishable once merged into process.env before we ran. `undefined` when
 * no profile is set at all.
 *
 * Feeds the auth notice (`authNotice` in s3.mjs), so a surprising profile — a stale
 * shell export shadowing a set's config, say — is traceable at a glance instead of
 * a silent mystery.
 * @returns {string | undefined}
 */
export function profileSource() {
  if (!process.env.AWS_PROFILE) {
    return undefined;
  }
  return envSources.get("AWS_PROFILE") ?? "your environment";
}

/**
 * Mark the environment initialized. The CLI entry point (src/s3cab.mjs) calls it
 * once before dispatching any command, and a library consumer calls it once
 * before using the API. **Commands do not call it** — the entry point has already
 * run it by the time any command body executes.
 *
 * With the per-user layer gone (ADR-0055) it loads no file: only a set's env
 * layer carries s3cab config, applied by {@link loadSet}. All it does now is drop
 * the `__S3CAB_ENV_LOADED` breadcrumb `s3.mjs`'s `client()` asserts — a
 * development tripwire that the up-front init ran before any S3 op, catching a lib
 * consumer who skipped it (ADR-0022). `__`-prefixed: an internal flag, not a
 * config var.
 */
export function loadEnv() {
  process.env.__S3CAB_ENV_LOADED = "1";
}

/**
 * Resolve a backup set *and* apply its env layer — the door every set-accepting
 * command routes through. `resolveSet` (sets.mjs) picks the set (sole-set
 * default), then this applies that set's `~/.s3cab/sets/<set>/env` over the
 * ambient shell (set > shell — the one s3cab layer, ADR-0055).
 *
 * Reading the set env file is not an AWS client build, so routing the local
 * commands (`snapshot`/`compare`/`tree`/`list`) through this keeps them cred-free
 * — they still never construct a client (see docs/adr/0022).
 * @param {string} [setName] - Backup set (default: the only set)
 * @returns {BackupSet}
 */
export function loadSet(setName) {
  const set = resolveSet(setName);
  announceHome();
  _loadedSet = { name: set.name, envPath: set.envPath };
  applyEnvLayer(set.envPath, `set '${set.name}' config`);
  return set;
}

/** Whether {@link announceHome} has already run this invocation. */
let homeAnnounced = false;

/**
 * Name s3cab's home directory once per run, in full.
 *
 * Two jobs. It is the **absolute** counterpart to the `~` every other path is
 * shortened to (`tildeify`, home.mjs): `~` expands in PowerShell and in a POSIX
 * shell but *not* in `cmd.exe`, where the only way back to a real path is to
 * paste this line and the shortened remainder together. And when `S3CAB_HOME` is
 * overridden, nothing else on screen says which state directory is live.
 *
 * Here rather than in `loadEnv` because that runs for every command, including
 * `--help` and `--version`, which touch no state and print no paths. `loadSet` is
 * the door every *set* command routes through (ADR-0022) — and it can run twice
 * in one invocation (a porcelain command and the plumbing it composes), hence the
 * flag.
 */
function announceHome() {
  if (homeAnnounced) {
    return;
  }
  homeAnnounced = true;
  console.warn("Using s3cab home", `'${s3cabDir()}'`);
}
