import assert from "node:assert";
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { secondsSince } from "./format.mjs";

/** @import { ExclusionRecord } from "./walk.mjs" */
/** @import { Writable, Readable } from "node:stream" */
/** @import { FileHandle } from "node:fs/promises" */

// The snapshot TSV — this module is its sole writer and parser. The file-row
// grammar (the tab-separated `hash`/`size`/`mtime`/`path` columns) is the
// recovery contract, specified in guide/format.md and decided in ADR-0004;
// `formatLine` below documents the fixed column widths it pads. The metadata
// rows are an internal detail (a recovery reader skips every `#` line), so their
// grammar lives here:
//   #SNAPSHOT<TAB><TAB>datetime<TAB>identity     opening header; identity = set name (ADR-0024)
//   #DIR<TAB><TAB><TAB>path                       one per member directory
//   #EXCLUDED<TAB>dirent_type<TAB>reason<TAB>path reason = the matching exclude pattern
//   #SKIPPED<TAB>dirent_type<TAB>reason<TAB>path  reason = why (e.g. "Unsupported file type")
//   #ERROR<TAB><TAB>reason<TAB>path               a file the walk couldn't hash
// so a snapshot is self-describing even found alone (docs/design/backup.md).
// `writeSnapshot` is the sole writer of all of it (header via `snapshotHeader`,
// then the `#EXCLUDED`/`#SKIPPED`/`#ERROR` rows via `excludedLine`/`skippedLine`/
// `errorLine`); the walk yields these as separate data buckets and no longer
// knows the grammar. On read, `parseSnapshotStream` surfaces `#SNAPSHOT`/`#DIR`
// (into the headers), `#ERROR` (into `errors`), and `#SKIPPED` (into `skipped`);
// `#EXCLUDED` and any other comment line are ignored.

// The comment markers heading the grammar's non-file lines — shared by the
// (module-private) writers (`snapshotHeader`/`excludedLine`/`skippedLine`/`errorLine`)
// and `parseSnapshotStream`, so the literal strings live in exactly one place.
const SNAPSHOT = "#SNAPSHOT";
const DIR = "#DIR";
const EXCLUDED = "#EXCLUDED";
const SKIPPED = "#SKIPPED";
const ERROR = "#ERROR";

/**
 * The properties a snapshot records for one file — its content `hash`, `size`,
 * and `mtime`. Produced by `fileProps` (lib/file-props.mjs) and the `prop`
 * command over it; this is the canonical home for the type.
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
/** @typedef {Map<string, string>} SnapshotSkipped */
/**
 * A parsed snapshot: the file `entries`, paths that failed hashing (`errors`,
 * mapped to the recorded reason), paths skipped by design (`skipped`, mapped to
 * the skip reason — e.g. unsupported file type), plus the `#SNAPSHOT`/`#DIR`
 * headers that make it self-describing (docs/design/backup.md). `dirs` are the
 * member directories captured at snapshot time; `identity` is the set name
 * (ADR-0024).
 * @typedef {{ entries: SnapshotEntries, errors: SnapshotErrors, skipped: SnapshotSkipped, dirs: string[], identity?: string }} Snapshot
 */

