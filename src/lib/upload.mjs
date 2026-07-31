import assert from "node:assert";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stderr } from "node:process";
import { readDeletionRecords } from "./deletion-record.mjs";
import { FileChangedError, isENOENT } from "./error.mjs";
import { fileProps } from "./file-props.mjs";
import { formatCount, plural, secondsSince } from "./format.mjs";
import { listObjectHashes, putObject } from "./objects.mjs";
import { createProgress } from "./progress.mjs";
import { remoteSnapshotUri } from "./remote.mjs";
import { objectExists, putFile } from "./s3.mjs";
import { readSnapshot, snapshotFileName } from "./snapshot-file.mjs";
import { isInteractive } from "./style.mjs";
import { readExcludePatterns, walkDirs } from "./walk.mjs";

/**
 * @import { Props, RowTransform, SnapshotEntries, SnapshotRow } from "./snapshot-file.mjs"
 * @import { Transfer } from "./s3.mjs"
 */

// The upload verb module: what counts as already stored (`storedHashes`), the
// streaming PUT transform over it (`uploadObjects`), and the compositions on top —
// `uploadSnapshot` (re-read an existing snapshot) and `uploadSnapshotFile` (the
// manifest, last). remote.mjs stays the remote snapshot-*store* module and keeps
// sole ownership of the `snapshots/` prefix (imported here, so the layout is
// still spelled in exactly one place); objects.mjs owns `objects/`.
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
 * With a `since` baseline it is that snapshot's hashes, but only once one HEAD
 * has confirmed the baseline still exists remotely (proposals/bugs.md, HIGH).
 * The objects-first/snapshot-last invariant makes a remote snapshot's presence
 * proof its objects were stored, and cleanup never deletes referenced objects —
 * so a baseline still in the cloud is a trustworthy skip-list. One that isn't
 * (forgotten remotely, or taken locally but never uploaded) may claim more is
 * stored than is; a hash it wrongly skips never reaches the conditional-PUT
 * backstop, so the published snapshot would reference a missing object. On a
 * miss, drop the baseline entirely — its skips are exactly the untrusted data —
 * and LIST the store instead, like a first backup.
 *
 * The result is a materialized Set, not a stream: the fused pipeline asks about
 * one row at a time, so membership has to be random-access. It is sized by the
 * store (a first backup's LIST) or by the baseline snapshot — the same order as
 * the snapshot Maps a run already holds.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} [args.since] - The baseline snapshot's name (trust-checked remotely)
 * @param {SnapshotEntries} [args.baseline] - That baseline's entries; without both, the store is LISTed
 * @returns {Promise<Set<string>>} Hashes that need no upload
 */
export async function storedHashes({ bucket, set, since, baseline }) {
  if (since && baseline) {
    const trusted = await objectExists(remoteSnapshotUri(bucket, set, since));
    if (trusted) {
      // The PR-A interlock's other half (ADR-0064): existing remotely proves the
      // baseline's objects were stored *then*; the deletion record says which of
      // them a later `delete` removed since. Subtract those, or the baseline
      // wrongly vouches for deleted content and the published snapshot
      // references missing objects. One LIST of `deletions/` — empty, and free,
      // for the repositories that never ran `delete`.
      const deleted = await readDeletionRecords(bucket);
      return baselineHashes(baseline, deleted.keys());
    }
    console.warn(
      `Baseline snapshot '${since}' is no longer in the cloud — ` +
        `checking what's stored instead.`,
    );
  }

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
  const start = Temporal.Now.instant();
  const label = `Scanning existing objects in 's3://${bucket}'…`;
  using progress = createProgress(stderr);
  // Paint the label before the first request, not once objects are already
  // arriving: ADR-0044/0045 put this announce *ahead* of the LIST precisely
  // because the wait is unpredictable, and a bucket slow to answer is exactly
  // when a blank screen reads as a hang. Bare label, no count — a "0" would be
  // worse.
  progress.update(label);
  /** @type {Set<string>} */
  const stored = new Set();

  // A clock, not the arriving keys, drives this line — the one progress line
  // here whose data comes in bursts. `listObjects` does `yield* page.Contents`,
  // so a whole LIST page (1,000 keys) drains with no wait between items: gating
  // on the redraw interval instead meant the first key after each round trip
  // drew and the other 999 were held, so the count only ever appeared as a
  // multiple of 1,000 *plus one* and then sat still for the next round trip. On
  // a timer the count is sampled whenever it fires — whatever has really landed
  // — and the elapsed figure keeps moving across the wait rather than freezing
  // on it. `unref` so a pending tick can never hold the process open; the
  // `finally` stops it if the LIST throws.
  const ticking = setInterval(() => {
    progress.update(
      `${label} ${formatCount(stored.size)} in ${secondsSince(start)}`,
    );
  }, 1000);
  ticking.unref();
  try {
    for await (const hash of listObjectHashes(bucket)) {
      stored.add(hash);
    }
  } finally {
    clearInterval(ticking);
  }

  const summary = `${label} ${formatCount(stored.size)} in ${secondsSince(start)}`;
  if (isInteractive(stderr)) {
    progress.update(summary);
  } else {
    console.warn(summary);
  }
  return stored;
}

