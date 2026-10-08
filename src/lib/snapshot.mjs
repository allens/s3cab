import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { fileProps } from "./file-props.mjs";
import {
  ELAPSED_COLUMNS,
  elapsedSince,
  formatByteValue,
  formatCount,
} from "./format.mjs";
import { tildeify } from "./home.mjs";
import { clockedLine } from "./progress.mjs";
import {
  assertNoWorkFile,
  listSnapshotNames,
  readParkedLookup,
  readSnapshotFile,
  recoverWorkFile,
  snapshotFileName,
  snapshotMoment,
  writeSnapshot,
} from "./snapshot-file.mjs";
import { dim, styleEnabled } from "./style.mjs";
import { resolveWalkRoot, walkSet } from "./walk.mjs";

/**
 * @import { BackupSet } from "./sets.mjs"
 * @import { CompareError } from "./compare.mjs"
 * @import { HashProgress, HashSource } from "./file-props.mjs"
 * @import { RowTransform, SnapshotEntries, SnapshotErrors } from "./snapshot-file.mjs"
 * @import { Sending, TransferState } from "./upload.mjs"
 */

// Taking a set's snapshot: find its files, hash them (reusing what hasn't
// changed), and write the TSV. The engine `snapshot` and `backup` share — both
// are thin porcelain over it, differing only in the `through` transform they pass
// (nothing, versus the object uploader that makes a backup one fused pass —
// ADR-0069). It sits above snapshot-file.mjs, which owns the file's grammar and
// its atomic, interrupt-parking write; this module owns *what goes in one*.

/**
 * The set's previous snapshot and the hash source a fresh one reuses.
 * `previous` is the compare baseline (and `backup`'s upload baseline) — strictly
 * the previous snapshot's entries. `lookup` is what hashing consults: those
 * entries **and** any hashes an interrupted run parked (ADR-0067), so restarting
 * a long first seed doesn't re-hash what it already did. The two stay apart
 * because parked rows were never in that snapshot, so they must not read as its
 * content.
 * @typedef {Object} SnapshotBaseline
 * @property {string} [name] - The previous snapshot's name (absent on a first run)
 * @property {SnapshotEntries} [previous] - Its entries — the compare/upload baseline
 * @property {SnapshotErrors} previousErrors - The paths it *couldn't* hash (`#ERROR` rows) — the compare baseline's other half, without which a file that was merely unreadable last time reads as brand new (ADR-0079). Always a Map, empty when there is no previous snapshot, so a caller that has a baseline has both halves of it
 * @property {HashSource} [lookup] - Where a stored hash may be reused from: the previous snapshot's entries with the parked ones laid over them. Absent under `--rehash`, or when there is neither
 * @property {string} [instant] - When it was taken, as a UTC instant. Absent when there is no previous snapshot, or its file carries no `#SNAPSHOT` header
 */

/**
 * Turn a recorded start instant into the epoch-millisecond boundary
 * {@link HashSource} carries — only when the set has opted in to the change-time
 * check with `S3CAB_CHECK_CHANGE_TIME`
 * ([ADR-0094](../../docs/adr/0094-change-time-check-opt-in.md)), in the set's env
 * file or the shell. Otherwise `undefined`: reuse on size and mtime alone.
 * @param {string} [at] - A recorded instant, if the file carries one
 * @returns {number | undefined}
 */
const trustBoundary = (at) =>
  process.env.S3CAB_CHECK_CHANGE_TIME && at !== undefined
    ? Date.parse(at)
    : undefined;

/**
 * Read the set's previous snapshot and assemble the hash lookup for a fresh one.
 * The parked lookup is read on *every* snapshot, not just a first one: no "is
 * this the first run?" branch to get wrong, and in the routine case the parked
 * file is simply consumed.
 *
 * `rehash` means re-hash everything, so it suppresses the `lookup` — but the
 * previous snapshot is still *read*, because it is also the compare baseline and
 * (for `backup`) the upload baseline, which `--rehash` says nothing about.
 *
 * `resume` adopts the work file a killed run left behind
 * ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md)), which
 * is why it happens *here*: adoption has to beat both the lock the write will
 * take and the parked read just below. Before the `rehash` return too — under
 * `--rehash` the hashes are unwanted but the unlock is the whole point, so the
 * combination has to clear the file rather than trip over it. Without
 * `--resume`, a work file is refused here for the same reason of order: this is
 * the first step of both commands, and `backup`'s store LIST comes next.
 * @param {BackupSet} set - The resolved set
 * @param {object} options
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.resume] - Adopt the work file an interrupted run left behind, reusing the hashes it had already computed (`--resume`)
 * @returns {Promise<SnapshotBaseline>}
 */
