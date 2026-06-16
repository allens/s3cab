import { loadEnv } from "../lib/auth.mjs";
import {
  latestRemoteSnapshot,
  readRemoteSnapshot,
  uploadCandidates,
} from "../lib/remote.mjs";
import { resolveRemoteSet, setSnapshotsDir } from "../lib/sets.mjs";
import { readSnapshot } from "../lib/snapshot-file.mjs";
import { listSnapshotNames } from "./list.mjs";

/**
 * Show what is backed up and what a backup would upload (specs/backup.md): the
 * read-only half of the uploader's diff — the set's latest *local* snapshot
 * compared against its latest *remote* manifest, with no writes. It reuses
 * `uploadCandidates`, the very diff `backup` runs (steps 1–2 of "how backup
 * computes the upload set"), so `status` and `backup` never disagree.
 *
 * `status` does not take a snapshot (it is read-only), so it reports against the
 * latest *existing* local snapshot — run `snapshot` first to reflect newer
 * on-disk changes. `toUpload` is the candidate count versus the latest remote
 * manifest; the objects cache and the conditional PUT may transfer fewer in
 * practice (an optimization `backup` applies, not part of this estimate).
 *
 * @param {string} [setName] - Backup set to report on (default: the only set)
 * @returns {Promise<{ set: string, snapshot: string, backedUp: string | null, toUpload: number }>}
 *   `snapshot` = latest local snapshot (the upload target); `backedUp` = latest
 *   remote snapshot (null if never backed up); `toUpload` = objects a backup would upload.
 */
export async function status(setName) {
  const set = resolveRemoteSet(setName);
  loadEnv({ set: set.name });

  const snapshotDir = setSnapshotsDir(set.name);
  const localName = listSnapshotNames(snapshotDir, { latest: true });
  if (!localName) {
    throw new Error(
      `No snapshot yet for set '${set.name}'. ` +
        `Take one with: s3cab snapshot ${set.name}`,
    );
  }
  const target = await readSnapshot(snapshotDir, localName);

  const remoteName = await latestRemoteSnapshot(set.bucket, set.namespace);
  const remote = remoteName
    ? (await readRemoteSnapshot(set.bucket, set.namespace, remoteName)).entries
    : new Map();

  const candidates = uploadCandidates(target, remote);

  return {
    set: set.name,
    snapshot: localName,
    backedUp: remoteName ?? null,
    toUpload: candidates.size,
  };
}
