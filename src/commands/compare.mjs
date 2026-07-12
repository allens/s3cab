import { compareSnapshots } from "../lib/compare.mjs";
import { loadSet } from "../lib/env.mjs";

/** @import { CompareResult } from "../lib/compare.mjs" */

/**
 * Show what changed between two of a backup set's snapshots, from an older
 * (`since`) to a newer (`until`) one (docs/design/backup.md).
 *
 * `compare` is **local-only** — there is no `--remote` mode
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)):
 * local snapshots are a superset of remote ones, so any two remote snapshots
 * already exist locally and a remote diff could only reproduce a local one. A
 * fresh machine gets full history because `reattach` pulls the set's
 * remote snapshot files down.
 * @param {string} [setName] - Backup set whose snapshots to compare (default: the only set)
 * @param {object} [options]
 * @param {string} [options.since] - Older snapshot to compare from (default: the one before `until`)
 * @param {string} [options.until] - Newer snapshot to compare to (default: latest)
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compare(setName, options = {}) {
  const set = loadSet(setName);
  return compareSnapshots(set.snapshotsDir, set.dirs, {
    ...options,
    setName: set.name,
  });
}
