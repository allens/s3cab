import assert from "node:assert";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stderr } from "node:process";
import { readDeletionRecords } from "./deletion-record.mjs";
import {
  ChangedWhileReadError,
  ContentMismatchError,
  isENOENT,
} from "./error.mjs";
import { fileProps, statProps } from "./file-props.mjs";
import { plural } from "./format.mjs";
import { holdUploadLock } from "./locks.mjs";
import { listObjectHashes, putObject, storedObjectSizes } from "./objects.mjs";
import { countedPass } from "./progress.mjs";
import { matchRemoteSnapshot, remoteSnapshotUri } from "./remote.mjs";
import { putFile } from "./s3.mjs";
import { assertHeld } from "./set-marker.mjs";
import { readSnapshot, snapshotFileName } from "./snapshot-file.mjs";
import { generateSnapshot, readBaseline } from "./snapshot.mjs";
import { shellCommand } from "./style.mjs";
import { readExcludePatterns, walkDirs } from "./walk.mjs";

/**
 * @import { Props, RowTransform, SnapshotEntries, SnapshotRow } from "./snapshot-file.mjs"
 * @import { Transfer } from "./s3.mjs"
 * @import { BackupSet } from "./sets.mjs"
 * @import { SnapshotBaseline, SnapshotPass } from "./snapshot.mjs"
 */

// The upload verb module: what counts as already stored (`storedHashes`), the
// streaming PUT transform over it (`uploadObjects`), and the four operations
// on top — `uploadSet` (the fused hash-and-upload pass behind `backup`),
// `uploadSnapshot` (re-read an existing snapshot), `uploadDir` (seed from a
// folder) and `uploadFile` (one object) — each ending, where a snapshot is
// involved, in `uploadSnapshotFile` (the manifest, last). remote.mjs stays the
// remote snapshot-*store* module and keeps sole ownership of the `snapshots/`
// prefix (imported here, so the layout is still spelled in exactly one
// place); objects.mjs owns `objects/`.
//
// Every one of the four runs under the upload lock (`holdUploadLock`,
// locks.mjs; [ADR-0112](../../docs/adr/0112-bucket-locks.md)), taken here and
// not by the commands: the lock is what makes an "already stored?" answer —
// a trusted baseline, a store LIST, a conditional PUT's 412 — safe to act on,
// and nothing can upload without passing through one of these, so no command
// has to know.
//
// `uploadObjects` is deliberately **source-agnostic** (ADR-0069): it consumes a
// stream of `[path, Props]` rows, wherever they come from — a snapshot file being
// re-read (`uploadSnapshot`), the hash pass of a live `backup`, which splices this
// same transform into its snapshot pipeline so each object ships milliseconds after
// it was hashed, or a walk of one folder (`uploadDir`). One PUT loop, one
// confirmation guard, three sources — and that is a correctness property, not
// tidiness: every path that hashes a file and then re-reads it to send it has a
// window in which the file can change underneath the hash recorded for it, so a
// second PUT loop is a second place for the guard to be missing from.

/**
 * The hashes a run may treat as **already stored** — the skip-list both upload
 * paths diff against, and the one place the baseline-vs-LIST decision lives
 * (docs/design/backup.md).
 *
 * With a `since` baseline it is that snapshot's hashes, but only once the
 * remote copy has been confirmed **byte-identical** to the local baseline file
 * (`matchRemoteSnapshot`, ADR-0084). The objects-first/snapshot-last invariant
 * makes a remote snapshot's presence proof its objects were stored, and cleanup
 * never deletes referenced objects — so a baseline still in the cloud is a
 * trustworthy skip-list. But only *this* baseline's presence proves anything:
 * names are minute-resolution wall clock, so another machine sharing the set
 * can hold the same name for a different snapshot, whose presence would vouch
 * for objects this machine never stored. A baseline that fails the check —
 * absent (forgotten remotely, or taken locally but never uploaded) or
 * different (someone else's) — may claim more is stored than is; a hash it
 * wrongly skips never reaches the conditional-PUT backstop, so the published
 * snapshot would reference a missing object. Drop it entirely — its skips are
 * exactly the untrusted data — and LIST the store instead, like a first backup.
 *
 * The result is a materialized Set, not a stream: the fused pipeline asks about
 * one row at a time, so membership has to be random-access. It is sized by the
 * store (a first backup's LIST) or by the baseline snapshot — the same order as
 * the snapshot Maps a run already holds.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} args.snapshotDir - Local dir holding the baseline (`<since>.tsv.gz`)
 * @param {string} [args.since] - The baseline snapshot's name (trust-checked remotely)
 * @param {SnapshotEntries} [args.baseline] - That baseline's entries; without both, the store is LISTed
 * @returns {Promise<Set<string>>} Hashes that need no upload
 */