export async function readBaseline(set, { rehash, resume }) {
  const snapshotDir = set.snapshotsDir;

  if (resume) {
    await recoverWorkFile(snapshotDir);
  } else {
    assertNoWorkFile(snapshotDir);
  }

  /** @type {SnapshotEntries | undefined} */
  let previous;
  /** @type {SnapshotErrors} */
  let previousErrors = new Map();
  /** @type {string | undefined} */
  let instant;
  const name = listSnapshotNames(snapshotDir).at(0);
  if (name) {
    // One line for the whole step, naming the file it reads. `readSnapshotFile`
    // used to log a second "Read snapshot file … in N sec" of its own on the way
    // out — two lines for one step, and a duration that is a second or two on
    // even a large set. The path is composed once and then *read*, rather than
    // announced here and resolved again by `readSnapshot`: the file named is the
    // file opened, by identity rather than by two derivations agreeing.
    // `listSnapshotNames` only yields names backed by a `.tsv.gz`, so the
    // composed path exists.
    const path = join(snapshotDir, snapshotFileName(name));
    console.warn("Reading previous snapshot", `'${tildeify(path)}'`);
    const { entries, errors, instant: at } = await readSnapshotFile(path);
    previous = entries;
    // Kept for the same reason as the entries, and just as free: the compare
    // that follows needs both halves of this snapshot to tell a file that was
    // unreadable last time from one that is genuinely new (ADR-0079).
    previousErrors = errors;
    // Already parsed on the way past, and free: the clock check below and the
    // change-time check's boundary are the reasons it is kept.
    instant = at;
  }

  if (rehash) {
    return { name, previous, previousErrors, instant };
  }

  const parked = await readParkedLookup(snapshotDir, instant);
  if (parked) {
    console.warn("Reusing the hashes parked by an interrupted snapshot");
  }

  // Parked rows laid over the previous ones: they are the newer of the two, so
  // where both know a path the parked row is the one that can still match a
  // file the interrupted run had already got to. One boundary for both, the
  // older start: a parked row was recorded after it, so a file untouched since
  // then is untouched since its parked row too.
  /** @type {HashSource | undefined} */
  let lookup;
  if (parked) {
    lookup = {
      entries: new Map([...(previous ?? []), ...parked.entries]),
      baselineMs: trustBoundary(previous ? instant : parked.instant),
    };
  } else if (previous) {
    lookup = { entries: previous, baselineMs: trustBoundary(instant) };
  }

  return { name, previous, previousErrors, lookup, instant };
}

/**
 * What one snapshot pass produced — the file it wrote, and the facts about the
 * run that only the pass itself knows. It used to return `{name, path}` and drop
 * the rest on the floor, so `backup` had nothing to report but an object count
 * ([ADR-0078](../../docs/adr/0078-backup-run-report.md)).
 *
 * `skipped` and `errors` come from **here**, not from the diff that follows,
 * even though the diff carries them too: they are facts about the snapshot just
 * written rather than about the comparison, and a first backup — which runs no
 * diff at all (ADR-0078 §7) — still has to report them.
 * @typedef {Object} SnapshotPass
 * @property {string} name - The snapshot's name
 * @property {string} path - Where it landed locally
 * @property {number} files - Files the walk kept and the pass went through
 * @property {number} bytes - The scanned files' total size — **not** bytes read off the disk, since an unchanged file reuses its stored hash and is never opened. It is the figure the progress line counts up to, so the closing report and the line the user watched agree
 * @property {number} hashedFiles - How many of those files were really read and hashed; the rest reused a stored hash
 * @property {number} hashedBytes - Their bytes — the disk work the elapsed time actually went on, and the difference between a routine pass and one that re-read the whole set
 * @property {number} skipped - Entries the walk left out by design (`#SKIPPED`): its unsupported types
 * @property {CompareError[]} errors - Files it couldn't hash (`#ERROR`), with the reason each row records
 * @property {string[]} roots - The member directories as the walk resolved them — the spelling every path above starts with, which `dirs.txt`'s text need not be
 * @property {number} elapsedMs - How long the whole pass took, walking included
 */

