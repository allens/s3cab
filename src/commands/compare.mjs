import { realpathSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { readSnapshot } from "../lib/snapshot-file.mjs";
import { notImplemented } from "../lib/error.mjs";
import { list } from "./list.mjs";

/**
 * @typedef {Object} CompareResult
 * @property {string[]} added
 * @property {string[]} moved
 * @property {string[]} modified
 * @property {string[]} deleted
 */

/**
 * Accept either a bare snapshot name (as `list` reports) or a full snapshot
 * filename, by stripping the `.tsv`/`.tsv.zst` extension.
 * @param {string} [name]
 */
const normalizeName = (name) => name?.replace(/\.tsv(\.zst)?$/, "");

/**
 * Show what changed between two snapshots, from an older (`since`) to a newer
 * (`until`) one.
 *
 * Naming a snapshot that doesn't exist is an error, never a silent empty
 * result. When `until` is the oldest snapshot (or the only one), the
 * baseline is empty and everything reports as added.
 * @param {string} dir - Snapshot directory
 * @param {object} [options]
 * @param {string} [options.since] - Older snapshot to compare from (default: the one before `until`)
 * @param {string} [options.until] - Newer snapshot to compare to (default: latest)
 * @param {boolean} [options.remote] - Compare against snapshots on the remote
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compare(dir = ".", options = {}) {
  if (options.remote) {
    notImplemented("compare --remote");
  }

  dir = realpathSync.native(dir);

  const snapshotNames = list(dir);

  // Newer side (`until`) defaults to the latest snapshot.
  const until = normalizeName(options.until) ?? snapshotNames.at(0);
  if (!until) {
    throw new Error(`No snapshots found in directory: ${dir}`);
  }
  const untilSnapshot = await readSnapshot(dir, until);

  // Older side (`since`) defaults to the snapshot immediately before `until`.
  let since = normalizeName(options.since);
  if (since === undefined) {
    const untilIndex = snapshotNames.indexOf(until);
    if (untilIndex === -1) {
      // `until` may still be a readable file outside the listed snapshots
      // (e.g. a debug .tsv) — but then it has no well-defined predecessor.
      throw new Error(
        `Snapshot '${until}' is not in the snapshot list; use --since to pick the older side`,
      );
    }
    since = snapshotNames.at(untilIndex + 1); // undefined when `until` is the oldest
  }

  /** @type {import("../lib/snapshot-file.mjs").SnapshotLookup} */
  let sinceSnapshot;
  if (since === undefined) {
    // Nothing older than `until`: an empty baseline; everything is "added".
    sinceSnapshot = new Map();
  } else {
    sinceSnapshot = await readSnapshot(dir, since);
  }
  console.warn(
    "Comparing",
    since ? `'${since}'` : "(nothing)",
    "→",
    `'${until}'`,
  );

  const { added, moved, modified, deleted } = diff(
    sinceSnapshot,
    untilSnapshot,
  );

  return {
    added: Array.from(added.entries()).map(([path, previousPaths]) => {
      let text = relative(dir, path);
      if (previousPaths && previousPaths.size) {
        text += " == ";
        text += Array.from(previousPaths, (path) => relative(dir, path));
      }
      return text;
    }),
    moved: Array.from(moved.entries()).map(([oldPath, newPath]) => {
      let text = relative(dir, oldPath);
      text += dirname(oldPath) === dirname(newPath) ? " → " : " →→ ";
      text += relative(dir, newPath);
      return text;
    }),
    modified: Array.from(modified, (path) => relative(dir, path)),
    deleted: Array.from(deleted, (path) => relative(dir, path)),
  };
}

/** @typedef {Set<string>} PathSet */
/** @typedef {Map<string, string>} PathFromToLookup */
/** @typedef {Map<string, PathSet>} PathDuplicatesLookup */

/**
 * @typedef {Object} DiffResult
 * @property {PathDuplicatesLookup} added
 * @property {PathFromToLookup} moved
 * @property {PathSet} modified
 * @property {PathSet} deleted
 */

/**
 * Create a lookup of hash to set of paths.
 * @param {import("../lib/snapshot-file.mjs").SnapshotLookup} snapshotLookup - Snapshot lookup
 * @returns {Map<string,PathSet>} Hash to path set lookup
 */
function getPathsByHash(snapshotLookup) {
  /** @type {Map<string,PathSet>} */
  const hashLookup = new Map();

  snapshotLookup.forEach(({ hash }, path) => {
    let paths = hashLookup.get(hash);
    if (!paths) {
      paths = new Set();
      hashLookup.set(hash, paths);
    }
    paths.add(path);
  });

  return hashLookup;
}

