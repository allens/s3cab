import assert from "node:assert";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import {
  EXIT_INTERRUPTED,
  InterruptedError,
  OnlineOnlyFileError,
} from "./error.mjs";
import { localMoment } from "./format.mjs";
import { tildeify } from "./home.mjs";

/** @import { ExclusionRecord } from "./walk.mjs" */
/** @import { Writable, Readable } from "node:stream" */
/** @import { FileHandle } from "node:fs/promises" */

// The snapshot TSV — this module is its sole writer and parser. The file-row
// grammar (the tab-separated `hash`/`size`/`mtime`/`path` columns) is the
// recovery contract, specified in guide/format.md and decided in ADR-0004;
// `formatLine` below documents the fixed column widths it pads. The metadata
// rows are an internal detail (a recovery reader skips every `#` line), so their
// grammar lives here:
//   #SNAPSHOT<TAB>set<TAB>instant<TAB>name zone   opening header (ADR-0072); set = ADR-0024 identity
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
// `#EXCLUDED` and any other comment line are ignored. That asymmetry is
// deliberate and settled: the live question ("what are my patterns dropping?")
// is answered by `tree --excluded` from a fresh walk, so a reader can check an
// exclude.txt edit by re-running rather than by taking another snapshot
// (ADR-0080). These rows stay a record for hand recovery — don't wire them up.

// The comment markers heading the grammar's non-file lines — shared by the
// (module-private) writers (`snapshotHeader`/`excludedLine`/`skippedLine`/`errorLine`)
// and `parseSnapshotStream`, so the literal strings live in exactly one place.
const SNAPSHOT = "#SNAPSHOT";
const DIR = "#DIR";
const EXCLUDED = "#EXCLUDED";
const SKIPPED = "#SKIPPED";
const ERROR = "#ERROR";

/**
 * The `dirent_type` a dehydrated cloud-sync placeholder is recorded and reported
 * under ([ADR-0080](../../docs/adr/0080-online-only-files-skipped.md)) — the one
 * value in that column the walk does **not** produce, because nothing knows a
 * file is one until the hashing pass reaches its `lstat`.
 *
 * Named for what the user has already been shown rather than for the mechanism
 * or the vendor: OneDrive's own Explorer status column reads *Online-only*, and
 * Dropbox and Google Drive use the same words, so the phrase arrives familiar and
 * points at the fix (make it available offline) without a sentence. It obeys both
 * rules `getFileType` sets for this column (src/lib/walk.mjs): plain words with no
 * niche acronym (ADR-0012), and a regular noun that `plural` can pluralize by
 * appending `s` — `48,213 Online-Only Files`.
 */
const ONLINE_ONLY_FILE = "Online-Only File";

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
/**
 * A pass-through transform over the snapshot's hashed rows — `writeSnapshot`'s
 * `through` seam (ADR-0069). Takes the row stream, yields it on (unchanged, in
 * order) to the TSV sink, and may do work per row as it passes: `uploadObjects`
 * (lib/upload.mjs) PUTs each object here, right after it was hashed. This is the
 * async-generator form of a `Transform` stream — what `stream.pipeline` accepts
 * as a link in the chain.
 * The input is accepted sync-or-async so the same transform can be driven straight
 * off a parsed snapshot's entries (a plain Map), which is how `upload` reuses it.
 * @typedef {(rows: Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>) => AsyncIterable<SnapshotRow>} RowTransform
 */
/** @typedef {Map<string, Props>} SnapshotEntries */
/** @typedef {Map<string, string>} SnapshotErrors */
/**
 * Paths the walk omitted by design, each with the `dirent_type` that got it
 * omitted and the recorded reason. **Both columns, not just the reason:** the
 * reason is nearly always the same string (`Unsupported file type`), while the
 * type is what actually answers "what *was* that?" — the question a reader has
 * when they meet the entry (ADR-0078). The row has carried the type all along;
 * only the reader dropped it.
 * @typedef {Map<string, { fileType: string, reason: string }>} SnapshotSkipped
 */
