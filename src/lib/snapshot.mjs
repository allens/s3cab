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
  readSnapshot,
  snapshotFileName,
  snapshotName,
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
  const name = listSnapshotNames(snapshotDir, { latest: true });
  if (name) {
    // One line for the whole step, naming the file it reads. `readSnapshotFile`
    // used to log a second "Read snapshot file … in N sec" of its own on the way
    // out — two lines for one step, and a duration that is a second or two on
    // even a large set. `listSnapshotNames` only yields names backed by a
    // `.tsv.zst`, so composing the path here lands on exactly the file
    // `readSnapshot` goes on to resolve.
    const path = join(snapshotDir, snapshotFileName(name));
    console.warn("Reading previous snapshot", `'${tildeify(path)}'`);
    const { entries } = await readSnapshot(snapshotDir, name);
    previous = entries;
  }

  if (rehash) {
    return { name, previous };
  }

  const parked = await readParkedLookup(snapshotDir);
  const lookup =
    parked && previous
      ? new Map([...previous, ...parked])
      : (parked ?? previous);

  return { name, previous, lookup };
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
 * @returns {Promise<{ name: string, path: string }>} The snapshot's name and local path
 */
export async function generateSnapshot(set, { lookup, through, debug } = {}) {
  const name = snapshotName();
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
  const path = await writeSnapshot(set.snapshotsDir, name, {
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
