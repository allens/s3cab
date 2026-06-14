import { existsSync, mkdirSync } from "node:fs";
import { copyFile, utimes } from "node:fs/promises";
import { dirname, isAbsolute, posix, sep } from "node:path";
import { stderr } from "node:process";
import { loadEnv } from "../lib/auth.mjs";
import {
  downloadObject,
  listRemoteSnapshots,
  readRemoteSnapshot,
} from "../lib/remote.mjs";
import { resolveRemoteSet } from "../lib/sets.mjs";

/** @import { Props } from "./prop.mjs" */

// The `restore` command (specs/backup.md): pull a set's files back from the
// cloud. Remote-only by nature — local snapshots record only hashes; the file
// *content* lives solely in the bucket's `objects/<sha256>` store — so there is
// no `--remote` flag (like `status`).

/**
 * Restore a set's files from a remote backup (specs/backup.md). Reads the
 * chosen remote manifest (latest, or `--snapshot <name>`) and writes each file
 * back to the **original absolute path** it was captured from, **never touching
 * an existing file** (it is reported skipped) unless `--overwrite` is given — so
 * the empty-disk and the "I deleted a folder" cases both just work and a
 * careless restore can't destroy newer work. Positional `paths…` filter what is
 * restored (see `selectEntries`); with none, the whole snapshot is restored.
 *
 * Each object is fetched and integrity-checked by `downloadObject` (its SHA-256
 * must match the manifest hash), then given the manifest mtime — required, since
 * the snapshot diff is mtime-based. Content shared across several paths (moved
 * or duplicated files) is downloaded once and copied to the rest. The manifest-
 * last upload invariant guarantees every referenced object exists, so there is
 * no pre-flight; a genuinely missing object surfaces as a failed download.
 *
 * The set must have a bucket bound and an existing remote backup. Because the
 * set is always the first positional, filtering by `paths…` requires naming the
 * set explicitly (`s3cab restore photos C:\…\beach.jpg`); the sole-set default
 * applies only when no positionals are given.
 *
 * @param {string} [setName] - Backup set to restore (default: the only set)
 * @param {string[]} [paths] - Positional path filters (empty = restore everything)
 * @param {{ snapshot?: string, overwrite?: boolean, debug?: boolean }} [options]
 * @returns {Promise<{ set: string, snapshot: string, restored: string[], skipped: string[] }>}
 *   `restored` = paths written; `skipped` = existing paths left untouched (rerun with --overwrite to replace).
 */
export async function restore(setName, paths = [], options = {}) {
  const set = resolveRemoteSet(setName);
  loadEnv({ set: set.name });

  // One listing picks the source and validates `--snapshot` against what's
  // really there (newest first), so a bad name errors loudly with the choices
  // rather than failing later on a 404 mid-fetch.
  const names = await listRemoteSnapshots(set.bucket, set.namespace);
  if (names.length === 0) {
    throw new Error(
      `No backups for set '${set.name}'. Back one up with: s3cab backup ${set.name}`,
    );
  }
  if (options.snapshot && !names.includes(options.snapshot)) {
    throw new Error(
      `Snapshot '${options.snapshot}' not found for set '${set.name}'.\n` +
        `Available snapshots (newest first):\n  ${names.join("\n  ")}`,
    );
  }
  // names is non-empty (guarded above), so the latest is defined.
  const name = options.snapshot ?? /** @type {string} */ (names[0]);

  const manifest = await readRemoteSnapshot(set.bucket, set.namespace, name);
  const targets = selectEntries(manifest.keys(), paths);
  if (paths.length && targets.length === 0) {
    throw new Error(
      `No files in snapshot '${name}' matched: ${paths.join(", ")}`,
    );
  }

  // Every target must be absolute on *this* platform before we touch the disk.
  // A manifest captured on another OS (Windows paths on POSIX, say) or a
  // hand-edited one would otherwise write files relative to the cwd with
  // surprising names like `C:\Users\…` — refuse up front rather than scatter
  // them. Cross-OS restore is what `--output` (planned) re-rooting will be for.
  const notAbsolute = targets.filter((path) => !isAbsolute(path));
  if (notAbsolute.length) {
    throw new Error(
      `Snapshot '${name}' has ${notAbsolute.length} path(s) that aren't absolute ` +
        `on this system (e.g. ${notAbsolute.slice(0, 3).join(", ")}). The backup ` +
        `was likely made on a different OS; restoring it here will need --output ` +
        `(planned) to re-root under a folder you choose.`,
    );
  }

  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const skipped = [];
  // First verified local copy of each content hash, so identical content under
  // several paths downloads once and is copied to the rest (design #1). Only
  // files *we* downloaded are trusted as a copy source — never a skipped
  // pre-existing file, whose content is unknown (the skip is content-blind).
  /** @type {Map<string, string>} */
  const fetched = new Map();

  // Track whether a progress line was drawn so the closing newline runs in a
  // `finally` — even if a download throws mid-loop the terminal cursor is left
  // on a fresh line, so the error message that follows isn't tacked onto the
  // half-written progress line.
  let progressed = false;
  try {
    for (const path of targets) {
      if (existsSync(path) && !options.overwrite) {
        skipped.push(path);
        continue;
      }
      const { hash, mtime } = /** @type {Props} */ (manifest.get(path));
      mkdirSync(dirname(path), { recursive: true });

      const source = fetched.get(hash);
      if (source) {
        await copyFile(source, path);
      } else {
        await downloadObject(set.bucket, hash, path);
        fetched.set(hash, path);
      }
      const when = new Date(mtime);
      await utimes(path, when, when);
      restored.push(path);

      const done = restored.length + skipped.length;
      if (done % 50 === 0 || done === targets.length) {
        stderr.write(`\rRestoring ${done}/${targets.length}...`);
        progressed = true;
      }
    }
  } finally {
    if (progressed) stderr.write("\n");
  }

  return { set: set.name, snapshot: name, restored, skipped };
}

/**
 * Normalize a path for filter matching: separators to `/`, and case-folded on
 * Windows. Mirrors how the exclude matcher (tree.mjs) treats paths — `split(sep)`
 * so a backslash is a separator on Windows but a literal character on POSIX, and
 * the `win32` case-insensitivity of `createMatcher`'s `"i"` flag.
 * @param {string} p
 * @returns {string}
 */
const normalize = (p) => {
  const slashed = p.split(sep).join(posix.sep);
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};

/**
 * Select which of a manifest's paths a restore should write, given the user's
 * positional `paths…` filters. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the manifest stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected.
 *
 * Pure and order-preserving (returns the input subset in iteration order) so the
 * restore loop's reporting is deterministic and this is unit-testable without S3.
 * @param {Iterable<string>} paths - The manifest's file paths
 * @param {string[]} filters - Positional path filters (empty = match all)
 * @returns {string[]} The subset of `paths` to restore, in input order
 */
export function selectEntries(paths, filters) {
  const needles = filters
    .map(normalize)
    .map((n) => n.replace(/\/+$/, ""))
    .filter(Boolean);
  if (needles.length === 0) return [...paths];

  const selected = [];
  for (const path of paths) {
    const hay = normalize(path);
    if (needles.some((n) => hay === n || hay.startsWith(n + posix.sep))) {
      selected.push(path);
    }
  }
  return selected;
}
