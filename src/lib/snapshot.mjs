import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { OnlineOnlyFileError } from "./error.mjs";
import { fileProps } from "./file-props.mjs";
import {
  countOf,
  elapsedSince,
  formatByteValue,
  formatCount,
} from "./format.mjs";
import { tildeify } from "./home.mjs";
import { createProgress } from "./progress.mjs";
import {
  listSnapshotNames,
  readParkedLookup,
  readSnapshotFile,
  snapshotFileName,
  snapshotMoment,
  writeSnapshot,
} from "./snapshot-file.mjs";
import { walkSet } from "./walk.mjs";

/**
 * @import { BackupSet } from "./sets.mjs"
 * @import { HashProgress } from "./file-props.mjs"
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
 * The set's previous snapshot and the hash lookup a fresh one reuses.
 * `previous` is the compare baseline (and `backup`'s upload baseline) — strictly
 * the previous snapshot's entries. `lookup` is what hashing consults, which is
 * those entries **plus** any hashes an interrupted run parked (ADR-0067), so
 * restarting a long first seed doesn't re-hash what it already did. The two are
 * separate maps on purpose: parked rows were never in that snapshot, so they
 * must not read as its content.
 * @typedef {Object} SnapshotBaseline
 * @property {string} [name] - The previous snapshot's name (absent on a first run)
 * @property {SnapshotEntries} [previous] - Its entries — the compare/upload baseline
 * @property {SnapshotErrors} previousErrors - The paths it *couldn't* hash (`#ERROR` rows) — the compare baseline's other half, without which a file that was merely unreadable last time reads as brand new (ADR-0079). Always a Map, empty when there is no previous snapshot, so a caller that has a baseline has both halves of it
 * @property {SnapshotEntries} [lookup] - The hash lookup: those entries with parked hashes overlaid
 * @property {string} [instant] - When it was taken, as a UTC instant. Absent when there is no previous snapshot, or its file carries no `#SNAPSHOT` header
 */

/**
 * Read the set's previous snapshot and assemble the hash lookup for a fresh one.
 * The parked lookup is read on *every* snapshot, not just a first one: no "is
 * this the first run?" branch to get wrong, and in the routine case the parked
 * file is simply consumed.
 *
 * `rehash` means re-hash everything, so it suppresses the `lookup` — but the
 * previous snapshot is still *read*, because it is also the compare baseline and
 * (for `backup`) the upload baseline, which `--rehash` says nothing about.
 * @param {BackupSet} set - The resolved set
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @returns {Promise<SnapshotBaseline>}
 */