/**
 * Take the set's snapshot: walk every member directory, hash each kept file
 * (reusing `lookup`'s hash where the file is unchanged), and write the result
 * into the set's snapshot store.
 *
 * `through` is the fusion seam (ADR-0069): a pass-through over the hashed rows,
 * which `backup` uses to PUT each object the moment it is hashed and `snapshot`
 * leaves empty. Because it rides *inside* the write, it inherits everything
 * `withSnapshotFile` gives that write — the concurrency lock (ADR-0048) and the
 * park-on-interrupt handler (ADR-0067) — so Ctrl+C during a backup parks its
 * hashes exactly as it does during a snapshot, with the objects already uploaded
 * left as harmless orphans.
 * @param {BackupSet} set - The resolved set
 * @param {object} [options]
 * @param {SnapshotBaseline} [options.baseline] - `readBaseline`'s result, passed through whole: `lookup` for hash reuse, `previous` for the progress line's byte denominator (see `withProgress`; absent on a first run, which has no previous snapshot to size against), and `instant` for the clock-went-backwards warning below
 * @param {RowTransform} [options.through] - Pass-through applied to each hashed row (`backup`'s object uploader)
 * @param {() => TransferState} [options.transfer] - That uploader's live state, so the one progress line can report the sending too
 * @param {boolean} [options.debug] - Leave an uncompressed copy beside the snapshot (and allow a same-minute overwrite)
 * @returns {Promise<SnapshotPass>} The snapshot, and what the pass took to make it
 */
