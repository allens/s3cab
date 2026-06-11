import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { secondsSince } from "../lib/format.mjs";
import {
  formatSnapshotLine,
  readSnapshot,
  stringifySnapshot,
  withSnapshotFile,
} from "../lib/snapshot-file.mjs";
import { compare } from "./compare.mjs";
import { list } from "./list.mjs";
import { prop } from "./prop.mjs";
import { tree } from "./tree.mjs";

/**
 * Create a snapshot of a directory.
 * @param {string} dir - Directory to snapshot
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.debug] - Enable debug mode
 * @returns {Promise<import("./compare.mjs").CompareResult>} Diff against the previous snapshot
 */
export async function snapshot(dir = ".", options = {}) {
  // TODO - some kind of lock file to stop concurrent snapshots

  dir = realpathSync.native(dir);

  const newSnapshotName = getTimestamp();
  console.warn("Generating new snapshot:", newSnapshotName);

  /** @type {import("../lib/snapshot-file.mjs").SnapshotLookup | undefined} */
  let lookup;
  const latestSnapshotName = list(dir, { latest: true });
  if (!options.rehash && latestSnapshotName) {
    console.warn("Reading previous snapshot", `'${latestSnapshotName}'`);
    lookup = await readSnapshot(dir, latestSnapshotName);
  }

  const snapshotPath = await withSnapshotFile(
    dir,
    newSnapshotName,
    async (writeStream) => {
      writeStream.write(
        formatSnapshotLine(
          "#SNAPSHOT",
          "",
          Temporal.Now.plainDateTimeISO().toString({
            smallestUnit: "minutes",
          }),
          dir,
        ),
      );

      const files = tree(dir, writeStream);

      await pipeline(
        files,
        withProgress("Generating snapshot file...", files.length),
        createPropsGenerator(lookup),
        stringifySnapshot,
        writeStream,
      );
    },
  );

  if (options.debug) {
    await pipeline(
      createReadStream(snapshotPath),
      createZstdDecompress(),
      createWriteStream(join(dirname(snapshotPath), ".snapshot.tsv")),
    );
  }

  // Compare with previous snapshot
  return await compare(dir, {
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
 * @param {Map<string, import("../commands/prop.mjs").Props>} [lookup] - Snapshot lookup map or path to snapshot file
 * @returns {(files: AsyncIterable<string>) => AsyncGenerator<[string, import("../commands/prop.mjs").Props|Error]>}
 */
export function createPropsGenerator(lookup) {
  return async function* (paths) {
    for await (const path of paths) {
      try {
        yield [path, await prop(path, { lookup })];
      } catch (err) {
        yield [path, err instanceof Error ? err : new Error(String(err))];
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