export async function storedHashes({
  bucket,
  set,
  snapshotDir,
  since,
  baseline,
}) {
  if (since && baseline) {
    const match = await matchRemoteSnapshot(bucket, set, since, snapshotDir);
    // Byte-identical means this baseline exists remotely — the precondition
    // `getUndeletedHashes` needs for the deletion record to be complete for it.
    const undeleted =
      match === "identical"
        ? await getUndeletedHashes(bucket, baseline)
        : undefined;
    if (undeleted) {
      return undeleted;
    }
    console.warn(
      match === "absent"
        ? `Baseline snapshot '${since}' is no longer in the cloud — ` +
            `checking what's stored instead.`
        : match === "different"
          ? `The cloud's snapshot '${since}' isn't the one on this computer — ` +
            `another machine backing up the set '${set}' may have taken it. ` +
            `Checking what's stored instead.`
          : `The deletion record in 's3://${bucket}' is damaged, or changed ` +
            `while it was read, so it can't say what's been deleted since ` +
            `'${since}' — checking what's stored instead.`,
    );
  }

  return listStoredHashes(bucket);
}

/**
 * Every hash in the store, from one LIST — what a run treats as already stored
 * when no baseline can vouch for it.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<Set<string>>}
 */
export async function listStoredHashes(bucket) {
  // No trustworthy baseline — LIST the store once instead. This is the one step
  // of a backup's preamble whose cost nothing on screen predicts: it is sized by
  // the whole bucket, not by the set being backed up, and it used to print its
  // announce and then go silent for the duration. So it gets `walkDirs`' line —
  // label, count redrawn in place as the LIST paginates, closing tally and
  // elapsed time. The announce still precedes the LIST (ADR-0044/0045); it is now
  // the first draw of that line rather than a line of its own.
  //
  // It names the bucket because nothing else in a backup's output does — the
  // preamble names the set's directories and s3cab's home, but the remote it is
  // talking to went unsaid — and because this is the line whose scope the bucket
  // *explains*: the count is the whole repository's, which is why it can dwarf
  // the set. Same shape as `walkDirs`' `Finding files in '<dir>'…`, quotes and
  // all. Bucket only, no `objects/`: the prefix is internal layout
  // (guide/format.md), while `s3://<bucket>` is the thing the user configured.
  /** @type {Set<string>} */
  const stored = new Set();

  // A clock, not the arriving keys, drives this line — the data comes in bursts.
  // `listObjects` does `yield* page.Contents`, so a whole LIST page (1,000 keys)
  // drains with no wait between items: redrawing per key meant the count only
  // ever appeared as a multiple of 1,000 *plus one* and then sat still for the
  // next round trip. A counted pass samples whatever has really landed at the
  // moment it draws, and its elapsed figure keeps moving across the wait rather
  // than freezing on it — and it stops on its own if the LIST throws, which is
  // what retires the `try`/`finally` this used to need.
  //
  // The label is painted before the first request, not once objects are already
  // arriving: ADR-0044/0045 put this announce *ahead* of the LIST precisely
  // because the wait is unpredictable, and a bucket slow to answer is exactly
  // when a blank screen reads as a hang.
  using progress = countedPass(
    stderr,
    `Scanning existing objects in 's3://${bucket}'…`,
    () => stored.size,
  );

  for await (const hash of listObjectHashes(bucket)) {
    stored.add(hash);
  }

  progress.done();
  return stored;
}

/**
 * The hashes a snapshot that exists remotely still vouches for as stored: its
 * content hashes, minus those a later `delete` removed (ADR-0064, ADR-0090).
 * Existing remotely proves the snapshot's objects were stored *then*; the
 * deletion record says which may be gone since. Without the subtraction the
 * snapshot wrongly vouches for deleted content — `backup` would publish a
 * snapshot referencing missing objects, and `status` would undercount what a
 * backup uploads.
 *
 * **Presence wins** (guide/format.md): a recorded hash is subtracted only if
 * its object is really absent, so each one the snapshot references is HEADed.
 * Not the record alone — deleted content re-uploads on the next backup and its
 * row stays, never trimmed while a snapshot references it, so every later
 * backup would re-PUT it and `status` would count it forever.
 *
 * **Only for a snapshot that still exists remotely.** That is what keeps the
 * record complete for it: a remote snapshot is a live reference to its hashes,
 * so `cleanup` cannot trim the rows this subtraction needs. One LIST of the
 * record files — empty, and free, for repositories that never ran `delete`.
 *
 * **Only while the record is valid** (ADR-0101): a file with a refused row may
 * have lost a deletion, which would leave the snapshot vouching for deleted
 * content — so this returns `undefined`, and the caller lists the store.
 * @param {string} bucket - The repository's S3 bucket
 * @param {SnapshotEntries} entries - The remote snapshot's entries
 * @returns {Promise<Set<string> | undefined>}
 */
export async function getUndeletedHashes(bucket, entries) {
  const { deleted, invalid } = await readDeletionRecords(bucket);
  if (invalid.length > 0) {
    return undefined;
  }
  /** @type {Set<string>} */
  const stored = new Set();
  for (const { hash } of entries.values()) {
    stored.add(hash);
  }
  const sizes = await storedObjectSizes(bucket, [
    ...stored.intersection(deleted),
  ]);
  for (const [hash, size] of sizes) {
    if (size === undefined) {
      stored.delete(hash);
    }
  }
  return stored;
}