export async function generateSnapshot(
  set,
  { baseline, through, transfer, debug } = {},
) {
  const { lookup, previous: sizes, instant: previousInstant } = baseline ?? {};
  // From here, not from the first hashed row: the walk is part of what the
  // report calls scanning, and on a big set it is minutes of it.
  const startedAt = performance.now();

  // One clock read gives the name, the UTC instant, and the zone — the three
  // spellings the file needs, which therefore cannot disagree (ADR-0072).
  const moment = snapshotMoment();
  const { name } = moment;
  warnIfClockWentBack(moment, previousInstant);
  // The pass announces itself once, here, so the line that follows carries no
  // constant text at all — it was spending a dozen columns four times a second
  // repeating a label that never changed, and those columns are what the file
  // path needs. It names what it is doing (an uploader spliced in makes this a
  // backup; hashing is then the means, not the errand), what it is doing it to,
  // and where that lands: `<set>/<snapshot>` is already how the rest of the
  // output identifies a snapshot within a set, and the path is the pasteable
  // half the "Generating new snapshot" line it replaces used to carry.
  const displayPath = join(set.snapshotsDir, snapshotFileName(name));
  const verb = transfer ? "Backing up" : "Snapshotting";
  console.warn(`${verb} '${set.name}/${name}' ('${tildeify(displayPath)}'):`);
  // Where the objects are going, on a second line (ADR-0078 §11). Until now the
  // only line that named the bucket was the store LIST's, which fires *only*
  // when there is no trusted baseline — so s3cab named the destination on a
  // first backup and never again, and every routine run afterwards said which
  // folders it was reading and stayed silent about where it was sending them.
  // Same shape as that line, quotes and all: the bucket alone, since the
  // `objects/` prefix is internal layout (guide/format.md) while `s3://<bucket>`
  // is the thing the user configured. Only when this pass is sending — an
  // offline `snapshot` has no destination to name.
  if (transfer) {
    console.warn(`Storing objects in 's3://${set.bucket}'`);
  }

  const { files, excluded, skipped } = walkSet(set);
  // The `#DIR` headers, canonicalized the same way the walk canonicalized the
  // roots it yielded these files from — `dirs.txt` is hand-edited (ADR-0052), so
  // its text can name a directory in any casing Windows accepts while the rows
  // below carry the on-disk spelling. Writing the raw text made a header that
  // disagreed with every row it introduced, which `restore --output` reads as
  // "this file is under no backed-up directory". After the walk, not before:
  // `walkSet` runs `assertWalkableDirs` first, so an unplugged drive is reported
  // as the whole list of what's unreachable (ADR-0054) instead of the first
  // one's `ENOENT`. One realpath per member directory, against a walk that has
  // just stat-ed every file under them.
  const roots = set.dirs.map(resolveWalkRoot);

  // The set's name — its whole identity (ADR-0024) — heads the snapshot, with
  // one #DIR line per member directory, so the file is self-describing even when
  // found alone in a bucket (docs/design/backup.md). Hashing is handed in as
  // `getProps` — `writeSnapshot`'s injected hashing seam (so tests can drive it
  // without disk) — here bound to the lib `fileProps` with the lookup assembled
  // by `readBaseline`, so an unchanged file reuses its stored hash.
  // The hash in flight, published by `fileProps` and cleared the moment it
  // returns — so the progress line can measure a hash that has run long enough
  // for its figures to be read. It does not name the file: `currentFile` below
  // does that for every file, this one included. Held here, at the binding site,
  // rather than inside `fileProps`: the function stays pure per call, and the
  // mutable "what is happening now" belongs to the pass that is running.
  /** @type {HashProgress | null} */
  let hashing = null;
  // The last file the pass had in its hands, named whether or not it was slow
  // enough to earn the detail above. A string, not a second `HashProgress`: one
  // assignment per file is affordable on the walk/snapshot hot path where one
  // object per file is not, and `fileProps` publishes a `HashProgress` only on
  // the streaming branch — so on a set of small files nothing else here ever
  // knows a name at all.
  //
  // **Set but never cleared**, which is the difference between this working and
  // not. `hashing` is cleared the moment its file is done because a stale
  // *measurement* would be a lie; a stale *name* is not, and clearing it showed
  // the empty column all over again. On a set of small files every redraw is
  // the pass's tick *between* rows (see `withProgress`), so a draw lands almost
  // exactly when no file is in hand — the same trap the clock was introduced to
  // get the transfer suffix out of. The pass is
  // sequential, so the file it last touched is always either in flight or just
  // finished: a truthful sample of where the walk has got to either way.
  /** @type {string | null} */
  let currentFile = null;
  // Whether the user has asked this pass to stop (ADR-0067's park). Read by the
  // progress line, and set from `writeSnapshot`'s `onStop` below rather than from
  // a handler of our own: the signal belongs to the scope that owns the open
  // stream, and installing a second handler here would be a second answer to the
  // same question. One-way — a park is never taken back.
  let stopping = false;
  // Bytes this pass has got through, and the total it is heading for. The total
  // is the previous snapshot's size for each file the walk just found — costing
  // one Map lookup per file and not a single `stat`, which is what makes a byte
  // figure affordable here at all (the walk yields paths, and stat-ing each one
  // is the per-file cost the hot path can't take). Files the baseline doesn't
  // know — new ones — are absent from it, so it is an estimate; `progressLine`
  // grows it rather than letting the percentage exceed 100.
  let bytesDone = 0;
  // Of those, what was really read rather than reused. Two figures that look
  // alike and answer different questions: `bytesDone` is how big the set is,
  // this is how much work the pass did. A backup that re-read 1.8TB and one
  // that reused every hash are minutes apart and otherwise indistinguishable
  // in the report — which is exactly the case a sync client rewriting mtimes
  // produces, silently, on a set nobody has touched.
  let hashedFiles = 0;
  let hashedBytes = 0;
  // Files the pass couldn't hash. Collected at the one place that learns of them
  // — `getProps` throwing is what `writeSnapshot` turns into an `#ERROR` row — so
  // the list cannot drift from the rows actually written.
  /** @type {CompareError[]} */
  const errored = [];
  let bytesTotal = 0;
  for (const file of files) {
    bytesTotal += sizes?.get(file)?.size ?? 0;
  }

  const path = await writeSnapshot(set.snapshotsDir, moment, {
    identity: set.name,
    dirs: roots,
    onStop: () => (stopping = true),
    files: withProgress({
      total: files.length,
      bytesTotal,
      bytes: () => bytesDone,
      transfer,
      hashing: () => hashing,
      currentFile: () => currentFile,
      stopping: () => stopping,
    })(files),
    excluded,
    skipped,
    getProps: async (file) => {
      currentFile = file;
      try {
        const props = await fileProps(file, lookup, {
          onHashStart: (started) => (hashing = started),
        });
        // The *real* size, not the baseline's guess at it: every file yields one
        // whether it was hashed or reused, so the numerator is exact even where
        // the denominator is estimated.
        bytesDone += props.size;
        // Read or reused, told apart at no cost: `fileProps` returns the
        // baseline's own `Props` object on a reuse and sets `hashDuration`
        // only on a path that actually hashed — and a row parsed back out of a
        // snapshot file never carries one (`parseSnapshotStream` builds
        // hash/size/mtime and nothing else). So the field's presence is an
        // exact discriminator rather than a heuristic.
        if (props.hashDuration !== undefined) {
          hashedFiles++;
          hashedBytes += props.size;
        }
        return props;
      } catch (error) {
        // The same text the `#ERROR` row records (see `propsRows`).
        const reason = Error.isError(error) ? error.message : String(error);
        errored.push({ path: file, reason });
        throw error;
      } finally {
        hashing = null;
      }
    },
    through,
    overwrite: Boolean(debug),
  });

  if (debug) {
    await pipeline(
      createReadStream(path),
      createGunzip(),
      createWriteStream(join(dirname(path), ".snapshot.tsv")),
    );
  }

  return {
    name,
    path,
    files: files.length,
    bytes: bytesDone,
    hashedFiles,
    hashedBytes,
    skipped: skipped.length,
    errors: errored,
    roots,
    elapsedMs: performance.now() - startedAt,
  };
}