/**
 * A snapshot's content hashes as a skip-list, minus any the repository's
 * deletion record marks deliberately removed (ADR-0064). Pure — the baseline
 * half of `storedHashes`, split out because `status` wants exactly this over a
 * remote snapshot, with no network read of its own.
 * @param {SnapshotEntries} baseline - The snapshot to trust
 * @param {Iterable<string>} [deleted] - Hashes a later `delete` removed from the store
 * @returns {Set<string>}
 */
export function baselineHashes(baseline, deleted) {
  /** @type {Set<string>} */
  const stored = new Set();
  for (const { hash } of baseline.values()) {
    stored.add(hash);
  }
  for (const hash of deleted ?? []) {
    stored.delete(hash);
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
 * @property {number} candidates - Objects considered for upload (not already stored)
 * @property {number} uploaded - Those actually transferred (the rest were no-ops the conditional PUT found present)
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
 * @typedef {Transfer & { startedAt: number }} Sending
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
 * nothing already `stored` is attempted. An `#ERROR` row — a file the hash pass
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
 *   minutes later.
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
          inFlight = { path, loaded: 0, total: props.size, startedAt };
          try {
            // Only take the bytes when someone is drawing them. Left on
            // unconditionally it would suppress `putFile`'s own byte bar for
            // callers that have no line of their own (`uploadSnapshot`, the
            // folder seed), leaving a long transfer showing nothing at all.
            const didUpload = await putObject(bucket, props.hash, path, {
              onProgress: ownProgress
                ? (transfer) => {
                    inFlight = { ...transfer, startedAt };
                  }
                : undefined,
            });
            if (didUpload) {
              uploaded++;
              settled += props.size;
            }
          } catch (error) {
            failure ??= Error.isError(error) ? error : new Error(String(error));
            transfersStopped = true;
          } finally {
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
    result: () => ({ candidates, uploaded, drifted, failure }),
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
 * a file and PUTting its bytes. Unchanged is the same staleness test `fileProps`
 * uses (size *and* mtime), against what the row recorded.
 *
 * **Every** `lstat` failure is a change, not just ENOENT: this runs inside a
 * pipeline link, where a throw would destroy the chain and truncate the snapshot
 * being written (ADR-0069). A file we cannot stat is one we cannot confirm, which
 * is reason enough not to store it — and it matches the hash pass, where an
 * unreadable file becomes an `#ERROR` row and the run carries on.
 * @param {string} path - The file about to be uploaded
 * @param {Props} recorded - What the row says about it
 * @returns {Promise<FileChange | undefined>}
 */
export async function fileChange(path, recorded) {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    // try/catch, not `.catch()`: a synchronous throw (a path `lstat` rejects
    // outright) has to be caught here too, or it escapes the transform.
    return isENOENT(error)
      ? { reason: "removed" }
      : { reason: "unreadable", cause: error };
  }
  const changed =
    current.size !== recorded.size ||
    current.mtime.toISOString() !== recorded.mtime;
  return changed ? { reason: "changed" } : undefined;
}

/**
 * Upload the snapshot manifest itself — the **last** step of any backup, which
 * is what makes a snapshot's mere presence proof its objects exist
 * (docs/design/backup.md). No-clobber, and here a name that already exists
 * remotely is an **error**, never an overwrite (snapshots are immutable).
 * Called by `uploadSnapshot` and by `backup`, each once its own objects are up.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} args.snapshotDir - Local dir holding the snapshot (`<name>.tsv.zst`)
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @returns {Promise<void>}
 */
export async function uploadSnapshotFile({ bucket, set, snapshotDir, name }) {
  const snapshotUri = remoteSnapshotUri(bucket, set, name);
  const snapshotPath = join(snapshotDir, snapshotFileName(name));
  const wrote = await putFile(snapshotPath, snapshotUri, { noClobber: true });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (${snapshotUri}). ` +
        `Snapshots are immutable and never overwritten (docs/design/backup.md).`,
    );
  }
}

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

  /** @type {SnapshotEntries | undefined} */
  let baseline;
  if (since) {
    const { entries } = await readSnapshot(snapshotDir, since);
    baseline = entries;
  }
  const stored = await storedHashes({ bucket, set, since, baseline });

  // A snapshot's entries iterate as exactly the `[path, Props]` rows the transform
  // consumes — the "one consumer, two sources" seam.
  const uploader = uploadObjects({ bucket, stored });
  await uploader.run(target);
  const { candidates, uploaded, drifted, failure } = uploader.result();
  // Transport failure first: it is the terminal one, and a drift on an earlier
  // row must not speak for a dead link met on a later one.
  if (failure) {
    throw failure;
  }
  if (drifted.length > 0) {
    throw fileChangedError(drifted, set);
  }

  await uploadSnapshotFile({ bucket, set, snapshotDir, name });

  return { name, candidates, uploaded };
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
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.dir - The subtree to seed from (already validated as a directory)
 * @param {string} args.excludePath - The set's `exclude.txt` (patterns applied to the walk)
 * @returns {Promise<{ candidates: number, uploaded: number, skipped: Drift[] }>}
 *   `candidates` = distinct objects walked; `uploaded` = those actually transferred
 *   (the rest were already stored); `skipped` = files the guard refused.
 */
export async function uploadDir({ bucket, dir, excludePath }) {
  const { files } = walkDirs([dir], readExcludePatterns(excludePath));

  /** One row at a time, so hashing and sending interleave per file. */
  async function* rows() {
    for (const path of files) {
      yield /** @type {SnapshotRow} */ ([path, await fileProps(path)]);
    }
  }

  // An empty `stored`: the conditional PUT is this path's already-stored check, so
  // there is deliberately no baseline and no store LIST to build one from.
  const uploader = uploadObjects({ bucket, stored: new Set() });
  await uploader.run(rows());
  const { candidates, uploaded, drifted, failure } = uploader.result();
  if (failure) {
    throw failure;
  }
  return { candidates, uploaded, skipped: drifted };
}

/**
 * The "we couldn't confirm this file" error raised for a run that was going to
 * **publish a manifest** — `backup` and `upload --snapshot`. Storing the file's
 * current bytes would file them under the recorded content's hash, corrupting that
 * object across the dedup graph, so that one file is left out — and because no
 * manifest is published, the run didn't finish, which is what makes one shared
 * "back up again" line honest for all three reasons.
 *
 * A {@link FileChangedError} because `backup` reads its *type* to pick the right
 * advice (ADR-0069): every other upload failure resumes with `upload --snapshot`,
 * this one needs a fresh backup. Wording follows ADR-0030 — a headline that says
 * what actually happened, the errno kept to a parenthetical, the fix as a
 * copy-pasteable command, the durable option (exclude) with its guide link — and
 * ADR-0012's consumer vocabulary: "s3cab", not "content-addressed backup".
 *
 * Exported because the drift is reported as *data* now: the caller decides whether
 * it is fatal, so the caller raises this. A run that publishes nothing (the folder
 * seed) has no business with a "the backup didn't finish" message and builds its
 * own — which is exactly why this is not built inside the transform.
 * @param {Drift[]} drifted - The refused files; the first names the error (at least one)
 * @param {string} set - The set being backed up (names the re-run command)
 * @returns {FileChangedError}
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

  return new FileChangedError(
    `Couldn't back up '${path}' — ${headline}.\n\n` +
      `s3cab stores a file only when it can confirm it's still the one it ` +
      `fingerprinted, so this file was left out and the backup didn't finish. ` +
      `Everything else was uploaded, and the snapshot taken here is saved on ` +
      `this computer, so backing up again won't re-read the files it already ` +
      `hashed:\n` +
      `  s3cab backup ${set}\n\n` +
      alsoCount +
      `If this keeps happening — a live database, a file another program is ` +
      `still writing, or one that comes and goes — it isn't a good fit for ` +
      `s3cab; exclude it from the set: https://s3cab.plantegral.com/guide/exclude`,
    { cause },
  );
}