/**
 * Which objects a snapshot would upload against what's already `stored`, and
 * from which local path — `Map<hash, path>`, first path wins, so identical
 * content under many names uploads once. Content-keyed, so a file that merely
 * moved or was renamed is *not* re-uploaded (design #1).
 *
 * Pure decision logic, and the batch twin of the per-row rule `uploadObjects`
 * applies as rows stream past (the same question, asked of a whole snapshot at
 * once). `status` is its caller: the read-only "what would a backup upload"
 * estimate, computed without touching the store.
 * @param {SnapshotEntries} target - The snapshot being backed up
 * @param {Set<string>} stored - Hashes that need no upload (`storedHashes`)
 * @returns {Map<string, string>} hash → the local path to upload it from
 */
export function planUpload(target, stored) {
  /** @type {Map<string, string>} */
  const plan = new Map();
  for (const [path, { hash }] of target) {
    if (!stored.has(hash) && !plan.has(hash)) {
      plan.set(hash, path);
    }
  }
  return plan;
}

/**
 * One file the guard would not let be stored, and why — a {@link FileChange} with
 * the path it happened to. Data, not a built error: what a drifted file *means*
 * differs per caller (fatal to a `backup` that is about to publish a manifest, a
 * reportable skip to a folder seed that publishes nothing), so the message is the
 * caller's to build — from {@link fileChangedError} or its own.
 * @typedef {FileChange & { path: string }} Drift
 */

/**
 * What an `uploadObjects` run did, read once its rows have drained.
 *
 * **Two failure fields, not one, because the two are different in kind.** A drift
 * is per-file and plural — several files can drift in one run and each is its own
 * decision. A transport failure is singular and terminal: one dead link stops
 * every remaining transfer. Collapsing them into one first-wins slot made an early
 * drift *hide* a later dropped connection, so the run failed blaming the wrong
 * thing — and any caller that tolerates drift would have reported success on a
 * dead network.
 * @typedef {Object} UploadOutcome
 * @property {number} candidates - Objects this run *attempted* — distinct hashes the `stored` skip-list didn't cover. Not the same as "not in the store": the skip-list is a baseline or a LIST taken earlier, and the conditional PUT is what actually settles presence, so some of these come back no-ops
 * @property {number} uploaded - Those actually transferred (the rest were no-ops the conditional PUT found present)
 * @property {number} uploadedBytes - Bytes those transfers moved
 * @property {number} sendingMs - Milliseconds spent inside the PUTs. The fused pass is strictly sequential — each PUT is awaited before its row is yielded on — so this and the rest of the pass's elapsed time sum to the pass exactly, which is what lets a backup report disk time and link time apart ([ADR-0078](../../docs/adr/0078-backup-run-report.md) §9)
 * @property {Drift[]} drifted - Files the guard refused, in the order met (see `uploadObjects`)
 * @property {Error} [failure] - The transport failure that stopped the transfers, if one did
 */
/**
 * The streaming object uploader: a transform to run rows through, plus the outcome.
 * @typedef {Object} ObjectUploader
 * @property {RowTransform} through - The transform to splice into a snapshot pipeline
 * @property {(rows: Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>) => Promise<void>} run - Drain a row source through the transform instead
 * @property {() => TransferState} transfer - How the sending is going *right now*, for a progress line
 * @property {() => UploadOutcome} result - What happened, once the rows have drained
 */
/**
 * The sending, as it stands right now — what a progress line needs and nothing
 * more. Read (never subscribed to), so the renderer pulls at its own cadence
 * rather than the SDK's event rate driving redraws.
 * @typedef {Object} TransferState
 * @property {number} sent - Bytes gone up so far this run, including the file in flight
 * @property {Sending | null} current - The file being sent, or null between transfers
 */
/**
 * One transfer with the moment it began — `startedAt` is this module's to set,
 * not `putFile`'s, because it marks when the *decision to send* was taken, which
 * is what a "has this been going long enough to report?" rule measures.
 * `hashed` says this run hashed the file, rather than reusing a baseline's hash
 * or reading a written snapshot's row.
 * @typedef {Transfer & { startedAt: number, hashed: boolean }} Sending
 */

