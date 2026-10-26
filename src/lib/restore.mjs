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
 * Select which of a snapshot's paths a restore should write, given the paths
 * the user named. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the snapshot stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected:
 * `--all`.
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
 * Build the path re-rooter for `restore --output <dir>`: each file lands at its
 * full original path under `<dir>`, its root turned into a folder
 * ([ADR-0109](../../docs/adr/0109-restore-output-keeps-the-full-path.md)) — a
 * drive keeps its letter (`C:\Users\a.jpg` → `<dir>/C/Users/a.jpg`), a share goes
 * under `UNC`, as Windows' own long-path form does (`\\nas\x\a.jpg` →
 * `<dir>/UNC/nas/x/a.jpg`), and a POSIX path keeps its segments. Where a file
 * lands depends on its own path alone, so two paths never meet, and the result
 * is valid on *this* machine wherever the backup was taken.
 *
 * Separator-agnostic, so a Windows snapshot re-roots correctly on POSIX and vice
 * versa: paths are split by `path-match.mjs`'s `preparePath` — both separators
 * where a path is Windows-shaped, `/` alone otherwise, so a literal backslash in
 * a POSIX filename stays one segment instead of being read as a separator. The
 * destination is rebuilt with this platform's separator under `output`. Pure and
 * side-effect-free (unit-testable without S3), like `selectEntries`.
 * @param {string} output - The `--output` directory
 * @returns {(path: string) => string | undefined} Maps a snapshot path to its
 *   destination, or `undefined` for one a Windows output can't place
 */
export function reroot(output) {
  const outDir = resolve(output);
  const windows = foldsCase(outDir);
  return (path) => {
    const { path: unified, foldCase } = preparePath(path);
    const names = unified
      .slice(rootLength(unified))
      .split(posix.sep)
      .filter(Boolean);
    // A drive's `C:` is no name a Windows folder can have, so it takes the
    // letter; `UNC` is three letters, so no drive folder can meet a share's.
    const root = unified.startsWith("//")
      ? ["UNC"]
      : foldCase
        ? [unified.charAt(0)]
        : [];
    const named = [...root, ...names];
    // The reader refuses a `.`/`..` segment (ADR-0101), but splits on `/` alone.
    // Windows also reads a POSIX name's `\` as a separator, so `back\slash.txt`
    // would land as a folder and `a\..\..\x` outside `<output>`, once `join`
    // resolves the `..`.
    if (windows && named.some((segment) => segment.includes("\\"))) {
      return undefined;
    }
    return join(outDir, ...named);
  };
}