/**
 * Execute a callback with a managed snapshot file write stream, writing into
 * `snapshotDir` (the set's `~/.s3cab/sets/<set>/snapshots/`, resolved by the
 * caller). The FileHandle is automatically disposed when the callback completes.
 *
 * The fixed-name temp file `.snapshot.tsv.zst` doubles as the set's snapshot
 * **concurrency lock** (ADR-0048): it is created atomically (`wx`), so a second
 * concurrent snapshot of the same set fails to acquire it rather than
 * interleaving writes into the same file. The success path releases the lock by
 * renaming it into place; any failure releases it by unlinking, so a leftover
 * temp file can only mean a killed/crashed run — `inProgressError` tells the
 * user the exact fix. Never auto-broken (no age or PID heuristics).
 *
 * Snapshot names are minute-precision, so a second snapshot of the same set in
 * the same minute would collide. That is refused (rather than silently
 * overwriting a snapshot file) unless `overwrite` is set — the debug escape hatch
 * for re-running within a minute (docs/design/backup.md). The target is checked up
 * front, before any walking/hashing, so a same-minute re-run fails fast.
 * @param {string} snapshotDir - Directory the snapshot file is written into
 * @param {string} name - Snapshot file name
 * @param {(stream: Writable) => Promise<void>} callbackFn - Callback receiving the write stream
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
  const snapshotPath = resolve(snapshotDir, snapshotFileName(name));
  if (!overwrite && existsSync(snapshotPath)) {
    throw new Error(
      `Snapshot '${name}' already exists in '${snapshotDir}'. A second ` +
        `snapshot in the same minute is refused so an accidental re-run can't ` +
        `overwrite one. (Set S3CAB_DEBUG to overwrite while debugging.)`,
    );
  }
  const tmpPath = resolve(snapshotDir, ".snapshot.tsv.zst");

  // Acquire the lock: `wx` creates the temp file only if absent, atomically —
  // the kernel enforces mutual exclusion, not a check-then-write racing it
  // (the seedStarterExclude pattern, lib/sets.mjs).
  /** @type {FileHandle} */
  let fd;
  try {
    fd = await open(tmpPath, "wx");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      throw inProgressError(tmpPath);
    }
    throw error;
  }

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

  try {
    // The finally ensures the fd is closed on every path — including a mid-pipeline
    // failure after callbackFn succeeds — so the rename below (which needs the
    // handle released on Windows) always sees a closed fd.
    try {
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
      await pipelinePromise;
    } finally {
      await fd.close();
    }

    await rename(tmpPath, snapshotPath);
    return snapshotPath;
  } catch (error) {
    // Release the lock on any failure (after the close above — Windows can't
    // unlink an open file), so a *failed* run never wedges the next one.
    // Best-effort: a failed unlink must not mask the real error.
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * The lock-held error `withSnapshotFile` raises when the snapshot temp file
 * already exists (ADR-0048): either another snapshot/backup of this set is
 * running right now, or a crashed run left the file behind. Manual removal is
 * the only unlock — the message gives the exact command (ADR-0030), gated on
 * "if nothing is running": on POSIX, deleting a *live* run's file and
 * re-running can corrupt the store (Windows blocks the delete via the open
 * handle).
 * @param {string} tmpPath - The lock/temp file path (`.snapshot.tsv.zst`)
 */
const inProgressError = (tmpPath) => {
  const del = process.platform === "win32" ? "del" : "rm";
  return new Error(
    `A snapshot of this set is already in progress — or a previous one was ` +
      `interrupted and left its work file behind.\n` +
      `If no snapshot or backup of this set is running now, delete the file and retry:\n` +
      `  ${del} "${tmpPath}"`,
  );
};

/**
 * Write a complete snapshot file and return its path: the `#SNAPSHOT`/`#DIR`
 * header, `#EXCLUDED` rows for pattern-matched entries, `#SKIPPED` rows for
 * by-design-unsupported entries, then a file-entry row per kept file — each
 * hashed via the injected `getProps`, with an `#ERROR` row for any that fails —
 * all zstd-compressed and atomically renamed into place (`withSnapshotFile`).
 * This is the single production seam for "files → snapshot file"; the grammar
 * (`snapshotHeader`/`excludedLine`/`skippedLine`/`errorLine`/`formatLine`,
 * `SnapshotRow`) never leaves this module.
 *
 * Hashing is *injected* as `getProps`, not imported — the seam that lets a test
 * drive the writer without touching disk (it passes a `getProps` that synthesizes
 * props; see test/helpers/write-snapshot.mjs). Production binds it to the lib
 * `fileProps` with the previous-snapshot lookup already in (commands/snapshot.mjs).
 * `files` is accepted as any (async) iterable, so the command can hand in a
 * progress-wrapped stream.
 *
 * Write order is header → excluded → skipped → entries: the "not backed up"
 * diagnostics sit near the top, where someone opening the file to ask "why
 * wasn't X backed up?" finds them without scrolling past the entries. `#ERROR`
 * rows stay inline with the entries, in file order. Parsing is marker-driven so
 * order doesn't affect correctness (`parseSnapshotStream`).
 * @param {string} snapshotDir - The set's snapshots dir (`~/.s3cab/sets/<set>/snapshots/`)
 * @param {string} name - Snapshot name (minute-precision timestamp, no extension — mint it with `snapshotName`); the `#SNAPSHOT` header datetime is derived from it
 * @param {object} args
 * @param {string} args.identity - The set name (its whole identity, ADR-0024) — the `#SNAPSHOT` line
 * @param {string[]} args.dirs - Member directories (one `#DIR` line each)
 * @param {Iterable<string> | AsyncIterable<string>} args.files - Kept file paths to hash and record
 * @param {ExclusionRecord[]} args.excluded - Pattern-matched entries (→ `#EXCLUDED` rows)
 * @param {ExclusionRecord[]} [args.skipped] - By-design unsupported entries (→ `#SKIPPED` rows)
 * @param {(path: string) => Promise<Props>} args.getProps - Compute a file's props (hash/size/mtime)
 * @param {boolean} [args.overwrite] - Replace an existing same-name snapshot instead of erroring
 * @returns {Promise<string>} Path to the created snapshot file
 */
export async function writeSnapshot(
  snapshotDir,
  name,
  {
    identity,
    dirs,
    files,
    excluded,
    skipped = [],
    getProps,
    overwrite = false,
  },
) {
  return withSnapshotFile(
    snapshotDir,
    name,
    async (writeStream) => {
      writeStream.write(snapshotHeader({ name, identity, dirs }));
      for (const { fileType, reason, path } of excluded) {
        writeStream.write(excludedLine(fileType, reason, path));
      }
      for (const { fileType, reason, path } of skipped) {
        writeStream.write(skippedLine(fileType, reason, path));
      }
      await pipeline(
        files,
        propsRows(getProps),
        stringifySnapshot,
        writeStream,
      );
    },
    { overwrite },
  );
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
 * The name for a new snapshot: "now" at minute precision with the colon
 * dropped (`2026-06-12T0915`) — the one place a snapshot name is minted, from
 * a single clock read. The `#SNAPSHOT` header datetime is derived back from
 * this name by the writer (`snapshotHeader`), so a snapshot's filename and its
 * own header agree by construction — no second `now()` for an `await` to slip
 * a minute boundary between.
 * @returns {string}
 */
export const snapshotName = () =>
  Temporal.Now.plainDateTimeISO()
    .toString({ smallestUnit: "minutes" })
    .replace(":", "");

/**
 * The filename a snapshot is stored as — its name plus the extension. The one
 * place the extension is *constructed*, so the modules that address snapshot
 * files (`remote.mjs`'s S3 keys, `upload.mjs`'s local reads) compose this
 * instead of spelling the grammar they don't own. The `.tsv.zst` itself is a
 * user-facing promise (guide/format.md, ADR-0002): a recoverer decompresses it
 * with plain `zstd -d`.
 * @param {string} name - Snapshot name without extension, e.g. `2026-06-12T0915`
 * @returns {string} e.g. `2026-06-12T0915.tsv.zst`
 */
export const snapshotFileName = (name) => `${name}.tsv.zst`;

/**
 * Accept either a bare snapshot name (as `list` reports) or a full snapshot
 * filename, by stripping the `.tsv`/`.tsv.zst` extension — so callers taking
 * user-supplied names (`compare`) never learn the extension grammar.
 * @param {string} [name]
 */
export const normalizeSnapshotName = (name) =>
  name?.replace(/\.tsv(\.zst)?$/, "");

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
 * rather than mistaking the path for deleted. `#SKIPPED` rows (entries the walk
 * omitted by design) are surfaced into `skipped`. `#EXCLUDED` and any other
 * comment line are ignored on read. Local callers that only want the file lookup
 * take `.entries` (`readSnapshotFile`); the remote reader surfaces the whole
 * snapshot.
 * @param {Readable} input - A decompressed snapshot TSV stream
 * @returns {Promise<Snapshot>} The file entries, hashing errors, skipped entries, and parsed headers
 */
export async function parseSnapshotStream(input) {
  /** @type {SnapshotEntries} */
  const entries = new Map();
  /** @type {SnapshotErrors} */
  const errors = new Map();
  /** @type {SnapshotSkipped} */
  const skipped = new Map();
  /** @type {string[]} */
  const dirs = [];
  /** @type {string | undefined} */
  let identity;

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim() === "") {
      continue;
    }
    const parts = line.split("\t");
    const path = parts.pop();
    const [hash, size, mtime] = parts.map((s) => s.trim());

    if (hash?.startsWith("#")) {
      // Marker comments carry their payload in the trailing columns (see the
      // grammar header): `#DIR<TAB><TAB><TAB>dir`, `#SNAPSHOT<TAB><TAB>datetime
      // <TAB>identity`, `#ERROR<TAB><TAB>reason<TAB>path` and
      // `#SKIPPED<TAB>fileType<TAB>reason<TAB>path` (reason in col3, the `mtime`
      // slot). `#EXCLUDED` and any other comment line are ignored on read.
      if (hash === DIR && path) {
        dirs.push(path);
      } else if (hash === SNAPSHOT && path) {
        identity = path;
      } else if (hash === ERROR && path) {
        errors.set(path, mtime ?? "");
      } else if (hash === SKIPPED && path) {
        skipped.set(path, mtime ?? "");
      }
      continue;
    }

    assert(hash && size && mtime && path, `Malformed snapshot line: ${line}`);

    entries.set(path, {
      size: Number(size),
      mtime,
      hash,
    });
  }

  return { entries, errors, skipped, dirs, identity };
}

