import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSet } from "../lib/env.mjs";
import {
  matchRemoteSnapshot,
  readLatestRemoteSnapshot,
} from "../lib/remote.mjs";
import {
  listSnapshotNames,
  readSnapshot,
  snapshotFileName,
} from "../lib/snapshot-file.mjs";
import {
  getUndeletedHashes,
  listStoredHashes,
  planUpload,
} from "../lib/upload.mjs";

/**
 * Show what is backed up and what a backup would upload (docs/design/backup.md): the
 * read-only half of the uploader's diff — the set's latest *local* snapshot
 * compared against its latest *remote* snapshot, with no writes. It reuses
 * `planUpload` over `getUndeletedHashes` — the same "is this content already
 * stored?" rule `backup` applies row by row as it hashes (steps 1–2 of "how
 * backup computes the upload set"), asked here of a whole snapshot at once, so
 * `status` and `backup` never disagree.
 *
 * `status` does not take a snapshot (it is read-only), so it reports against the
 * latest *existing* local snapshot — run `snapshot` first to reflect newer
 * on-disk changes. Whether that snapshot is backed up is whether the bucket
 * holds it, not whether it is the bucket's latest: another machine's
 * later backup of the set, or a newest local file removed by hand, leaves the
 * bucket newer than this machine with nothing of this machine's missing from it
 * ([ADR-0117](../../docs/adr/0117-health-reports-count-only-what-they-checked.md)).
 * Holding it means byte for byte, not by name: two machines can mint one
 * minute's name ([ADR-0084](../../docs/adr/0084-snapshot-identity-byte-equality.md)).
 * "Latest" is by name, as everywhere, but a snapshot started after it under a
 * name that sorts earlier — the clock went back — is reported too
 * (`takenLater`), so `up to date` is never said over a snapshot taken last.
 * `toUpload` is deliberately the target-vs-latest-remote diff —
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
 * @property {"identical" | "different" | "absent"} snapshotInBucket - What the bucket holds under `snapshot`'s name: it, byte for byte (backed up), another snapshot, or nothing
 * @property {string[]} takenLater - Local snapshots the bucket doesn't hold, started after `snapshot` under names that sort before it; looked for only when `snapshot` is backed up
 * @property {string | null} backedUp - Latest remote snapshot (null if never backed up)
 * @property {number} toUpload - Objects a backup would upload
 *
 * @param {string} [setName] - Backup set to report on (default: the only set)
 * @returns {Promise<StatusReport>}
 */
export async function status(setName) {
  const set = loadSet(setName);

  const snapshotDir = set.snapshotsDir;
  const [localName, ...older] = listSnapshotNames(snapshotDir);
  if (!localName) {
    throw new Error(
      `No snapshot yet for set '${set.name}'. ` +
        `Take one with: s3cab snapshot ${set.name}`,
    );
  }
  const { entries: target, instant: start } = await readSnapshot(
    snapshotDir,
    localName,
  );

  const {
    names: remoteNames,
    lookup: remote,
    bytes: remoteLatest,
  } = await readLatestRemoteSnapshot(set.bucket, set.name);

  /** @type {StatusReport["snapshotInBucket"]} */
  let snapshotInBucket = "absent";
  if (localName === remoteNames.at(0) && remoteLatest !== undefined) {
    const local = await readFile(
      join(snapshotDir, snapshotFileName(localName)),
    );
    snapshotInBucket = local.equals(remoteLatest) ? "identical" : "different";
  } else if (remoteNames.includes(localName)) {
    snapshotInBucket = await matchRemoteSnapshot(
      set.bucket,
      set.name,
      localName,
      snapshotDir,
    );
  }

  // Which was taken last, where the names can't say: daylight saving's
  // repeated hour, or a move west, mints a name that sorts before one already
  // taken. Each snapshot's recorded start says; a file's mtime doesn't, since a
  // pull writes the newest first and a copy rewrites them all. Instants compare
  // as text (guide/format.md). A name is local time and no two zones are more
  // than 26 hours apart, so only a snapshot named less than that before the
  // latest can have started after it, and no other is read.
  /** @type {string[]} */
  const takenLater = [];
  if (snapshotInBucket === "identical" && start) {
    const latest = Temporal.PlainDateTime.from(localName);
    for (const name of older) {
      if (Temporal.PlainDateTime.from(name).until(latest).total("hours") > 26) {
        break;
      }
      if (remoteNames.includes(name)) {
        continue;
      }
      const { instant } = await readSnapshot(snapshotDir, name);
      if (instant && instant > start) {
        takenLater.push(name);
      }
    }
  }

  // A damaged deletion record can't vouch for the remote snapshot, so the store
  // is listed instead — what `backup` does too.
  let stored = await getUndeletedHashes(set.bucket, remote);
  stored ??= await listStoredHashes(set.bucket);
  const plan = planUpload(target, stored);

  return {
    set: set.name,
    snapshot: localName,
    snapshotInBucket,
    takenLater,
    backedUp: remoteNames.at(0) ?? null,
    toUpload: plan.size,
  };
}