/**
 * Wrap a stream of file paths in the pass's one stderr progress line.
 *
 * One line, because this pass is one activity to the person watching it, however
 * many stages it has inside. When `transfer` is supplied the pass is *also*
 * sending files (the fused backup, ADR-0069) — so the line says so, adds the
 * bytes gone up, and suffixes whichever file is on the wire:
 *
 * ```
 * 3m 02s  4,182/58,310   38% of 2.4GB  (Uploaded: 1.2GB)    …/ragged.jpg  [hashed, sent 55% of 999.9MB]
 * 3m 02s  4,182/58,310   38% of 2.4GB  (Uploaded: 1.2GB)    …/notes.txt
 *     8s  4,182/58,310   38% of 2.4GB
 * 3m 02s  4,182/58,310   38% of 2.4GB  (Uploaded: 1.2GB)    Stopping…  …/ragged.jpg  [hashed, sent 55% of 999.9MB]
 * ```
 *
 * The second line is the ordinary case, and the common one: no verb, because
 * nothing in flight has taken long enough to be worth measuring, but the path is
 * still there — going by several times a second on a set of small files, which
 * is what a working line looks like.
 *
 * **The percentage is of bytes, never of files.** A file percentage was tried
 * and dropped: the wait is dominated by bytes, and the sizes here span four
 * orders of magnitude (a photo set is thousands of ~4MB files and a handful of
 * multi-GB videos), so "99%" with the big files still to go is a promise the
 * number can't keep. The counts stay too — they answer a different question —
 * but they are no longer the only thing on offer.
 *
 * What makes a byte figure affordable is that **it costs no `stat`**: the
 * denominator comes from the previous snapshot, which the run has already read
 * for its hash lookup and which records a size for every file in it. Stat-ing
 * each walked file instead would be the per-file cost the hot path can't take
 * (roughly an order of magnitude on the walk, on Windows) — so the one honest
 * source that is already in memory is the one used. A first run has no previous
 * snapshot, hence no denominator, and falls back to counts alone.
 *
 * The in-place animation, the TTY gate, and the redraw cadence live in
 * `lib/progress.mjs`; this owns only what the line says.
 * @param {object} args
 * @param {number} args.total
 * @param {number} args.bytesTotal - Bytes this pass expects to get through (0 = unknown)
 * @param {() => number} args.bytes - Bytes it has got through so far
 * @param {() => TransferState} [args.transfer] - The sending's live state, when this pass sends
 * @param {() => HashProgress | null} args.hashing - The hash in flight, if one is, of `currentFile`
 * @param {() => string | null} [args.currentFile] - The file in hand, named even when
 *   it is too fast to be measured
 * @param {() => boolean} [args.stopping] - Whether the user has asked the pass to stop
 */
function withProgress({
  total,
  bytesTotal,
  bytes,
  transfer,
  hashing,
  currentFile,
  stopping,
}) {
  /** @param {Iterable<string> | AsyncIterable<string>} paths */
  return async function* (paths) {
    const start = Temporal.Now.instant();
    const color = styleEnabled(process.stderr);
    let current = 0;
    /** @param {boolean} inHand - Whether a file is in hand to name */
    const frame = (inHand) =>
      progressLine({
        current,
        total,
        bytesDone: bytes(),
        bytesTotal,
        start,
        state: transfer?.(),
        hashing: inHand ? hashing() : null,
        currentFile: inHand ? currentFile?.() : null,
        stopping: stopping?.(),
        width: process.stderr.columns,
        color,
      });

    // A clock drives this line, not the paths flowing through it. This is a
    // *pull* pipeline — paths → hash → upload → write — so redrawing as each
    // path is pulled means redrawing only between rows, which is precisely when
    // there is nothing being sent: the file that was uploading has finished and
    // the next has not begun, so the transfer suffix was never once on screen
    // while it had something to say. Worse, a row that takes minutes (a
    // multi-GB upload, a slow hash) blocks the pull, and the whole line — count,
    // bytes, clock — froze for the duration, exactly when it most needed to look
    // alive. On a clock the line reports what is true at the moment it draws.
    // Four times a second: fast enough that a byte percentage climbs visibly,
    // calm enough for a line this wide.
    using line = clockedLine(process.stderr, () => frame(true), {
      every: TICK_MS,
    });
    for await (const path of paths) {
      current++;
      yield path;
      // The clock's other hand (ADR-0093). The line's timer fires only on an
      // event-loop turn, and on a set of small files this pipeline gives it
      // none: every stage is an `async` function whose work is synchronous, so
      // each `await` is a microtask and the loop never turns. The timer still
      // carries the slow *asynchronous* row (a multipart upload, a streamed
      // hash), which turns the loop on real I/O; this carries everything else.
      // **After the row, not before it.** A pull pipeline resumes here only
      // once the consumer has finished with the path it was handed, so by this
      // point `current` and the pass's `currentFile` describe the same file.
      // Ticking before the yield would draw file N-1's name beside a count of N.
      line.tick();
    }
    // The pass ran to its end, so its last frame is the true one: every file,
    // every byte, and no detail column, because nothing is in hand. Drawn here
    // rather than from disposal, so a pass that throws or is stopped keeps the
    // last frame it ticked — where it got to — instead of one claiming it
    // finished.
    line.done(frame(false));
  };
}

