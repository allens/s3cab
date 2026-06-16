import assert from "node:assert";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { prop } from "../commands/prop.mjs";
import { secondsSince } from "./format.mjs";

// Snapshot file format:
// Each line represents a file with the following tab-separated fields:
// col1<TAB>col2<TAB>col3<TAB>path<TAB>optional_extra_fields
// Column widths are:
// col1: 64 characters (length of lowercase hex-encoded SHA-256 hash)
// col2: 10 characters (file size in bytes as string long enough to go to double digit Gigabytes)
// col3: 24 characters (ISO 8601 datetime string to milliseconds precision)
// path: unlimited length (file path)
// # : comment line
// For included files  the fields are:
// hash<TAB>size<TAB>mtime<TAB>path
// where:
// hash: SHA-256 hash of the file content in lowercase hex encoding
// mtime: modification time in ISO 8601 format
// size: size of the file in bytes (right-aligned)
// For comment lines the fields are:
// #comment<TAB>context<TAB>dirent_type<TAB>path
// A manifest opens with two header comment lines (written by `snapshot`):
//   #SNAPSHOT<TAB><TAB>datetime<TAB>identity   identity = user@machine:set
//   #DIR<TAB><TAB><TAB>path                     one per member directory
// so a manifest is self-describing even found alone (specs/backup.md). Comment
// lines are skipped on read.

/** @typedef {import("../commands/prop.mjs").Props} Props */
/** @typedef {[string, Props | Error]} SnapshotEntry */
/** @typedef {Map<string, Props>} SnapshotLookup */
/**
 * A parsed manifest: the file `entries` plus the `#SNAPSHOT`/`#DIR` headers that
 * make it self-describing (specs/backup.md). `dirs` are the member directories
 * captured at snapshot time; `identity` is the pinned `user@machine:set`.
 * @typedef {{ entries: SnapshotLookup, dirs: string[], identity?: string }} SnapshotManifest
 */

/**
 * Execute a callback with a managed snapshot file write stream, writing into
 * `snapshotDir` (the set's `~/.s3cab/sets/<set>/snapshots/` — this module no
 * longer knows about `.s3cab`; the caller resolves the path from the set).
 * The FileHandle is automatically disposed when the callback completes.
 *
 * Snapshot names are minute-precision, so a second snapshot of the same set in
 * the same minute would collide. That is refused (rather than silently
 * overwriting a manifest) unless `overwrite` is set — the debug escape hatch
 * for re-running within a minute (specs/backup.md). The target is checked up
 * front, before any walking/hashing, so a same-minute re-run fails fast.
 * @param {string} snapshotDir - Directory the snapshot file is written into
 * @param {string} name - Snapshot file name
 * @param {(stream: import("node:stream").Writable) => Promise<void>} callbackFn - Callback receiving the write stream
 * @param {object} [options]
 * @param {boolean} [options.overwrite] - Replace an existing same-name snapshot instead of erroring
 * @returns {Promise<string>} Path to the created snapshot file
 */
export async function withSnapshotFile(
  snapshotDir,
  name,
  callbackFn,
  { overwrite = false } = {},
) {
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = resolve(snapshotDir, name + ".tsv.zst");
  if (!overwrite && existsSync(snapshotPath)) {
    throw new Error(
      `Snapshot '${name}' already exists in '${snapshotDir}'. A second ` +
        `snapshot in the same minute is refused so an accidental re-run can't ` +
        `overwrite one. (Set S3CAB_DEBUG to overwrite while debugging.)`,
    );
  }
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

  // Execute the callback with the write stream. If it throws (e.g. a member
  // directory vanished mid-walk), tear the writer down and let the already-
  // running pipeline settle before rethrowing — otherwise it surfaces later as
  // an orphaned ERR_STREAM_PREMATURE_CLOSE rejection that masks the real error.
  try {
    await callbackFn(snapshotWriter);
  } catch (error) {
    snapshotWriter.destroy();
    await pipelinePromise.catch(() => {});
    throw error;
  }

  // Wait for the pipeline to complete
  await pipelinePromise;

  await fd.close();

  await rename(tmpPath, snapshotPath);
  return snapshotPath;
}

/**
 * Read a snapshot by name from a snapshot directory.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {string} name - Snapshot name
 * @returns {Promise<SnapshotLookup>} Snapshot lookup
 * @throws When the named snapshot does not exist — never silently returns an
 *   empty lookup, which a caller could mistake for an empty snapshot.
 */
export async function readSnapshot(snapshotDir, name) {
  assert(snapshotDir, "No snapshot directory specified");
  assert(name, "No snapshot name specified");
  const base = join(snapshotDir, name);

  for (const path of [base, base + ".tsv", base + ".tsv.zst"]) {
    if (existsSync(path)) {
      return readSnapshotFile(path);
    }
  }
  throw new Error(`Snapshot '${name}' not found in '${snapshotDir}'`);
}

