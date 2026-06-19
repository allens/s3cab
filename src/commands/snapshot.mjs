import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { compareSnapshots } from "../lib/compare.mjs";
import { secondsSince } from "../lib/format.mjs";
import { resolveSet, setSnapshotsDir } from "../lib/sets.mjs";
import {
  listSnapshotNames,
  readSnapshot,
  snapshotHeader,
  stringifySnapshot,
  withSnapshotFile,
} from "../lib/snapshot-file.mjs";
import { walkSet } from "../lib/walk.mjs";
import { prop } from "./prop.mjs";

/**
 * @import { Props } from "./prop.mjs"
 * @import { SnapshotEntries } from "../lib/snapshot-file.mjs"
 * @import { CompareResult } from "../lib/compare.mjs"
 */

/**
 * Take a snapshot of a backup set: walk every member directory and write a
 * single snapshot into the set's snapshot store, then report what changed
 * since the previous one (specs/backup.md).
 * @param {string} [setName] - Backup set to snapshot (default: the only set)
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.debug] - Enable debug mode (and allow a same-minute overwrite)
 * @returns {Promise<CompareResult>} Diff against the previous snapshot
 */
export async function snapshot(setName, options = {}) {
  // TODO - some kind of lock file to stop concurrent snapshots

  const set = resolveSet(setName);
  const snapshotDir = setSnapshotsDir(set.name);

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

  // The set's pinned identity (user@machine:set) heads the snapshot, with one
  // #DIR line per member directory, so the file is self-describing even when
  // found alone in a bucket (specs/backup.md).
  const identity = set.namespace?.replace("/", ":") ?? set.name;

  const snapshotPath = await withSnapshotFile(
    snapshotDir,
    newSnapshotName,
    async (writeStream) => {
      const datetime = Temporal.Now.plainDateTimeISO().toString({
        smallestUnit: "minutes",
      });
      writeStream.write(snapshotHeader({ datetime, identity, dirs: set.dirs }));

      const files = walkSet(set, writeStream);

      await pipeline(
        files,
        withProgress("Generating snapshot file...", files.length),
        createPropsGenerator(lookup),
        stringifySnapshot,
        writeStream,
      );
    },
    { overwrite: Boolean(options.debug) },
  );

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
  });
}

/**
 * @param {string} label
 * @param {number} total
 */
function withProgress(label, total) {
  /** @param {AsyncIterable<string>} paths */
  return async function* (paths) {
    using progress = createProgress(label, total);
    for await (const path of paths) {
      progress.next();
      yield path;
    }
  };
}

/**
 * Create an async generator that yields file properties.
 * @param {Map<string, Props>} [lookup] - Snapshot lookup map or path to snapshot file
 * @returns {(files: AsyncIterable<string>) => AsyncGenerator<[string, Props|Error]>}
 */
export function createPropsGenerator(lookup) {
  return async function* (paths) {
    for await (const path of paths) {
      try {
        yield [path, await prop(path, { lookup })];
      } catch (err) {
        yield [path, Error.isError(err) ? err : new Error(String(err))];
      }
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