/**
 * Compose the progress line. Split out from `withProgress`, and taking the
 * terminal width rather than reading it, so the wording and the trimming are
 * both assertable without a pipeline or a terminal.
 * @param {object} args
 * @param {number} args.current - Files hashed so far
 * @param {number} args.total - Files this pass will hash
 * @param {number} [args.bytesDone] - Bytes got through so far
 * @param {number} [args.bytesTotal] - Bytes expected in all (0/absent = unknown, e.g. a first run)
 * @param {Temporal.Instant} args.start
 * @param {TransferState} [args.state] - Absent when the pass only hashes
 * @param {HashProgress | null} [args.hashing] - The hash in flight, if one is, of `currentFile`
 * @param {string | null} [args.currentFile] - The file in hand, which names a hash in flight too
 * @param {boolean} [args.stopping] - The user has asked the pass to stop and it is finishing the file in hand (ADR-0067)
 * @param {number} [args.width] - Columns available (absent = unbounded)
 * @param {boolean} [args.color] - Dim the detail (`styleEnabled`)
 * @returns {string}
 */
export function progressLine({
  current,
  total,
  bytesDone = 0,
  bytesTotal = 0,
  start,
  state,
  hashing,
  currentFile,
  stopping,
  width,
  color = false,
}) {
  // Every field before the path is fixed width, so the path starts at the same
  // column from one redraw to the next. Left to grow — a count gaining a digit,
  // an elapsed going from `9s` to `12m 21s` — it shuffles sideways four times a
  // second, which is unreadable however correct each frame is.
  //
  // The clock leads, unlabelled: it is the whole pass's, not any one figure's.
  // The bytes sent are bracketed apart from the two progress figures — they
  // measure the wire, not how far through the set the pass is — and padded
  // *whole*, on the right, so no gap opens between the label and its number.
  const totals = formatCount(total);
  const counts = `${formatCount(current).padStart(totals.length)}/${totals}`;
  const clock = elapsedSince(start).padStart(ELAPSED_COLUMNS);
  const share = byteShare(bytesDone, bytesTotal);
  const sent = state
    ? `  ${`(Uploaded: ${formatByteValue(state.sent)})`.padEnd(UPLOADED_COLUMNS)}`
    : "";
  const run = `${clock}  ${counts}${share}${sent}`;
  // A stop goes with the figures, not in the detail column, and two reasons point
  // the same way. The figures are the last thing shed — the budget below drops
  // the path first and then the detail whole — so the stop survives every width
  // the figures themselves do. (Narrower than that and this returns an
  // over-width line, which `createProgress`'s backstop cuts from the right,
  // taking the stop with it. Accepted: a terminal too narrow for the counts has
  // already lost the line, and buying the stop a width of its own would mean a
  // shed order the figures no longer win.) And the detail is where `[hashed,
  // sent 55% of 1.2GB]` lives, which *during* a stop is the answer to "how long is this
  // wait", so it is the last thing worth taking away: the second Ctrl+C is the
  // way out of waiting, and a user deciding whether to press it needs that
  // percentage. The cost is the path column shifting right once, at the moment
  // the state changes — a one-off on a deliberate event, not the per-frame
  // shuffle the padding exists to prevent.
  //
  // The handler also prints a retained line saying what the stop will save
  // (`parkOnInterrupt`). That line scrolls; this one is where the eye already is,
  // and it is the only thing on screen still being repainted.
  const stop = stopping ? "  Stopping…" : "";
  const head = `${run}${stop}`;
  // The same figures without the clause's padding, which the stop would otherwise
  // hold open in front of it.
  const bare = `${run.trimEnd()}${stop}`;

  const detail = activity(
    state?.current ?? null,
    hashing ?? null,
    currentFile ?? null,
  );
  if (!detail) {
    return bare;
  }
  // The detail follows the path rather than sitting in a column before it, so
  // the path starts right after the figures and a fast file — no detail, the
  // common case — has no blank slot held open in front of it. Not a padded
  // column before the path: it held 24 columns empty on nearly every frame.
  // Square brackets, not round: a path can end in `(1).jpg`.
  const tail = detail.text ? `  [${detail.text}]` : "";
  // The edge column stays unwritten — writing a row's last cell makes some
  // terminals wrap on their own.
  const room = (width ?? Infinity) - 1;
  if (bare.length + tail.length > room) {
    // Not even the figures fit. The counts are the line's reason for existing,
    // so they win: shedding the detail whole beats letting the backstop in
    // lib/progress.mjs cut it mid-word.
    return bare;
  }
  // Keep the clause's padding so the path column holds still — but only while
  // that leaves the path room to be worth printing. On a narrow terminal a fixed
  // column the path never reaches is alignment for its own sake, so the padding
  // goes first.
  const aligned = room - head.length - 2 - tail.length >= MIN_PATH_COLUMNS;
  const lead = aligned ? head : bare;
  const shown = fitPath(detail.path, room - lead.length - 2 - tail.length);
  // No room for the path. A labelled detail still says something without one
  // (`[hashed, sent 27% of 1.8GB]`); a bare current file is *only* the path, so the
  // line ends at the figures.
  // Dimmed only now: the budget above counts columns, and escape codes take none.
  // The brackets stay, so the detail is still set apart where styling is off.
  const styled = color && detail.text ? `  ${dim(`[${detail.text}]`)}` : tail;
  return shown ? `${lead}  ${shown}${styled}` : `${bare}${styled}`;
}

