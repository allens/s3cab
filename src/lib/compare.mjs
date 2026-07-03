import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { listSnapshotNames, readSnapshot } from "./snapshot-file.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * @typedef {Object} CompareResult
 * @property {string[]} added
 * @property {string[]} moved
 * @property {string[]} modified
 * @property {string[]} deleted
 * @property {string[]} errors - Files the newer snapshot couldn't hash, each as
 *   `path (reason)` where reason is the recorded error message
 */

/**
 * Accept either a bare snapshot name (as `list` reports) or a full snapshot
 * filename, by stripping the `.tsv`/`.tsv.zst` extension.
 * @param {string} [name]
 */
const normalizeName = (name) => name?.replace(/\.tsv(\.zst)?$/, "");

/**
 * Display a snapshot's absolute path relative to its containing member
 * directory — so a set's report reads `2025\beach.jpg`, not the full path. A
 * single-root set is unchanged from the per-directory days; with several roots
 * each path is shortened against whichever one contains it (the shortest
 * relative wins when roots nest). A path under no root falls back to absolute.
 * @param {string[]} dirs - The set's member directories
 * @param {string} path - An absolute snapshot path
 */
function relativeToRoot(dirs, path) {
  /** @type {string | undefined} */
  let best;
  for (const root of dirs) {
    const rel = relative(root, path);
    // Inside the root unless `rel` escapes it: a leading `..` *segment* (exactly
    // `..`, or `..` + separator), or an absolute path. A prefix check alone
    // would wrongly reject an in-root name that merely starts with `..`
    // (e.g. `..foo/file.txt`).
    const escapes =
      rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
    if (rel && !escapes) {
      if (best === undefined || rel.length < best.length) {
        best = rel;
      }
    }
  }
  return best ?? path;
}

/**
 * Diff two snapshots from a snapshot directory, displaying paths relative to
 * `dirs` (the set's member directories). The engine behind the `compare`
 * command, reused by `snapshot` for its post-snapshot report.
 *
 * Naming a snapshot that doesn't exist is an error, never a silent empty
 * result. When `until` is the oldest snapshot (or the only one), the baseline
 * is empty and everything reports as added.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {string[]} dirs - The set's member directories (for path display)
 * @param {object} [options]
 * @param {string} [options.since] - Older snapshot to compare from (default: the one before `until`)
 * @param {string} [options.until] - Newer snapshot to compare to (default: latest)
 * @param {string} [options.setName] - The set's name, for the "no snapshots yet" guidance
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compareSnapshots(snapshotDir, dirs, options = {}) {
  const snapshotNames = listSnapshotNames(snapshotDir);

  // Newer side (`until`) defaults to the latest snapshot.
  const until = normalizeName(options.until) ?? snapshotNames.at(0);
  if (!until) {
    throw new Error(
      `No snapshots to compare yet for set '${options.setName}'.\n` +
        `Take one first with:\n  s3cab snapshot ${options.setName}`,
    );
  }
  const untilSnapshot = await readSnapshot(snapshotDir, until);

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

  /** @type {SnapshotEntries} */
  let sinceEntries;
  if (since === undefined) {
    // Nothing older than `until`: an empty baseline; everything is "added".
    sinceEntries = new Map();
  } else {
    const sinceSnapshot = await readSnapshot(snapshotDir, since);
    sinceEntries = sinceSnapshot.entries;
  }
  console.warn(
    "Comparing",
    since ? `'${since}'` : "(nothing)",
    "→",
    `'${until}'`,
  );

  const { added, moved, modified, deleted } = diff(
    sinceEntries,
    untilSnapshot.entries,
  );

  // A file the `until` snapshot couldn't hash parses into `errors`, not
  // `entries`, so `diff` never sees it. Report those paths under their own
  // category, and pull any out of `deleted`: a path present in the older
  // snapshot that errored in the newer one is not a deletion, just unreadable.
  for (const path of untilSnapshot.errors.keys()) {
    deleted.delete(path);
  }

  return {
    added: Array.from(added.entries()).map(([path, previousPaths]) => {
      let text = relativeToRoot(dirs, path);
      if (previousPaths && previousPaths.size) {
        text += " == ";
        text += Array.from(previousPaths, (path) => relativeToRoot(dirs, path));
      }
      return text;
    }),
    moved: Array.from(moved.entries()).map(([oldPath, newPath]) => {
      let text = relativeToRoot(dirs, oldPath);
      text += dirname(oldPath) === dirname(newPath) ? " → " : " →→ ";
      text += relativeToRoot(dirs, newPath);
      return text;
    }),
    modified: Array.from(modified, (path) => relativeToRoot(dirs, path)),
    deleted: Array.from(deleted, (path) => relativeToRoot(dirs, path)),
    errors: Array.from(
      untilSnapshot.errors,
      ([path, reason]) => `${relativeToRoot(dirs, path)} (${reason})`,
    ),
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
 * @param {SnapshotEntries} snapshotLookup - Snapshot lookup
 * @returns {Map<string,PathSet>} Hash to path set lookup
 */
function getPathsByHash(snapshotLookup) {
  /** @type {Map<string,PathSet>} */
  const hashLookup = new Map();

  snapshotLookup.forEach(({ hash }, path) => {
    hashLookup.getOrInsertComputed(hash, () => new Set()).add(path);
  });

  return hashLookup;
}

/**
 * Diff two snapshots. Neither input is modified.
 *
 * Classification rules (each pinned by a test in compare.test.mjs; the
 * user-facing guide is guide/compare.md):
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
 * - Files that failed hashing are not entries — they parse into the snapshot's
 *   `errors` map, not `currentSnapshot` — so `diff` never sees them.
 *   `compareSnapshots` reports them under its own `errors` category and keeps
 *   them out of `deleted`.
 * @param {SnapshotEntries} previousSnapshot - Previous snapshot lookup
 * @param {SnapshotEntries} currentSnapshot - Current snapshot
 * @returns {DiffResult} Diff results
 */
export function diff(previousSnapshot, currentSnapshot) {
  /** @type {PathDuplicatesLookup} */ // new paths - mapped to matching paths in previous snapshot
  const added = new Map();

  /** @type {PathFromToLookup} */ // from to path
  const moved = new Map();

  /** @type {PathSet} */ // modified paths - files that have changed
  const modified = new Set();

  /** @type {PathSet} */
  const deleted = new Set();

  const previousPathsByHash = getPathsByHash(previousSnapshot);

  // Paths only in the current snapshot; both-side paths are settled first.
  const currentOnly = new Map(currentSnapshot);

  previousSnapshot.forEach(({ hash }, path) => {
    const currentProps = currentOnly.get(path);
    if (currentProps) {
      currentOnly.delete(path);
      if (currentProps.hash !== hash) {
        modified.add(path);
      }
    } else {
      deleted.add(path);
    }
  });

  // Phase two: what's left in currentOnly is the added paths — classify each as
  // genuinely new, a move/rename, or a copy.
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
