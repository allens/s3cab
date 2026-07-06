import { loadSet } from "../lib/env.mjs";
import { uploadSnapshot } from "../lib/remote.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
import { snapshot } from "./snapshot.mjs";

/**
 * Back up a set to the cloud (docs/design/backup.md): take a fresh snapshot of the
 * set, then upload it — or, with `--snapshot`, upload an existing snapshot
 * instead of taking a new one. A thin coordination of `snapshot()` and the
 * snapshot-uploader (`uploadSnapshot`); `backup` itself never hashes (the
 * snapshot already carries every hash) and never walks the filesystem.
 *
 * Every set is bound to a bucket at setup (ADR-0026), so `backup` just reads it
 * off the resolved set. As the porcelain, `backup` resolves the change-detection
 * baseline and hands it to the plumbing uploader: the set's **previous local
 * snapshot** (single-owner model — the local history is authoritative), or, on a
 * first backup with no previous snapshot, nothing — the uploader then LISTs the
 * store. The conditional PUT backstops either way (docs/design/backup.md).
 *
 * @typedef {Object} BackupResult
 * @property {string} set - The set backed up
 * @property {string} snapshot - The snapshot that was uploaded (fresh or `--snapshot`)
 * @property {number} candidates - Objects considered for upload (new since the last backup)
 * @property {number} uploaded - Those actually transferred (the rest were already in the store)
 *
 * @param {string} [setName] - Backup set to back up (default: the only set)
 * @param {{ snapshot?: string, debug?: boolean }} [options]
 * @returns {Promise<BackupResult>}
 */
export async function backup(setName, options = {}) {
  // Resolve the set and apply its env layer (its bucket's auth) on top of the
  // user env already loaded at the entry point (env.mjs, ADR-0022).
  const set = loadSet(setName);

  const snapshotDir = set.snapshotsDir;

  let name = options.snapshot;
  if (!name) {
    // Take a fresh snapshot, then upload the one just written — the latest
    // local snapshot. (snapshot() returns its diff, not the name it generated,
    // so read the name back rather than change that contract.)
    await snapshot(set.name, options);
    name = listSnapshotNames(snapshotDir, { latest: true });
    if (!name) {
      throw new Error(`No snapshot was produced for set '${set.name}'.`);
    }
  }

  // The change-detection baseline: the immediately-preceding local snapshot
  // (names are timestamps and sorted newest-first, so the first name below the
  // target is its predecessor). Undefined on a first backup → the uploader LISTs.
  const since = listSnapshotNames(snapshotDir).find((n) => n < name);

  const { candidates, uploaded } = await uploadSnapshot({
    bucket: set.bucket,
    set: set.name,
    snapshotDir,
    name,
    since,
  });

  return { set: set.name, snapshot: name, candidates, uploaded };
}
