import { Temporal } from "@js-temporal/polyfill";
import assert from "node:assert";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { prop } from "./commands/prop.mjs";
import { secondsSince } from "./format.mjs";

// Snapshot file format:
// Each line represents a file with the following tab-separated fields:
// col1<TAB>col2<TAB>col3<TAB>path<TAB>optional_extra_fields
// Column widths are:
// col1: 43 characters (length of base64url-encoded SHA256 hash)
// col2: 11 characters (file size in bytes as string long enough to go to double digit Gigabytes)
// col3: 24 characters (ISO 8601 datetime string to milliseconds precision)
// path: unlimited length (file path)
// # : comment line
// For included files  the fields are:
// hash<TAB>size<TAB>mtime<TAB>path
// where:
// hash: SHA256 hash of the file content in base64url encoding
// mtime: modification time in ISO 8601 format
// size: size of the file in bytes (right-aligned)
// For comment lines the fields are:
// #comment<TAB>context<TAB>dirent_type<TAB>path

/** @typedef {import("./commands/prop.mjs").Props} Props */
/** @typedef {[string, Props | Error]} SnapshotEntry */
/** @typedef {Map<string, Props>} SnapshotLookup */

/** @param {string} dir */
export const resolveSnapshotDir = (dir) => resolve(dir, ".s3cab", "snapshots");

/**
 * Execute a callback with a managed snapshot file write stream.
 * The FileHandle is automatically disposed when the callback completes.
 * @param {string} dir - Path to snapshot directory
 * @param {string} name - Snapshot file name
 * @param {(stream: import("node:stream").Writable) => Promise<void>} callbackFn - Callback receiving the write stream
 * @returns {Promise<string>} Path to the created snapshot file
 */
export async function withSnapshotFile(dir, name, callbackFn) {
  const snapshotDir = createSnapshotDir(dir);
  const tmpPath = resolve(snapshotDir, ".snapshot.tsv.zst");
  if (existsSync(tmpPath)) {
    throw new Error(
      `Snapshot already in progress. You need to delete '.snapshot.tsv.zst' in '${snapshotDir}' before creating a new snapshot.`,
    );
  }

  await using fd = await open(tmpPath, "w");
  const chunkSize = 128 * 1024; // 128 KB

  const snapshotWriter = new PassThrough({ highWaterMark: chunkSize * 4 });

  // Start the pipeline but don't await it yet
  const pipelinePromise = pipeline(
    snapshotWriter,
    createZstdCompress({
      chunkSize,
      params: {
        [constants.ZSTD_c_compressionLevel]: 19,
      },
    }),
    fd.createWriteStream(),
  );

  // Execute the callback with the write stream
  await callbackFn(snapshotWriter);

  // Wait for the pipeline to complete
  await pipelinePromise;

  await fd.close();

  const snapshotPath = resolve(snapshotDir, name + ".tsv.zst");
  await rename(tmpPath, snapshotPath);
  return snapshotPath;
}

/**
 * Create snapshot directory if it doesn't exist.
 * @param {string} baseDir - Base directory
 * @returns {string} Snapshot directory path
 */
export function createSnapshotDir(baseDir) {
  const snapshotDir = resolveSnapshotDir(baseDir);
  mkdirSync(snapshotDir, { recursive: true });
  return snapshotDir;
}

/**
 * Read a snapshot from snapshot directory
 * @param {string} dir - Snapshot directory
 * @param {string} name - Snapshot name
 * @returns {Promise<SnapshotLookup>} Snapshot lookup
 */
export async function readSnapshot(dir, name) {
  assert(dir, "No directory specified");
  if (name) {
    let snapshotPath = join(resolveSnapshotDir(dir), name);

    if (existsSync(snapshotPath)) {
      return readSnapshotFile(snapshotPath);
    } else if (existsSync(snapshotPath + ".tsv")) {
      return readSnapshotFile(snapshotPath + ".tsv");
    } else if (existsSync(snapshotPath + ".tsv.zst")) {
      return readSnapshotFile(snapshotPath + ".tsv.zst");
    }
  }
  return new Map();
}

/**
 * Read a snapshot file.
 * @param {string} path - Path to snapshot file
 * @returns {Promise<SnapshotLookup>} Snapshot lookup
 */
export async function readSnapshotFile(path) {
  const start = Temporal.Now.instant();

  /** @type {SnapshotLookup} */
  const lookup = new Map();

  const readStream = createReadStream(path);

  const input =
    extname(path) === ".zst"
      ? readStream.pipe(createZstdDecompress())
      : readStream;

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    assert(line.trim() !== "", "Empty line in snapshot file");
    const [hash, size, mtime, path] = line.split("\t").map((s) => s.trim());

    if (hash.startsWith("#")) {
      continue;
    }

    lookup.set(path, {
      size: Number(size),
      mtime,
      hash,
    });
  }

  console.warn(`Read snapshot file '${path}' in ${secondsSince(start)}`);

  return lookup;
}

/**
 * Convert snapshot data to TSV lines.
 * @param {SnapshotLookup} snapshot - Snapshot data
 * @yields {string} TSV line
 * @returns {AsyncGenerator<string>} TSV lines
 */
export async function* stringifySnapshot(snapshot) {
  for await (const [path, props] of snapshot) {
    if (props instanceof Error) {
      yield formatSnapshotLine("#" + props.message, "", "", path);
      continue;
    }
    yield formatSnapshotLine(props.hash, props.size, props.mtime, path);
  }
}

/**
 * Format a snapshot line.
 * @param {string} col1 - First column (hash)
 * @param {string|number} col2 - Second column (size)
 * @param {string} col3 - Third column (mtime)
 * @param {string} col4 - Fourth column (path)
 * @returns {string} Formatted snapshot line
 */
export function formatSnapshotLine(col1, col2, col3, col4) {
  col1 = col1.toString().padEnd(64);
  col2 = col2.toString().padStart(10);
  col3 = col3.padEnd(24);
  return `${col1}\t${col2}\t${col3}\t${col4}\n`;
}
/**
 * @param {string} dir
 * @param {string} name
 * @param {Array<string|File>} files
 * @returns {Promise<string>} path to written snapshot file
 */
export async function writeSnapshot(dir, name, files) {
  const snapshot = new Map();
  for (const file of files) {
    const path = typeof file === "string" ? file : file.name;
    snapshot.set(resolve(dir, path), await prop(file));
  }
  const snapshotPath = join(createSnapshotDir(dir), name + ".tsv");
  await writeFile(snapshotPath, stringifySnapshot(snapshot));
  return snapshotPath;
}