/**
 * A parsed snapshot: the file `entries`, paths that failed hashing (`errors`,
 * mapped to the recorded reason), paths skipped by design (`skipped`, mapped to
 * the dirent type and the skip reason), plus the `#SNAPSHOT`/`#DIR`
 * headers that make it self-describing (docs/design/backup.md). `dirs` are the
 * member directories captured at snapshot time; `identity` is the set name
 * (ADR-0024). `instant` and `zone` are the moment it was taken
 * ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)).
 * All three are optional because a snapshot may carry no `#SNAPSHOT` line at all
 * — the row-only form the test fixture builder writes — not because any header
 * layout omits them.
 * @typedef {{ entries: SnapshotEntries, errors: SnapshotErrors, skipped: SnapshotSkipped, dirs: string[], identity?: string, instant?: string, zone?: string }} Snapshot
 */

/**
 * The parked hash lookup an interrupted snapshot leaves behind
 * ([ADR-0067](../../docs/adr/0067-park-hashes-on-interrupt.md)) — the work file
 * of a run stopped with Ctrl+C, renamed aside so the next run can reuse the
 * hashes instead of computing them again. Two names, two meanings: the temp
 * `.snapshot.tsv.zst` says "a run is writing right now, keep out" (the ADR-0048
 * lock), this one says "nobody is writing; here are hashes to reuse". A
 * leading-dot, non-datestamped name, so `snapshotNames` can never mistake it for
 * a real snapshot and `list` never shows it; local-only, never uploaded.
 * @param {string} snapshotDir - The set's snapshots dir
 */
const parkedLookupPath = (snapshotDir) =>
  resolve(snapshotDir, ".snapshot.lookup.tsv.zst");

/**
 * The interrupts a snapshot parks its work on. SIGINT (Ctrl+C) is the blessed,
 * documented path and works on every platform; SIGHUP/SIGTERM are best-effort —
 * closing the console window on Windows raises SIGHUP with a short grace period,
 * and a modest snapshot can finalise inside it. Best-effort is *safe* because
 * finalising ends in an atomic rename: either it completes (a valid parked file)
 * or it doesn't (the temp is left at the lock name, today's "delete and retry").
 * SIGKILL and power loss are out of scope by construction — no handler runs, so
 * the next run simply re-hashes: no harm, only time.
 */
const PARK_SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"];

/**
 * Install the park-on-interrupt handler for the duration of a snapshot write,
 * returning the `AbortSignal` that asks the write to stop (and removing the
 * handler on disposal, so an interrupt outside a snapshot keeps Node's default
 * "die now" behaviour). Aborting is a *request to stop cleanly*, not a teardown:
 * the writer finishes the row it is on and ends the stream, so only whole rows
 * reach the file.
 *
 * A second interrupt force-quits, so the user is never stuck behind a flush —
 * at the cost of the ordinary hard-kill outcome (a leftover lock file the
 * `inProgressError` explains).
 * @returns {{ signal: AbortSignal } & Disposable}
 */
function parkOnInterrupt() {
  const controller = new AbortController();
  const onSignal = () => {
    if (controller.signal.aborted) {
      process.exit(EXIT_INTERRUPTED);
    }
    controller.abort();
    // Signal-agnostic wording: SIGHUP/SIGTERM reach this too, and a second one
    // of those force-quits just as a second Ctrl+C does. The key stays in
    // parentheses so the interactive case — the one anybody actually reads —
    // keeps a concrete instruction.
    console.warn(
      "\nStopping — saving the hashes computed so far so the next run can " +
        "reuse them.\nInterrupt again (Ctrl+C) to quit immediately.",
    );
  };

  for (const signal of PARK_SIGNALS) {
    process.on(signal, onSignal);
  }

  return {
    signal: controller.signal,
    [Symbol.dispose]() {
      for (const signal of PARK_SIGNALS) {
        process.off(signal, onSignal);
      }
    },
  };
}

