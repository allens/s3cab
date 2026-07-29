import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readDeletionRecords } from "./deletion-record.mjs";
import { FileChangedError, isENOENT } from "./error.mjs";
import { fileProps } from "./file-props.mjs";
import { listObjectHashes, putObject } from "./objects.mjs";
import { remoteSnapshotUri } from "./remote.mjs";
import { objectExists, putFile } from "./s3.mjs";
import { readSnapshot, snapshotFileName } from "./snapshot-file.mjs";
import { readExcludePatterns, walkDirs } from "./walk.mjs";

/**
 * @import { Props, RowTransform, SnapshotEntries, SnapshotRow } from "./snapshot-file.mjs"
 */

// The upload verb module: what counts as already stored (`storedHashes`), the
// streaming PUT transform over it (`uploadObjects`), and the compositions on top —
// `uploadSnapshot` (re-read an existing snapshot) and `uploadSnapshotFile` (the
// manifest, last). remote.mjs stays the remote snapshot-*store* module and keeps
// sole ownership of the `snapshots/` prefix (imported here, so the layout is
// still spelled in exactly one place); objects.mjs owns `objects/`.
//
// `uploadObjects` is deliberately **source-agnostic** (ADR-0069): it consumes a
// stream of `[path, Props]` rows, whether they come from a snapshot file being
// re-read (here) or from the hash pass of a live `backup`, which splices this
// same transform into its snapshot pipeline so each object ships milliseconds after
// it was hashed. One PUT loop, one drift guard, two sources.

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

  // No trustworthy baseline — LIST the store once instead. Announce it: a large
  // store can take a moment.
  console.warn("Scanning existing objects…");
  /** @type {Set<string>} */
  const stored = new Set();
  for await (const hash of listObjectHashes(bucket)) {
    stored.add(hash);
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
 * What an `uploadObjects` run did, read once its rows have drained.
 * @typedef {Object} UploadOutcome
 * @property {number} candidates - Objects considered for upload (not already stored)
 * @property {number} uploaded - Those actually transferred (the rest were no-ops the conditional PUT found present)
 * @property {Error} [failure] - The upload that failed, if one did (see `uploadObjects`)
 */
/**
 * The streaming object uploader: a transform to run rows through, plus the outcome.
 * @typedef {Object} ObjectUploader
 * @property {RowTransform} through - The transform to splice into a snapshot pipeline
 * @property {(rows: Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>) => Promise<void>} run - Drain a row source through the transform instead
 * @property {() => UploadOutcome} result - What happened, once the rows have drained
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
 * The two kinds of failure differ only in what happens *next*:
 * - **An upload fails** (network, credentials, a rejected PUT): stop attempting
 *   further uploads — one dead link is enough, and s3.mjs has already spent its
 *   retry window (ADR-0068). The retry is `upload <set> --snapshot <name>`: the
 *   transfers alone.
 * - **A file drifted** (its size/mtime no longer match what was just recorded for
 *   it, or it's gone): skip *that file* and carry on uploading the rest. The store
 *   trusts the hash on write, so PUTting its current bytes would file them under
 *   the recorded content's hash — corrupting that object for every snapshot and
 *   path that dedups to it, surfacing only at restore (proposals/bugs.md). The
 *   other files' bytes are fine and worth storing, so they go up; the caller
 *   raises {@link FileChangedError} at the end, which asks for a fresh `backup`
 *   rather than an upload retry, because that one row can never be reconciled
 *   with the file as it now stands. Because this transform re-checks *after*
 *   hashing, it also catches a file that changed **while** it was being hashed —
 *   a mixed-content read the old phase-boundary guard could only notice minutes
 *   later.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set being backed up (names the re-run command in the drift error)
 * @param {Set<string>} args.stored - Hashes that need no upload (`storedHashes`)
 * @returns {ObjectUploader}
 */
export function uploadObjects({ bucket, set, stored }) {
  /** @type {Set<string>} */
  const seen = new Set();
  let candidates = 0;
  let uploaded = 0;
  /** @type {Error | undefined} */
  let failure;
  let transfersStopped = false;

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
          failure ??= fileChangedError(path, set, change);
        } else if (!transfersStopped) {
          try {
            const didUpload = await putObject(bucket, props.hash, path);
            if (didUpload) {
              uploaded++;
            }
          } catch (error) {
            failure ??= Error.isError(error) ? error : new Error(String(error));
            transfersStopped = true;
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
    result: () => ({ candidates, uploaded, failure }),
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
async function fileChange(path, recorded) {
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
  const uploader = uploadObjects({ bucket, set, stored });
  await uploader.run(target);
  const { candidates, uploaded, failure } = uploader.result();
  if (failure) {
    throw failure;
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
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.dir - The subtree to seed from (already validated as a directory)
 * @param {string} args.excludePath - The set's `exclude.txt` (patterns applied to the walk)
 * @returns {Promise<{ candidates: number, uploaded: number }>} `candidates` =
 *   distinct objects walked; `uploaded` = those actually transferred (the rest
 *   were already stored).
 */
export async function uploadDir({ bucket, dir, excludePath }) {
  const { files } = walkDirs([dir], readExcludePatterns(excludePath));

  /** @type {Set<string>} */
  const seen = new Set();
  let uploaded = 0;
  for (const path of files) {
    const { hash } = await fileProps(path);
    if (seen.has(hash)) {
      continue; // identical content already handled this run — one PUT suffices
    }
    seen.add(hash);
    const didUpload = await putObject(bucket, hash, path);
    if (didUpload) {
      uploaded++;
    }
  }
  return { candidates: seen.size, uploaded };
}

/**
 * The "we couldn't confirm this file" error `uploadObjects` records when the file
 * on disk is no longer the one that was hashed. Storing its current bytes would
 * file them under the recorded content's hash, corrupting that object across the
 * dedup graph (proposals/bugs.md), so that one file is left out — and because no
 * manifest is published, the run didn't finish, which is what makes one shared
 * "back up again" line honest for all three reasons.
 *
 * A {@link FileChangedError} because `backup` reads its *type* to pick the right
 * advice (ADR-0069): every other upload failure resumes with `upload --snapshot`,
 * this one needs a fresh backup. Wording follows ADR-0030 — a headline that says
 * what actually happened, the errno kept to a parenthetical, the fix as a
 * copy-pasteable command, the durable option (exclude) with its guide link — and
 * ADR-0012's consumer vocabulary: "s3cab", not "content-addressed backup".
 * @param {string} path - The file that couldn't be confirmed
 * @param {string} set - The set being backed up (names the re-run command)
 * @param {FileChange} change - Which of the three happened, and the raw cause if any
 * @returns {FileChangedError}
 */
function fileChangedError(path, set, { reason, cause }) {
  const code = /** @type {NodeJS.ErrnoException} */ (cause)?.code;
  const headline = {
    changed: `it changed while the backup was running, so it's no longer the file s3cab fingerprinted`,
    removed: `it was removed while the backup was running`,
    unreadable: `it could no longer be read while the backup was running${code ? ` (${code})` : ""}`,
  }[reason];

  return new FileChangedError(
    `Couldn't back up '${path}' — ${headline}.\n\n` +
      `s3cab stores a file only when it can confirm it's still the one it ` +
      `fingerprinted, so this file was left out and the backup didn't finish. ` +
      `Everything else was uploaded, and the snapshot taken here is saved on ` +
      `this computer, so backing up again won't re-read the files it already ` +
      `hashed:\n` +
      `  s3cab backup ${set}\n\n` +
      `If this keeps happening — a live database, a file another program is ` +
      `still writing, or one that comes and goes — it isn't a good fit for ` +
      `s3cab; exclude it from the set: https://s3cab.plantegral.com/guide/exclude`,
    { cause },
  );
}
