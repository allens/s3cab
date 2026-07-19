import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseEnv } from "node:util";
import { isENOENT, ValidationError } from "./error.mjs";
import { updateEnvFile } from "./env-file.mjs";
import { assertPathSegment, s3cabDir } from "./home.mjs";
import { parseLines } from "./read-lines.mjs";

/** @import { Dirent } from "node:fs" */

// The backup-set store (docs/design/backup.md): one directory per set under
// `~/.s3cab/sets/<name>/`, holding plain-text files a user can read and edit
// directly — `dirs.txt` (member directories, one absolute path per line) and
// `env` (the bound bucket and any per-set auth overrides — a layer in env.mjs's
// env layering). The files are the API: editing a set is opening these files in
// an editor, deleting the directory deletes the set, so this module never caches
// and re-reads from disk on every call.
//
// A set's **name** is its whole identity (ADR-0024): the local handle, the local
// directory name, and the remote namespace, all one `[a-z0-9-]+` string. There is
// no `user@machine` component — `validateSetName` keeps the single name clean as
// handle, path segment, and remote key with zero escaping anywhere downstream.

/** `~/.s3cab/sets` — one directory per backup set. */
const setsRoot = () => join(s3cabDir(), "sets");

/**
 * A set name is interpolated into a path under `~/.s3cab/sets`, so it is guarded
 * as a single path segment (`assertPathSegment`, the shared traversal guard). A
 * *created* set's name is always canonical (see `validateSetName`), but read
 * paths run on caller-supplied names too.
 * @param {string} name
 */
const setDir = (name) => join(setsRoot(), assertPathSegment(name, "set name"));

// The set's on-disk layout — the single place these paths are spelled out.
// Not exported: every consumer reads them off a resolved `BackupSet` (the
// `snapshotsDir`/`excludePath`/`envPath` fields `readSet` derives), so the
// layout never leaks across an import seam.
/** @param {string} name */
const setEnvPath = (name) => join(setDir(name), "env");
/** @param {string} name */
const setDirsPath = (name) => join(setDir(name), "dirs.txt");
/**
 * The set's snapshot store, `~/.s3cab/sets/<name>/snapshots/` — where this set's
 * snapshots live (docs/design/backup.md).
 * @param {string} name
 */
const setSnapshotsDir = (name) => join(setDir(name), "snapshots");
/**
 * The set's optional exclude file, `~/.s3cab/sets/<name>/exclude.txt`. Its glob
 * patterns (guide/exclude.md) apply relative to *each* member directory.
 * @param {string} name
 */
const setExcludePath = (name) => join(setDir(name), "exclude.txt");