/**
 * PUT each row's object as the row goes past — the single PUT loop, shaped as a
 * pass-through over a stream of `[path, Props]` rows (ADR-0069). `backup`
 * splices it into its snapshot pipeline through `writeSnapshot`'s `through`
 * seam, so an object ships **milliseconds** after its bytes were hashed;
 * `uploadSnapshot` `run`s a re-read snapshot through the very same transform. Rows
 * are yielded on unchanged and in order: fusing changes *when* objects ship,
 * never *what* the snapshot records.
 *
 * One PUT per distinct hash (`seen` dedups within the run, first path wins), and
 * nothing already `stored` is attempted. An `#error` row — a file the hash pass
 * couldn't read — has no object to store and simply passes through.
 *
 * **Nothing here ever throws mid-stream** (ADR-0069). A throw inside a pipeline
 * link destroys every stream in the chain — including the snapshot writer — which
 * would truncate the file being written and throw away the whole hash pass. So a
 * failure is *recorded* (first one wins) and the rows keep flowing; the caller
 * reads `result()` once they have drained and throws then, before publishing any
 * manifest. That is what leaves a complete local snapshot behind, which is both
 * the cheap retry and — since a fresh run reads the latest local snapshot as its
 * hash lookup — the reason no hashing is ever repeated.
 *
 * The two kinds of failure differ in what happens *next*, which is why they are
 * reported apart (see {@link UploadOutcome}):
 * - **An upload fails** (network, credentials, a rejected PUT): stop attempting
 *   further uploads — one dead link is enough, and s3.mjs has already spent its
 *   retry window (ADR-0068). The retry is `upload <set> --snapshot <name>`: the
 *   transfers alone.
 * - **A file drifted** (its size/mtime no longer match what was just recorded for
 *   it, or it's gone): skip *that file* and carry on uploading the rest. The store
 *   trusts the hash on write, so PUTting its current bytes would file them under
 *   the recorded content's hash — corrupting that object for every snapshot and
 *   path that dedups to it, surfacing only at restore. The other files' bytes are
 *   fine and worth storing, so they go up, and the drift is recorded as a
 *   {@link Drift} for the caller to judge: fatal where a manifest is about to be
 *   published, a reportable skip where none is. Because this transform re-checks
 *   *after* hashing, it also catches a file that changed **while** it was being
 *   hashed — a mixed-content read the old phase-boundary guard could only notice
 *   minutes later. The last window — a write landing **during the transfer**
 *   itself, after the re-check passed — is closed inside `putFile`: it hashes
 *   the bytes it actually streams, and a mismatch (a {@link ContentMismatchError},
 *   raised before anything is stored) is recorded here as the same `"changed"`
 *   drift.
 *
 * It takes no set name: the drift message is the caller's to build, so nothing
 * here needs to know which set (or whether there is one — the folder seed reaches
 * this through a bucket alone).
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {Set<string>} args.stored - Hashes that need no upload (`storedHashes`)
 * @param {boolean} [args.ownProgress] - The caller draws its own progress line and
 *   will read {@link ObjectUploader.transfer}, so per-file byte bars stay off
 * @returns {ObjectUploader}
 */
export function uploadObjects({ bucket, stored, ownProgress = false }) {
  /** @type {Set<string>} */
  const seen = new Set();
  let candidates = 0;
  let uploaded = 0;
  /** @type {Drift[]} */
  const drifted = [];
  /** @type {Error | undefined} */
  let failure;
  let transfersStopped = false;
  // Bytes of *finished* transfers, plus whichever file is in flight — kept apart
  // so the running total climbs smoothly through a big file instead of standing
  // still for minutes and then jumping by its whole size.
  let settled = 0;
  /** @type {Sending | null} */
  let inFlight = null;
  // Time spent with a PUT in flight, accumulated per transfer rather than
  // measured end-to-end: the pass is doing something else in between, and the
  // whole point of the figure is to tell that something else apart from this.
  let sendingMs = 0;

  /** @type {RowTransform} */
  async function* through(rows) {
    for await (const row of rows) {
      const [path, props] = row;
      if (
        !Error.isError(props) &&
        !stored.has(props.hash) &&
        !seen.has(props.hash)
      ) {
        seen.add(props.hash);
        candidates++;
        const change = transfersStopped
          ? undefined
          : await fileChange(path, props);
        if (change) {
          drifted.push({ path, ...change });
        } else if (!transfersStopped) {
          const startedAt = performance.now();
          const hashed = props.hashDuration !== undefined;
          inFlight = { path, loaded: 0, total: props.size, startedAt, hashed };
          try {
            // Only take the bytes when someone is drawing them. Left on
            // unconditionally it would suppress `putFile`'s own byte bar for
            // callers that have no line of their own (`uploadSnapshot`, the
            // folder seed), leaving a long transfer showing nothing at all.
            const didUpload = await putObject(bucket, props.hash, path, {
              onProgress: ownProgress
                ? (transfer) => {
                    inFlight = { ...transfer, startedAt, hashed };
                  }
                : undefined,
            });
            if (didUpload) {
              uploaded++;
              settled += props.size;
            }
          } catch (error) {
            if (error instanceof ContentMismatchError) {
              // The file was rewritten *during* its transfer — putFile hashed
              // the bytes it streamed, saw they no longer match, and stored
              // nothing. Same fact as the pre-PUT drift guard, caught later: a
              // per-file skip, not a dead link, so the remaining transfers go on.
              drifted.push({ path, reason: "changed", cause: error });
            } else {
              failure ??= Error.isError(error)
                ? error
                : new Error(String(error));
              transfersStopped = true;
            }
          } finally {
            sendingMs += performance.now() - startedAt;
            inFlight = null;
          }
        }
      }
      yield row;
    }
  }

  return {
    through,
    async run(rows) {
      for await (const row of through(rows)) {
        // Nothing downstream: the uploading happened inside the transform, and this
        // caller's snapshot file is already on disk.
        void row;
      }
    },
    transfer: () => ({
      sent: settled + (inFlight?.loaded ?? 0),
      current: inFlight,
    }),
    result: () => ({
      candidates,
      uploaded,
      uploadedBytes: settled,
      sendingMs,
      drifted,
      failure,
    }),
  };
}

/**
 * Why a file can't be stored under the hash recorded for it — the three ways the
 * drift guard can fail, kept apart so the message can say which happened rather
 * than list the possibilities (ADR-0030: be specific, and put codes in a
 * parenthetical). `cause` carries the raw filesystem error for the `unreadable`
 * case, so `S3CAB_DEBUG` can print the errno and a caller could branch on it.
 * @typedef {{ reason: "changed" | "removed" | "unreadable", cause?: unknown }} FileChange
 */

