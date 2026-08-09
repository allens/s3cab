import { compareSnapshots } from "../lib/compare.mjs";
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

/** @import { CompareResult } from "../lib/compare.mjs" */

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
 * **What a finished run reports** ([ADR-0078](../../docs/adr/0078-backup-run-report.md)):
 * in *files*, not objects — content-addressed dedup means a moved file changes
 * everything and uploads nothing, so an object count alone answers a question
 * nobody asked. `backup` states in full only what only `backup` knows (bytes,
 * timings, transfers), and hands the detail to `compare`: everything the
 * *snapshot* holds is a count plus a copy-pasteable command. Every figure lands
 * here rather than in the renderer, so `--json` gains it deliberately.
 *
 * @typedef {Object} BackupResult
 * @property {string} set - The set backed up
 * @property {string} bucket - Where its objects went
 * @property {string} snapshot - The fresh snapshot that was uploaded
 * @property {number} files - Files the pass went through
 * @property {number} bytes - Those files' total size — **not** bytes read off the disk, since an unchanged file reuses its stored hash and is never opened. Which is why the report says "Scanned", not "Hashed"
 * @property {number} scanMs - Milliseconds the pass spent on everything except sending: walking, stat-ing, and hashing whatever had changed
 * @property {number} candidates - Objects this backup attempted — the ones its skip-list (the trusted baseline, else a store LIST) didn't already account for
 * @property {number} uploaded - Those actually transferred (the rest were already in the store)
 * @property {number} uploadedBytes - Bytes those transfers moved
 * @property {number} uploadMs - Milliseconds spent sending them
 * @property {number} skipped - Entries the walk left out by design (a symlink, a socket)
 * @property {number} errors - Files that couldn't be read to be backed up
 * @property {CompareResult | null} comparison - What changed since the baseline; `null` on a first backup, which runs no comparison at all (ADR-0078 §7)
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
  const pass = await generateSnapshot(set, {
    lookup,
    // Doubles as the progress line's byte total — it already records a size for
    // every file, so the figure costs no `stat` (lib/snapshot.mjs `withProgress`).
    sizes: previous,
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
  const { name } = pass;
  const { candidates, uploaded, uploadedBytes, sendingMs, drifted, failure } =
    uploader.result();
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

  // What changed, computed by **`compare` itself** over the snapshot just
  // written, with the baseline handed straight in from memory — it already
  // accepts that form, and `readBaseline` above is holding those very entries
  // (ADR-0078 §8). Accumulating the diff during the fused pass would be cheaper
  // and would reimplement `compare`; a report reading "425 added" above a
  // command that then lists 424 is a trust bug in the one place this design asks
  // for trust. One parse of a file still in the page cache is the price of
  // "these cannot diverge".
  //
  // A first backup runs none of it (§7): every file is an addition against an
  // empty baseline, which is where the diff is both most expensive and least
  // worth having.
  const comparison =
    since && previous
      ? await compareSnapshots(set.snapshotsDir, set.dirs, {
          since: { name: since, entries: previous },
          until: name,
          setName: set.name,
        })
      : null;

  return {
    set: set.name,
    bucket: set.bucket,
    snapshot: name,
    files: pass.files,
    bytes: pass.bytes,
    // The pass minus the sending. The two are exclusive because the fused pass
    // is strictly sequential (ADR-0078 §9), so this really is the disk half —
    // which is the whole point: one combined figure makes 14.9GB in 11m 24s
    // read as a slow link when the time went on reading 1.8TB off the disk.
    scanMs: Math.max(0, pass.elapsedMs - sendingMs),
    candidates,
    uploaded,
    uploadedBytes,
    uploadMs: sendingMs,
    skipped: pass.skipped,
    errors: pass.errors,
    comparison,
  };
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