/**
 * Read a file's text, or undefined if it doesn't exist.
 * @param {string} path
 */
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isENOENT(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Read a set's local `exclude.txt` verbatim, or `undefined` if it has none —
 * what `setup`/`backup` push to the remote marker and `reattach` writes back. Verbatim
 * (not parsed) because the exclude file is the user's to read and edit, and is
 * stored on the remote byte-for-byte (set-marker.mjs).
 * @param {string} name
 * @returns {string | undefined}
 */
export const readSetExclude = (name) => readTextFile(setExcludePath(name));

/**
 * Write a set's local `exclude.txt` from text — used by `reattach` to recreate
 * the exclude file pulled from the remote marker. Creates the set directory if
 * absent (so it can run before `writeSet` if ever needed).
 * @param {string} name
 * @param {string} text
 */
export function writeSetExclude(name, text) {
  mkdirSync(setDir(name), { recursive: true, mode: 0o700 });
  writeFileSync(setExcludePath(name), text);
}

/**
 * Rewrite a `/`-written glob to the platform's separator, so the starter shows a
 * Windows user the paths they know (`\`) and a POSIX user `/`. Only the pattern
 * *separator* is a display choice — the matcher normalizes either back to `/`
 * internally (exclude.mjs), so this never changes what a pattern matches.
 * @param {string} pattern
 */
const nativePattern = (pattern) => pattern.replaceAll("/", sep);

/**
 * The starter `exclude.txt` a new set is born with (`setup` create only, via
 * `seedStarterExclude` below; reattach reproduces the remote config exactly and
 * never seeds — setup.mjs). The active patterns are "you'd almost never want
 * this backed up": regenerable dependency trees, VCS metadata (`.git` — its
 * working internals churn every commit, and the history normally lives on the
 * remote), and OS metadata/system noise. `.git` is defaulted-out but *disclosed*
 * — `setup` lists every active pattern (setup.mjs), so the skip is visible, not
 * silent, keeping faith with "a backup tool must not silently skip files a user
 * might mean to keep"; genuinely arguable patterns (build output, logs, temp
 * files) still ship commented ([ADR-0050](../../docs/adr/0050-default-exclude-git-with-disclosure.md)).
 *
 * Patterns are written with the **native** separator (`\` on Windows, `/`
 * elsewhere, via `nativePattern`): `exclude.txt` is a public file a user reads
 * and edits, so it speaks the paths they see everywhere else in s3cab — the `/`
 * canonical form is an internal matching detail that stays behind the matcher,
 * not something a Windows user should have to learn ([ADR-0051](../../docs/adr/0051-native-separator-in-user-path-files.md)).
 * The header doubles as the topic's discovery hook: it points at 's3cab help
 * exclude' at the exact moment the user is editing patterns.
 */
export const starterExclude = `# Files and directories this backup set skips — one glob pattern per line.
# '${sep}' separates directories. '**${sep}' matches any depth; a trailing
# '${sep}' matches a directory and everything in it. Blank lines and # comments
# are ignored. Syntax help: 's3cab help exclude'
# Full guide: https://s3cab.plantegral.com/guide/exclude

# Regenerable dependency trees and VCS metadata — huge and/or already on your remote
${nativePattern("**/node_modules/")}
${nativePattern("**/.git/")}

# Operating-system noise (safe to skip on any platform)
${nativePattern("**/.DS_Store")}
${nativePattern("**/Thumbs.db")}
${nativePattern("**/._*")}
${nativePattern("**/desktop.ini")}
${nativePattern("$RECYCLE.BIN/")}
${nativePattern("System Volume Information/")}

# Common suggestions — uncomment any that fit this set
# ${nativePattern("**/dist/")}
# ${nativePattern("**/build/")}
# ${nativePattern("**/coverage/")}
# ${nativePattern("**/__pycache__/")}
# ${nativePattern("**/*.tmp")}
# ${nativePattern("**/*.log")}
`;

/**
 * Seed a set with the starter exclude file, unless it already has one — a
 * hand-written `exclude.txt` (or one racing in from elsewhere) is never
 * clobbered: the write is atomic write-if-absent (`wx`), so the kernel
 * enforces the guarantee rather than a check-then-write racing it.
 * Idempotent; returns whether the starter was written, so the caller can
 * tell the user where the file landed.
 * @param {string} name
 * @returns {boolean} `true` if the starter was written, `false` if the set
 *   already had an exclude file
 */
export function seedStarterExclude(name) {
  mkdirSync(setDir(name), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(setExcludePath(name), starterExclude, { flag: "wx" });
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      return false; // already had one — never clobbered
    }
    throw error;
  }
}

/**
 * Coerce a string to the canonical set-name charset: lowercase `a-z`, `0-9`, `-`
 * — nothing else, so nothing downstream ever needs escaping. Lowercase; every
 * other run of characters becomes one `-`; leading/trailing `-` trimmed. Used to
 * build `validateSetName`'s "Try: …" suggestion — a hint shown alongside the
 * rejection, never to silently rewrite a value the user must live with.
 * @param {string} part
 */
export const sanitizeNamePart = (part) =>
  part
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

/**
 * Validate a user-chosen set name against the canonical charset — a name is
 * valid exactly when it is its own sanitized form. Unlike the captured parts,
 * a set name is user-chosen, so a non-conforming one is rejected with the rule
 * and a suggested form rather than silently normalized (teach the rule).
 * @param {string} name
 */
export function validateSetName(name) {
  const suggestion = sanitizeNamePart(name);
  if (suggestion === name && name.length > 0) {
    return;
  }
  throw new ValidationError(
    `Invalid set name: ${name}\n` +
      `Set names use lowercase letters, digits, and hyphens only (a-z, 0-9, -).` +
      (suggestion ? `\nTry: ${suggestion}` : ""),
  );
}

/**
 * Validate a user-supplied bucket name when a set is created — a fail-fast guard
 * against the two natural mistakes (deferred from PR #33): pasting an `s3://`
 * URL, or a path/prefix rather than a bare bucket. One s3cab repository is one
 * whole bucket (CLAUDE.md), so the name must be a single segment.
 *
 * Deliberately *not* full AWS bucket-naming validation (length, charset, no
 * IP-form, …): s3cab also targets non-AWS S3 providers (R2/B2/…) whose rules
 * differ, so an over-strict check would reject valid names (#8). The provider
 * rejects a truly malformed name at first use with its own error.
 *
 * A caller that *does* have provider-specific limits passes them as options —
 * `aws` sets `allowDots: false` and a `maxLength` because it derives named
 * CloudFormation/IAM resources from the bucket. The checks stay provider-neutral
 * (the message states the constraint, not why); the caller owns the "why".
 * @param {string} bucket
 * @param {{ allowDots?: boolean, maxLength?: number }} [options]
 */