/**
 * How the file on disk differs from the one that was hashed, or `undefined` when
 * it is still the same file — the drift guard, run in the sliver between hashing
 * a file and PUTting its bytes. Unchanged means the same size *and* mtime as
 * the row recorded.
 *
 * **Every** `lstat` failure is a change, not just ENOENT: this runs inside a
 * pipeline link, where a throw would destroy the chain and truncate the snapshot
 * being written (ADR-0069). A file we cannot stat is one we cannot confirm, which
 * is reason enough not to store it — and it matches the hash pass, where an
 * unreadable file becomes an `#error` row and the run carries on.
 * @param {string} path - The file about to be uploaded
 * @param {Props} recorded - What the row says about it
 * @returns {Promise<FileChange | undefined>}
 */
export async function fileChange(path, recorded) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    // try/catch, not `.catch()`: a synchronous throw (a path `lstat` rejects
    // outright) has to be caught here too, or it escapes the transform.
    return fileChangeFrom(error);
  }
  const { size, mtime } = statProps(current);
  const changed = size !== recorded.size || mtime !== recorded.mtime;
  return changed ? { reason: "changed" } : undefined;
}

/**
 * The {@link FileChange} a failure to hash or `lstat` a file stands for.
 * @param {unknown} error
 * @returns {FileChange}
 */
const fileChangeFrom = (error) =>
  error instanceof ChangedWhileReadError
    ? { reason: "changed" }
    : isENOENT(error)
      ? { reason: "removed" }
      : { reason: "unreadable", cause: error };

/**
 * What `uploadSet` leaves a `backup` to report: the baseline it read, the pass
 * it ran, and the sending's own figures (ADR-0078).
 * @typedef {Object} SetUpload
 * @property {SnapshotBaseline} baseline - The set's previous snapshot, as `readBaseline` read it
 * @property {SnapshotPass} pass - The snapshot the fused pass wrote and published
 * @property {number} candidates - Objects the run attempted (see `UploadOutcome`)
 * @property {number} uploaded - Those actually transferred
 * @property {number} uploadedBytes - Bytes those transfers moved
 * @property {number} sendingMs - Milliseconds spent inside the PUTs
 */

/**
 * Back a set up: snapshot and upload in **one fused pass** (ADR-0069) — each
 * file's object is PUT the moment its bytes have been hashed, and the same
 * row goes straight on into the snapshot TSV. There is no
 * write-the-whole-snapshot-then-read-it-back-to-upload round trip, and no
 * minutes-long window in which an edited file drifts out from under the hash
 * recorded for it. The operation behind `backup`, which adds only the
 * reporting around it.
 *
 * The composition, under the upload lock from the first step to the last:
 * 1. **`readBaseline`** — the set's previous local snapshot: the hash lookup
 *    that spares unchanged files a re-read, and the upload baseline below.
 * 2. **`storedHashes`** — what needs no upload, decided *before* any hashing so
 *    a credentials or network problem surfaces in seconds rather than after a
 *    long pass. The single-owner model makes the previous **local** snapshot
 *    the authoritative baseline (ADR-0045), trusted only once `storedHashes`
 *    has confirmed the remote copy is byte-identical to it (ADR-0084); a first
 *    backup LISTs the store instead.
 * 3. **`generateSnapshot` with the object uploader spliced in** — the fused
 *    pass. The uploader is a pipe, not a callback: it consumes rows and yields
 *    them on unchanged, so a backup writes byte-for-byte the snapshot a plain
 *    `snapshot` would have written.
 * 4. **`uploadSnapshotFile`** — the manifest, *last*, once the pipeline has
 *    drained: the objects-first/snapshot-last invariant, kept absolute.
 *
 * **Nothing that goes wrong up there costs the hash pass.** The uploader never
 * throws mid-stream, so the local snapshot always lands complete: a failed
 * transfer is resumed with `upload <set> --snapshot <name>`, and even a file
 * that drifted only costs a fresh `backup`, which reads that snapshot as its
 * hash lookup and so re-reads nothing that didn't change.
 *
 * @param {BackupSet} set - The resolved set
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.resume] - Adopt what an interrupted run left behind
 * @param {boolean} [options.debug] - Leave an uncompressed copy beside the snapshot
 * @returns {Promise<SetUpload>}
 */
export function uploadSet(set, { rehash, resume, debug } = {}) {
  return holdUploadLock(
    { bucket: set.bucket, command: "backup", set: set.name },
    async () => {
      const baseline = await readBaseline(set, { rehash, resume });
      const { name: since, previous } = baseline;
      const stored = await storedHashes({
        bucket: set.bucket,
        set: set.name,
        snapshotDir: set.snapshotsDir,
        since,
        baseline: previous,
      });

      const uploader = uploadObjects({
        bucket: set.bucket,
        stored,
        ownProgress: true,
      });
      const pass = await generateSnapshot(set, {
        baseline,
        through: uploader.through,
        // Both halves of the fused pass report into one progress line:
        // `through` does the sending, `transfer` is how that sending is going.
        transfer: uploader.transfer,
        debug,
      });

      // The snapshot file has landed locally whatever happened above — that
      // is what makes the retry cheap — so an upload failure surfaces only
      // now, and no manifest is ever published for objects that didn't all
      // make it.
      //
      // Which retry to name depends on the kind of failure (ADR-0069): a file
      // that changed under us can never be reconciled with the snapshot that
      // recorded it, so it asks for a fresh backup; anything else is a
      // transfer that can simply be resumed. The transport failure is checked
      // **first** — it is the terminal one, and it must not be spoken for by
      // a drift met on an earlier row.
      const { name } = pass;
      const {
        candidates,
        uploaded,
        uploadedBytes,
        sendingMs,
        drifted,
        failure,
      } = uploader.result();
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
        claimPath: set.claimPath,
      });

      return { baseline, pass, candidates, uploaded, uploadedBytes, sendingMs };
    },
  );
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
      `  ${shellCommand(`s3cab upload ${set} --snapshot ${name}`)}`,
    { cause },
  );

