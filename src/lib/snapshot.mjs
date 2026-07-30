import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { fileProps } from "./file-props.mjs";
import { secondsSince } from "./format.mjs";
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
 * @param {boolean} [options.debug] - Leave an uncompressed copy beside the snapshot (and allow a same-minute overwrite)
 * @param {string} [options.previousInstant] - When the previous snapshot was taken (`readBaseline`), for the clock-went-backwards warning
 * @returns {Promise<{ name: string, path: string }>} The snapshot's name and local path
 */
export async function generateSnapshot(
  set,
  { lookup, through, debug, previousInstant } = {},
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
    files: withProgress("Generating snapshot file…", files.length)(files),
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
 * Wrap a stream of file paths in a stderr progress counter — the percentage of
 * `total` walked so far, with elapsed time — redrawn only when the percentage
 * changes. The in-place animation and TTY gate live in `lib/progress.mjs`; this
 * owns only the counting and the percentage rendering.
 * @param {string} label
 * @param {number} total
 */
function withProgress(label, total) {
  /** @param {Iterable<string> | AsyncIterable<string>} paths */
  return async function* (paths) {
    using progress = createProgress(process.stderr);
    const start = Temporal.Now.instant();
    let current = 0;
    let previousPercent = "";
    for await (const path of paths) {
      current++;
      const percent =
        (Math.floor((current / total) * 10000) / 100).toFixed(2) + "%";
      if (percent !== previousPercent) {
        previousPercent = percent;
        // Space, not `": "` — the label ends in an ellipsis, and every other
        // progress line here reads `<label>… <figure> in <elapsed>`.
        progress.update(`${label} ${percent} in ${secondsSince(start)}`);
      }
      yield path;
    }
  };
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