/**
 * `  38% of 2.4GB`, or nothing at all when there is no total to be a share of.
 *
 * The denominator is the previous snapshot's sizes for the files this pass
 * walked (see `withProgress`), so a file that is new — or that has grown since —
 * is not in it, while the numerator counts every byte actually got through. Left
 * alone the two would disagree and the figure would sail past 100%, which is
 * worse than no figure: so the total is grown to whatever has really been read.
 * The percentage then only ever *slows down*, which is the honest direction for
 * an estimate to be wrong in — it never promises a finish it can't deliver.
 *
 * Nothing is shown when there is no baseline at all (a first run). "100% of
 * 4.2GB" derived from `Math.max` alone would be a measurement of itself.
 * @param {number} done
 * @param {number} total
 * @returns {string}
 */
function byteShare(done, total) {
  if (!total) {
    return "";
  }
  const of = Math.max(total, done);
  const percent = `${Math.floor((done / of) * 100)}%`;
  // The percentage is padded, so `9%` becoming `100%` doesn't shift the path
  // column. The total isn't: it is fixed for the run, and grows only when a run
  // reads more than the previous snapshot recorded.
  return `  ${percent.padStart(4)} of ${formatByteValue(of)}`;
}

// How often the line redraws.
const TICK_MS = 250;

// A row has to be *worth* reporting before it gets a *labelled* detail —
// `[hashed 27% of 1.8GB]`, a verb and a measurement. Below this the figures are
// over before they can be read, and tens of thousands of them flickering past
// hide the one row that is actually holding things up.
//
// It no longer decides whether the file is *named*: that gate applied to the
// path too, and on a set of small files nothing ever passed it, so the line ran
// for hours with an empty detail column and read as hung (ADR-0076, amended).
const WORTH_REPORTING_MS = 1000;

// `999.9MB` is the widest `formatByteValue` gets; the bytes-sent clause is
// padded to its own widest so nothing to its right moves as the figure changes.
const BYTES_COLUMNS = 7;
const UPLOADED_COLUMNS = "(Uploaded: ".length + BYTES_COLUMNS + ")".length;

/**
 * The one slow thing this pass is doing right now, as `hashed 27% of 1.8GB` —
 * or `hashing 1.8GB` until a figure comes back. A single PUT reports its bytes
 * once, at the end, so a small upload never earns a percentage; a streamed hash
 * and a multipart upload both do. A send this run hashed says so (`hashed, sent
 * 55% of 2.4GB`), because the two steps run back to back on one file and each
 * climbs to 100% on its own; a send of a reused hash is just `sent`.
 *
 * Failing that, the file in hand with no text at all. Nothing measurable is known
 * about it — `fileProps` slurps anything under 5MB in one call and publishes no
 * `HashProgress` — but *which* file is known, always, and a path going by four
 * times a second is the difference between a line that is working and a line
 * that has hung.
 * @param {Sending | null} sending
 * @param {HashProgress | null} hashing
 * @param {string | null} [currentFile]
 * @returns {{ text: string, path: string } | null}
 */
