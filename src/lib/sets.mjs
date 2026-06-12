import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";

// The backup-set store (specs/backup.md): one folder per set under
// `~/.s3cab/sets/<name>/`, holding plain-text files a user can read and edit
// directly — `dirs.txt` (member directories, one absolute path per line) and
// `env` (the pinned remote namespace, the bound bucket, and any per-set auth
// overrides — a layer in auth.mjs's env layering). The files are the API:
// editing a set is opening these files in an editor, deleting the folder
// deletes the set, so this module never caches and re-reads from disk on
// every call.
//
// A set's full identity is `user@machine:set-name`, captured ONCE at creation
// (sanitized from the OS username/hostname) and pinned into the set's `env` as
// the remote namespace `user@machine/set-name` — never recomputed, so renaming
// the machine (or the set folder, a purely local handle) cannot fork the
// backup history.

/** `~/.s3cab/sets` — one folder per backup set. */
const setsRoot = () => join(homedir(), ".s3cab", "sets");

/**
 * A set name is interpolated into a path under `~/.s3cab/sets`, so reject one
 * carrying a path separator (same traversal guard as auth.mjs's per-bucket env
 * path). A *created* set's name is always canonical (see `validateSetName`),
 * but read paths run on caller-supplied names too.
 * @param {string} name
 */
const setDir = (name) => {
  if (basename(name) !== name) {
    throw new Error(`Invalid set name (contains a path separator): ${name}`);
  }
  return join(setsRoot(), name);
};

/** @param {string} name */
export const setEnvPath = (name) => join(setDir(name), "env");
/** @param {string} name */
const setDirsPath = (name) => join(setDir(name), "dirs.txt");

/**
 * Read a file's text, or undefined if it doesn't exist.
 * @param {string} path
 */
function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Sanitize a captured identity part (OS username / hostname) to the canonical
 * namespace charset: lowercase `a-z`, `0-9`, `-` — nothing else, so nothing
 * downstream ever needs escaping. Lowercase; every other run of characters
 * becomes one `-`; leading/trailing `-` trimmed. Silent normalization is fine
 * here — the user never typed these (Windows usernames may carry spaces or
 * unicode).
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

/** The names of all backup sets (the folders under `~/.s3cab/sets`), sorted. */
export function listSets() {
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(setsRoot(), { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
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
 * @typedef {Object} BackupSet
 * @property {string} name - The local handle (the folder name under `~/.s3cab/sets`)
 * @property {string[]} dirs - Member directories (absolute paths, from `dirs.txt`)
 * @property {string} [bucket] - The bound S3 bucket (`S3CAB_BUCKET` in the set's env)
 * @property {string} [namespace] - The pinned remote namespace, `user@machine/set-name`
 */

/**
 * Read one set's configuration from its folder.
 * @param {string} name
 * @returns {BackupSet}
 */
export function readSet(name) {
  if (!existsSync(setDir(name))) {
    const names = listSets();
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
  return {
    name,
    dirs,
    bucket: env.S3CAB_BUCKET,
    namespace: env.S3CAB_NAMESPACE,
  };
}

const NO_SETS_MESSAGE =
  "No backup sets configured.\nCreate one with: s3cab setup <set> <folder>...";

/**
 * Resolve which set a command operates on: a given name, or — per the
 * set-first CLI surface — the only set when exactly one exists, so plain
 * `s3cab backup` just works after setup. Anything else errors, listing the
 * sets to choose from.
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
    const target = bucket ? `→ s3://${bucket}` : "(no bucket — local only)";
    const count = `(${dirs.length} folder${dirs.length === 1 ? "" : "s"})`;
    lines.push(name.padEnd(nameColumn) + `${target}   ${count}`);
    for (const dir of dirs) {
      lines.push(" ".repeat(nameColumn) + dir);
    }
  }
  return lines.join("\n");
}

/**
 * Create or update a set: write `dirs.txt` when dirs are given, bind the
 * bucket when given, and pin the namespace once at creation. Member dirs are
 * stored as passed — resolving/validating them is the `setup` command's job.
 * @param {string} name - A valid set name (see `validateSetName`)
 * @param {object} [pieces]
 * @param {string[]} [pieces.dirs] - Member directories (absolute paths)
 * @param {string} [pieces.bucket] - The S3 bucket to bind
 * @returns {BackupSet} The set as stored after the write
 */
export function writeSet(name, { dirs, bucket } = {}) {
  const creating = !existsSync(setDir(name));
  mkdirSync(setDir(name), { recursive: true });

  if (dirs?.length) {
    writeFileSync(setDirsPath(name), dirs.join("\n") + "\n");
  }

  /** @type {Record<string, string>} */
  const updates = {};
  if (creating) {
    const user = sanitizeNamePart(userInfo().username);
    const machine = sanitizeNamePart(hostname());
    updates.S3CAB_NAMESPACE = `${user}@${machine}/${name}`;
  }
  if (bucket) updates.S3CAB_BUCKET = bucket;
  if (Object.keys(updates).length) updateEnvFile(setEnvPath(name), updates);

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
    const existing = new RegExp(`^${key}=.*$`, "m");
    if (existing.test(text)) {
      text = text.replace(existing, line);
    } else {
      if (text && !text.endsWith("\n")) text += "\n";
      text += line + "\n";
    }
  }
  writeFileSync(path, text);
}
