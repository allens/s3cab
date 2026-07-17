import assert from "node:assert";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT } from "./error.mjs";
import { listObjectHashes, putObject } from "./objects.mjs";
import { remoteSnapshotUri } from "./remote.mjs";
import { putFile } from "./s3.mjs";
import { readSnapshot, snapshotFileName } from "./snapshot-file.mjs";

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
    // Guard the snapshot→upload window: the store trusts the hash on write, so
    // PUTting a file that changed since the snapshot would file its *current*
    // bytes under the *old* content's hash — corrupting that object for every
    // snapshot and path that dedups to it, surfacing only at restore
    // (proposals/bugs.md). Re-check the planned file's size+mtime against what
    // the snapshot recorded (the same staleness test `fileProps` uses to call a
    // file unchanged) and abort rather than store mismatched bytes. First drift
    // stops the run: objects already uploaded stay (content-addressed, reused on
    // re-run), but no snapshot is published referencing an object we couldn't
    // store correctly — the objects-first/snapshot-last invariant, kept absolute.
    const recorded = target.get(path);
    assert(recorded, `upload: planned path '${path}' absent from the snapshot`);
    const current = await lstat(path).catch((error) => {
      if (isENOENT(error)) {
        return null; // removed since the snapshot — drift, handled below
      }
      throw error;
    });
    if (
      !current ||
      current.size !== recorded.size ||
      current.mtime.toISOString() !== recorded.mtime
    ) {
      throw staleFileError(path, set);
    }

    const didUpload = await putObject(bucket, hash, path);
    if (didUpload) {
      uploaded++;
    }
  }

  // The snapshot, last. No-clobber, and a duplicate remote name is an error.
  const snapshotUri = remoteSnapshotUri(bucket, set, name);
  const snapshotPath = join(snapshotDir, snapshotFileName(name));
  const wrote = await putFile(snapshotPath, snapshotUri, { noClobber: true });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (${snapshotUri}). ` +
        `Snapshots are immutable and never overwritten (docs/design/backup.md).`,
    );
  }

  return { name, candidates: plan.size, uploaded };
}

/**
 * The "a file changed under us mid-backup" error `uploadSnapshot` raises when a
 * planned file's on-disk size/mtime no longer matches what the snapshot
 * recorded (or the file is gone). Uploading its current bytes would file them
 * under the snapshot's *old*-content hash, corrupting that object across the
 * dedup graph (proposals/bugs.md), so the run stops here. A named factory
 * because the message is heavy and actionable (error.mjs taxonomy); a plain
 * Error, caught by no one — it flows to the CLI top-level and exits non-zero.
 * Wording follows ADR-0030: goal-framed headline, the fix as a copy-pasteable
 * command, the durable option (exclude) with its guide link.
 * @param {string} path - The file that changed since the snapshot
 * @param {string} set - The set being backed up (names the re-run command)
 * @returns {Error}
 */
const staleFileError = (path, set) =>
  new Error(
    `Can't back up '${path}' safely — it changed or was removed while the ` +
      `backup was running, so it no longer matches what the snapshot recorded ` +
      `a moment ago.\n\n` +
      `s3cab stopped rather than store mismatched bytes under the snapshot's ` +
      `fingerprint, which it could not have restored correctly later. Nothing ` +
      `already uploaded is lost — take a fresh snapshot and back up again:\n` +
      `  s3cab backup ${set}\n\n` +
      `If a file changes this often — a live database, or a file another ` +
      `program is still writing — it isn't a good fit for content-addressed ` +
      `backup; exclude it from the set: https://s3cab.plantegral.com/guide/exclude`,
  );
