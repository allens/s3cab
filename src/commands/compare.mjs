import { compareSnapshots } from "../lib/compare.mjs";
import { notImplemented } from "../lib/error.mjs";
import { resolveSet, setSnapshotsDir } from "../lib/sets.mjs";

/** @import { CompareResult } from "../lib/compare.mjs" */

/**
 * Show what changed between two of a backup set's snapshots, from an older
 * (`since`) to a newer (`until`) one (docs/specs/backup.md).
 * @param {string} [setName] - Backup set whose snapshots to compare (default: the only set)
 * @param {object} [options]
 * @param {string} [options.since] - Older snapshot to compare from (default: the one before `until`)
 * @param {string} [options.until] - Newer snapshot to compare to (default: latest)
 * @param {boolean} [options.remote] - Compare against snapshots on the remote
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compare(setName, options = {}) {
  if (options.remote) {
    notImplemented("compare --remote");
  }

  const set = resolveSet(setName);
  return compareSnapshots(setSnapshotsDir(set.name), set.dirs, options);
}
