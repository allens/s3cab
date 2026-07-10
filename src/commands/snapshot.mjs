import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { compareSnapshots } from "../lib/compare.mjs";
import { loadSet } from "../lib/env.mjs";
import { fileProps } from "../lib/file-props.mjs";
import { secondsSince } from "../lib/format.mjs";
import { createProgress } from "../lib/progress.mjs";
import {
  listSnapshotNames,
  readSnapshot,
  writeSnapshot,
} from "../lib/snapshot-file.mjs";
import { walkSet } from "../lib/walk.mjs";

/**
 * @import { SnapshotEntries } from "../lib/snapshot-file.mjs"
 * @import { CompareResult } from "../lib/compare.mjs"
 */

/**
 * Take a snapshot of a backup set: walk every member directory and write a
 * single snapshot into the set's snapshot store, then report what changed
 * since the previous one (docs/design/backup.md).
 * @param {string} [setName] - Backup set to snapshot (default: the only set)
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.debug] - Enable debug mode (and allow a same-minute overwrite)
 * @returns {Promise<CompareResult>} Diff against the previous snapshot
 */
export async function snapshot(setName, options = {}) {
  // TODO - some kind of lock file to stop concurrent snapshots

  const set = loadSet(setName);
  const snapshotDir = set.snapshotsDir;

  const newSnapshotName = getTimestamp();
  console.warn("Generating new snapshot:", newSnapshotName);

  /** @type {SnapshotEntries | undefined} */
  let lookup;
  const latestSnapshotName = listSnapshotNames(snapshotDir, { latest: true });
  if (!options.rehash && latestSnapshotName) {
    console.warn("Reading previous snapshot", `'${latestSnapshotName}'`);
    const { entries } = await readSnapshot(snapshotDir, latestSnapshotName);
    lookup = entries;
  }

  const { files, excluded, skipped } = walkSet(set);

  // The set's name — its whole identity (ADR-0024) — heads the snapshot, with
  // one #DIR line per member directory, so the file is self-describing even when
  // found alone in a bucket (docs/design/backup.md). Hashing is handed in as
  // `getProps` — `writeSnapshot`'s injected hashing seam (so tests can drive it
  // without disk) — here bound to the lib `fileProps` with the previous-snapshot
  // lookup, so an unchanged file reuses its stored hash.
  const datetime = Temporal.Now.plainDateTimeISO().toString({
    smallestUnit: "minutes",
  });
  const snapshotPath = await writeSnapshot(snapshotDir, newSnapshotName, {
    identity: set.name,
    dirs: set.dirs,
    datetime,
    files: withProgress("Generating snapshot file...", files.length)(files),
    excluded,
    skipped,
    getProps: (path) => fileProps(path, lookup),
    overwrite: Boolean(options.debug),
  });

  if (options.debug) {
    await pipeline(
      createReadStream(snapshotPath),
      createZstdDecompress(),
      createWriteStream(join(dirname(snapshotPath), ".snapshot.tsv")),
    );
  }

  // Compare with the previous snapshot. When it was already read for the hash
  // lookup above, hand the parse through so the baseline isn't decompressed and
  // parsed a second time; under --rehash it wasn't read, so the compare reads it.
  return await compareSnapshots(snapshotDir, set.dirs, {
    since:
      lookup && latestSnapshotName
        ? { name: latestSnapshotName, entries: lookup }
        : latestSnapshotName,
    until: newSnapshotName,
    setName: set.name,
  });
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
        progress.update(`${label}: ${percent} in ${secondsSince(start)}`);
      }
      yield path;
    }
  };
}

const getTimestamp = () =>
  Temporal.Now.plainDateTimeISO()
    .toString({ smallestUnit: "minutes" })
    .replace(":", "");