/**
 * Upload the snapshot manifest itself — the **last** step of any backup, which
 * is what makes a snapshot's mere presence proof its objects exist
 * (docs/design/backup.md). No-clobber, and a name that already exists remotely
 * holding **different bytes** is an error, never an overwrite (snapshots are
 * immutable). Holding the **same bytes** is quiet success (ADR-0084): the
 * no-clobber PUT retries on a lost response, and the retry then meets this
 * run's own first attempt as a 412 — refusing there turned an upload that
 * *worked* into a reported failure. Byte-identity tells the two apart exactly.
 * Called by `uploadSnapshot` and by `backup`, each once its own objects are up.
 *
 * Refused unless this machine holds the set, checked immediately before the
 * PUT (ADR-0108): the format's rule for publishing a snapshot.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} args.snapshotDir - Local dir holding the snapshot (`<name>.tsv.gz`)
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @param {string} args.claimPath - The set's `claim` file, this machine's proof it holds the set
 * @returns {Promise<void>}
 */
export async function uploadSnapshotFile({
  bucket,
  set,
  snapshotDir,
  name,
  claimPath,
}) {
  await assertHeld(bucket, set, claimPath);
  const snapshotUri = remoteSnapshotUri(bucket, set, name);
  const snapshotPath = join(snapshotDir, snapshotFileName(name));
  const wrote = await putFile(snapshotPath, snapshotUri, { noClobber: true });
  if (wrote) {
    return;
  }
  const match = await matchRemoteSnapshot(bucket, set, name, snapshotDir);
  if (match === "identical") {
    return; // this very manifest is already up — publishing is idempotent
  }
  throw nameTakenError(set, name, snapshotUri);
}

/**
 * The 412 that isn't this run's own retried PUT — the name was taken by someone
 * else (ADR-0084: byte-identity is what tells the two apart).
 *
 * **One message for both losing outcomes**, `"different"` and `"absent"`. They
 * differ only in whether the snapshot that beat us is still there when we look a
 * moment later, which changes nothing the reader can act on: their objects are
 * stored, their backup went unrecorded, and the fix is to run it again. Hence
 * the past tense — *was* already taken *when we wrote it* — which stays true
 * whether or not it has since been deleted. Two factories here would be two
 * wordings for one user action.
 *
 * **Rare, but not a misuse.** The holder check just before the PUT
 * ([ADR-0108](../../docs/adr/0108-set-ownership.md)) leaves two ways in: a
 * takeover landing between that check and the PUT, and a holder whose `claim`
 * travelled with copied state (a cloned VM, a restored `~/.s3cab`). Either way
 * the user did nothing wrong, so this message is the whole explanation they get.
 *
 * Worded against what the user is actually left with, because the message this
 * replaced — "Snapshot '<name>' is already backed up" — was true of the *name*
 * and false of their *data*, and read as reassurance at the exact moment their
 * backup had not been recorded (ADR-0030). Their objects went up before the
 * manifest (objects-first, docs/design/backup.md), so nothing is lost and a
 * re-run mints the next minute's name and publishes. The likely cause is named
 * as a cause and not asserted as fact: all the code can see is bytes it didn't
 * write, which a regenerated local manifest produces too.
 * @param {string} set - The set's name
 * @param {string} name - The snapshot name that collided
 * @param {string} uri - The remote snapshot's `s3://` URI
 * @returns {Error}
 */
const nameTakenError = (set, name, uri) =>
  new Error(
    `Couldn't record this backup as '${name}': the name was already taken ` +
      `when we wrote it (${uri}).\n` +
      `Snapshot names are the local time to the minute, so another computer ` +
      `backing up the same set can take one first. Your files were uploaded ` +
      `and are safe in the store — it is this backup's record that wasn't ` +
      `written, and snapshots are never overwritten.\n\n` +
      `Run it again to record it under the next minute's name:\n` +
      `  ${shellCommand(`s3cab backup ${set}`)}`,
  );

