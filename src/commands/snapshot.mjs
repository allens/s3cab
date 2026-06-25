import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { compareSnapshots } from "../lib/compare.mjs";
import { loadSet } from "../lib/env.mjs";
import { secondsSince } from "../lib/format.mjs";
import {
  listSnapshotNames,
  readSnapshot,
  writeSnapshot,
} from "../lib/snapshot-file.mjs";
import { walkSet } from "../lib/walk.mjs";
import { prop } from "./prop.mjs";

/**
 * @import { SnapshotEntries } from "../lib/snapshot-file.mjs"
 * @import { CompareResult } from "../lib/compare.mjs"
 */

/**
 * Take a snapshot of a backup set: walk every member directory and write a
 * single snapshot into the set's snapshot store, then report what changed
 * since the previous one (docs/specs/backup.md).
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
  // found alone in a bucket (docs/specs/backup.md). Hashing is handed in:
  // `prop` lives here under `commands/`, so the lib writer can't import it
  // (ADR-0023) — the command binds the previous-snapshot lookup into `getProps`.
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
    getProps: (path) => prop(path, { lookup }),
    overwrite: Boolean(options.debug),
  });

  if (options.debug) {
    await pipeline(
      createReadStream(snapshotPath),
      createZstdDecompress(),
      createWriteStream(join(dirname(snapshotPath), ".snapshot.tsv")),
    );
  }

  // Compare with previous snapshot
  return await compareSnapshots(snapshotDir, set.dirs, {
    since: latestSnapshotName,
    until: newSnapshotName,
    setName: set.name,
  });
}

/**
 * @param {string} label
 * @param {number} total
 */
function withProgress(label, total) {
  /** @param {Iterable<string> | AsyncIterable<string>} paths */
  return async function* (paths) {
    using progress = createProgress(label, total);
    for await (const path of paths) {
      progress.next();
      yield path;
    }
  };
}

/**
 * @param {string} label
 * @param {number} total
 */
function createProgress(label, total) {
  const start = Temporal.Now.instant();

  let current = 0;
  let previousPercent = "";

  return {
    next: () => {
      current++;

      const percent =
        (Math.floor((current / total) * 10000) / 100).toFixed(2) + "%";

      if (percent === previousPercent) {
        return;
      }
      previousPercent = percent;

      process.stderr.write(
        `\r${label}: ${percent} in ${secondsSince(start)}`.padEnd(80),
      );
    },
    [Symbol.dispose]: () => {
      process.stderr.write("\n");
    },
  };
}

const getTimestamp = () =>
  Temporal.Now.plainDateTimeISO()
    .toString({ smallestUnit: "minutes" })
    .replace(":", "");
