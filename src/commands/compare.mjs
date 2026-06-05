import { realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { readSnapshot } from "../snapshot-file.mjs";
import { list } from "./list.mjs";

/**
 * @typedef {Object} CompareResult
 * @property {string[]} added
 * @property {string[]} moved
 * @property {string[]} modified
 * @property {string[]} deleted
 */

/**
 * Diff two snapshots.
 * @param {string} dir - Snapshot directory
 * @param {string} [currentSnapshotName] - Current snapshot name
 * @param {string} [previousSnapshotName] - Previous snapshot name
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compare(
  dir = ".",
  currentSnapshotName,
  previousSnapshotName,
) {
  dir = realpathSync.native(dir);

  const snapshotNames = list(dir);

  // Current snapshot
  if (!currentSnapshotName) {
    currentSnapshotName = snapshotNames.at(0);
  }
  if (!currentSnapshotName) {
    throw new Error(`No snapshots found in directory: ${dir}`);
  }
  const currentSnapshot = await readSnapshot(dir, currentSnapshotName);

  // Previous snapshot
  if (!previousSnapshotName) {
    const currentSnapshotIndex = snapshotNames.indexOf(currentSnapshotName);
    previousSnapshotName = snapshotNames.at(currentSnapshotIndex + 1);
  }
  let previousSnapshot = await readSnapshot(dir, previousSnapshotName);
  if (!previousSnapshot) {
    previousSnapshot = new Map();
  } else {
    console.warn(
      "Comparing snapshot",
      `'${currentSnapshotName}'`,
      "with",
      `'${previousSnapshotName}'`,
    );
  }

  const { added, moved, modified, deleted } = diff(
    previousSnapshot,
    currentSnapshot,
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
 * @param {import("../snapshot-file.mjs").SnapshotLookup} snapshotLookup - Snapshot lookup
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
 * Diff two snapshots.
 * @param {import("../snapshot-file.mjs").SnapshotLookup} previousSnapshot - Previous snapshot lookup
 * @param {import("../snapshot-file.mjs").SnapshotLookup} currentSnapshot - Current snapshot
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

  previousPathsByHash.forEach((pathSet, hash) => {
    pathSet.forEach((path) => {
      const currentProps = currentSnapshot.get(path);
      if (currentProps) {
        currentSnapshot.delete(path);
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
  });

  // Now current lookup should only have new paths
  // We just need to work out of they are really new, moved, renamed
  for (const [addedPath, { hash }] of currentSnapshot) {
    const previousPathSetForHash = previousPathsByHash.get(hash);

    if (previousPathSetForHash) {
      let deletedPath = null;
      for (const pathForHash of previousPathSetForHash) {
        if (deleted.has(pathForHash)) {
          // moved!
          deletedPath = pathForHash;
          deleted.delete(pathForHash);
          moved.set(pathForHash, addedPath);
          // TODO: I'm not sure if this is needed
          // objectPaths.delete(path);
          break;
        }
      }

      if (!deletedPath) {
        const notMovedPaths = previousPathSetForHash.difference(moved);
        added.set(addedPath, notMovedPaths);
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
