import { join, posix, resolve, win32 } from "node:path";

import {
  foldsCase,
  pathMatcher,
  preparePath,
  rootLength,
} from "./path-match.mjs";

/** @import { Props, SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * Whether `dest` puts a `:` in a name on Windows. NTFS doesn't refuse one, it
 * reads `a:b.txt` as stream `b.txt` of a file `a`: a copy succeeds into that
 * hidden stream (measured). So the name is caught here, before anything is
 * written. Keyed on the path's shape, like `foldsCase`; a backup made on Linux
 * reaches one only through `--output`.
 * @param {string} dest
 * @returns {boolean}
 */
const putsColonInName = (dest) =>
  foldsCase(dest) && dest.slice(win32.parse(dest).root.length).includes(":");

/**
 * One target's step. `skip`, `refuse` and `block` leave `dest` alone; `write`
 * restores content `hash` to it and gives it the snapshot's `mtime`, as stored.
 * A `refuse` for a path with no destination at all names the snapshot path.
 * @typedef {{ action: "skip", dest: string }
 *   | { action: "refuse", dest: string }
 *   | { action: "block", dest: string }
 *   | { action: "write", dest: string, hash: string, mtime: string }} RestoreStep
 */

/**
 * Decide what to do with each restore target, without touching the disk or the
 * network. A target whose destination is already a folder is `block`ed, since
 * no `overwrite` replaces one, and before a download it couldn't land; one
 * whose destination exists otherwise is `skip`ped unless `overwrite`; one with
 * no destination (`reroot`'s `undefined`), or whose name the destination can't
 * hold as a file (`putsColonInName`), is `refuse`d; every other target is a
 * `write`.
 *
 * Not where identical content is deduplicated, because only the restore loop
 * knows where content actually landed: a write can fail without ending the run
 * (ADR-0086).
 *
 * Pure and order-preserving, like `selectEntries`/`reroot`: `stat` is
 * injected so this is unit-testable without touching the filesystem.
 * @param {SnapshotEntries} entries - Source path → `{ hash, mtime }`
 * @param {string[]} targets - Snapshot source paths to restore, in order
 * @param {(source: string) => string | undefined} destFor - Maps a source path to its destination
 * @param {object} options
 * @param {(dest: string) => { isDirectory(): boolean } | undefined} options.stat - What is at `dest` already, or `undefined` for nothing
 * @param {boolean} [options.overwrite] - Overwrite an existing destination instead of skipping it
 * @returns {RestoreStep[]} One step per target, in input order
 */
export function planRestore(
  entries,
  targets,
  destFor,
  { stat, overwrite = false },
) {
  /** @type {RestoreStep[]} */
  const plan = [];
  for (const source of targets) {
    const dest = destFor(source);
    if (dest === undefined) {
      plan.push({ dest: source, action: "refuse" });
      continue;
    }
    if (putsColonInName(dest)) {
      plan.push({ dest, action: "refuse" });
      continue;
    }
    const there = stat(dest);
    if (there?.isDirectory()) {
      plan.push({ dest, action: "block" });
    } else if (there && !overwrite) {
      plan.push({ dest, action: "skip" });
    } else {
      const { hash, mtime } = /** @type {Props} */ (entries.get(source));
      plan.push({ dest, action: "write", hash, mtime });
    }
  }
  return plan;
}

/**
 * Select which of a snapshot's paths a restore should write, given the user's
 * positional `paths…` filters. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the snapshot stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected.
 *
 * Pure and order-preserving (returns the input subset in iteration order) so the
 * restore loop's reporting is deterministic and this is unit-testable without S3.
 * @param {Iterable<string>} paths - The snapshot's file paths
 * @param {string[]} filters - Positional path filters (empty = match all)
 * @returns {string[]} The subset of `paths` to restore, in input order
 */
export function selectEntries(paths, filters) {
  const matches = pathMatcher(filters);
  return matches ? [...paths].filter(matches) : [...paths];
}

/**
 * How far a disk may round a modification time before the restore counts it as
 * not kept: FAT's step, the coarsest in common use. exFAT keeps 10ms, HFS+ and
 * WSL's view of a Windows drive whole seconds; a time off by less is reported
 * once, as a count, and exits 0. Past it the time is wrong, not rounded.
 */
export const COARSEST_DISK_MS = 2000;