/**
 * Upload an **existing local snapshot** to the bucket: every object it
 * references that isn't already stored, then the snapshot last. The re-read
 * source of the shared upload transform — `backup` no longer comes through here (it
 * fuses `uploadObjects` into its own hash pass, ADR-0069), so this is the
 * `upload <set> --snapshot <name>` path alone: retrying a backup whose transfers
 * failed part-way, or pushing a snapshot taken offline. It never hashes (the
 * snapshot already carries every hash) and never walks the filesystem.
 *
 * What's already stored is `storedHashes`' decision (a trust-checked baseline,
 * else a LIST); the PUT loop, the dedup and the drift guard are `uploadObjects`'.
 * The target is read before the lock is taken, so a missing `--snapshot` fails
 * fast with nothing to undo.
 * @param {Pick<BackupSet, "name" | "bucket" | "snapshotsDir" | "claimPath">} set - The resolved set
 * @param {object} args
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @param {string} [args.since] - Baseline snapshot to skip against (a local snapshot
 *   name); omit for a first backup, which LISTs the store instead
 * @returns {Promise<{ name: string, candidates: number, uploaded: number }>}
 *   `candidates` = objects considered for upload; `uploaded` = those actually
 *   transferred (the rest were no-ops the conditional PUT found already present).
 */
export async function uploadSnapshot(set, { name, since }) {
  const { bucket, snapshotsDir: snapshotDir } = set;
  const { entries: target } = await readSnapshot(snapshotDir, name);

  /** @type {SnapshotEntries | undefined} */
  let baseline;
  if (since) {
    const { entries } = await readSnapshot(snapshotDir, since);
    baseline = entries;
  }

  return holdUploadLock(
    { bucket, command: "upload", set: set.name },
    async () => {
      const stored = await storedHashes({
        bucket,
        set: set.name,
        snapshotDir,
        since,
        baseline,
      });

      // A snapshot's entries iterate as exactly the `[path, Props]` rows the
      // transform consumes — the "one consumer, two sources" seam.
      const uploader = uploadObjects({ bucket, stored });
      await uploader.run(target);
      const { candidates, uploaded, drifted, failure } = uploader.result();
      // Transport failure first: it is the terminal one, and a drift on an
      // earlier row must not speak for a dead link met on a later one.
      if (failure) {
        throw failure;
      }
      if (drifted.length > 0) {
        throw fileChangedError(drifted, set.name);
      }

      await uploadSnapshotFile({
        bucket,
        set: set.name,
        snapshotDir,
        name,
        claimPath: set.claimPath,
      });

      return { name, candidates, uploaded };
    },
  );
}

/**
 * Seed a repository's object store from a live directory subtree — the "push my
 * priority folders before the initial backup" primitive (docs/design/backup.md).
 * Walk `dir` (applying the set's `exclude.txt`, so a seed matches exactly what a
 * backup would store), hash each file, and conditional-PUT its object; the later
 * full `backup` then dedups against everything already here for free (design #1).
 *
 * **Objects-only, no snapshot.** Writing a manifest is the `snapshot` command's
 * job, not `upload`'s — so until a backup references them the seeded objects are
 * unreferenced. That is the *safe* direction (wasted space, never corruption),
 * but a `cleanup` run before the first backup would reap them as orphans
 * (docs/design/backup.md). No baseline diff and no store LIST: the conditional
 * PUT is the "already stored?" check, so re-running is cheap and idempotent.
 * Identical content under many names uploads once (hashes deduped within the run).
 *
 * **The third source of the one PUT loop.** This walks and hashes; `uploadObjects`
 * does the storing, so the dedup, the counting and — the reason this matters — the
 * confirmation guard are the same code a backup runs. Seeding hashes a file and
 * then re-reads it to send it, exactly as a backup does, so it has exactly the same
 * window in which the file can change underneath the hash recorded for it; running
 * its own PUT loop meant it had none of the protection. Rows are produced **lazily**
 * (one file hashed, its object shipped, then the next): a seed is aimed at
 * multi-GB folders, so hashing the whole subtree before sending anything would
 * waste the entire read before a byte went out.
 *
 * **A file that can't be confirmed is skipped, and the run still succeeds** — the
 * one place this diverges from `backup`, and it turns on publishing. A backup that
 * skipped a file would publish a manifest promising an object that was never
 * stored, so it must fail; a seed publishes nothing, so a skipped file leaves
 * nothing inconsistent behind and the next backup stores it properly. The bytes
 * that *were* confirmed are worth having either way. The skips are returned for the
 * caller to report (never swallowed — they are files the user asked for and didn't
 * get); a transport failure still throws, because nothing more can be sent.
 * @param {Pick<BackupSet, "name" | "bucket" | "excludePath">} set - The resolved set, for its bucket and `exclude.txt`
 * @param {object} args
 * @param {string} args.dir - The subtree to seed from (already validated as a directory)
 * @returns {Promise<{ candidates: number, uploaded: number, skipped: Drift[] }>}
 *   `candidates` = distinct objects walked; `uploaded` = those actually transferred
 *   (the rest were already stored); `skipped` = files that failed their hash or
 *   the guard.
 */
export function uploadDir(set, { dir }) {
  const { bucket } = set;
  return holdUploadLock(
    { bucket, command: "upload", set: set.name },
    async () => {
      const { files } = walkDirs([dir], readExcludePatterns(set.excludePath));
      /** @type {Drift[]} files that failed their hash */
      const unhashed = [];

      /** One row at a time, so hashing and sending interleave per file. */
      async function* rows() {
        for (const path of files) {
          let props;
          try {
            props = await fileProps(path);
          } catch (error) {
            unhashed.push({ path, ...fileChangeFrom(error) });
            continue;
          }
          yield /** @type {SnapshotRow} */ ([path, props]);
        }
      }

      // An empty `stored`: the conditional PUT is this path's already-stored
      // check, so there is deliberately no baseline and no store LIST to build
      // one from.
      const uploader = uploadObjects({ bucket, stored: new Set() });
      await uploader.run(rows());
      const { candidates, uploaded, drifted, failure } = uploader.result();
      if (failure) {
        throw failure;
      }
      return { candidates, uploaded, skipped: [...unhashed, ...drifted] };
    },
  );
}

