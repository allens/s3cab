import assert from "node:assert";
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
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
// For #EXCLUDED comment lines the fields are (col2/col3 as `excludedLine` writes them):
// #EXCLUDED<TAB>dirent_type<TAB>reason<TAB>path
// For #ERROR comment lines — a file the walk couldn't hash — the fields are
// (col3 as `errorLine` writes it):
// #ERROR<TAB><TAB>reason<TAB>path
// A snapshot file opens with two header comment lines (written by `snapshotHeader`):
//   #SNAPSHOT<TAB><TAB>datetime<TAB>identity   identity = the set name (ADR-0024)
//   #DIR<TAB><TAB><TAB>path                     one per member directory
// so a snapshot file is self-describing even found alone (docs/specs/backup.md). The
// walk also writes `#EXCLUDED` rows (via `excludedLine`) and `#ERROR` rows (via
// `errorLine`). On read `parseSnapshotStream` surfaces `#SNAPSHOT`/`#DIR` (into
// the headers) and `#ERROR` (into `errors`); any other comment line is skipped.

// The comment markers heading the grammar's non-file lines — shared by the
// writers (`snapshotHeader`/`excludedLine`/`errorLine`) and
// `parseSnapshotStream`, so the literal strings live in exactly one place.
const SNAPSHOT = "#SNAPSHOT";
const DIR = "#DIR";
const EXCLUDED = "#EXCLUDED";
const ERROR = "#ERROR";

/**
 * The properties a snapshot records for one file — its content `hash`, `size`,
 * and `mtime`. Produced by the `prop` command; this is the canonical home so
 * lib doesn't reach up into a command for the type.
 * @typedef {Object} Props
 * @property {number} size
 * @property {string} mtime
 * @property {string} hash
 * @property {number} [hashDuration] - Seconds spent hashing (absent when the
 *   hash came from a snapshot lookup, and not stored in the snapshot file).
 */
/** @typedef {[string, Props | Error]} SnapshotRow */
/** @typedef {Map<string, Props>} SnapshotEntries */
/** @typedef {Map<string, string>} SnapshotErrors */
/**
 * A parsed snapshot: the file `entries`, the paths that failed hashing
 * (`errors`, mapped to the recorded reason), plus the `#SNAPSHOT`/`#DIR` headers
 * that make it self-describing (docs/specs/backup.md). `dirs` are the member
 * directories captured at snapshot time; `identity` is the set name (ADR-0024).
 * @typedef {{ entries: SnapshotEntries, errors: SnapshotErrors, dirs: string[], identity?: string }} Snapshot
 */

/**
 * Execute a callback with a managed snapshot file write stream, writing into
 * `snapshotDir` (the set's `~/.s3cab/sets/<set>/snapshots/` — this module no
 * longer knows about `.s3cab`; the caller resolves the path from the set).
 * The FileHandle is automatically disposed when the callback completes.
 *
 * Snapshot names are minute-precision, so a second snapshot of the same set in
 * the same minute would collide. That is refused (rather than silently
 * overwriting a snapshot file) unless `overwrite` is set — the debug escape hatch
 * for re-running within a minute (docs/specs/backup.md). The target is checked up
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
 * @returns {Promise<Snapshot>} The parsed snapshot (take `.entries` for the lookup)
 * @throws When the named snapshot does not exist — never silently returns an
 *   empty snapshot, which a caller could mistake for an empty one.
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
 * is recognised; `list` (local files) and the remote lister (snapshot keys with
 * their `snapshots/<set>/` prefix already stripped) both run through here,
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
 * @overload
 * @param {string} snapshotDir
 * @param {{ latest: true }} options
 * @returns {string | undefined}
 */

/**
 * @overload
 * @param {string} snapshotDir
 * @param {{ latest?: false }} [options]
 * @returns {string[]}
 */

/**
 * List the snapshot names in a snapshot directory, newest first — the storage
 * core behind the `list` command, and reused by `snapshot`/`compare`/`status`,
 * which already hold a resolved snapshot directory. Reads the directory, then
 * filters and sorts the names through `snapshotNames`.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {object} [options]
 * @param {boolean} [options.latest] - Return only the latest snapshot name
 * @returns {string[] | string | undefined} Snapshot names, or the latest name
 */
export function listSnapshotNames(snapshotDir, options = {}) {
  if (!existsSync(snapshotDir)) {
    return options.latest ? undefined : [];
  }

  const fileNames = readdirSync(snapshotDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name);

  const names = snapshotNames(fileNames);
  return options.latest ? names.at(0) : names;
}

/**
 * Read a snapshot file.
 * @param {string} path - Path to snapshot file
 * @returns {Promise<Snapshot>} The parsed snapshot (take `.entries` for the lookup)
 */
export async function readSnapshotFile(path) {
  const start = Temporal.Now.instant();

  const readStream = createReadStream(path);

  const input =
    extname(path) === ".zst"
      ? readStream.pipe(createZstdDecompress())
      : readStream;

  const snapshot = await parseSnapshotStream(input);

  console.warn(`Read snapshot file '${path}' in ${secondsSince(start)}`);

  return snapshot;
}

