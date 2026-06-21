import { prepareRemoteSet } from "../lib/env.mjs";
import { uploadSnapshot } from "../lib/remote.mjs";
import { setSnapshotsDir } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
import { snapshot } from "./snapshot.mjs";

/**
 * Back up a set to the cloud (docs/specs/backup.md): take a fresh snapshot of the
 * set, then upload it — or, with `--snapshot`, upload an existing snapshot
 * instead of taking a new one. A thin coordination of `snapshot()` and the
 * snapshot-uploader (`uploadSnapshot`); `backup` itself never hashes (the
 * snapshot already carries every hash) and never walks the filesystem.
 *
 * The set must have a bucket bound — a bucket-less set is a local-only snapshot
 * engine, so `backup` stops with the exact command to bind one. `--skip-cache`
 * bypasses the per-bucket objects cache (re-checking the cloud via the
 * conditional PUT instead) for when its sync is in doubt.
 *
 * @param {string} [setName] - Backup set to back up (default: the only set)
 * @param {{ snapshot?: string, "skip-cache"?: boolean, debug?: boolean }} [options]
 * @returns {Promise<{ set: string, snapshot: string, candidates: number, uploaded: number }>}
 *   `candidates` = objects considered for upload; `uploaded` = those actually
 *   transferred (the rest already in the store).
 */
export async function backup(setName, options = {}) {
  // Resolve the set and load its env (its bucket's auth layer) before any S3
  // access — the one front door for the set's remote (env.mjs, ADR-0022).
  const set = prepareRemoteSet(setName);

  const snapshotDir = setSnapshotsDir(set.name);

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

  const { candidates, uploaded } = await uploadSnapshot({
    bucket: set.bucket,
    set: set.name,
    snapshotDir,
    name,
    skipCache: options["skip-cache"],
  });

  return { set: set.name, snapshot: name, candidates, uploaded };
}