/**
 * The "you stopped it" error a parked snapshot ends with — the deliberate stop
 * the CLI reports as a stop rather than a failure (ADR-0030 wording: the user's
 * goal first, then what to do next).
 */
const interruptedError = () =>
  new InterruptedError(
    `Snapshot stopped. The file hashes computed so far are saved — run the ` +
      `same command again to carry on from here, without re-hashing them.`,
  );

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
 * A *graceful interrupt* is the third release path (ADR-0067): the callback is
 * asked to stop through the `AbortSignal` it is handed, and the work file is
 * renamed to the parked lookup name instead of being unlinked, so the next run
 * reuses the hashes it holds. This module owns that file's whole lifecycle —
 * parked here, read by `readParkedLookup`, deleted when a snapshot next lands.
 *
 * Snapshot names are minute-precision, so a second snapshot of the same set in
 * the same minute would collide. That is refused (rather than silently
 * overwriting a snapshot file) unless `overwrite` is set — the debug escape hatch
 * for re-running within a minute (docs/design/backup.md). The target is checked up
 * front, before any walking/hashing, so a same-minute re-run fails fast.
 * @param {string} snapshotDir - Directory the snapshot file is written into
 * @param {string} name - Snapshot file name
 * @param {(stream: Writable, signal: AbortSignal) => Promise<void>} callbackFn - Callback receiving the write stream and the stop-cleanly signal
 * @param {object} [options]
 * @param {boolean} [options.overwrite] - Replace an existing same-name snapshot instead of erroring
 * @returns {Promise<string>} Path to the created snapshot file
 * @throws {InterruptedError} When the user interrupted the run — its work is parked, not lost
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

  const parkedPath = parkedLookupPath(snapshotDir);

  try {
    // Handler installed here, around the write, rather than at the top-level
    // dispatch — that has no handle on the open stream to finalise (ADR-0067).
    // `backup` gets it for free, through `snapshot`.
    using park = parkOnInterrupt();

    // The finally ensures the fd is closed on every path — including a mid-pipeline
    // failure after callbackFn succeeds — so the rename below (which needs the
    // handle released on Windows) always sees a closed fd.
    try {
      // Execute the callback with the write stream. If it throws (e.g. a member
      // directory vanished mid-walk), tear the writer down and let the already-
      // running pipeline settle before rethrowing — otherwise it surfaces later as
      // an orphaned ERR_STREAM_PREMATURE_CLOSE rejection that masks the real error.
      try {
        await callbackFn(snapshotWriter, park.signal);
      } catch (error) {
        snapshotWriter.destroy();
        await pipelinePromise.catch(() => {});
        throw error;
      }
      await pipelinePromise;
    } finally {
      await fd.close();
    }

    if (park.signal.aborted) {
      // Park rather than discard: the same atomic rename, to the other name.
      // Unlink first because Windows will not rename onto an existing file —
      // and replacing is always right, since a resumed run re-records every row
      // the file it replaces held, making each parked file a superset.
      await unlink(parkedPath).catch(() => {});
      await rename(tmpPath, parkedPath);
      throw interruptedError();
    }

    await rename(tmpPath, snapshotPath);

    // Delete the parked lookup on *success*, not on read: while a resumed run is
    // in flight both files exist, so a second interrupt still preserves the
    // earlier work. This snapshot re-records every hash the parked file held, so
    // landing it is what makes the parked copy redundant. Best-effort — the
    // snapshot is already installed, and a leftover parked file is only ever a
    // stale lookup, which is safe (`readParkedLookup`).
    await unlink(parkedPath).catch(() => {});
    return snapshotPath;
  } catch (error) {
    // Release the lock on any failure (after the close above — Windows can't
    // unlink an open file), so a *failed* run never wedges the next one.
    // Best-effort: a failed unlink must not mask the real error. On the parked
    // path the temp is already renamed away, so this is a no-op.
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * The hashes an interrupted snapshot of this set parked, ready to be overlaid on
 * the normal previous-snapshot lookup (ADR-0067) — or `undefined` when nothing is
 * parked, which is the ordinary case.
 *
 * Reading needs **no** liveness check — none of the PID/age heuristics ADR-0048
 * rejected. A parked hash is only ever a *candidate*: `fileProps` re-validates it
 * against the live file's size and mtime before reuse, so an entry from a stale
 * (or even a concurrently written) file is either still valid — a correct reuse —
 * or invalidated, and re-hashed. There is no corruption path from reading, which
 * is also why the file's `#SNAPSHOT` identity is deliberately *not* checked
 * against the set: a path whose size and mtime still match is the same file
 * whichever set recorded it, so the check would reject nothing that could do harm.
 * @param {string} snapshotDir - The set's snapshots dir (`~/.s3cab/sets/<set>/snapshots/`)
 * @returns {Promise<SnapshotEntries | undefined>} The parked entries, or undefined when none are parked
 */
export async function readParkedLookup(snapshotDir) {
  const path = parkedLookupPath(snapshotDir);
  if (!existsSync(path)) {
    return undefined;
  }
  console.warn("Reusing the hashes parked by an interrupted snapshot");
  const { entries } = await readSnapshotFile(path);
  return entries;
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
 *
 * `through` is the **fusion seam** (ADR-0069): a pass-through inserted between
 * the hashing producer and the TSV sink, so a caller can act on each row *the
 * moment it is hashed* and hand it on unchanged. `backup` passes the object
 * uploader there — which is what collapses the hash→PUT window from minutes to
 * milliseconds; `snapshot` passes nothing and writes a plain offline snapshot.
 * The writer stays ignorant of what the transform does: it is a pipe, not a callback
 * (the transform owns its own state and reports back to whoever built it).
 * @param {string} snapshotDir - The set's snapshots dir (`~/.s3cab/sets/<set>/snapshots/`)
 * @param {{ name: string, instant: string, zone: string }} moment - The snapshot's moment, from one clock read (`snapshotMoment`): its name, the UTC instant, and the zone the name was minted in
 * @param {object} args
 * @param {string} args.identity - The set name (its whole identity, ADR-0024) — the `#SNAPSHOT` line
 * @param {string[]} args.dirs - Member directories (one `#DIR` line each)
 * @param {Iterable<string> | AsyncIterable<string>} args.files - Kept file paths to hash and record
 * @param {ExclusionRecord[]} args.excluded - Pattern-matched entries (→ `#EXCLUDED` rows)
 * @param {ExclusionRecord[]} [args.skipped] - By-design unsupported entries (→ `#SKIPPED` rows)
 * @param {(path: string) => Promise<Props>} args.getProps - Compute a file's props (hash/size/mtime)
 * @param {RowTransform} [args.through] - Pass-through applied to each hashed row before it reaches the TSV (`backup`'s object uploader)
 * @param {boolean} [args.overwrite] - Replace an existing same-name snapshot instead of erroring
 * @returns {Promise<string>} Path to the created snapshot file
 */
export async function writeSnapshot(
  snapshotDir,
  moment,
  {
    identity,
    dirs,
    files,
    excluded,
    skipped = [],
    getProps,
    through,
    overwrite = false,
  },
) {
  return withSnapshotFile(
    snapshotDir,
    moment.name,
    async (writeStream, signal) => {
      writeStream.write(snapshotHeader({ moment, identity, dirs }));
      for (const { fileType, reason, path } of excluded) {
        writeStream.write(excludedLine(fileType, reason, path));
      }
      for (const { fileType, reason, path } of skipped) {
        writeStream.write(skippedLine(fileType, reason, path));
      }
      const rows = propsRows(getProps, signal);
      await pipeline(
        files,
        // Composed rather than spliced into the argument list: `pipeline`'s
        // variadic overloads type a fixed chain far more happily than a
        // conditionally-built array of transforms.
        through ? (paths) => through(rows(paths)) : rows,
        stringifySnapshot,
        writeStream,
      );
    },
    { overwrite },
  );
}

/**
 * Read a snapshot by name from a snapshot directory.
 *
 * One candidate, composed by `snapshotFileName`: a snapshot *is* its
 * `<name>.tsv.zst`, so the name this resolves is exactly the name the writer
 * lands on and `listSnapshotNames` reports. It used to try `<name>` and
 * `<name>.tsv` first (carried from the initial commit, never a decision), which
 * bought nothing — a name arrives here either straight from the lister or
 * extension-stripped by `normalizeSnapshotName` — and cost a real failure: a
 * *directory* called `<name>.tsv` beside the snapshot passed the bare
 * `existsSync` and made `backup` die on `EISDIR`. Hence the `isFile` test too:
 * only a regular file is a snapshot, matching `listSnapshotNames`'s
 * `dirent.isFile()` filter, so anything else reads as "not found" rather than
 * failing deep in a read stream.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {string} name - Snapshot name
 * @returns {Promise<Snapshot>} The parsed snapshot (take `.entries` for the lookup)
 * @throws When the named snapshot does not exist — never silently returns an
 *   empty snapshot, which a caller could mistake for an empty one. The error
 *   **names the snapshots that do exist** (ADR-0030: give the fix, don't just
 *   state the failure), which is the standard `restore` and `forget` already
 *   set for remote names; this is the local path `compare` and
 *   `upload --snapshot` reach through. Enriching it here rather than at those
 *   call sites is safe because the only other caller, `readBaseline`, passes a
 *   name that came *from* this directory's listing and so can never miss.
 */
export async function readSnapshot(snapshotDir, name) {
  assert(snapshotDir, "No snapshot directory specified");
  assert(name, "No snapshot name specified");

  const path = join(snapshotDir, snapshotFileName(name));
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    throw notFoundError(snapshotDir, name);
  }
  return readSnapshotFile(path);
}

/**
 * The "no such snapshot" error, with the alternatives — the shape `forget` uses
 * for remote names, applied to the local directory. Never truncated
 * ([ADR-0010](../../docs/adr/0010-cli-output-conventions.md)); a set with no
 * snapshots at all gets a different sentence, because listing nothing under
 * "here are the others" reads as a bug.
 *
 * Reached when the name resolves to nothing *or* to a non-file — the stray
 * directory case #249 fixed reads as "not found" to a user either way, and the
 * listing tells them what is actually there.
 * @param {string} snapshotDir
 * @param {string} name
 */
function notFoundError(snapshotDir, name) {
  const names = listSnapshotNames(snapshotDir);
  if (names.length === 0) {
    return new Error(
      `Snapshot '${name}' not found — there are no snapshots in ` +
        `'${tildeify(snapshotDir)}' yet.\n` +
        `Take one with:\n  s3cab snapshot`,
    );
  }
  return new Error(
    `Snapshot '${name}' not found in '${tildeify(snapshotDir)}'.\n` +
      `Snapshots there, newest first:\n` +
      names.map((n) => `  ${n}`).join("\n"),
  );
}

/**
 * The name for a new snapshot: "now" at minute precision with the colon
 * dropped (`2026-06-12T0915`) — the one place a snapshot name is minted, from
 * a single clock read — the name alone, for callers that need nothing else.
 * The header's instant and zone come from that *same* read rather than being
 * derived from this string (`snapshotMoment`, which this calls through), so a
 * snapshot's filename and its own header still agree by construction — no
 * second `now()` for an `await` to slip a minute boundary between.
 * @returns {string}
 */
export const snapshotName = () => snapshotMoment().name;

/**
 * The moment a snapshot is taken, in the three spellings the format needs, from
 * **one clock read** ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)):
 *
 * - `name` — local wall clock, minute precision, colon dropped (`2026-06-12T0915`).
 *   The snapshot's filename and identity, typed by people, so it stays the time
 *   the clock on the wall said.
 * - `instant` — the same moment in UTC at millisecond precision
 *   (`2026-06-12T08:15:32.123Z`), the machine-readable field of record. Exactly
 *   24 characters, like `mtime`, so it lands in the same column.
 * - `zone` — the IANA zone the name was minted in (`Europe/London`). It is what
 *   makes a naive local name resolvable, and naming the zone rather than an
 *   offset says *where*, which explains a DST shift instead of just recording one.
 *
 * One read matters: deriving the instant separately would let an `await` slip a
 * minute boundary between the two, and a file whose name and header disagree is
 * exactly what a record must never be.
 * @returns {{ name: string, instant: string, zone: string }}
 */
export const snapshotMoment = () => localMoment("minutes");

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
 * List the snapshot names in a snapshot directory, newest first — the storage
 * core behind the `list` command, and reused by `snapshot`/`compare`/`status`,
 * which already hold a resolved snapshot directory. Reads the directory, then
 * filters and sorts the names through `snapshotNames`.
 *
 * Always the array, never "just the newest": callers wanting the latest write
 * `.at(0)`, which gives `undefined` on an empty directory exactly as a
 * dedicated option did. A `{ latest: true }` option used to flip the return
 * type between `string[]` and `string | undefined`, costing two `@overload`
 * blocks and two contracts to hold in your head — and it wasn't even shorter
 * at the call site.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @returns {string[]} Snapshot names, newest first
 */
export function listSnapshotNames(snapshotDir) {
  if (!existsSync(snapshotDir)) {
    return [];
  }

  const fileNames = readdirSync(snapshotDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name);

  return snapshotNames(fileNames);
}

/**
 * Read a snapshot file.
 *
 * Silent on purpose: the reader has no idea *why* it is being read, so anything
 * it announced was necessarily generic, and it announced it on the way *out* —
 * a second line after whatever the caller already said, reporting a duration
 * that is a second or two on even a large set. `compare` printed it twice.
 * Callers that want to say something own the wording (`readBaseline`'s "Reading
 * previous snapshot").
 * @param {string} path - Path to snapshot file
 * @returns {Promise<Snapshot>} The parsed snapshot (take `.entries` for the lookup)
 */
export async function readSnapshotFile(path) {
  const readStream = createReadStream(path);

  return extname(path) === ".zst"
    ? parseCompressedSnapshotStream(readStream)
    : parseSnapshotStream(readStream);
}

/**
 * Parse a **compressed** (`.tsv.zst`) snapshot byte stream into a snapshot —
 * the zstd-decompressing front of {@link parseSnapshotStream}, shared by the
 * local `.zst` read ({@link readSnapshotFile}) and the remote read
 * (`readRemoteSnapshot`, streaming an S3 body). A `pipeline` with the parser as
 * its **terminal sink**, which is the one shape with both properties this read
 * needs: a mid-stream source error (a dropped connection, a failed disk read)
 * propagates and rejects instead of stalling the parser (`.pipe` forwards no
 * `error`), and teardown waits for the sink — the source is fully consumed
 * first, so a live S3 request is never aborted on normal completion (the eager
 * teardown of a bare `compose`/`pipeline` regressed #171 with `ABORT_ERR`).
 * @param {Readable} source - Raw `.tsv.zst` bytes (a file stream or S3 body)
 * @returns {Promise<Snapshot>}
 */
export async function parseCompressedSnapshotStream(source) {
  const decompressed = createZstdDecompress();
  // The sink closes over the zstd stream rather than taking pipeline's sink
  // argument — the same object at runtime, but typed as a bare AsyncIterable,
  // which the parser's readline can't take.
  return await pipeline(source, decompressed, () =>
    parseSnapshotStream(decompressed),
  );
}

/**
 * Parse a decompressed snapshot TSV stream into a snapshot — the line-parsing
 * core of `readSnapshotFile`, split out so a snapshot can be read straight from
 * a remote object stream (`backup`/`restore` downloading from `snapshots/`)
 * with no temp file. The caller hands in an already-**decompressed** TSV stream;
 * both compressed sources — a local `.zst` file and a remote S3 body — come
 * through {@link parseCompressedSnapshotStream}, which fronts this parser with
 * zstd as a pipeline sink.
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
  /** @type {string | undefined} */
  let instant;
  /** @type {string | undefined} */
  let zone;

  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim() === "") {
      continue;
    }
    // The four columns, named for their *position* only: what each one holds
    // depends on the marker in col1 and is knowable only inside the branch that
    // has read it. col4 in particular is a path on four of the five row kinds and
    // is *not* a path on the fifth — on `#SNAPSHOT` it is `<name> <zone>`. So each
    // column earns a real name inside its branch, where that name can be true, and
    // is trimmed at the same moment: the format pads the leading fields with
    // spaces so the raw file reads as columns, and requires readers to trim
    // (guide/format.md). Path-valued columns are deliberately *not* trimmed — the
    // writer never pads the last field, and a filename may legitimately begin or
    // end with a space. Within a branch the names are declared in column order.
    //
    // Defaulted to `""` rather than left `undefined`, so every column is a string
    // and `.trim()` needs no `?.` or `?? ""` at a dozen call sites. A short line
    // yields empty columns, which are falsy exactly where `undefined` was, so the
    // marker branches skip it and the file-row assert below still catches it.
    //
    // Positional, not `parts.pop()`: every row is exactly four fields, because a
    // path containing a tab is refused at write time (ADR-0073). Popping the last
    // field defended against a case the format forbids and mishandled the one it
    // allows — on a truncated three-field line it silently returned col3 as the
    // path, where col4 is empty and the assert fires.
    const [col1 = "", col2 = "", col3 = "", col4 = ""] = line.split("\t");
    const marker = col1.trim();

    if (marker.startsWith("#")) {
      // Marker comments carry their payload in the trailing columns (see the
      // grammar header): `#DIR<TAB><TAB><TAB>dir`, `#SNAPSHOT<TAB>set<TAB>instant
      // <TAB>name zone`, `#ERROR<TAB><TAB>reason<TAB>path` and
      // `#SKIPPED<TAB>fileType<TAB>reason<TAB>path`. `#EXCLUDED` and any other
      // comment line are ignored on read.
      if (marker === DIR && col4) {
        const dir = col4;
        dirs.push(dir);
      } else if (marker === SNAPSHOT && col4) {
        // set | instant | "name zone" (ADR-0072).
        identity = col2.trim();
        instant = col3.trim();
        // col4 is "<name> <zone>" here — not a path. The name is the filename,
        // which the reader already knows, so only the zone is surfaced (the
        // header-vs-filename check is deliberately not built — ADR-0072).
        const nameAndZone = col4;
        const gap = nameAndZone.indexOf(" ");
        zone = gap === -1 ? undefined : nameAndZone.slice(gap + 1);
      } else if (marker === ERROR && col4) {
        const errorMessage = col3.trim();
        const path = col4;
        errors.set(path, errorMessage);
      } else if (marker === SKIPPED && col4) {
        const fileType = col2.trim();
        const reason = col3.trim();
        const path = col4;
        skipped.set(path, { fileType, reason });
      }
      continue;
    }

    // A file row — the only shape where all four columns are what their familiar
    // names say, so this is where they get them.
    //
    // The assert reads the *trimmed* values, not the raw columns: the leading
    // fields are space-padded (guide/format.md), so an all-blank column is
    // *truthy* while the value it yields is empty — and `Number("   ")` is 0, not
    // NaN, so a blank size column would file a real entry of size zero instead of
    // refusing the line.
    const hash = col1.trim();
    const size = col2.trim();
    const mtime = col3.trim();
    const path = col4;
    assert(hash && size && mtime && path, `Malformed snapshot line: ${line}`);

    entries.set(path, {
      size: Number(size),
      mtime,
      hash,
    });
  }

  return { entries, errors, skipped, dirs, identity, instant, zone };
}