/**
 * Diff two snapshots. Neither input is modified.
 *
 * Classification rules (each pinned by a test in compare.test.mjs; the
 * user-facing guide is doc/compare.md):
 * - Same path in both snapshots → `modified` when the hash differs; silently
 *   unchanged when it matches. The hash is the only signal — size/mtime are
 *   ignored, so a touch never reports as a change.
 * - Path only in the previous snapshot → `deleted`, unless claimed as a move
 *   source below.
 * - Path only in the current snapshot → `moved` when a *deleted* path with
 *   the same hash exists, otherwise `added`. Move pairing prefers same
 *   basename, then same parent directory, then any candidate (greedy — see
 *   the comment at the pairing).
 * - Only deleted paths can be move sources: rotation/copy-then-edit reports
 *   as modified plus an annotated copy, and swapped contents report as two
 *   modifications — never as moves of paths that still exist.
 * - `added` entries carry the previous-snapshot paths that held the same
 *   content; when all of those were claimed as move sources, the moved-to
 *   locations are reported instead.
 * - Files that failed hashing are stored as #comment lines, invisible here:
 *   an unreadable file reports as `deleted` (an explicit errors category is
 *   a planned follow-up — see CLAUDE.md "Known gaps").
 * @param {import("../lib/snapshot-file.mjs").SnapshotLookup} previousSnapshot - Previous snapshot lookup
 * @param {import("../lib/snapshot-file.mjs").SnapshotLookup} currentSnapshot - Current snapshot
 * @returns {DiffResult} Diff results
 */
export function diff(previousSnapshot, currentSnapshot) {
  /** @type {PathDuplicatesLookup} */ // new paths - mapped to matching paths in previous snapshot
  const added = new Map();

  /** @type {PathFromToLookup} */ // from to path
  const moved = new Map();

  /** @type {PathSet} */ // modified paths - files that have changed
  const modified = new Set();

  /** @type {PathSet} */ // deleted paths - files that are not in the current snapshot
  const deleted = new Set();

  const previousPathsByHash = getPathsByHash(previousSnapshot);

  // Paths only in the current snapshot; both-side paths are settled first.
  const currentOnly = new Map(currentSnapshot);

  previousSnapshot.forEach(({ hash }, path) => {
    const currentProps = currentOnly.get(path);
    if (currentProps) {
      currentOnly.delete(path);
      // If the path from the previous snapshot exists in the current snapshot and the hash is different, it is modified
      if (currentProps.hash !== hash) {
        modified.add(path);
      } else {
        // nominally unchanged but we assume this and don't do anything with it
      }
    } else {
      // If the path from the previous snapshot does NOT exist in the current snapshot, it is deleted or possibly moved
      deleted.add(path);
    }
  });

  // Now currentOnly holds only new paths
  // We just need to work out if they are really new, moved, renamed
  for (const [addedPath, { hash }] of currentOnly) {
    const previousPathSetForHash = previousPathsByHash.get(hash);

    if (previousPathSetForHash) {
      const sources = Array.from(previousPathSetForHash).filter((path) =>
        deleted.has(path),
      );
      const [firstSource] = sources;

      if (firstSource) {
        // moved! Pair greedily: same basename, then same parent dir, then
        // any. Greedy in iteration order, not a globally optimal matching —
        // an early added path can take a later one's better-matching source.
        // Accepted: with identical content the pairing is display-only; the
        // stored objects are the same either way.
        const source =
          sources.find((path) => basename(path) === basename(addedPath)) ??
          sources.find((path) => dirname(path) === dirname(addedPath)) ??
          firstSource;
        deleted.delete(source);
        moved.set(source, addedPath);
        // No lookup cleanup is needed here (an old parked question): a
        // claimed source can't be re-claimed, since `sources` only accepts
        // paths still in `deleted` — and the copy annotations below subtract
        // the `moved` keys instead, keeping previousPathSetForHash intact.
      } else {
        // Set.difference treats the `moved` Map as set-like: its keys are the
        // moved-from paths, which is exactly what to subtract here.
        let sameContentPaths = previousPathSetForHash.difference(moved);
        if (sameContentPaths.size === 0) {
          // Every previous holder of this content was claimed as a move
          // source — point at where the content lives now instead, so a copy
          // is never mistaken for brand-new content. (No holder can still be
          // in `deleted` here, else this path would have claimed it as a
          // move; the filter only narrows the type.)
          sameContentPaths = new Set(
            Array.from(previousPathSetForHash, (path) =>
              moved.get(path),
            ).filter((path) => path !== undefined),
          );
        }
        added.set(addedPath, sameContentPaths);
      }
    } else {
      added.set(addedPath, new Set());
    }
  }

  return {
    added,
    moved,
    modified,
    deleted,
  };
}