/**
 * Store one already-hashed file as one object — `upload --file`, the fourth
 * source of a PUT, kept apart from the transform on purpose: `--force` means
 * "overwrite deliberately", which the transform has no concept of, and its
 * dedup/skip-list machinery is dead weight for one file. What *is* shared is
 * the guard (ADR-0069): hashing then re-reading to send means the file can
 * change in between, and the store trusts the hash on write — so its new
 * bytes would be filed under the old content's hash and corrupt that object
 * for every path that dedups to it. One file rather than thousands doesn't
 * change that. The hash was taken before the lock (it can take as long as
 * the file is big, and decides nothing); the guard, the PUT and its 412 run
 * under it.
 *
 * A file that fails the guard is returned as a {@link FileChange}, not
 * thrown: the message names the exact re-run, which the caller holds.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {Pick<BackupSet, "name">} [args.set] - The set the upload is for; absent for `upload --bucket`
 * @param {string} args.path - The file to store
 * @param {Props} args.props - Its hash, size and mtime, as just taken
 * @param {boolean} [args.force] - Overwrite an object already stored under the hash
 * @returns {Promise<{ uploaded: boolean, change?: FileChange }>} `uploaded` =
 *   transferred (false: already stored, or `change` says why nothing was)
 */
export function uploadFile({ bucket, set, path, props, force }) {
  return holdUploadLock(
    { bucket, command: "upload", set: set?.name },
    async () => {
      const change = await fileChange(path, props);
      if (change) {
        return { uploaded: false, change };
      }
      try {
        const uploaded = await putObject(bucket, props.hash, path, { force });
        return { uploaded };
      } catch (error) {
        if (error instanceof ContentMismatchError) {
          return {
            uploaded: false,
            change: { reason: "changed", cause: error },
          };
        }
        throw error;
      }
    },
  );
}

/**
 * The "we couldn't confirm this file" error raised for a run that was going to
 * **publish a manifest** — `backup` and `upload --snapshot`. Storing the file's
 * current bytes would file them under the recorded content's hash, corrupting that
 * object across the dedup graph, so that one file is left out — and because no
 * manifest is published, the run didn't finish, which is what makes one shared
 * "back up again" line honest for all three reasons.
 *
 * Wording follows ADR-0030 — a headline that says what actually happened, the
 * errno kept to a parenthetical, the fix as a copy-pasteable command, the durable
 * option (exclude) with its guide link — and ADR-0012's consumer vocabulary:
 * "s3cab", not "content-addressed backup".
 *
 * Exported because the drift is reported as *data* now: the caller decides whether
 * it is fatal, so the caller raises this. A run that publishes nothing (the folder
 * seed) has no business with a "the backup didn't finish" message and builds its
 * own — which is exactly why this is not built inside the transform.
 * @param {Drift[]} drifted - The refused files; the first names the error (at least one)
 * @param {string} set - The set being backed up (names the re-run command)
 * @returns {Error}
 */
export function fileChangedError(drifted, set) {
  const first = drifted[0];
  assert(first, "fileChangedError needs at least one drifted file");
  const { path, reason, cause } = first;
  const code = /** @type {NodeJS.ErrnoException} */ (cause)?.code;
  const headline = {
    changed: `it changed while the backup was running, so it's no longer the file s3cab fingerprinted`,
    removed: `it was removed while the backup was running`,
    unreadable: `it could no longer be read while the backup was running${code ? ` (${code})` : ""}`,
  }[reason];

  // How many *else* went the same way. One unlucky file and forty are the same
  // event to the code and completely different situations to the reader: forty
  // says something is actively writing into the set, which is what the closing
  // paragraph is really about. The count is the only thing that tells them apart,
  // so it is said rather than left to be inferred from one named example.
  const others = drifted.length - 1;
  const alsoCount =
    others > 0
      ? `${others} other ${plural(others, "file")} couldn't be confirmed ` +
        `either and ${others === 1 ? "was" : "were"} left out too.\n\n`
      : ``;

  return new Error(
    `Couldn't back up '${path}' — ${headline}.\n\n` +
      `s3cab stores a file only when it can confirm it's still the one it ` +
      `fingerprinted, so this file was left out and the backup didn't finish. ` +
      `Everything else was uploaded, and the snapshot taken here is saved on ` +
      `this computer, so backing up again won't re-read the files it already ` +
      `hashed:\n` +
      `  ${shellCommand(`s3cab backup ${set}`)}\n\n` +
      alsoCount +
      `If this keeps happening — a live database, a file another program is ` +
      `still writing, or one that comes and goes — it isn't a good fit for ` +
      `s3cab; exclude it from the set: https://s3cab.plantegral.com/guide/exclude`,
    { cause },
  );
}
