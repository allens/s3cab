import { join } from "node:path";
import { listObjectHashes, putObject } from "./objects.mjs";
import { remoteSnapshotsPrefix } from "./remote.mjs";
import { putFile } from "./s3.mjs";
import { readSnapshot } from "./snapshot-file.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

// The upload verb module: the planner (`planUpload`, pure) and its executor
// (`uploadSnapshot`, the PUT loop + the objects-first/snapshot-last invariant)
// — the plan/execute split `restore.mjs` and `cleanup.mjs` also follow
// (docs/design/backup.md). remote.mjs stays the remote snapshot-*store* module
// and keeps sole ownership of the `snapshots/` prefix (imported here, so the
// layout is still spelled in exactly one place); objects.mjs owns `objects/`.

/**
 * The upload plan: which objects a backup must PUT, and from which local path
 * — `Map<hash, path>`, first path wins, so identical content under many names
 * uploads once. Pure decision logic (no I/O of its own — unit tests feed it
 * in-memory Maps and arrays), the plan/execute twin of `planRestore` and
 * `planCleanup`.
 *
 * The plan is the target's hashes minus what's already stored
 * (docs/design/backup.md), subtracted from whichever sources the caller has:
 * - `baseline` — a snapshot whose objects were stored when it was uploaded:
 *   the set's previous **local** snapshot for `backup` (single-owner model —
 *   local history is authoritative), or the latest **remote** snapshot for
 *   `status`'s read-only estimate. Content-keyed, so a file that merely moved
 *   or was renamed is *not* re-uploaded (design #1).
 * - `listed` — the stored hashes from a one-time LIST of the object store (a
 *   first backup, which has no baseline). An (async) iterable, streamed with
 *   delete-as-you-scan so peak memory scales with the snapshot, never the
 *   (possibly huge) bucket — why this is not a materialized Set.
 * Both may be given; with neither, everything is planned. Either way the
 * conditional PUT (`noClobber`) stays the correctness backstop — the plan is
 * an optimization, never load-bearing.
 * @param {SnapshotEntries} target - The snapshot being backed up
 * @param {object} [stored] - What's already stored, by whichever source is known
 * @param {SnapshotEntries} [stored.baseline] - Snapshot to diff against
 * @param {AsyncIterable<string> | Iterable<string>} [stored.listed] - Stored
 *   object hashes from a LIST of the store
 * @returns {Promise<Map<string, string>>} hash → the local path to upload it from
 */
export async function planUpload(target, { baseline, listed } = {}) {
  /** @type {Set<string>} */
  const have = new Set();
  if (baseline) {
    for (const { hash } of baseline.values()) {
      have.add(hash);
    }
  }

  /** @type {Map<string, string>} */
  const plan = new Map();
  for (const [path, { hash }] of target) {
    if (!have.has(hash) && !plan.has(hash)) {
      plan.set(hash, path);
    }
  }

  if (listed) {
    for await (const hash of listed) {
      plan.delete(hash);
    }
  }

  return plan;
}

/**
 * Upload a local snapshot to the bucket: every object it references that isn't
 * already stored, then the snapshot **last** — the objects-first/snapshot-last
 * invariant that makes a snapshot's mere presence proof its objects exist
 * (docs/design/backup.md). The lower-level uploader `backup` composes after taking a
 * snapshot; it never hashes (the snapshot already carries every hash) and never
 * walks the filesystem.
 *
 * What to PUT is `planUpload`'s decision; this executes the plan. With `since`,
 * the plan diffs against that previous local snapshot (no network read); with
 * no `since` (a first backup) the object store is LISTed once instead. The
 * snapshot is uploaded no-clobber too, but here a name that already exists
 * remotely is an **error**, never an overwrite (snapshots are immutable,
 * docs/design/backup.md).
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} args.snapshotDir - Local dir holding the snapshot (`<name>.tsv.zst`)
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @param {string} [args.since] - Baseline snapshot to skip against (a local snapshot
 *   name); omit for a first backup, which LISTs the store instead
 * @returns {Promise<{ name: string, candidates: number, uploaded: number }>}
 *   `candidates` = objects considered for upload; `uploaded` = those actually
 *   transferred (the rest were no-ops the conditional PUT found already present).
 */
export async function uploadSnapshot({
  bucket,
  set,
  snapshotDir,
  name,
  since,
}) {
  const { entries: target } = await readSnapshot(snapshotDir, name);

  /** @type {Map<string, string>} */
  let plan;
  if (since) {
    const { entries: baseline } = await readSnapshot(snapshotDir, since);
    plan = await planUpload(target, { baseline });
  } else {
    // First backup — no local baseline; LIST the store once instead.
    // Announce it: a large store can take a moment.
    console.warn("Scanning existing objects…");
    plan = await planUpload(target, { listed: listObjectHashes(bucket) });
  }

  let uploaded = 0;
  for (const [hash, path] of plan) {
    const didUpload = await putObject(bucket, hash, path);
    if (didUpload) {
      uploaded++;
    }
  }

  // The snapshot, last. No-clobber, and a duplicate remote name is an error.
  const snapshotKey = `${remoteSnapshotsPrefix(set)}${name}.tsv.zst`;
  const snapshotPath = join(snapshotDir, `${name}.tsv.zst`);
  const wrote = await putFile(snapshotPath, `s3://${bucket}/${snapshotKey}`, {
    noClobber: true,
  });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (s3://${bucket}/${snapshotKey}). ` +
        `Snapshots are immutable and never overwritten (docs/design/backup.md).`,
    );
  }

  return { name, candidates: plan.size, uploaded };
}