/**
 * Wrap a props-computing function into the snapshot row generator: yields
 * `[path, Props]` per file, or `[path, Error]` when hashing fails — the latter
 * becomes an `#ERROR` row (via `stringifySnapshot`), so an unreadable file is
 * reported rather than silently dropped or mistaken for deleted. Module-private:
 * `writeSnapshot`'s pipeline is its only caller. Hashing itself is injected via
 * `getProps` (the writer's test seam) — see `writeSnapshot`.
 * @param {(path: string) => Promise<Props>} getProps
 * @returns {(paths: AsyncIterable<string>) => AsyncGenerator<SnapshotRow>}
 */
function propsRows(getProps) {
  return async function* (paths) {
    for await (const path of paths) {
      try {
        yield [path, await getProps(path)];
      } catch (error) {
        yield [path, Error.isError(error) ? error : new Error(String(error))];
      }
    }
  };
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
 * (docs/design/backup.md). The datetime is *derived from the snapshot's name*
 * (re-inserting the colon the filename drops), so a snapshot's filename and
 * its own header cannot disagree — the two spellings of one moment share one
 * source. Module-private: `writeSnapshot` is its only caller; the
 * `#SNAPSHOT`/`#DIR` markers and their order live here, beside the
 * `parseSnapshotStream` that reads them back.
 * @param {object} header
 * @param {string} header.name - The snapshot name (minute-precision timestamp, see `snapshotName`)
 * @param {string} header.identity - The set name (its whole identity, ADR-0024)
 * @param {string[]} header.dirs - The member directories (one `#DIR` line each)
 * @returns {string}
 */
function snapshotHeader({ name, identity, dirs }) {
  const datetime = name.replace(/T(\d{2})(\d{2})$/, "T$1:$2");
  let out = formatLine(SNAPSHOT, "", datetime, identity);
  for (const dir of dirs) {
    out += formatLine(DIR, "", "", dir);
  }
  return out;
}

/**
 * An `#EXCLUDED` row: a file or directory the walk dropped because it matched a
 * user-specified exclude pattern. Recorded for transparency; ignored on read.
 * Module-private: `writeSnapshot` formats the walk's `excluded` records with it.
 * @param {string} fileType - The dirent type (File, Directory, …)
 * @param {string} reason - The matching exclude pattern
 * @param {string} path - The excluded path
 * @returns {string}
 */
const excludedLine = (fileType, reason, path) =>
  formatLine(EXCLUDED, fileType, reason, path);

/**
 * A `#SKIPPED` row: a file the walk omitted by design because its type is not
 * content-addressable (symlink, socket, FIFO, …). Distinct from `#EXCLUDED`
 * (user-chosen via pattern) and `#ERROR` (tried to process, failed). Surfaced
 * on read into `Snapshot.skipped` so callers can report what was ignored.
 * Module-private: `writeSnapshot` formats the walk's `skipped` records with it.
 * @param {string} fileType - The dirent type (SymbolicLink, FIFO, …)
 * @param {string} reason - Why it was skipped (e.g. "Unsupported file type")
 * @param {string} path - The skipped path
 * @returns {string}
 */
const skippedLine = (fileType, reason, path) =>
  formatLine(SKIPPED, fileType, reason, path);

/**
 * An `#ERROR` row: a file the walk couldn't hash (e.g. permission denied),
 * recorded in the snapshot for transparency. `reason` is the error message,
 * written in col3. Unlike other comments these are surfaced on read (into
 * `Snapshot.errors`) so `compare` reports the path rather than mistaking it for
 * deleted. Module-private: `stringifySnapshot` emits it for an errored row.
 * @param {string} reason - The error message (why the file couldn't be hashed)
 * @param {string} path - The unreadable path
 * @returns {string}
 */
const errorLine = (reason, path) => formatLine(ERROR, "", reason, path);
