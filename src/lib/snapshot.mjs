import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { fileProps } from "./file-props.mjs";
import { elapsedSince, formatByteValue, formatCount } from "./format.mjs";
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
 * @import { RowTransform, SnapshotEntries } from "./snapshot-file.mjs"
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
    const { entries, instant: at } = await readSnapshotFile(path);
    previous = entries;
    // Already parsed on the way past, and free: the clock check below is the
    // only reason it is kept rather than discarded with the rest of the header.
    instant = at;
  }

  if (rehash) {
    return { name, previous, instant };
  }

  const parked = await readParkedLookup(snapshotDir);
  const lookup =
    parked && previous
      ? new Map([...previous, ...parked])
      : (parked ?? previous);

  return { name, previous, lookup, instant };
}

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
 * @param {string} [options.previousInstant] - When the previous snapshot was taken (`readBaseline`), for the clock-went-backwards warning
 * @returns {Promise<{ name: string, path: string }>} The snapshot's name and local path
 */
export async function generateSnapshot(
  set,
  { lookup, sizes, through, transfer, debug, previousInstant } = {},
) {
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
  let bytesTotal = 0;
  for (const file of files) {
    bytesTotal += sizes?.get(file)?.size ?? 0;
  }

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
        const props = await fileProps(
          file,
          lookup,
          (started) => (hashing = started),
        );
        // The *real* size, not the baseline's guess at it: every file yields one
        // whether it was hashed or reused, so the numerator is exact even where
        // the denominator is estimated.
        bytesDone += props.size;
        return props;
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

  return { name, path };
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
