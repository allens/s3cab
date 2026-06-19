import { loadEnv } from "../lib/env.mjs";
import { readLatestRemoteSnapshot, uploadCandidates } from "../lib/remote.mjs";
import { resolveRemoteSet, setSnapshotsDir } from "../lib/sets.mjs";
import { readSnapshot } from "../lib/snapshot-file.mjs";
import { listSnapshotNames } from "./list.mjs";

/**
 * Show what is backed up and what a backup would upload (specs/backup.md): the
 * read-only half of the uploader's diff — the set's latest *local* snapshot
 * compared against its latest *remote* snapshot, with no writes. It reuses
 * `uploadCandidates`, the very diff `backup` runs (steps 1–2 of "how backup
 * computes the upload set"), so `status` and `backup` never disagree.
 *
 * `status` does not take a snapshot (it is read-only), so it reports against the
 * latest *existing* local snapshot — run `snapshot` first to reflect newer
 * on-disk changes. `toUpload` is deliberately this pre-cache diff — "what is new
 * since your last backup", a property of the two snapshots that reads the same
 * on any machine — not a prediction of the bytes the next `backup` will push:
 * the objects cache that narrows `backup` further is local and machine-specific,
 * and even it is inexact given the conditional-PUT safety net. So the cache and
 * the conditional PUT may transfer fewer in practice (an optimization `backup`
 * applies, not part of this estimate).
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
  const { entries: target } = await readSnapshot(snapshotDir, localName);

  const { name: remoteName, lookup: remote } = await readLatestRemoteSnapshot(
    set.bucket,
    set.namespace,
  );

  const candidates = uploadCandidates(target, remote);

  return {
    set: set.name,
    snapshot: localName,
    backedUp: remoteName ?? null,
    toUpload: candidates.size,
  };
}