export async function readBaseline(set, { rehash } = {}) {
  const snapshotDir = set.snapshotsDir;

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
    // `listSnapshotNames` only yields names backed by a `.tsv.zst`, so the
    // composed path exists.
    const path = join(snapshotDir, snapshotFileName(name));
    console.warn("Reading previous snapshot", `'${tildeify(path)}'`);
    const { entries, errors, instant: at } = await readSnapshotFile(path);
    previous = entries;
    // Kept for the same reason as the entries, and just as free: the compare
    // that follows needs both halves of this snapshot to tell a file that was
    // unreadable last time from one that is genuinely new (ADR-0079).
    previousErrors = errors;
    // Already parsed on the way past, and free: the clock check below is the
    // only reason it is kept rather than discarded with the rest of the header.
    instant = at;
  }

  if (rehash) {
    return { name, previous, previousErrors, instant };
  }

  const parked = await readParkedLookup(snapshotDir);
  const lookup =
    parked && previous
      ? new Map([...previous, ...parked])
      : (parked ?? previous);

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
 * @property {number} skipped - Entries left out by design (`#SKIPPED`): the walk's unsupported types, plus the cloud placeholders this pass declined to download (ADR-0081)
 * @property {number} errors - Files it couldn't hash (`#ERROR`)
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
 * @param {SnapshotEntries} [options.lookup] - Hash lookup: an unchanged file reuses its stored hash
 * @param {SnapshotEntries} [options.sizes] - The previous snapshot's entries, read for their `size` alone: the progress line's byte denominator (see `withProgress`). Omit on a first run, which has none
 * @param {RowTransform} [options.through] - Pass-through applied to each hashed row (`backup`'s object uploader)
 * @param {() => TransferState} [options.transfer] - That uploader's live state, so the one progress line can report the sending too
 * @param {boolean} [options.debug] - Leave an uncompressed copy beside the snapshot (and allow a same-minute overwrite)
 * @param {string} [options.previousInstant] - When the previous snapshot was taken (`readBaseline`): the clock-went-backwards warning, and the ctime cross-check on hash reuse (ADR-0085)
 * @param {boolean} [options.includeOnlineOnly] - Hash cloud placeholders too, downloading each one (`--include-online-only`, ADR-0081). Off by default: a first pass over a synced folder otherwise pulls the whole cloud account onto the local disk
 * @returns {Promise<SnapshotPass>} The snapshot, and what the pass took to make it
 */
export async function generateSnapshot(
  set,
  {
    lookup,
    sizes,
    through,
    transfer,
    debug,
    previousInstant,
    includeOnlineOnly,
  } = {},
) {
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

  // The set's name — its whole identity (ADR-0024) — heads the snapshot, with
  // one #DIR line per member directory, so the file is self-describing even when
  // found alone in a bucket (docs/design/backup.md). Hashing is handed in as
  // `getProps` — `writeSnapshot`'s injected hashing seam (so tests can drive it
  // without disk) — here bound to the lib `fileProps` with the lookup assembled
  // by `readBaseline`, so an unchanged file reuses its stored hash.
  // The hash in flight, published by `fileProps` and cleared the moment it
  // returns — so the progress line can name the file it is chewing on when one
  // takes long enough to be worth naming. Held here, at the binding site, rather
  // than inside `fileProps`: the function stays pure per call, and the mutable
  // "what is happening now" belongs to the pass that is running.
  /** @type {HashProgress | null} */
  let hashing = null;
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
  // Files the pass couldn't hash. Counted at the one place that learns of them —
  // `getProps` throwing is what `writeSnapshot` turns into an `#ERROR` row — so
  // the tally cannot drift from the rows actually written.
  let errored = 0;
  // Cloud placeholders this pass declined to download. Counted apart from
  // `errored` above and folded into the skipped total below — they are `#SKIPPED`
  // rows, so counting them as errors would report a working backup as a failing
  // one. Kept as its own variable rather than added straight to a running skip
  // total because the closing hint below needs the figure on its own: it is the
  // only skip class with a flag that changes it.
  let onlineOnly = 0;
  let bytesTotal = 0;
  for (const file of files) {
    bytesTotal += sizes?.get(file)?.size ?? 0;
  }

  // The baseline's instant as epoch millis, parsed once for the whole pass:
  // `fileProps` weighs every file's ctime against it, and re-parsing the string
  // per file is exactly the per-file cost the hot path can't take.
  const baselineMs =
    previousInstant === undefined ? undefined : Date.parse(previousInstant);

  const path = await writeSnapshot(set.snapshotsDir, moment, {
    identity: set.name,
    dirs: set.dirs,
    files: withProgress({
      total: files.length,
      bytesTotal,
      bytes: () => bytesDone,
      transfer,
      hashing: () => hashing,
    })(files),
    excluded,
    skipped,
    getProps: async (file) => {
      try {
        const props = await fileProps(file, lookup, {
          onHashStart: (started) => (hashing = started),
          includeOnlineOnly,
          baselineMs,
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
        // Two throws, two tallies — and the split has to happen here, at the one
        // place that learns of either, for the same reason `errored` is counted
        // here: the writer turns the throw into a row, so a count taken anywhere
        // else can drift from the rows actually written. A placeholder we
        // declined to download is a `#SKIPPED` row and belongs with the walk's
        // skips; everything else is a file we tried to read and couldn't.
        if (error instanceof OnlineOnlyFileError) {
          onlineOnly++;
        } else {
          errored++;
        }
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
      createZstdDecompress(),
      createWriteStream(join(dirname(path), ".snapshot.tsv")),
    );
  }

  // `transfer` is what tells the two porcelains apart, the same discriminator the
  // opening line uses for `Backing up` vs `Snapshotting` — so the command the
  // hint offers is the command the user actually ran.
  warnAboutOnlineOnly(onlineOnly, set.name, transfer ? "backup" : "snapshot");

  return {
    name,
    path,
    files: files.length,
    bytes: bytesDone,
    hashedFiles,
    hashedBytes,
    // The walk's skips and the pass's, added up: both are `#SKIPPED` rows in the
    // file just written, so the figure the report prints and the rows `compare`
    // lists come from the same set of things (ADR-0078 §2).
    skipped: skipped.length + onlineOnly,
    errors: errored,
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
 * 4,182/58,310   38% of   2.4GB  Uploaded   1.2GB in 3 min   Uploading 999.9MB (55%) …/ragged.jpg
 * 4,182/58,310   38% of   2.4GB in 8 sec
 * ```
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
 * @param {() => HashProgress | null} args.hashing - The hash in flight, if one is
 */
function withProgress({ total, bytesTotal, bytes, transfer, hashing }) {
  /** @param {Iterable<string> | AsyncIterable<string>} paths */
  return async function* (paths) {
    using progress = createProgress(process.stderr);
    const start = Temporal.Now.instant();
    let current = 0;
    const draw = () =>
      progress.update(
        progressLine({
          current,
          total,
          bytesDone: bytes(),
          bytesTotal,
          start,
          state: transfer?.(),
          hashing: hashing(),
          width: process.stderr.columns,
        }),
      );

    // A clock drives this line, not the paths flowing through it. This is a
    // *pull* pipeline — paths → hash → upload → write — so redrawing as each
    // path is pulled means redrawing only between rows, which is precisely when
    // there is nothing being sent: the file that was uploading has finished and
    // the next has not begun, so the transfer suffix was never once on screen
    // while it had something to say. Worse, a row that takes minutes (a
    // multi-GB upload, a slow hash) blocks the pull, and the whole line — count,
    // bytes, clock — froze for the duration, exactly when it most needed to look
    // alive. On a timer the line reports what is true at the moment it draws.
    //
    // Four times a second: fast enough that a byte percentage climbs visibly,
    // calm enough for a line this wide. `unref` so a pending tick can never hold
    // the process open; the `finally` stops it if the pipeline throws.
    draw();
    const ticking = setInterval(draw, 250);
    ticking.unref();
    try {
      for await (const path of paths) {
        current++;
        yield path;
      }
    } finally {
      clearInterval(ticking);
    }
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
 * @param {HashProgress | null} [args.hashing] - The hash in flight, if one is
 * @param {number} [args.width] - Columns available (absent = unbounded)
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
  width,
}) {
  // Every field before the path is fixed width, so the path starts at the same
  // column from one redraw to the next. Left to grow — a count gaining a digit,
  // an elapsed going from `9s` to `12m 21s` — it shuffles sideways four times a
  // second, which is unreadable however correct each frame is.
  const totals = formatCount(total);
  const counts = `${formatCount(current).padStart(totals.length)}/${totals}`;
  const elapsed = elapsedSince(start);
  const share = byteShare(bytesDone, bytesTotal);
  const run = state
    ? `${counts}${share}  Uploaded ${formatByteValue(state.sent).padStart(BYTES_COLUMNS)} in ${elapsed}`
    : `${counts}${share} in ${elapsed}`;

  const detail = activity(state?.current ?? null, hashing ?? null);
  if (!detail) {
    return run;
  }
  // Two budgets, because the two layouts spend different numbers of spaces:
  // `run + "  " + detail` when the path is dropped, and one more space before the
  // path when it isn't. Both leave the edge column unwritten — writing a row's
  // last cell makes some terminals wrap on their own. Budgeting the whole line
  // against the wider layout would shed the detail at the one width where it
  // fits exactly without a path.
  const forDetail = (width ?? Infinity) - run.length - 3;
  const forBoth = forDetail - 1;
  if (forDetail < detail.text.length) {
    // Not even the figures fit. The counts are the line's reason for existing,
    // so they win: shedding the detail whole beats letting the backstop in
    // lib/progress.mjs cut it mid-word.
    return run;
  }
  // Pad the detail so the path column holds still — but only while that leaves
  // the path room to be worth printing. On a narrow terminal a fixed column the
  // path never reaches is alignment for its own sake, so the padding goes first.
  const padded = detail.text.padEnd(ACTIVITY_COLUMNS);
  const aligned = forBoth - padded.length >= MIN_PATH_COLUMNS;
  const text = aligned ? padded : detail.text;
  const shown = fitPath(detail.path, forBoth - text.length);
  return shown ? `${run}  ${text} ${shown}` : `${run}  ${detail.text}`;
}

/**
 * `  38% of   2.4GB`, or nothing at all when there is no total to be a share of.
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
  // Both padded, for the same reason every other field here is: `9%` becoming
  // `100%`, or `999.9MB` becoming `1.0GB`, must not shift the path column.
  return `  ${percent.padStart(4)} of ${formatByteValue(of).padStart(BYTES_COLUMNS)}`;
}

// A row has to be *worth* reporting before its name goes on the line. Below this
// it is over before it can be read, and naming every one of tens of thousands of
// fast files is noise that hides the one that is actually holding things up.
const WORTH_REPORTING_MS = 1000;

// `999.9MB` is the widest `formatByteValue` gets, and `Uploading ` + that +
// ` (100%)` the widest the detail gets. Both are padded to their maximum so
// nothing to their right moves as the figures change.
const BYTES_COLUMNS = 7;
const ACTIVITY_COLUMNS = "Uploading ".length + BYTES_COLUMNS + " (100%)".length;

/**
 * The one slow thing this pass is doing right now, as `<verb> <size> (<pct>)` —
 * the size always (it is the fact we always have), the percentage parenthetical
 * because it is the fact we sometimes have. A single PUT reports its bytes once,
 * at the end, so a small upload never earns a percentage; a streamed hash and a
 * multipart upload both do.
 * @param {Sending | null} sending
 * @param {HashProgress | null} hashing
 * @returns {{ text: string, path: string } | null}
 */
function activity(sending, hashing) {
  const now = performance.now();
  // The text carries no separator of its own — `progressLine` owns the spacing,
  // so `ACTIVITY_COLUMNS` measures the same string that gets padded. Leading
  // spaces in here would both double the gap and push a maximum-length activity
  // past the pad width, shifting the path column in precisely the case the
  // padding exists to hold still.
  if (sending && now - sending.startedAt >= WORTH_REPORTING_MS) {
    return {
      text: `Uploading ${sized(sending.total, sending.loaded)}`,
      path: sending.path,
    };
  }
  if (hashing && now - hashing.startedAt >= WORTH_REPORTING_MS) {
    return {
      text: `Hashing ${sized(hashing.size, hashing.read())}`,
      path: hashing.path,
    };
  }
  return null;
}

/**
 * `1.8GB (27%)`, or just `1.8GB` when nothing has been reported yet — "0%" would
 * dress up "no figure has come back" as a measurement.
 * @param {number} size
 * @param {number} done
 * @returns {string}
 */
const sized = (size, done) =>
  done > 0 && size > 0
    ? `${formatByteValue(size)} (${Math.floor((done / size) * 100)}%)`
    : formatByteValue(size);

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
 * Say that cloud placeholders were left out, and how to include them.
 *
 * The count alone reaches the user through the closing report's
 * `Couldn't be backed up: N skipped` (ADR-0078 §2), and the paths and their type
 * through `compare` — but neither says the one thing this skip class needs said:
 * **it is the only one with a flag that changes it.** A symlink is skipped
 * because it can't be backed up; these were skipped because backing them up
 * means downloading them first, which is a choice the user is entitled to make
 * and can't make from a number.
 *
 * Worded to fit both porcelains, because both reach it: `snapshot` stores
 * nothing, so "backing them up" would be false there — the cost it warns about
 * is the *reading*, which is the same either way. "Including them" also names
 * what the flag on the line below does.
 *
 * ADR-0030 shape: the user's goal first, the mechanism in a parenthetical, the
 * exact fix as a copy-pasteable line of its own. It names the disk-space cost
 * because that is the reason the default is what it is — on a drive smaller than
 * the cloud account, the flag fills it and the run dies part-way.
 *
 * Silent at zero, which is every run on a machine with no sync client and every
 * run after the first on one that has (a placeholder already in the baseline
 * reuses its stored hash and never reaches the check — see `fileProps`).
 * @param {number} count - Placeholders this pass declined to download
 * @param {string} setName - The set, so the offered command names it as every other printed command does
 * @param {"backup" | "snapshot"} command - Which porcelain is running
 */
function warnAboutOnlineOnly(count, setName, command) {
  if (!count) {
    return;
  }
  // Worded so grammatical number never shows — `format.mjs`'s own advice for
  // clause agreement, and here it saves three hand-rolled is/are, was/were and
  // it/them pairs in one sentence.
  console.warn(
    `Left ${countOf(count, "file")} in '${setName}' online rather than ` +
      `downloading them: this computer holds a placeholder for each, not the ` +
      `contents (OneDrive Files On-Demand, or the same feature in Dropbox or ` +
      `Google Drive).\n` +
      `Including them means downloading every one to this disk first, so ` +
      `there has to be room for the lot. To do that:\n` +
      `  s3cab ${command} ${setName} --include-online-only`,
  );
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