/**
 * Wrap a props-computing function into the snapshot row generator: yields
 * `[path, Props]` per file, or `[path, Error]` when hashing fails — the latter
 * becomes an `#ERROR` row (via `stringifySnapshot`), so an unreadable file is
 * reported rather than silently dropped or mistaken for deleted. Module-private:
 * `writeSnapshot`'s pipeline is its only caller. Hashing itself is injected via
 * `getProps` (the writer's test seam) — see `writeSnapshot`.
 *
 * This is also where a graceful interrupt takes effect (ADR-0067): on `signal`,
 * the generator simply *returns* between files, which ends the pipeline the
 * ordinary way — every downstream stream is flushed and closed, so the file
 * stops on a whole row rather than being torn down mid-write. The file being
 * hashed when the interrupt arrives is finished first (its hash would be thrown
 * away otherwise, and a second Ctrl+C force-quits if that wait is too long).
 * @param {(path: string) => Promise<Props>} getProps
 * @param {AbortSignal} signal - Stop cleanly when aborted (the park-on-interrupt request)
 * @returns {(paths: AsyncIterable<string>) => AsyncGenerator<SnapshotRow>}
 */
function propsRows(getProps, signal) {
  return async function* (paths) {
    for await (const path of paths) {
      if (signal.aborted) {
        return;
      }
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
    // A cloud placeholder is the one throw out of `fileProps` that is a
    // *decision* rather than a fault, so it lands beside the symlinks and the
    // sockets rather than among the read failures (ADR-0080). It travels the
    // error channel because that is the channel the pipeline already has for
    // "this path produced no entry" — the row type is `Props | Error`, and the
    // uploader passes any `Error` row along without storing anything, which is
    // exactly the handling a skip needs.
    //
    // These rows come out *interleaved* with the entries rather than in the
    // header block, because nothing knows about them until the file is reached:
    // the walk takes no `stat` (the hot-path rule), so detection can only happen
    // where the `lstat` already is. Harmless — parsing is marker-driven and the
    // writer's doc says so explicitly.
    if (props instanceof OnlineOnlyFileError) {
      yield skippedLine(ONLINE_ONLY_FILE, props.message, path);
      continue;
    }
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
 * (docs/design/backup.md). Every spelling of the moment comes from the single
 * `snapshotMoment` read the caller made, so a snapshot's filename and its own
 * header cannot disagree. Module-private: `writeSnapshot` is its only caller;
 * the `#SNAPSHOT`/`#DIR` markers and their order live here, beside the
 * `parseSnapshotStream` that reads them back.
 * @param {object} header
 * @param {{ name: string, instant: string, zone: string }} header.moment - The snapshot's moment (see `snapshotMoment`)
 * @param {string} header.identity - The set name (its whole identity, ADR-0024)
 * @param {string[]} header.dirs - The member directories (one `#DIR` line each)
 * @returns {string}
 */
function snapshotHeader({ moment, identity, dirs }) {
  // Four columns (ADR-0072): the set, the machine-readable instant in `mtime`'s
  // own column, then the snapshot's own name and the clock it was minted from.
  // Col4 is *the name*, not "the local time" — so a file that gets renamed or
  // copied still says what it was called.
  let out = formatLine(
    SNAPSHOT,
    identity,
    moment.instant,
    `${moment.name} ${moment.zone}`,
  );
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
 * @param {string} fileType - The dirent type (Symbolic Link, FIFO, …)
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