export function validateBucketName(
  bucket,
  { allowDots = true, maxLength = Infinity } = {},
) {
  if (bucket === "") {
    throw new ValidationError(
      `No bucket name given. ` +
        `Pass a plain S3 bucket name, e.g. --bucket my-backup-bucket.`,
    );
  }
  if (/:\/\//.test(bucket)) {
    throw new ValidationError(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name, not a URL ` +
        `(e.g. 'my-backup-bucket', not 's3://my-backup-bucket').`,
    );
  }
  if (bucket.includes("/") || bucket.includes("\\")) {
    throw new ValidationError(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name — a single segment, not a path or prefix.`,
    );
  }
  if (bucket.trim() !== bucket) {
    throw new ValidationError(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name with no surrounding whitespace.`,
    );
  }
  if (!allowDots && bucket.includes(".")) {
    throw new ValidationError(
      `Invalid bucket name: ${bucket}\n` +
        `Give a bucket name without dots, e.g. ${bucket.replaceAll(".", "-")}.`,
    );
  }
  if (bucket.length > maxLength) {
    throw new ValidationError(
      `Invalid bucket name: ${bucket}\n` +
        `Give a bucket name of ${maxLength} characters or fewer (this is ${bucket.length}).`,
    );
  }
}

/** The names of all backup sets (the directories under `~/.s3cab/sets`), sorted. */
export function listSets() {
  /** @type {Dirent[]} */
  let entries;
  try {
    entries = readdirSync(setsRoot(), { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * A subset of a set's fields — what a listing needs (`formatSets`), and the
 * structural shape a full `BackupSet` also satisfies. Typed narrowly so callers
 * that only summarize a set don't depend on its derived paths.
 * @typedef {Object} SetSummary
 * @property {string} name
 * @property {string[]} dirs
 * @property {string} bucket
 */

/**
 * A resolved backup set: its stored config (`name`/`dirs`/`bucket`) plus the
 * on-disk locations derived from its name. The path fields are the set module's
 * one window onto the layout — consumers read them instead of rebuilding paths,
 * so `~/.s3cab/sets/<name>/…` lives in exactly one place (see `setSnapshotsDir`
 * and friends above).
 * @typedef {Object} BackupSet
 * @property {string} name - The local handle, local directory name, and remote namespace — one `[a-z0-9-]+` string (ADR-0024)
 * @property {string[]} dirs - Member directories (absolute paths, from `dirs.txt`)
 * @property {string} bucket - The bound S3 bucket (`S3CAB_BUCKET` in the set's env). Every set is bound at creation (ADR-0026), so this is never absent — `readSet` enforces it.
 * @property {string} dir - The set's own directory, `~/.s3cab/sets/<name>/` (derived from `name`) — for state that belongs to the set but has no dedicated field, e.g. `forget`'s audit records
 * @property {string} snapshotsDir - The set's snapshot store, `~/.s3cab/sets/<name>/snapshots/` (derived from `name`)
 * @property {string} dirsPath - The set's member-directories file, `~/.s3cab/sets/<name>/dirs.txt` (derived from `name`)
 * @property {string} excludePath - The set's exclude file, `~/.s3cab/sets/<name>/exclude.txt` (derived from `name`)
 * @property {string} envPath - The set's env file, `~/.s3cab/sets/<name>/env` (derived from `name`)
 */

/**
 * Read one set's configuration from its directory.
 *
 * Every set is bound to a bucket at creation (ADR-0026), so this is the single
 * point that enforces the invariant: a set directory whose `env` is missing
 * `S3CAB_BUCKET` is *corrupt* (hand-edited, or a pre-redesign local-only directory),
 * not a supported "local-only" set, and is rejected here. Guaranteeing the bucket
 * at the one place a `BackupSet` is built from disk is what lets `bucket` be a
 * plain `string` for every consumer — and is why the old two-tier
 * `resolveRemoteSet` resolver could fold back into `resolveSet`.
 * @param {string} name
 * @returns {BackupSet}
 */
export function readSet(name) {
  const names = listSets();
  if (!names.includes(name)) {
    throw new Error(
      `Unknown backup set: ${name}\n\n` +
        (names.length
          ? `Available sets:\n\n${formatSets(names.map(readSet))}`
          : NO_SETS_MESSAGE),
    );
  }
  const dirs = parseLines(readTextFile(setDirsPath(name)) ?? "");
  const envText = readTextFile(setEnvPath(name));
  const env = envText === undefined ? {} : parseEnv(envText);
  const bucket = env.S3CAB_BUCKET;
  if (!bucket) {
    throw new Error(
      `Backup set '${name}' has no bucket to back up to ` +
        `(no S3CAB_BUCKET in ${setEnvPath(name)}).\n` +
        `To fix it, add 'S3CAB_BUCKET=<bucket>' to that file — or remove the set ` +
        `directory and create it again:\n` +
        `  s3cab setup --set ${name} --bucket <bucket> <directory>...`,
    );
  }
  return {
    name,
    dirs,
    bucket,
    dir: setDir(name),
    snapshotsDir: setSnapshotsDir(name),
    dirsPath: setDirsPath(name),
    excludePath: setExcludePath(name),
    envPath: setEnvPath(name),
  };
}

/**
 * The shared "you have no sets yet" guidance — a complete, copy-pasteable next
 * step (ADR-0030). Exported so `list`'s empty case prints the same words, since
 * the two messages had drifted ("configured." vs "yet."). `--bucket` is included
 * because `setup` requires it (ADR-0026): omitting it dead-ended a first-timer at
 * `Missing required argument: -b, --bucket`.
 */
export const NO_SETS_MESSAGE =
  "No backup sets yet.\nCreate one with: s3cab setup --set <set> --bucket <bucket> <directory>...";

/**
 * Resolve which set a command operates on: a given name, or — per the
 * set-first CLI surface — the only set when exactly one exists, so plain
 * `s3cab backup` just works after setup. Anything else errors, listing the
 * sets to choose from.
 *
 * Every set is bound to a bucket at setup (ADR-0026), enforced by `readSet`, so
 * a resolved set is already cloud-ready — there is no second "has a bucket?"
 * resolver tier. This is the env-free inner resolver: commands reach a set
 * through `loadSet` (env.mjs), which wraps this and applies the set's env layer
 * over the ambient shell (ADR-0022/0055 — the one s3cab layer).
 * @param {string} [name]
 * @returns {BackupSet}
 */
export function resolveSet(name) {
  if (name) {
    return readSet(name);
  }
  const names = listSets();
  const [only] = names;
  if (names.length === 1 && only) {
    return readSet(only);
  }
  if (names.length === 0) {
    throw new Error(NO_SETS_MESSAGE);
  }
  throw new Error(
    `Several backup sets exist — name one:\n\n${formatSets(names.map(readSet))}`,
  );
}

/**
 * Format sets as the human-readable listing the `list` command prints — also
 * the body of resolveSet's several-sets error, so the error shows exactly what
 * the command would.
 * @param {SetSummary[]} sets
 */
export function formatSets(sets) {
  const nameColumn = Math.max(...sets.map(({ name }) => name.length)) + 3;
  const lines = [];
  for (const { name, dirs, bucket } of sets) {
    const count = `(${dirs.length} ${dirs.length === 1 ? "directory" : "directories"})`;
    lines.push(name.padEnd(nameColumn) + `→ s3://${bucket}   ${count}`);
    for (const dir of dirs) {
      lines.push(" ".repeat(nameColumn) + dir);
    }
  }
  return lines.join("\n");
}

/**
 * Create or update a set: write `dirs.txt` when dirs are given, and bind the
 * bucket when given. Member dirs are stored as passed — resolving/validating
 * them is the `setup` command's job. The set's identity is just its `name`
 * (ADR-0024), so there is nothing to pin: creating and updating run the same path.
 * @param {string} name - A valid set name (see `validateSetName`)
 * @param {object} [pieces]
 * @param {string[]} [pieces.dirs] - Member directories (absolute paths)
 * @param {string} [pieces.bucket] - The S3 bucket to bind
 * @returns {BackupSet} The set as stored after the write
 */
export function writeSet(name, { dirs, bucket } = {}) {
  // Owner-only (applied to ~/.s3cab too when this creates it recursively): the
  // set's env file may carry secrets (see lib/env-file.mjs).
  mkdirSync(setDir(name), { recursive: true, mode: 0o700 });

  if (dirs?.length) {
    writeFileSync(setDirsPath(name), dirs.join("\n") + "\n");
  }

  if (bucket) {
    updateEnvFile(setEnvPath(name), { S3CAB_BUCKET: bucket });
  }

  return readSet(name);
}
