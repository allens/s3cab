import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { isENOENT } from "./error.mjs";
import { assertPathSegment, s3cabDir } from "./home.mjs";

// The backup-set store (docs/specs/backup.md): one folder per set under
// `~/.s3cab/sets/<name>/`, holding plain-text files a user can read and edit
// directly — `dirs.txt` (member directories, one absolute path per line) and
// `env` (the bound bucket and any per-set auth overrides — a layer in env.mjs's
// env layering). The files are the API: editing a set is opening these files in
// an editor, deleting the folder deletes the set, so this module never caches
// and re-reads from disk on every call.
//
// A set's **name** is its whole identity (ADR-0024): the local handle, the local
// folder name, and the remote namespace, all one `[a-z0-9-]+` string. There is
// no `user@machine` component — `validateSetName` keeps the single name clean as
// handle, path segment, and remote key with zero escaping anywhere downstream.

/** `~/.s3cab/sets` — one folder per backup set. */
const setsRoot = () => join(s3cabDir(), "sets");

/**
 * A set name is interpolated into a path under `~/.s3cab/sets`, so it is guarded
 * as a single path segment (`assertPathSegment`, the same traversal guard
 * objects.mjs's `objects.<bucket>` cache path uses). A *created* set's name is always
 * canonical (see `validateSetName`), but read paths run on caller-supplied
 * names too.
 * @param {string} name
 */
const setDir = (name) => join(setsRoot(), assertPathSegment(name, "set name"));

/** @param {string} name */
export const setEnvPath = (name) => join(setDir(name), "env");
/** @param {string} name */
const setDirsPath = (name) => join(setDir(name), "dirs.txt");
/**
 * The set's snapshot store, `~/.s3cab/sets/<name>/snapshots/` — where this set's
 * snapshots live now that `<dir>/.s3cab/` has retired (docs/specs/backup.md slice 2).
 * @param {string} name
 */
export const setSnapshotsDir = (name) => join(setDir(name), "snapshots");
/**
 * The set's optional exclude file, `~/.s3cab/sets/<name>/exclude.txt`. Its glob
 * patterns (guide/exclude.md) apply relative to *each* member directory.
 * @param {string} name
 */
export const setExcludePath = (name) => join(setDir(name), "exclude.txt");

/**
 * Read a file's text, or undefined if it doesn't exist.
 * @param {string} path
 */
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
}

/**
 * Read a set's local `exclude.txt` verbatim, or `undefined` if it has none —
 * what `setup` pushes to the remote marker and `--inherit` writes back. Verbatim
 * (not parsed) because the exclude file is the user's to read and edit, and is
 * stored on the remote byte-for-byte (set-marker.mjs).
 * @param {string} name
 * @returns {string | undefined}
 */
export const readSetExclude = (name) => readTextFile(setExcludePath(name));

/**
 * Write a set's local `exclude.txt` from text — used by `--inherit` to recreate
 * the exclude file pulled from the remote marker. Creates the set folder if
 * absent (so it can run before `writeSet` if ever needed).
 * @param {string} name
 * @param {string} text
 */
export function writeSetExclude(name, text) {
  mkdirSync(setDir(name), { recursive: true });
  writeFileSync(setExcludePath(name), text);
}

/**
 * Coerce a string to the canonical set-name charset: lowercase `a-z`, `0-9`, `-`
 * — nothing else, so nothing downstream ever needs escaping. Lowercase; every
 * other run of characters becomes one `-`; leading/trailing `-` trimmed. Used in
 * two cosmetic spots: `validateSetName`'s "Try: …" suggestion, and the
 * `$username` default `setup` offers for the first set's name (ADR-0024) — never
 * to silently rewrite a value the user must live with.
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
  if (suggestion === name && name.length > 0) return;
  throw new Error(
    `Invalid set name: ${name}\n` +
      `Set names use lowercase letters, digits, and hyphens only (a-z, 0-9, -).` +
      (suggestion ? `\nTry: ${suggestion}` : ""),
  );
}

/**
 * Validate a user-supplied bucket name at `setup` time — a fail-fast guard
 * against the two natural mistakes (deferred from PR #33): pasting an `s3://`
 * URL, or a path/prefix rather than a bare bucket. One s3cab repository is one
 * whole bucket (CLAUDE.md), so the name must be a single segment.
 *
 * Deliberately *not* full AWS bucket-naming validation (length, charset, no
 * IP-form, …): s3cab also targets non-AWS S3 providers (R2/B2/…) whose rules
 * differ, so an over-strict check would reject valid names (#8). The provider
 * rejects a truly malformed name at first use with its own error.
 * @param {string} bucket
 */
