import { loadSet } from "../lib/env.mjs";
import { pushSetConfig } from "../lib/set-marker.mjs";
import { readSetExclude } from "../lib/sets.mjs";
import { generateSnapshot, readBaseline } from "../lib/snapshot.mjs";
import {
  fileChangedError,
  storedHashes,
  uploadObjects,
  uploadSnapshotFile,
} from "../lib/upload.mjs";

/**
 * Back up a set to the cloud (docs/design/backup.md) — snapshot and upload in
 * **one fused pass** (ADR-0069): each file's object is PUT the moment its bytes
 * have been hashed, and the same row goes straight on into the snapshot TSV.
 * There is no write-the-whole-snapshot-then-read-it-back-to-upload round trip,
 * and no minutes-long window in which an edited file drifts out from under the
 * hash recorded for it.
 *
 * The composition, all of it over shared `lib` parts:
 * 1. **`readBaseline`** — the set's previous local snapshot: the hash lookup
 *    that spares unchanged files a re-read, and the upload baseline below.
 * 2. **`storedHashes`** — what needs no upload, decided *before* any hashing so
 *    a credentials or network problem surfaces in seconds rather than after a
 *    long pass. The single-owner model makes the previous **local** snapshot the
 *    authoritative baseline (ADR-0045), trusted only once `storedHashes` has
 *    confirmed it still exists remotely; a first backup LISTs the store instead.
 * 3. **`generateSnapshot` with the object uploader spliced in** — the fused
 *    pass. The uploader is a pipe, not a callback: it consumes rows and yields
 *    them on unchanged, so a backup writes byte-for-byte the snapshot a plain
 *    `snapshot` would have written.
 * 4. **`uploadSnapshotFile`** — the manifest, *last*, once the pipeline has
 *    drained: the objects-first/snapshot-last invariant, kept absolute.
 *
 * **Nothing that goes wrong up there costs the hash pass.** The uploader never
 * throws mid-stream, so the local snapshot always lands complete: a failed
 * transfer is resumed with `upload <set> --snapshot <name>`, and even a file that
 * drifted only costs a fresh `backup`, which reads that snapshot as its hash
 * lookup and so re-reads nothing that didn't change.
 *
 * @typedef {Object} BackupResult
 * @property {string} set - The set backed up
 * @property {string} snapshot - The fresh snapshot that was uploaded
 * @property {number} candidates - Objects considered for upload (new since the last backup)
 * @property {number} uploaded - Those actually transferred (the rest were already in the store)
 *
 * With no update mode ([ADR-0052](../../docs/adr/0052-retire-setup-update-mode.md)),
 * a set's `dirs.txt`/`exclude.txt` are edited by hand, so `backup` is where those
 * edits re-sync to the remote `sets/<name>/` marker (which a later `reattach`
 * reads). It's best-effort metadata: a failure there must not fail a backup whose
 * objects + snapshot are already safely up — the next backup re-publishes.
 *
 * @param {string} [setName] - Backup set to back up (default: the only set)
 * @param {{ debug?: boolean }} [options]
 * @returns {Promise<BackupResult>}
 */
export async function backup(setName, options = {}) {
  // Resolve the set and apply its env layer (its bucket's auth) over the ambient
  // shell (env.mjs, ADR-0022/0055 — the one s3cab layer), before any S3 call.
  const set = loadSet(setName);

  const {
    name: since,
    previous,
    lookup,
    instant: previousInstant,
  } = await readBaseline(set);
  const stored = await storedHashes({
    bucket: set.bucket,
    set: set.name,
    since,
    baseline: previous,
  });

  const uploader = uploadObjects({
    bucket: set.bucket,
    stored,
    ownProgress: true,
  });
  const { name } = await generateSnapshot(set, {
    lookup,
    previousInstant,
    through: uploader.through,
    // Both halves of the fused pass report into one progress line: `through`
    // does the sending, `transfer` is how that sending is going.
    transfer: uploader.transfer,
    debug: options.debug,
  });

  // The snapshot file has landed locally whatever happened above — that is what
  // makes the retry cheap — so an upload failure surfaces only now, and no
  // manifest is ever published for objects that didn't all make it.
  //
  // Which retry to name depends on the kind of failure (ADR-0069): a file that
  // changed under us can never be reconciled with the snapshot that recorded it,
  // so it asks for a fresh backup; anything else is a transfer that can simply be
  // resumed. The transport failure is checked **first** — it is the terminal one,
  // and it must not be spoken for by a drift met on an earlier row.
  const { candidates, uploaded, drifted, failure } = uploader.result();
  if (failure) {
    throw uploadFailedError(failure, set.name, name);
  }
  if (drifted.length > 0) {
    throw fileChangedError(drifted, set.name);
  }

  await uploadSnapshotFile({
    bucket: set.bucket,
    set: set.name,
    snapshotDir: set.snapshotsDir,
    name,
  });

  // Re-sync the set's published config to the remote marker (ADR-0052): the
  // objects + snapshot are already up, so this is best-effort metadata — a hiccup
  // here leaves the marker stale until the next backup, never a failed backup.
  try {
    await pushSetConfig(set.bucket, set.name, {
      dirs: set.dirs,
      exclude: readSetExclude(set.name),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `Backed up. (Couldn't refresh this set's cloud config just now — ${detail}. ` +
        `It'll re-sync on your next backup.)`,
    );
  }

  return { set: set.name, snapshot: name, candidates, uploaded };
}

/**
 * The "the bytes didn't all make it" error a backup ends with when an upload
 * failed mid-pass. Its whole job is to say that the *hashing* wasn't wasted —
 * the snapshot is on disk, so the retry transfers what's left instead of
 * re-reading the set (ADR-0069). A named factory (heavy, actionable message —
 * error.mjs taxonomy), worded per ADR-0030: the user's goal first, the cause in
 * a parenthetical, the fix as a copy-pasteable command.
 * @param {Error} cause - The upload failure that stopped the transfers
 * @param {string} set - The set being backed up
 * @param {string} name - The snapshot that was written locally
 * @returns {Error}
 */
const uploadFailedError = (cause, set, name) =>
  new Error(
    `Couldn't finish backing up — sending your files to the cloud stopped ` +
      `part-way (${cause.message}).\n\n` +
      `The snapshot of what's on this computer is saved, so nothing has to be ` +
      `read or hashed again. Once the problem is sorted, carry on from where it ` +
      `stopped:\n` +
      `  s3cab upload ${set} --snapshot ${name}`,
    { cause },
  );
