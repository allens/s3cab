import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { fileProps } from "./file-props.mjs";
import { formatByteValue, formatCount, secondsSince } from "./format.mjs";
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
 * @import { RowTransform, SnapshotEntries } from "./snapshot-file.mjs"
 * @import { TransferState } from "./upload.mjs"
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
 * @property {string} [instant] - When it was taken, as a UTC instant (ADR-0072). Absent on a first run *and* on a pre-0072 snapshot, whose header carried no instant — so a consumer must handle not knowing
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
  const name = listSnapshotNames(snapshotDir, { latest: true });
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
 * @param {RowTransform} [options.through] - Pass-through applied to each hashed row (`backup`'s object uploader)
 * @param {() => TransferState} [options.transfer] - That uploader's live state, so the one progress line can report the sending too
 * @param {boolean} [options.debug] - Leave an uncompressed copy beside the snapshot (and allow a same-minute overwrite)
 * @param {string} [options.previousInstant] - When the previous snapshot was taken (`readBaseline`), for the clock-went-backwards warning
 * @returns {Promise<{ name: string, path: string }>} The snapshot's name and local path
 */
export async function generateSnapshot(
  set,
  { lookup, through, transfer, debug, previousInstant } = {},
) {
  // One clock read gives the name, the UTC instant, and the zone — the three
  // spellings the file needs, which therefore cannot disagree (ADR-0072).
  const moment = snapshotMoment();
  const { name } = moment;
  warnIfClockWentBack(moment, previousInstant);
  // The file it will land in, not just the name: the same shape as the
  // "Reading previous snapshot" line above, so the two ends of the step read as
  // a pair and either path can be pasted straight at a shell.
  const displayPath = join(set.snapshotsDir, snapshotFileName(name));
  console.warn("Generating new snapshot", `'${tildeify(displayPath)}'`);

  const { files, excluded, skipped } = walkSet(set);

  // The set's name — its whole identity (ADR-0024) — heads the snapshot, with
  // one #DIR line per member directory, so the file is self-describing even when
  // found alone in a bucket (docs/design/backup.md). Hashing is handed in as
  // `getProps` — `writeSnapshot`'s injected hashing seam (so tests can drive it
  // without disk) — here bound to the lib `fileProps` with the lookup assembled
  // by `readBaseline`, so an unchanged file reuses its stored hash.
  const path = await writeSnapshot(set.snapshotsDir, moment, {
    identity: set.name,
    dirs: set.dirs,
    // The pass names what it is doing. With an uploader spliced in it is a
    // backup — hashing is the means, not the errand — and saying "generating
    // snapshot file" while the wait is object transfers is the line telling half
    // the story (the half it was written for, before ADR-0069 fused the two).
    files: withProgress(
      transfer ? "Backing up…" : "Generating snapshot file…",
      files.length,
      transfer,
    )(files),
    excluded,
    skipped,
    getProps: (file) => fileProps(file, lookup),
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
 * Backing up… 4,182 of 58,310 files · 1.2GB sent in 3 min   55% of 2.4GB …\ragged.jpg
 * Generating snapshot file… 4,182 of 58,310 files in 8 sec
 * ```
 *
 * Counts, not the percentage this line used to show: the percentage is of
 * *files*, while the wait is dominated by *bytes*, and the sizes here span four
 * orders of magnitude (a photo set is thousands of ~4MB files and a handful of
 * multi-GB videos). "99%" with the big files still to go is a promise the number
 * can't keep, and a plain count doesn't make it. A byte percentage would be
 * honest but isn't available — the walk yields paths without stat-ing them, and
 * a stat pass per file is exactly the per-file cost the hot path can't afford —
 * so bytes appear as a running total instead.
 *
 * The in-place animation, the TTY gate, and the redraw cadence live in
 * `lib/progress.mjs`; this owns only what the line says.
 * @param {string} label
 * @param {number} total
 * @param {() => TransferState} [transfer] - The sending's live state, when this pass sends
 */
function withProgress(label, total, transfer) {
  /** @param {Iterable<string> | AsyncIterable<string>} paths */
  return async function* (paths) {
    using progress = createProgress(process.stderr);
    const start = Temporal.Now.instant();
    let current = 0;
    const draw = () =>
      progress.update(
        progressLine({
          label,
          current,
          total,
          start,
          state: transfer?.(),
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
 * @param {string} args.label
 * @param {number} args.current - Files hashed so far
 * @param {number} args.total - Files this pass will hash
 * @param {Temporal.Instant} args.start
 * @param {TransferState} [args.state] - Absent when the pass only hashes
 * @param {number} [args.width] - Columns available (absent = unbounded)
 * @returns {string}
 */
export function progressLine({ label, current, total, start, state, width }) {
  const counts = `${formatCount(current)} of ${formatCount(total)} files`;
  // "1.2GB sent in 3 min" — the elapsed time reads as the transfer's, which is
  // what the person waiting is actually timing. With nothing being sent there is
  // nothing to attach it to, so it falls back to the bare `in <elapsed>` the
  // other phases use.
  const elapsed = secondsSince(start);
  const run = state
    ? `${label} ${counts} · ${formatByteValue(state.sent)} sent in ${elapsed}`
    : `${label} ${counts} in ${elapsed}`;
  if (!state?.current) {
    return run;
  }
  const { path, loaded, total: size } = state.current;
  // A percentage only once there is one to report. Below the multipart threshold
  // a file goes up as a single PUT and the SDK reports its bytes once, at the
  // end — so `loaded` is 0 for the whole of a small file's transfer, and "0%"
  // would be dressing "nothing has come back yet" up as a measurement. The size
  // and the name are what we actually know; the percentage joins them when a
  // part lands, which on a multi-GB file is soon and often.
  const detail =
    loaded > 0
      ? `   ${Math.floor((loaded / size) * 100)}% of ${formatByteValue(size)}`
      : `   ${formatByteValue(size)}`;
  // One column short of the edge (writing a row's last cell makes some terminals
  // wrap on their own), and one more for the space before the path.
  const room = (width ?? Infinity) - run.length - detail.length - 2;
  const shown = fitPath(path, room);
  return shown ? `${run}${detail} ${shown}` : run + detail;
}

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
 * Silent when there is nothing to compare: a first snapshot, or a predecessor
 * written before ADR-0072, whose header carried no instant. Guessing from the
 * names instead would reintroduce exactly the ambiguity this check exists to see
 * through.
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