export function validateBucketName(bucket) {
  if (bucket === "") {
    throw new Error(
      `No bucket name given. ` +
        `Pass a plain S3 bucket name, e.g. --bucket my-backup-bucket.`,
    );
  }
  if (/:\/\//.test(bucket)) {
    throw new Error(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name, not a URL ` +
        `(e.g. 'my-backup-bucket', not 's3://my-backup-bucket').`,
    );
  }
  if (bucket.includes("/") || bucket.includes("\\")) {
    throw new Error(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name — a single segment, not a path or prefix.`,
    );
  }
  if (bucket.trim() !== bucket) {
    throw new Error(
      `Invalid bucket name: ${bucket}\n` +
        `Give a plain bucket name with no surrounding whitespace.`,
    );
  }
}

/** The names of all backup sets (the folders under `~/.s3cab/sets`), sorted. */
export function listSets() {
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(setsRoot(), { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * @typedef {Object} BackupSet
 * @property {string} name - The local handle, local folder name, and remote namespace — one `[a-z0-9-]+` string (ADR-0024)
 * @property {string[]} dirs - Member directories (absolute paths, from `dirs.txt`)
 * @property {string} bucket - The bound S3 bucket (`S3CAB_BUCKET` in the set's env). Every set is bound at `setup` (ADR-0026), so this is never absent — `readSet` enforces it.
 */

/**
 * Read one set's configuration from its folder.
 *
 * Every set is bound to a bucket at `setup` (ADR-0026), so this is the single
 * point that enforces the invariant: a set folder whose `env` is missing
 * `S3CAB_BUCKET` is *corrupt* (hand-edited, or a pre-redesign local-only folder),
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
  const dirs = (readTextFile(setDirsPath(name)) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const envText = readTextFile(setEnvPath(name));
  const env = envText === undefined ? {} : parseEnv(envText);
  const bucket = env.S3CAB_BUCKET;
  if (!bucket) {
    throw new Error(
      `Backup set '${name}' has no bucket bound ` +
        `(no S3CAB_BUCKET in ${setEnvPath(name)}).\n` +
        `Add it back, or delete the set folder and run setup again.`,
    );
  }
  return { name, dirs, bucket };
}

const NO_SETS_MESSAGE =
  "No backup sets configured.\nCreate one with: s3cab setup <set> <folder>...";

/**
 * Resolve which set a command operates on: a given name, or — per the
 * set-first CLI surface — the only set when exactly one exists, so plain
 * `s3cab backup` just works after setup. Anything else errors, listing the
 * sets to choose from.
 *
 * Every set is bound to a bucket at setup (ADR-0026), enforced by `readSet`, so
 * a resolved set is already cloud-ready — there is no second "has a bucket?"
 * resolver tier. The cloud commands reach the set through `prepareRemoteSet`
 * (env.mjs), which wraps this with the env load they also need (ADR-0022); the
 * offline commands (`snapshot`/`compare`/`tree`) call `resolveSet` directly and
 * simply ignore the bucket.
 * @param {string} [name]
 * @returns {BackupSet}
 */
export function resolveSet(name) {
  if (name) return readSet(name);
  const names = listSets();
  const [only] = names;
  if (names.length === 1 && only) return readSet(only);
  if (names.length === 0) throw new Error(NO_SETS_MESSAGE);
  throw new Error(
    `Several backup sets exist — name one:\n\n${formatSets(names.map(readSet))}`,
  );
}

/**
 * Format sets as the human-readable listing the `sets` command prints — also
 * the body of resolveSet's several-sets error, so the error shows exactly what
 * the command would.
 * @param {BackupSet[]} sets
 */
export function formatSets(sets) {
  const nameColumn = Math.max(...sets.map(({ name }) => name.length)) + 3;
  const lines = [];
  for (const { name, dirs, bucket } of sets) {
    const count = `(${dirs.length} folder${dirs.length === 1 ? "" : "s"})`;
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
  mkdirSync(setDir(name), { recursive: true });

  if (dirs?.length) {
    writeFileSync(setDirsPath(name), dirs.join("\n") + "\n");
  }

  if (bucket) updateEnvFile(setEnvPath(name), { S3CAB_BUCKET: bucket });

  return readSet(name);
}

/**
 * Set `KEY=value` lines in an env file, replacing each key's existing line or
 * appending a new one. Line-based on purpose: the file is the API and may
 * carry hand-written comments and overrides, which an update must preserve —
 * never a parse-and-rewrite.
 * @param {string} path
 * @param {Record<string, string>} updates
 */
function updateEnvFile(path, updates) {
  let text = readTextFile(path) ?? "";
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    // Global: replace EVERY occurrence — parseEnv is last-wins, so updating
    // only the first of hand-made duplicates would leave the old value live.
    const existing = new RegExp(`^${key}=.*$`, "gm");
    if (existing.test(text)) {
      text = text.replaceAll(existing, line);
    } else {
      if (text && !text.endsWith("\n")) text += "\n";
      text += line + "\n";
    }
  }
  writeFileSync(path, text);
}