function activity(sending, hashing, currentFile) {
  const now = performance.now();
  // The text carries no separator of its own — `progressLine` owns the spacing
  // and budgets the line against this exact string.
  if (sending && now - sending.startedAt >= WORTH_REPORTING_MS) {
    return {
      text: `${sending.hashed ? "hashed, " : ""}${measured("sending", "sent", sending.total, sending.loaded)}`,
      path: sending.path,
    };
  }
  if (!currentFile) {
    return null;
  }
  // A hash in flight is always `currentFile`'s: the pass sets that before it
  // starts the hash, and hashes one file at a time. So the name comes from there
  // and `HashProgress` carries none.
  if (hashing && now - hashing.startedAt >= WORTH_REPORTING_MS) {
    return {
      text: measured("hashing", "hashed", hashing.size, hashing.read()),
      path: currentFile,
    };
  }
  return { text: "", path: currentFile };
}

/**
 * `hashed 27% of 1.8GB`, or `hashing 1.8GB` when nothing has been reported yet —
 * "0%" would dress up "no figure has come back" as a measurement.
 * @param {string} doing
 * @param {string} did
 * @param {number} size
 * @param {number} done
 * @returns {string}
 */
const measured = (doing, did, size, done) =>
  done > 0 && size > 0
    ? `${did} ${Math.floor((done / size) * 100)}% of ${formatByteValue(size)}`
    : `${doing} ${formatByteValue(size)}`;

// Below this a path is unreadable rubble — "…pg" tells you nothing, and the
// percentage it would crowd out tells you something. Drop it instead.
const MIN_PATH_COLUMNS = 12;

/**
 * Trim a path to the room left on the line, keeping the *end* — the file name is
 * the part worth reading, and a progress line must not wrap: an in-place redraw
 * clears one row, so the overflow of a wrapped line is stranded on screen.
 * @param {string} path
 * @param {number} room - Columns left for the path
 * @returns {string} The path, its tail behind an ellipsis, or nothing
 */
function fitPath(path, room) {
  if (path.length <= room) {
    return path;
  }
  return room >= MIN_PATH_COLUMNS ? "…" + path.slice(-(room - 1)) : "";
}

/**
 * Warn when the snapshot about to be written will sort *before* its predecessor
 * — check A of [ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md).
 *
 * Snapshot names are local wall clock, and `listSnapshotNames` orders them by
 * sorting those strings. That is right almost always and wrong in two knowable
 * cases: the hour the clocks go back, and a machine carried across time zones.
 * The consequence is silent — `restore` with no `--snapshot`, `compare`'s
 * default previous, and `--latest` would all keep choosing the older name — so
 * this says it out loud at the one moment the fault is *created*, rather than
 * leaving someone to find it when they are restoring.
 *
 * Compares true instants, not names, so it cannot mis-fire on a name that merely
 * looks odd; and it catches every cause, including a clock that is simply wrong.
 *
 * **Warns, never blocks.** A clock oddity must not stop a backup — least of all
 * while travelling, which is one of the two ways to get here.
 *
 * Silent whenever the predecessor cannot answer — the condition is
 * `previousInstant`, not "is this a first run". Usually there is no predecessor
 * at all; a predecessor whose file carries no `#SNAPSHOT` header reaches here
 * the same way, since `Snapshot` leaves the instant absent rather than guessing
 * it. Guessing from the names instead would reintroduce exactly the ambiguity
 * this check exists to see through.
 * @param {{ name: string, instant: string }} moment - The snapshot about to be written
 * @param {string} [previousInstant] - The predecessor's instant, if it has one
 */
function warnIfClockWentBack({ name, instant }, previousInstant) {
  if (
    !previousInstant ||
    Temporal.Instant.compare(instant, previousInstant) >= 0
  ) {
    return;
  }
  console.warn(
    `This snapshot will be named '${name}', which sorts before the one before ` +
      `it — the computer's clock has gone back since then (daylight saving, a ` +
      `different time zone, or a clock that needs setting).\n` +
      `The backup itself is unaffected. Until the clock passes that time, ` +
      `commands that default to the latest snapshot will keep choosing the ` +
      `earlier one, so name this snapshot explicitly if you restore from it.`,
  );
}
