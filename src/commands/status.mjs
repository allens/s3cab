import { loadSet } from "../lib/env.mjs";
import { readLatestRemoteSnapshot } from "../lib/remote.mjs";
import { listSnapshotNames, readSnapshot } from "../lib/snapshot-file.mjs";
import { baselineHashes, planUpload } from "../lib/upload.mjs";

/**
 * Show what is backed up and what a backup would upload (docs/design/backup.md): the
 * read-only half of the uploader's diff — the set's latest *local* snapshot
 * compared against its latest *remote* snapshot, with no writes. It reuses
 * `planUpload` over `baselineHashes` — the same "is this content already
 * stored?" rule `backup` applies row by row as it hashes (steps 1–2 of "how
 * backup computes the upload set"), asked here of a whole snapshot at once, so
 * `status` and `backup` never disagree.
 *
 * `status` does not take a snapshot (it is read-only), so it reports against the
 * latest *existing* local snapshot — run `snapshot` first to reflect newer
 * on-disk changes. `toUpload` is deliberately the target-vs-latest-remote diff —
 * "what is new since your last backup", a property of the two snapshots that
 * reads the same on any machine — not a prediction of the exact bytes the next
 * `backup` will push: `backup` diffs against the local previous snapshot and the
 * conditional-PUT safety net still no-ops anything already stored, so it may
 * transfer fewer in practice (an optimization `backup` applies, not part of this
 * estimate).
 *
 * @typedef {Object} StatusReport
 * @property {string} set - The set reported on
 * @property {string} snapshot - Latest local snapshot (the upload target)
 * @property {string | null} backedUp - Latest remote snapshot (null if never backed up)
 * @property {number} toUpload - Objects a backup would upload
 *
 * @param {string} [setName] - Backup set to report on (default: the only set)
 * @returns {Promise<StatusReport>}
 */
export async function status(setName) {
  const set = loadSet(setName);

  const snapshotDir = set.snapshotsDir;
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
    set.name,
  );

  const plan = planUpload(target, baselineHashes(remote));

  return {
    set: set.name,
    snapshot: localName,
    backedUp: remoteName ?? null,
    toUpload: plan.size,
  };
}