/**
 * Parse a decompressed snapshot TSV stream into a snapshot — the line-parsing
 * core of `readSnapshotFile`, split out so a snapshot can be read straight from
 * a remote object stream (`backup`/`restore` downloading from `snapshots/`)
 * with no temp file. The caller hands in an already-**decompressed** TSV stream:
 * `readSnapshotFile` decompresses a `.zst` path itself; the remote reader pipes
 * the S3 body through zstd.
 *
 * The `#SNAPSHOT`/`#DIR` header comments are parsed out (into `identity`/`dirs`)
 * rather than discarded, so a snapshot stays self-describing on read — the
 * member dirs are what `restore --output` re-roots by. `#ERROR` rows (files the
 * walk couldn't hash) are surfaced into `errors` so `compare` can report them
 * rather than mistaking the path for deleted. Any other comment line is skipped.
 * Local callers that only want the file lookup take `.entries`
 * (`readSnapshotFile`); the remote reader surfaces the whole snapshot.
 * @param {import("node:stream").Readable} input - A decompressed snapshot TSV stream
 * @returns {Promise<Snapshot>} The file entries, hashing errors, and parsed headers
 */
export async function parseSnapshotStream(input) {
  /** @type {SnapshotEntries} */
  const entries = new Map();
  /** @type {SnapshotErrors} */
  const errors = new Map();
  /** @type {string[]} */
  const dirs = [];
  /** @type {string | undefined} */
  let identity;

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    assert(line.trim() !== "", "Empty line in snapshot file");
    const [hash, size, mtime, path] = line.split("\t").map((s) => s.trim());

    if (hash?.startsWith("#")) {
      // Marker comments carry their payload in the trailing columns (see the
      // grammar header): `#DIR<TAB><TAB><TAB>dir`, `#SNAPSHOT<TAB><TAB>datetime
      // <TAB>identity`, `#ERROR<TAB><TAB>reason<TAB>path` (reason in col3, the
      // `mtime` slot). Any other comment line is skipped.
      if (hash === DIR && path) dirs.push(path);
      else if (hash === SNAPSHOT && path) identity = path;
      else if (hash === ERROR && path) errors.set(path, mtime ?? "");
      continue;
    }

    assert(hash && size && mtime && path, `Malformed snapshot line: ${line}`);

    entries.set(path, {
      size: Number(size),
      mtime,
      hash,
    });
  }

  return { entries, errors, dirs, identity };
}

/**
 * Convert snapshot data to TSV lines.
 * @param {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} snapshot - Snapshot entries (a lookup Map, or the props pipeline stream)
 * @yields {string} TSV line
 * @returns {AsyncGenerator<string>} TSV lines
 */
export async function* stringifySnapshot(snapshot) {
  for await (const [path, props] of snapshot) {
    if (Error.isError(props)) {
      yield errorLine(props.message, path);
      continue;
    }
    yield formatLine(props.hash, props.size, props.mtime, path);
  }
}

/**
 * Format one TSV line at the fixed column widths — the private padder every
 * writer below shares: col1 64-wide (hash or `#`-marker), col2 10-wide
 * right-aligned (size), col3 24-wide (mtime/datetime), then the path. Internal
 * to the grammar; callers reach it through the semantic writers and never spell
 * a line by hand.
 * @param {string} col1 - First column (hash or `#`-marker)
 * @param {string|number} col2 - Second column (size)
 * @param {string} col3 - Third column (mtime/datetime)
 * @param {string} col4 - Fourth column (path)
 * @returns {string} Formatted snapshot line
 */
function formatLine(col1, col2, col3, col4) {
  col1 = col1.toString().padEnd(64);
  col2 = col2.toString().padStart(10);
  col3 = col3.padEnd(24);
  return `${col1}\t${col2}\t${col3}\t${col4}\n`;
}

/**
 * The opening header of a snapshot file: a `#SNAPSHOT` line carrying the
 * snapshot's datetime and identity, then one `#DIR` line per member directory —
 * the preamble that makes a snapshot self-describing even found alone
 * (docs/specs/backup.md). Returns the whole block for the caller to write; the
 * `#SNAPSHOT`/`#DIR` markers and their order live here, beside the
 * `parseSnapshotStream` that reads them back.
 * @param {object} header
 * @param {string} header.datetime - Snapshot datetime (minute precision)
 * @param {string} header.identity - The set name (its whole identity, ADR-0024)
 * @param {string[]} header.dirs - The member directories (one `#DIR` line each)
 * @returns {string}
 */
export function snapshotHeader({ datetime, identity, dirs }) {
  let out = formatLine(SNAPSHOT, "", datetime, identity);
  for (const dir of dirs) out += formatLine(DIR, "", "", dir);
  return out;
}

/**
 * An `#EXCLUDED` row: a file or directory the walk skipped, recorded in the
 * snapshot for transparency and skipped on read. `reason` is the matching
 * exclude pattern, or why the entry was skipped (e.g. an unsupported file type).
 * @param {string} fileType - The dirent type (File, Directory, …)
 * @param {string} reason - The matching exclude pattern, or the skip reason
 * @param {string} path - The excluded path
 * @returns {string}
 */
export const excludedLine = (fileType, reason, path) =>
  formatLine(EXCLUDED, fileType, reason, path);

/**
 * An `#ERROR` row: a file the walk couldn't hash (e.g. permission denied),
 * recorded in the snapshot for transparency. `reason` is the error message,
 * written in col3. Unlike other comments these are surfaced on read (into
 * `Snapshot.errors`) so `compare` reports the path rather than mistaking it for
 * deleted.
 * @param {string} reason - The error message (why the file couldn't be hashed)
 * @param {string} path - The unreadable path
 * @returns {string}
 */
export const errorLine = (reason, path) => formatLine(ERROR, "", reason, path);
