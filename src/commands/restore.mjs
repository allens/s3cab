import { existsSync, mkdirSync } from "node:fs";
import { copyFile, utimes } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
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
 * `--output <dir>` re-roots instead of restoring to original locations: each
 * member directory's contents land under `<dir>/<root-basename>/…` (see `reroot`).
 * That recovers a backup whose absolute paths don't fit this machine — a
 * different drive layout, or another OS entirely — and is the only mode that
 * accepts non-absolute-on-this-platform paths.
 *
 * The set must have a bucket bound and an existing remote backup. Because the
 * set is always the first positional, filtering by `paths…` requires naming the
 * set explicitly (`s3cab restore photos C:\…\beach.jpg`); the sole-set default
 * applies only when no positionals are given.
 *
 * @param {string} [setName] - Backup set to restore (default: the only set)
 * @param {string[]} [paths] - Positional path filters (empty = restore everything)
 * @param {{ snapshot?: string, overwrite?: boolean, output?: string, debug?: boolean }} [options]
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

  const { entries: manifest, dirs } = await readRemoteSnapshot(
    set.bucket,
    set.namespace,
    name,
  );
  const targets = selectEntries(manifest.keys(), paths);
  if (paths.length && targets.length === 0) {
    throw new Error(
      `No files in snapshot '${name}' matched: ${paths.join(", ")}`,
    );
  }

  // Where each manifest path is written. `--output` re-roots under the chosen
  // dir (and so accepts any path, cross-OS included); otherwise files go back to
  // their original absolute location.
  /** @type {(path: string) => string} */
  let destFor = (path) => path;
  if (options.output) {
    destFor = reroot(dirs, options.output);
  } else {
    // Every target must be absolute on *this* platform before we touch the disk.
    // A manifest captured on another OS (Windows paths on POSIX, say) or a
    // hand-edited one would otherwise write files relative to the cwd with
    // surprising names like `C:\Users\…` — refuse up front rather than scatter
    // them, and point at `--output` for the cross-OS case.
    const notAbsolute = targets.filter((path) => !isAbsolute(path));
    if (notAbsolute.length) {
      throw new Error(
        `Snapshot '${name}' has ${notAbsolute.length} path(s) that aren't absolute ` +
          `on this system (e.g. ${notAbsolute.slice(0, 3).join(", ")}). The backup ` +
          `was likely made on a different OS; restore it here with --output <dir> ` +
          `to re-root under a folder you choose.`,
      );
    }
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
    for (const source of targets) {
      const dest = destFor(source);
      if (existsSync(dest) && !options.overwrite) {
        skipped.push(dest);
        continue;
      }
      const { hash, mtime } = /** @type {Props} */ (manifest.get(source));
      mkdirSync(dirname(dest), { recursive: true });

      const have = fetched.get(hash);
      if (have) {
        await copyFile(have, dest);
      } else {
        await downloadObject(set.bucket, hash, dest);
        fetched.set(hash, dest);
      }
      const when = new Date(mtime);
      await utimes(dest, when, when);
      restored.push(dest);

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

/**
 * Build the path re-rooter for `restore --output <dir>`: each manifest file lands
 * under `<output>/<member-root-basename>/<path-below-that-root>` — shallow and
 * human-readable, and valid on *this* machine regardless of where the backup was
 * taken (specs/backup.md). The member roots are the manifest's `#DIR` headers.
 *
 * Separator-agnostic, so a Windows manifest re-roots correctly on POSIX and vice
 * versa: roots and paths are split on both `/` and `\`, and matched by exact
 * segments. Path-vs-root matching is case-sensitive (a path and its `#DIR` root
 * were written by the same snapshot run, so their casing already agrees); only
 * the basename-collision check below folds case, deliberately, to catch two roots
 * that would land in the same `<output>` folder. The destination is rebuilt with
 * this platform's separator under `output`. The longest matching root wins, so a
 * nested member dir takes precedence over a parent.
 *
 * Two roots whose basename collides (e.g. `C:\a\Photos` and `D:\b\Photos`, both
 * wanting `<output>/Photos`) are rejected up front: restore them one at a time
 * with a path filter, or to their original locations. Pure and side-effect-free
 * (unit-testable without S3), like `selectEntries`.
 * @param {string[]} dirs - The manifest's member roots (its `#DIR` headers)
 * @param {string} output - The `--output` directory
 * @returns {(path: string) => string} Maps a manifest path to its destination
 */
export function reroot(dirs, output) {
  if (dirs.length === 0) {
    throw new Error(
      "This snapshot has no directory headers, so --output cannot re-root it. " +
        "Omit --output to restore to the original locations instead.",
    );
  }

  const roots = dirs
    .map((dir) => dir.split(/[\\/]/).filter(Boolean))
    .map((segments) => ({ segments, base: segments.at(-1) ?? "" }))
    // Longest first: a nested root must win over a parent that also matches.
    .sort((a, b) => b.segments.length - a.segments.length);

  const seen = new Set();
  for (const { base } of roots) {
    const key = base.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `Two backed-up folders are both named "${base}", so --output cannot keep ` +
          `them apart under one root. Restore them one at a time with a path ` +
          `filter, or to their original locations.`,
      );
    }
    seen.add(key);
  }

  const base = resolve(output);
  return (path) => {
    const segments = path.split(/[\\/]/).filter(Boolean);
    const root = roots.find(
      (r) =>
        r.segments.length <= segments.length &&
        r.segments.every((seg, i) => seg === segments[i]),
    );
    if (!root) {
      throw new Error(
        `Path is not under any backed-up folder, so --output cannot place it: ${path}`,
      );
    }
    // No `.`/`..` sandbox guard here on purpose: manifest paths are first-party
    // (written by `snapshot` walking the real filesystem, which never emits `.`
    // or `..` segments), and a `..` could only arrive in a hand-crafted manifest
    // — outside the trust model (your own bucket, your own backups, #2). Guarding
    // only `--output` would also be inconsistent: plain `restore` writes straight
    // to the manifest's absolute paths, so it already trusts the manifest to
    // direct writes anywhere. (Reviewers re-flag this as path traversal; it is a
    // deliberate non-guard, not an oversight — see PR #55.)
    return join(base, root.base, ...segments.slice(root.segments.length));
  };
}