/**
 * The snapshot names among a set of snapshot file names, newest first. This
 * datestamped `.tsv.zst` filter is the one place the snapshot naming convention
 * is recognised; `list` (local files) and the remote lister (manifest keys with
 * their `snapshots/<namespace>/` prefix already stripped) both run through here,
 * so a local and a remote listing sort and filter identically.
 * @param {Iterable<string>} names - Snapshot file names (e.g. `2026-06-12T0915.tsv.zst`)
 * @returns {string[]} Snapshot names without extension (e.g. `2026-06-12T0915`), newest first
 */
export function snapshotNames(names) {
  return [...names]
    .filter((name) => /\d{4}-\d{2}-\d{2}T\d{4}\.tsv\.zst$/.test(name))
    .map((name) => basename(name, ".tsv.zst"))
    .sort()
    .reverse();
}

/**
 * Read a snapshot file.
 * @param {string} path - Path to snapshot file
 * @returns {Promise<SnapshotLookup>} Snapshot lookup
 */
export async function readSnapshotFile(path) {
  const start = Temporal.Now.instant();

  const readStream = createReadStream(path);

  const input =
    extname(path) === ".zst"
      ? readStream.pipe(createZstdDecompress())
      : readStream;

  const { entries } = await parseSnapshotStream(input);

  console.warn(`Read snapshot file '${path}' in ${secondsSince(start)}`);

  return entries;
}

/**
 * Parse a decompressed snapshot TSV stream into a manifest — the line-parsing
 * core of `readSnapshotFile`, split out so a manifest can be read straight from
 * a remote object stream (`backup`/`restore` downloading from `snapshots/`)
 * with no temp file. The caller hands in an already-**decompressed** TSV stream:
 * `readSnapshotFile` decompresses a `.zst` path itself; the remote reader pipes
 * the S3 body through zstd.
 *
 * The `#SNAPSHOT`/`#DIR` header comments are parsed out (into `identity`/`dirs`)
 * rather than discarded, so a manifest stays self-describing on read — the
 * member dirs are what `restore --output` re-roots by. Any other comment line is
 * skipped. Local callers that only want the file lookup take `.entries`
 * (`readSnapshotFile`); the remote reader surfaces the whole manifest.
 * @param {import("node:stream").Readable} input - A decompressed snapshot TSV stream
 * @returns {Promise<SnapshotManifest>} The file entries plus parsed headers
 */
export async function parseSnapshotStream(input) {
  /** @type {SnapshotLookup} */
  const entries = new Map();
  /** @type {string[]} */
  const dirs = [];
  /** @type {string | undefined} */
  let identity;

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    assert(line.trim() !== "", "Empty line in snapshot file");
    const [hash, size, mtime, path] = line.split("\t").map((s) => s.trim());

    if (hash?.startsWith("#")) {
      // Header comments carry the path in the last column (see formatSnapshotLine
      // calls in snapshot.mjs): `#DIR<TAB><TAB><TAB>dir`, `#SNAPSHOT<TAB><TAB>
      // datetime<TAB>identity`.
      if (hash === "#DIR" && path) dirs.push(path);
      else if (hash === "#SNAPSHOT" && path) identity = path;
      continue;
    }

    assert(hash && size && mtime && path, `Malformed snapshot line: ${line}`);

    entries.set(path, {
      size: Number(size),
      mtime,
      hash,
    });
  }

  return { entries, dirs, identity };
}

/**
 * Convert snapshot data to TSV lines.
 * @param {Iterable<SnapshotEntry> | AsyncIterable<SnapshotEntry>} snapshot - Snapshot entries (a lookup Map, or the props pipeline stream)
 * @yields {string} TSV line
 * @returns {AsyncGenerator<string>} TSV lines
 */
export async function* stringifySnapshot(snapshot) {
  for await (const [path, props] of snapshot) {
    if (Error.isError(props)) {
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
 * Write a snapshot of the given files into `snapshotDir`, in the same
 * `.tsv.zst` form real snapshots take (so a snapshot lister sees it when the
 * name is datestamped). File paths are stored absolute, resolved against
 * `base` (defaulting to `snapshotDir` — handy for tests that store snapshots
 * alongside the files they describe). Used by tests and `restore` fixtures.
 * @param {string} snapshotDir
 * @param {string} name
 * @param {Array<string|File>} files
 * @param {string} [base] - Root the file paths resolve against (default: `snapshotDir`)
 * @returns {Promise<string>} path to written snapshot file
 */
export async function writeSnapshot(
  snapshotDir,
  name,
  files,
  base = snapshotDir,
) {
  const snapshot = new Map();
  for (const file of files) {
    const path = typeof file === "string" ? file : file.name;
    snapshot.set(resolve(base, path), await prop(file));
  }
  return withSnapshotFile(snapshotDir, name, (stream) =>
    pipeline(stringifySnapshot(snapshot), stream),
  );
}