/**
 * Build the path re-rooter for `restore --output <dir>`: each file in the snapshot lands
 * under `<output>/<member-root-name>/<path-below-that-root>` — shallow and
 * human-readable, and valid on *this* machine regardless of where the backup was
 * taken (docs/design/backup.md). The member roots are the snapshot's `@SET DIR` rows.
 * A root's name is its last segment; a drive root's is its letter, and `/` has
 * none, so its files land in `<output>` itself.
 *
 * Separator-agnostic, so a Windows snapshot re-roots correctly on POSIX and vice
 * versa: roots and paths are split by `path-match.mjs`'s `preparePath` — both
 * separators where a root or path is Windows-shaped, `/` alone otherwise, so a
 * literal backslash in a POSIX filename stays one segment instead of being read
 * as a separator. Case-folded when — and only when — the root is Windows-shaped,
 * since there the two spellings name one file (`preparePath`'s `foldCase`); the
 * basename-collision check below folds unconditionally, deliberately, to catch
 * two roots that would land in the same `<output>` directory. The destination is
 * rebuilt with this platform's separator under `output`. The longest matching
 * root wins, so a nested member dir takes precedence over a parent.
 *
 * `snapshot` writes canonical roots, so its own headers already agree with its
 * rows — the folding is for a snapshot a *user* has edited, which is a supported
 * thing to do to a file we promise is plain text (ADR-0002). It keys on the
 * path's shape rather than `process.platform` for the reason `path-match.mjs`
 * documents: a Windows snapshot restored on Linux is exactly the case `--output`
 * exists for.
 *
 * Two roots whose basename collides (e.g. `C:\a\Photos` and `D:\b\Photos`, both
 * wanting `<output>/Photos`) are rejected up front, and so is `/` beside any
 * other root — but only roots that some path to restore lands under count, so
 * a path filter restores each on its own. Pure and side-effect-free
 * (unit-testable without S3), like `selectEntries`.
 * @param {string[]} dirs - The member roots (`@SET DIR` rows)
 * @param {string[]} paths - The snapshot paths to restore, which decide the roots
 *   that must not collide
 * @param {string} output - The `--output` directory
 * @returns {(path: string) => string | undefined} Maps a snapshot path to its
 *   destination, or `undefined` for one a Windows output can't place
 */
export function reroot(dirs, paths, output) {
  const roots = dirs
    // A doubled separator past the root is an empty segment, which no valid
    // path has, so that `DIR` matches nothing (guide/format.md). Dropped here
    // because `segments` below filters empties out, which would match it as
    // the path without one. Trailing separators are ignored, as everywhere.
    .filter((dir) => {
      const { path } = preparePath(dir);
      const names = path.slice(rootLength(path)).replace(/\/+$/, "");
      return names === "" || !names.split(posix.sep).includes("");
    })
    .map((dir) => {
      const { path, foldCase } = preparePath(dir);
      // Not `preparePath`'s own `base`: that answers "what follows the last
      // separator", which is empty for a `@SET DIR` row, written with a
      // trailing one (ADR-0098). `segments` already trims those.
      const segments = path.split(posix.sep).filter(Boolean);
      const last = segments.at(-1) ?? "";
      return {
        dir,
        segments,
        // A drive's segment is `C:`, which no Windows folder can be called, so
        // it takes the letter. No later segment of a Windows path has a colon.
        base: foldCase && /^[A-Za-z]:$/.test(last) ? last.slice(0, -1) : last,
        fold: foldCase,
      };
    })
    // Longest first: a nested root must win over a parent that also matches.
    .sort((a, b) => b.segments.length - a.segments.length);
  /** @param {string} path */
  const split = (path) =>
    preparePath(path).path.split(posix.sep).filter(Boolean);
  /** @param {string[]} segments @param {boolean} fold - The path's own kind is Windows */
  const rootOf = (segments, fold) =>
    roots.find(
      (r) =>
        r.fold === fold &&
        r.segments.length <= segments.length &&
        r.segments.every((seg, i) => {
          // The length guard above puts `i` in range; `?? ""` is for the type
          // checker, and can't match a segment (they're non-empty by `filter`).
          const other = segments[i] ?? "";
          return r.fold
            ? seg.toLowerCase() === other.toLowerCase()
            : seg === other;
        }),
    );

  const reached = new Set(
    paths.map((path) => rootOf(split(path), foldsCase(path))),
  );
  const used = roots.filter((root) => reached.has(root));
  const apart =
    "Restore them one at a time with a path filter, or to their original locations.";
  const top = used.find(({ base }) => base === "");
  const beside = used.find(({ base }) => base !== "");
  if (top && beside) {
    throw new Error(
      `This snapshot backs up "${top.dir}" beside "${beside.dir}", and under --output ` +
        `the files of "${top.dir}" land in the output itself, where they could mix ` +
        `with the others. ${apart}`,
    );
  }
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const { dir, base } of used) {
    const key = base.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `"${first}" and "${dir}" would both land in a folder named "${base}" under ` +
          `--output, which can't keep them apart. ${apart}`,
      );
    }
    seen.set(key, dir);
  }

  const outDir = resolve(output);
  const windows = foldsCase(outDir);
  return (path) => {
    const segments = split(path);
    const root = rootOf(segments, foldsCase(path));
    if (!root) {
      throw new Error(
        `Path is not under any backed-up directory, so --output cannot place it: ${path}`,
      );
    }
    const named = [root.base, ...segments.slice(root.segments.length)];
    // The reader refuses a `.`/`..` segment (ADR-0101), but splits on `/` alone.
    // Windows also reads a POSIX name's `\` as a separator, so `back\slash.txt`
    // would land as a folder and `a\..\..\x` outside `<output>`, once `join`
    // resolves the `..`. Only the names joined here count: a `\` above the root
    // is dropped with it.
    if (windows && named.some((segment) => segment.includes("\\"))) {
      return undefined;
    }
    return join(outDir, ...named);
  };
}
