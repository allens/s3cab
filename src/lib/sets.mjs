import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { hash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { isENOENT } from "./error.mjs";
import { assertPathSegment, s3cabDir } from "./home.mjs";

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
const setsRoot = () => join(s3cabDir(), "sets");

/**
 * A set name is interpolated into a path under `~/.s3cab/sets`, so it is guarded
 * as a single path segment (`assertPathSegment`, the same traversal guard
 * auth.mjs's per-bucket env path uses). A *created* set's name is always
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
 * snapshots live now that `<dir>/.s3cab/` has retired (specs/backup.md slice 2).
 * @param {string} name
 */
export const setSnapshotsDir = (name) => join(setDir(name), "snapshots");
/**
 * The set's optional exclude file, `~/.s3cab/sets/<name>/exclude.txt`. Its glob
 * patterns (doc/exclude.md) apply relative to *each* member directory.
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
 * A captured identity part for the namespace: the sanitized form, or — when
 * the charset can't express the name at all (e.g. an all-non-Latin username,
 * which sanitizes to "") — a short stable hash of the raw value. The hash
 * keeps identities *distinct* in a shared bucket even when recognisability
 * is unsalvageable; a constant fallback would collide every such user.
 * (Settled in PR #33 review.)
 * @param {string} part
 */
export const namespacePart = (part) =>
  sanitizeNamePart(part) || hash("sha256", part, "hex").slice(0, 6);

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

/**
 * Validate a namespace supplied for adoption (`setup --from`): the pinned
 * remote identity `user@machine/set`, each part the canonical `[a-z0-9-]+`
 * charset — so it is a safe `snapshots/<namespace>/` key prefix and matches
 * exactly what `writeSet` pins when creating normally. User-supplied, so a
 * malformed value is rejected with the shape rather than silently normalized.
 * @param {string} namespace
 */
export function validateNamespace(namespace) {
  if (!isNamespace(namespace)) {
    throw new Error(
      `Invalid namespace: ${namespace}\n` +
        `Adopt with a remote namespace of the form user@machine/set ` +
        `(lowercase letters, digits, and hyphens, e.g. allen@allen-pc/photos).`,
    );
  }
}

/**
 * Whether a string is a canonical `user@machine/set` namespace — the single
 * source of truth for the shape, shared by `validateNamespace` (which throws)
 * and `remote.mjs`'s namespace discovery (which filters keys to real targets).
 * @param {string} s
 * @returns {boolean}
 */
export const isNamespace = (s) => /^[a-z0-9-]+@[a-z0-9-]+\/[a-z0-9-]+$/.test(s);

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
 * Resolve a set that is ready for cloud operations: the named set (sole-set
 * default, via `resolveSet`), guarded to have a bucket bound and a pinned
 * namespace. The shared front door for `backup`/`status` (and later
 * `restore`/`verify`) — a bucket-less set is a local-only snapshot engine and
 * stops here with the exact command to bind one. Env loading stays in each
 * command (per CLAUDE.md), so this does no `loadEnv` and keeps no auth
 * dependency (which would also cycle, auth.mjs → sets.mjs).
 * @param {string} [setName]
 * @returns {BackupSet & { bucket: string, namespace: string }}
 */
export function resolveRemoteSet(setName) {
  const set = resolveSet(setName);
  if (!set.bucket) {
    throw new Error(
      `Backup set '${set.name}' has no bucket bound — it is local-only.\n` +
        `Bind one with:  s3cab setup ${set.name} --bucket <bucket>`,
    );
  }
  if (!set.namespace) {
    throw new Error(
      `Backup set '${set.name}' has no pinned namespace ` +
        `(S3CAB_NAMESPACE missing from its env).`,
    );
  }
  return { ...set, bucket: set.bucket, namespace: set.namespace };
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
 *
 * The namespace is pinned at creation and never changed thereafter. Normally it
 * is derived fresh from this machine's identity; adoption (`setup --from`)
 * passes an existing remote `namespace` to pin instead, so a fresh machine can
 * point a new local set at another machine's backup (specs/backup.md). A given
 * namespace only takes effect when creating — an existing set's is immutable.
 * @param {string} name - A valid set name (see `validateSetName`)
 * @param {object} [pieces]
 * @param {string[]} [pieces.dirs] - Member directories (absolute paths)
 * @param {string} [pieces.bucket] - The S3 bucket to bind
 * @param {string} [pieces.namespace] - Pin this remote namespace (adoption); validated by the caller
 * @returns {BackupSet} The set as stored after the write
 */
export function writeSet(name, { dirs, bucket, namespace } = {}) {
  const creating = !existsSync(setDir(name));
  mkdirSync(setDir(name), { recursive: true });

  if (dirs?.length) {
    writeFileSync(setDirsPath(name), dirs.join("\n") + "\n");
  }

  /** @type {Record<string, string>} */
  const updates = {};
  if (creating) {
    const user = namespacePart(userInfo().username);
    const machine = namespacePart(hostname());
    updates.S3CAB_NAMESPACE = namespace ?? `${user}@${machine}/${name}`;
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
