import assert from "node:assert";
import { isUtf8 } from "node:buffer";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { constants, createGunzip, createGzip } from "node:zlib";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_INTERRUPTED, InterruptedError, isENOENT } from "./error.mjs";
import {
  completionInstant,
  formatByteValue,
  localMoment,
  shortDuration,
} from "./format.mjs";
import { showControlChars } from "./control-chars.mjs";
import { s3cabDir, tildeify } from "./home.mjs";
import {
  foldsCase,
  isMatchableDir,
  pathKey,
  pathMatcher,
  preparePath,
  rootLength,
} from "./path-match.mjs";
import { shellCommand } from "./style.mjs";
import { userAtMachine } from "./user-at-machine.mjs";

/** @import { ExclusionRecord, WalkError } from "./walk.mjs" */
/** @import { Writable, Readable } from "node:stream" */
/** @import { FileHandle } from "node:fs/promises" */
/** @import { AssertionError } from "node:assert" */

// The snapshot TSV — this module is its sole writer and parser. The layout is
// specified in guide/format.md and decided in ADR-0098 and ADR-0103: five
// tab-separated columns under a fixed heading row, each row typed by its first
// column. The walk yields its findings as separate data buckets and doesn't
// know the grammar; `writeSnapshot` writes all of it. On read,
// `parseSnapshotStream` surfaces only what code reads (ADR-0098's table): `-`
// rows into `entries`, `#error` into `errors`, `@SET DIR` into `dirs`,
// `@SNAPSHOT START`'s instant — and refuses what ADR-0101 calls invalid, the
// whole file or one path. The rules every s3cab file follows, the deletion
// record's too, are `parseS3cabFile`'s, the closing `.` among them. Every other
// `@` or `#` row is for people and is skipped. `#excluded` is one of those
// deliberately: "what are my patterns dropping?" is answered by `tree
// --excluded` from a fresh walk, so a reader can check an exclude.txt edit by
// re-running rather than by taking another snapshot (ADR-0080).

// The row types and the properties the parser reads — shared with the writers,
// so the literal strings live in exactly one place. The first character says
// what a row is (ADR-0103): `@` a property, `-` a file, `#` a path a restore
// doesn't act on.
export const FILE = "-";
const EXCLUDED = "#excluded";
const ERROR = "#error";
const S3CAB = "@S3CAB";
const CLIENT = "@CLIENT";
const SET = "@SET";
const SNAPSHOT = "@SNAPSHOT";
const FORMAT = "FORMAT";
const DIR = "DIR";
const START = "START";
const HEADING_URL = "https://s3cab.plantegral.com/guide/format";

/**
 * Row 1 of every s3cab file: names the columns Excel's AutoFilter shows, says
 * what the file is, and where its format is explained. The URL is frozen into
 * every stored file, so it must keep resolving (CLAUDE.md, printed URLs).
 */
export const HEADING = formatLine(S3CAB, FORMAT, "size", "time", HEADING_URL);

/**
 * The date of the format s3cab writes, `@S3CAB SPEC`'s value (ADR-0107). It
 * moves when the format does, never for a wording edit to guide/format.md.
 */
export const SPEC_DATE = "2026-10-30";

/**
 * The last line of every whole s3cab file, and its completeness check
 * (ADR-0082, ADR-0106). A terminator, not a row: the one line with neither five
 * fields nor a type.
 */
export const TERMINATOR = ".";

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
 * The paths whose rows the reader refused (ADR-0101), each mapped to why.
 * @typedef {Map<string, string>} SnapshotRefused
 */
/**
 * A parsed snapshot: what the code reads of it (ADR-0098) — the `-` rows
 * (`entries`), paths with no usable row (`errors`: the `#error` rows mapped to
 * their message, and every refused path to its reason), the refused paths alone
 * (`refused`, for `restore` and `verify`, which report them as damage), the
 * member directories captured at snapshot time (`dirs`, from `@SET DIR`), the
 * moment the run started (`instant`, from `@SNAPSHOT START`), and who took it
 * (`by`, from `@SNAPSHOT BY`, which `list` shows as a read-only set's holder).
 * @typedef {{ entries: SnapshotEntries, errors: SnapshotErrors, refused: SnapshotRefused, dirs: string[], instant?: string, by?: string }} Snapshot
 */
/**
 * What a snapshot records about its set and the run's configuration — the
 * `@SET` rows, and the patterns as `@CLIENT EXCLUDE`. Read only by people
 * (ADR-0098).
 * @typedef {Object} SnapshotSet
 * @property {string} name - The set's name (its whole identity, ADR-0024)
 * @property {string} bucket - The set's bucket
 * @property {string} [endpoint] - The S3 endpoint, for a provider other than AWS
 * @property {string[]} dirs - Member directories, canonical
 * @property {string[]} patterns - The exclude patterns in force
 */

/**
 * The parked hash lookup an interrupted snapshot leaves behind
 * ([ADR-0067](../../docs/adr/0067-park-hashes-on-interrupt.md)) — the work file
 * of a run stopped with Ctrl+C, renamed aside so the next run can reuse the
 * hashes instead of computing them again. Two names, two meanings: the temp
 * `.snapshot.tsv.gz` says "a run is writing right now, keep out" (the ADR-0048
 * lock), this one says "nobody is writing; here are hashes to reuse". A
 * leading-dot, non-datestamped name, so `snapshotNames` can never mistake it for
 * a real snapshot and `list` never shows it; local-only, never uploaded.
 * @param {string} snapshotDir - The set's snapshots dir
 */
const parkedLookupPath = (snapshotDir) =>
  resolve(snapshotDir, ".snapshot.lookup.tsv.gz");

/**
 * The in-progress snapshot's own file — the temp the writer streams into, which
 * doubles as the set's concurrency lock (ADR-0048; see {@link withSnapshotFile}
 * for the two names' two meanings). Left behind by a run that died without its
 * handler finishing, which is what {@link recoverWorkFile} adopts.
 * @param {string} snapshotDir - The set's snapshots dir
 */
const workFilePath = (snapshotDir) => resolve(snapshotDir, ".snapshot.tsv.gz");

/**
 * The interrupts a snapshot parks its work on. SIGINT (Ctrl+C) is the blessed,
 * documented path and works on every platform; SIGHUP/SIGTERM are best-effort —
 * closing the console window on Windows raises SIGHUP with a short grace period,
 * and a modest snapshot can finalise inside it. Best-effort is *safe* because
 * finalising ends in an atomic rename: either it completes (a valid parked file)
 * or it doesn't (the temp is left at the lock name, today's "delete and retry").
 * SIGKILL and power loss see no handler at all, so nothing is parked — the work
 * file is left at the lock name, and `--resume` is how the user takes it back
 * ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md); it is
 * not "no harm, only time", which is what 0067 assumed before the hashes turned
 * out to be recoverable).
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
 * The fixed-name temp file `.snapshot.tsv.gz` doubles as the set's snapshot
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
  const tmpPath = workFilePath(snapshotDir);

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
    // gzip, not a newer codec: every reader decodes it out of the box (ADR-0097).
    // `Z_FILTERED` drops the short matches deflate otherwise finds by chance in
    // the random hex of the hash column — each costs more bits than the four or
    // so a hex literal does — so the hashes code close to their entropy while
    // the paths, which really do repeat, keep their long matches. Level 9 and
    // `memLevel` 9 are zlib's maximums; both cost the compressor only.
    createGzip({
      chunkSize,
      level: 9,
      memLevel: 9,
      strategy: constants.Z_FILTERED,
    }),
    fd.createWriteStream(),
  );

  const parkedPath = parkedLookupPath(snapshotDir);

  try {
    // Handler installed here, around the write, rather than at the top-level
    // dispatch — that has no handle on the open stream to finalise (ADR-0067).
    // `backup` and `snapshot` both get it, through `generateSnapshot`.
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
      // Replacing an existing parked file needs no unlink first (`rename`
      // replaces on Windows too — see `recoverWorkFile`), and replacing is
      // always right, since a resumed run re-records every row the file it
      // replaces held, making each parked file a superset.
      await rename(tmpPath, parkedPath);
      throw interruptedError();
    }

    await rename(tmpPath, snapshotPath);

    // Delete the parked lookup on *success*, not on read: while a resumed run is
    // in flight both files exist, so a second interrupt still preserves the
    // earlier work. This snapshot re-records every hash the parked file held, so
    // landing it is what makes the parked copy redundant. Best-effort — the
    // snapshot is already installed, and a leftover parked file starts before
    // it, which is how `readParkedLookup` knows to ignore it.
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
 * is also why the file's `@SET NAME` is deliberately *not* checked against the
 * set: a path whose size and mtime still match is the same file whichever set
 * recorded it, so the check would reject nothing that could do harm.
 * `instant` — when the stopped run started — comes back too: `readBaseline`
 * uses it as the change-time check's boundary for a set with no previous
 * snapshot to take one from ([ADR-0094](../../docs/adr/0094-change-time-check-opt-in.md)).
 * Read **tolerantly** ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md)),
 * which a snapshot never is: a parked file has no closing `.`, whether its run
 * was stopped or killed, and a killed run's last row is torn, with no LF. Every parked file
 * has its `@SNAPSHOT START` row, written before any object, so `instant` is
 * there either way.
 * @param {string} snapshotDir - The set's snapshots dir (`~/.s3cab/sets/<set>/snapshots/`)
 * @param {string} [notBefore] - When the previous snapshot started; a parked file whose run started earlier is ignored
 * @returns {Promise<{ entries: SnapshotEntries, instant?: string } | undefined>} The parked entries and when the stopped run started, or undefined when none are parked
 */
export async function readParkedLookup(snapshotDir, notBefore) {
  const path = parkedLookupPath(snapshotDir);
  if (!existsSync(path)) {
    return undefined;
  }
  const { entries, instant } = await parseCompressedSnapshotStream(
    createReadStream(path),
    { tolerant: true },
  );
  // A leftover a landed snapshot's best-effort delete missed: that snapshot
  // re-recorded every row, and laid on top, these older hashes would undo a
  // `--rehash` that corrected one. Not deleted here: this runs before the lock,
  // so a run parking right now could have replaced it. The next landing does.
  if (instant && notBefore && Date.parse(instant) < Date.parse(notBefore)) {
    return undefined;
  }
  return { entries, instant };
}

/**
 * Adopt the work file a killed run left behind, so the next pass reuses its
 * hashes instead of re-reading those files
 * ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md)) — the
 * `--resume` half of what {@link inProgressError} offers. The rename *is* the
 * recovery: it moves the file from the name that means "a run is writing right
 * now, keep out" to the name that means "nobody is writing; here are hashes to
 * reuse", which releases the lock and feeds {@link readParkedLookup} in one
 * motion.
 *
 * **The caller is the liveness check, and that is the whole safety argument** —
 * none of the PID/age heuristics ADR-0048 rejected. `inProgressError` asks the
 * user to confirm nothing is running before they pass `--resume`, exactly as it
 * already does before they delete the file. Reading what is adopted stays
 * harmless either way (ADR-0067): every hash is re-validated against the live
 * file's size and mtime, so a stale row is re-hashed rather than trusted.
 *
 * Replaces an existing parked file rather than merging, on the same reasoning as
 * the graceful park it mirrors: a run re-records every row the file it read held,
 * so the newer file is normally a superset of the older.
 * @param {string} snapshotDir - The set's snapshots dir
 * @returns {Promise<boolean>} Whether there was a work file to adopt
 */
export async function recoverWorkFile(snapshotDir) {
  // One `rename`, and no `existsSync` ahead of it: the rename *is* the claim, so
  // two `--resume` runs started together can't both adopt the file — the loser's
  // rename fails `ENOENT` and it adopts nothing. Checking first and then
  // replacing the parked file would lose that race destructively, the loser
  // unlinking the file the winner had just adopted, and that is the one outcome
  // ADR-0092 doesn't accept: *reading* a file another run owns is harmless,
  // deleting the hashes is the whole loss this exists to prevent.
  //
  // Replacing the existing parked file needs no unlink first — Node's `rename`
  // replaces atomically on Windows too (libuv's `MoveFileEx` with
  // `MOVEFILE_REPLACE_EXISTING`), which is the only reason one call can do both
  // jobs.
  try {
    await rename(workFilePath(snapshotDir), parkedLookupPath(snapshotDir));
  } catch (error) {
    if (isENOENT(error)) {
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Refuse up front when the set's work file is already there — the lock
 * {@link withSnapshotFile} would fail to take — so the refusal comes before a
 * store LIST and a walk rather than after them. A fail-fast only, never the
 * guard: two runs started together both pass here, and the `wx` open still
 * stops the second.
 * @param {string} snapshotDir - The set's snapshots dir
 */
export function assertNoWorkFile(snapshotDir) {
  const tmpPath = workFilePath(snapshotDir);
  if (existsSync(tmpPath)) {
    throw inProgressError(tmpPath);
  }
}

/**
 * The lock-held error `withSnapshotFile` raises when the snapshot temp file
 * already exists (ADR-0048): either another snapshot/backup of this set is
 * running right now, or a crashed run left the file behind. Never auto-broken —
 * both remedies are gated on "if nothing is running": on POSIX, taking a *live*
 * run's file and re-running can corrupt the store (Windows blocks it via the
 * open handle).
 *
 * **Two remedies, recovery first** ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md)):
 * the work file holds the hashes the dead run had already worked out, which on a
 * long first pass is hours of reading, so offering only the delete threw that
 * away by default. The delete stays as the way to start the pass over.
 *
 * The recovery is "the same command again with `--resume`", not a pasteable
 * `s3cab backup <set> --resume` (ADR-0030's usual form): that needs the calling
 * command threaded down here, and would drop any other options the user typed.
 * @param {string} tmpPath - The lock/temp file path (`.snapshot.tsv.gz`)
 */
const inProgressError = (tmpPath) => {
  const del = process.platform === "win32" ? "del" : "rm";
  return new Error(
    `A snapshot of this set is already in progress — or a previous one was ` +
      `interrupted and left its work file behind.\n\n` +
      `If no snapshot, backup or upload of this set is running now, run the same ` +
      `command again with --resume to carry on from the file hashes it had ` +
      `already worked out.\n\n` +
      `Or start the pass over, reading those files again:\n` +
      `  ${shellCommand(`${del} "${tmpPath}"`)}`,
  );
};

/**
 * Write a complete snapshot file and return its path: the heading row, the
 * `@S3CAB`/`@CLIENT`/`@SET`/`@SNAPSHOT` property rows, `#excluded` rows for
 * pattern-matched entries, `#error` rows for entries the walk couldn't check,
 * then a `-` row per kept file — each hashed via the
 * injected `getProps`, with an `#error` row for any that fails — and the
 * `FILES`/`SIZE`/`FINISH` trailer and closing `.`, all gzip-compressed and atomically renamed into
 * place (`withSnapshotFile`). This is the single production seam for "files →
 * snapshot file"; the grammar never leaves this module.
 *
 * Hashing is *injected* as `getProps`, not imported — the seam that lets a test
 * drive the writer without touching disk (it passes a `getProps` that synthesizes
 * props; see test/helpers/write-snapshot.mjs). Production binds it to the lib
 * `fileProps` with the previous-snapshot lookup already in (`generateSnapshot`).
 * `files` is accepted as any (async) iterable, so the caller can hand in a
 * progress-wrapped stream.
 *
 * The "not backed up" rows come before the objects, where someone opening the
 * file to ask "why wasn't X backed up?" finds them without scrolling past the
 * entries. A hashing `#error` stays inline with the objects, in file order.
 * Parsing is type-driven so order doesn't affect correctness
 * (`parseSnapshotStream`).
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
 * @param {SnapshotSet} args.set - The set as this run saw it (→ `@SET` rows)
 * @param {Iterable<string> | AsyncIterable<string>} args.files - Kept file paths to hash and record
 * @param {ExclusionRecord[]} args.excluded - Pattern-matched entries (→ `#excluded` rows)
 * @param {WalkError[]} args.errors - Entries the walk couldn't check (→ `#error` rows)
 * @param {(path: string) => Promise<Props>} args.getProps - Compute a file's props (hash/size/mtime)
 * @param {RowTransform} [args.through] - Pass-through applied to each hashed row before it reaches the TSV (`backup`'s object uploader)
 * @param {boolean} [args.overwrite] - Replace an existing same-name snapshot instead of erroring
 * @param {() => void} [args.onStop] - Called once when the user asks the pass to stop (ADR-0067), so a caller's progress line can say so
 * @returns {Promise<string>} Path to the created snapshot file
 */
export async function writeSnapshot(
  snapshotDir,
  moment,
  {
    set,
    files,
    excluded,
    errors,
    getProps,
    through,
    overwrite = false,
    onStop,
  },
) {
  // Whatever a person reads is spelled out (ADR-0100); only the paths the code
  // reads back as real ones are refused instead, by the walk.
  const preamble = [
    openingRows(),
    ...set.patterns.map((pattern) => property(CLIENT, "EXCLUDE", pattern)),
    property(SET, "NAME", set.name),
    property(SET, "BUCKET", `s3://${set.bucket}`),
    ...(set.endpoint ? [property(SET, "ENDPOINT", set.endpoint)] : []),
    ...set.dirs.map((dir) => property(SET, DIR, asFolder(dir))),
    property(SNAPSHOT, "NAME", moment.name),
    property(SNAPSHOT, "BY", userAtMachine()),
    property(SNAPSHOT, START, moment.zone, moment.instant),
    ...excluded.map(({ pattern, path, isDir }) =>
      formatLine(
        EXCLUDED,
        showControlChars(pattern),
        "",
        "",
        showControlChars(isDir ? asFolder(path) : path),
      ),
    ),
    ...errors.map(({ path, reason }) => errorLine(reason, path)),
  ].join("");
  return withSnapshotFile(
    snapshotDir,
    moment.name,
    async (writeStream, signal) => {
      // The park signal is created in here, under `withSnapshotFile`, because
      // that is the scope holding the stream to finalise (ADR-0067) — so a
      // caller that composed its progress line *before* this call has no way to
      // learn of the stop. One listener hands it back out. On the abort itself,
      // not between rows: the pass notices between files, and behind an upload
      // that is minutes away on a multi-gigabyte one (ADR-0069), which is the
      // whole interval the user spends wondering whether Ctrl+C did anything.
      if (onStop) {
        signal.addEventListener("abort", onStop, { once: true });
      }
      const rows = propsRows(getProps, signal);
      await pipeline(
        files,
        // Composed rather than spliced into the argument list: `pipeline`'s
        // variadic overloads type a fixed chain far more happily than a
        // conditionally-built array of transforms.
        through ? (paths) => through(rows(paths)) : rows,
        // The signal reaches the trailer the same way it reaches `propsRows`:
        // handed in, not read from a module global. It is what tells a finished
        // file from one the user stopped, and only this scope holds it.
        (produced) =>
          stringifySnapshot(produced, {
            start: moment.instant,
            preamble,
            signal,
          }),
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
 * `<name>.tsv.gz`, so the name this resolves is exactly the name the writer
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
 *   set for remote names. Enriching it here rather than at each call site is
 *   safe because a name that came *from* this directory's listing can never
 *   miss, so only a name the user typed ever sees the error.
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
        `\nTake one with:\n  ${shellCommand("s3cab snapshot")}`,
    );
  }
  return new Error(
    `Snapshot '${name}' not found in '${tildeify(snapshotDir)}'.\n` +
      `Snapshots there, newest first:\n` +
      names.map((n) => `  ${n}`).join("\n"),
  );
}

/**
 * The moment a snapshot is taken, in the three spellings the format needs, from
 * **one clock read** ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)):
 *
 * - `name` — local wall clock, minute precision, ISO 8601 basic form (`20260612T0915`).
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
 * instead of spelling the grammar they don't own. The `.tsv.gz` itself is a
 * user-facing promise (guide/format.md, ADR-0002): a recoverer decompresses it
 * with plain `gunzip`.
 * @param {string} name - Snapshot name without extension, e.g. `20260612T0915`
 * @returns {string} e.g. `20260612T0915.tsv.gz`
 */
export const snapshotFileName = (name) => `${name}.tsv.gz`;

/**
 * Accept either a bare snapshot name (as `list` reports) or a full snapshot
 * filename, by stripping the `.tsv`/`.tsv.gz` extension — so callers taking
 * user-supplied names (`compare`) never learn the extension grammar.
 * @param {string} [name]
 */
export const normalizeSnapshotName = (name) =>
  name?.replace(/\.tsv(\.gz)?$/, "");

/**
 * The snapshot names among a set of snapshot file names, newest first. This
 * datestamped `.tsv.gz` filter is the one place the snapshot naming convention
 * is recognised; `list` (local files) and the remote lister (snapshot keys with
 * their `snapshots/<set>/` prefix already stripped) both run through here,
 * so a local and a remote listing sort and filter identically. Anchored at
 * both ends: the remote listing is recursive, so a key in a folder below the
 * set's (`old/20990101T0000.tsv.gz`) arrives here with its folder, and isn't
 * the set's snapshot.
 * @param {Iterable<string>} names - Snapshot file names (e.g. `20260612T0915.tsv.gz`)
 * @returns {string[]} Snapshot names without extension (e.g. `20260612T0915`), newest first
 */
export function snapshotNames(names) {
  return [...names]
    .filter((name) => /^\d{8}T\d{4}\.tsv\.gz$/.test(name))
    .map((name) => name.slice(0, -".tsv.gz".length))
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

  return extname(path) === ".gz"
    ? parseCompressedSnapshotStream(readStream)
    : parseSnapshotStream(readStream);
}

/**
 * Parse a **compressed** (`.tsv.gz`) snapshot byte stream into a snapshot —
 * the gunzipping front of {@link parseSnapshotStream}, shared by the
 * local `.gz` read ({@link readSnapshotFile}) and the remote read
 * (`readRemoteSnapshot`, streaming an S3 body). A `pipeline` with the parser as
 * its **terminal sink**, which is the one shape with both properties this read
 * needs: a mid-stream source error (a dropped connection, a failed disk read)
 * propagates and rejects instead of stalling the parser (`.pipe` forwards no
 * `error`), and teardown waits for the sink — the source is fully consumed
 * first, so a live S3 request is never aborted on normal completion (the eager
 * teardown of a bare `compose`/`pipeline` regressed #171 with `ABORT_ERR`).
 * @param {Readable} source - Raw `.tsv.gz` bytes (a file stream or S3 body)
 * @param {object} [options]
 * @param {boolean} [options.tolerant] - Accept a stream cut short, and pass the same tolerance on to {@link parseSnapshotStream} — the work-file read, and nothing else
 * @returns {Promise<Snapshot>}
 * @throws {AssertionError} When the bytes are cut short, unless `tolerant` — whichever layer
 *   notices, so a truncated snapshot reads the same on every Node (ADR-0082
 *   amendment 2)
 */
export async function parseCompressedSnapshotStream(
  source,
  { tolerant = false } = {},
) {
  // A killed run's work file is a gzip stream never closed, and the default
  // `finishFlush` rejects one with `Z_BUF_ERROR` after emitting every row it
  // holds; `Z_SYNC_FLUSH` ends cleanly with them. Tolerant reads only — for a
  // snapshot, a cut stream must stay loud (ADR-0082 amendment 2).
  const decompressed = createGunzip(
    tolerant ? { finishFlush: constants.Z_SYNC_FLUSH } : {},
  );
  try {
    return await pipeline(source, decompressed, (tsv) =>
      parseSnapshotStream(tsv, { tolerant }),
    );
  } catch (error) {
    // gunzip rejects a stream that ends before its own trailer, before the
    // parser can miss its closing `.` — so for a *compressed* snapshot this is
    // where truncation is caught, and the `.` covers what gzip's check can't see
    // (ADR-0082 amendment 3). Same damage, so the same AssertionError.
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "Z_BUF_ERROR") {
      assert.fail(
        "Damaged snapshot: the compressed data ends mid-stream, so the file was cut short",
      );
    }
    throw error;
  }
}

/**
 * Parse a decompressed snapshot TSV stream into a snapshot — the line-parsing
 * core of `readSnapshotFile`, split out so a snapshot can be read straight from
 * a remote object stream (`backup`/`restore` downloading from `snapshots/`)
 * with no temp file. The caller hands in an already-**decompressed** TSV stream;
 * both compressed sources — a local `.gz` file and a remote S3 body — come
 * through {@link parseCompressedSnapshotStream}, which fronts this parser with
 * gunzip as a pipeline sink.
 *
 * Only what code reads is parsed (ADR-0098): `-` rows into `entries`, `#error`
 * rows into `errors` (so `compare` reports the path rather than mistaking it
 * for deleted), `@SET DIR` into `dirs` (what `restore --output` re-roots by),
 * `@SNAPSHOT START`'s instant and `@SNAPSHOT BY`. Every other `@` or `#` row is
 * for people, or from a newer s3cab, and is skipped.
 *
 * Validity is ADR-0101's. The whole file is refused for any fault
 * {@link parseS3cabFile} finds in it. One path is refused, and the rest still read,
 * for a malformed `-` row, a path that isn't absolute, holds a tab, CR or NUL,
 * has an empty, `.` or `..` segment, or isn't strictly inside a `@SET DIR`,
 * and a path two such rows name, or that one names as a folder of the other's:
 * both are refused, so no reader guesses between them.
 * @param {AsyncIterable<Uint8Array>} input - A decompressed snapshot TSV stream
 * @param {object} [options]
 * @param {boolean} [options.tolerant] - Read a **work file** rather than a snapshot ([ADR-0092](../../docs/adr/0092-recover-the-interrupted-work-file.md)): accept a stream that ends without the closing `.`. Off everywhere else, because for a *snapshot* that is the damage the `.` exists to make loud. Deliberately not a mode a caller outside this module reaches for: `readParkedLookup` is the only one that sets it
 * @returns {Promise<Snapshot>}
 * @throws {AssertionError} When the whole file is refused — truncation
 *   (ADR-0082) among the rest — which `isCorruptSnapshotError` classifies as
 *   damage rather than an S3 failure
 */
export async function parseSnapshotStream(input, { tolerant = false } = {}) {
  /** @type {SnapshotEntries} */
  const entries = new Map();
  /** @type {SnapshotErrors} */
  const errors = new Map();
  /** @type {SnapshotRefused} */
  const refused = new Map();
  /**
   * Every path a file row has named, so a second file row refuses both. Not
   * `#error` rows: one repeating a file row's path changes nothing a restore
   * writes, and refusing the file for it would part s3cab from a reader that
   * skips `#` rows (ADR-0101).
   */
  const seen = new Set();
  /** @type {string[]} */
  const dirs = [];
  /** @type {string | undefined} */
  let instant;
  /** @type {string | undefined} */
  let by;

  /** @param {string} path @param {string} reason */
  const refuse = (path, reason) => {
    entries.delete(path);
    refused.set(path, reason);
  };

  /**
   * Read one row into the state above. A snapshot's row faults refuse a path,
   * never the file, so it returns none.
   * @param {Fields} fields
   * @returns {undefined}
   */
  const parseRow = (fields) => {
    // The five columns, named for their *position* only: what each holds depends
    // on the type in col1, so each earns a real name inside the branch that has
    // read it.
    const [type, col2, col3, col4, col5] = fields;
    const property = col2;

    if (type === FILE) {
      // A per-path row refuses its own path and nothing else (ADR-0101): rows
      // are independent lines, so the rest of the file still reads.
      const path = col5;
      if (seen.has(path)) {
        refuse(path, "it appears in two rows of the snapshot");
        return;
      }
      seen.add(path);
      const rowFault = fileRowFault(col2, col3, col4, path);
      if (rowFault) {
        refuse(path, rowFault);
      } else {
        entries.set(path, { size: Number(col3), mtime: col4, hash: col2 });
      }
    } else if (type === ERROR && col5) {
      errors.set(col5, col2);
    } else if (type === SET && property === DIR && col5) {
      dirs.push(col5);
    } else if (type === SNAPSHOT && property === START) {
      // Any other shape reads as no START, for every reader of `instant`:
      // compared as text against deletion instants, it would decide at random.
      instant = isInstant(col4) ? col4 : undefined;
    } else if (type === SNAPSHOT && property === "BY") {
      by = col5 || undefined;
    }
  };

  const fault = await parseS3cabFile(input, parseRow, { tolerant });
  // An AssertionError on purpose: `isCorruptSnapshotError`
  // (lib/referenced.mjs) classifies it as snapshot damage, so verify records
  // the finding and cleanup/delete refuse.
  assert(fault === undefined, `Damaged snapshot: ${fault}`);

  // After the read, not per row: only a whole file says which `@SET DIR` rows
  // and which other paths there are. The file rows must fit in one tree as
  // files. So each lies strictly inside a DIR: its folder is, not the path
  // itself, or a row naming the DIR would pass. And none is a DIR, which with
  // nested DIRs can still lie inside the outer one; only a folder that holds a
  // DIR can hold such a row. Both passes judge a row by its folder, and a
  // snapshot lists a folder's files together, so each answer is kept for the
  // next row: without that, the passes cost a 100k-row read 20% (POSIX paths)
  // to 40% (Windows) more; with it, nothing measurable.
  const members = dirs.filter(isMatchableDir);
  const underDir = pathMatcher(members) ?? (() => false);
  const dirKeys = new Set(members.map(pathKey));
  const dirParents = new Set(
    [...dirKeys].map((key) => key.slice(0, key.lastIndexOf("/"))),
  );
  /** @param {string} path */
  const folderOf = (path) => path.slice(0, -preparePath(path).base.length);
  /** @type {string | undefined} */
  let folder;
  let inside = false;
  let holdsDir = false;
  for (const path of entries.keys()) {
    const here = folderOf(path);
    if (here !== folder) {
      folder = here;
      inside = underDir(here);
      holdsDir = dirParents.has(pathKey(here));
    }
    if (!inside) {
      refuse(
        path,
        "its path isn't inside any of the snapshot's @SET DIR folders",
      );
    } else if (holdsDir && dirKeys.has(pathKey(path))) {
      refuse(path, "its path is one of the snapshot's @SET DIR folders");
    }
  }
  // And no path left runs through another as a folder. Not the rows refused
  // above: they land nowhere, so they block nothing. Paths compare exactly,
  // like the repeated-path check: two spellings of one name are the
  // destination's collision, not the file's.
  const files = new Set(entries.keys());
  folder = undefined;
  /** @type {string | undefined} */
  let blocker;
  for (const path of files) {
    const here = folderOf(path);
    if (here !== folder) {
      folder = here;
      const separator = foldsCase(here) ? /[\\/]/g : /\//g;
      blocker = [...here.matchAll(separator)]
        .map(({ index }) => here.slice(0, index))
        .find((above) => files.has(above));
    }
    if (blocker !== undefined) {
      refuse(blocker, "another row's path runs through it as a folder");
      refuse(path, "a folder in its path is another row's file");
    }
  }
  // Elsewhere a refused path is one with no row (ADR-0101): read like an
  // `#error`, `compare` lists it as unreadable and `backup` re-hashes it.
  for (const [path, reason] of refused) {
    errors.set(path, reason);
  }

  return { entries, errors, refused, dirs, instant, by };
}

/**
 * Why a `-` row can't be trusted, or `undefined` for a well-formed one — the
 * field checks of ADR-0101's valid file.
 * @param {string} hash @param {string} size @param {string} mtime @param {string} path
 * @returns {string | undefined}
 */
const fileRowFault = (hash, size, mtime, path) =>
  !/^[0-9a-f]{64}$/.test(hash)
    ? "its hash isn't 64 lowercase hex digits"
    : !/^[0-9]+$/.test(size)
      ? "its size isn't a whole number of bytes"
      : !isInstant(mtime)
        ? "its time isn't a UTC instant like 2026-08-14T09:31:07.412Z"
        : pathFault(path);

/**
 * Why a per-path row's path can't be restored to, or `undefined`. The path's
 * own shape says which separators count, as everywhere (path-match.mjs).
 * @param {string} path
 * @returns {string | undefined}
 */
function pathFault(path) {
  if (!path) {
    return "it has no path";
  }
  if (!foldsCase(path) && !path.startsWith("/")) {
    return "its path isn't absolute";
  }
  if (path.includes("\r")) {
    return "its path holds a carriage return";
  }
  if (path.includes("\t")) {
    return "its path holds a tab";
  }
  // No filesystem allows one in a name. Without this, Node's fs throws
  // ERR_INVALID_ARG_VALUE at the write, which no refused-name check catches,
  // so one row aborts the whole restore; and a reader in C cuts the string at
  // it, so `../\0x` passes the segment check below and reaches the disk as `..`.
  if (path.includes("\0")) {
    return "its path holds a NUL";
  }
  // Past its root (`/`, `C:/`, or a share's `//`), every segment names a file
  // or folder: an empty one is a trailing or doubled separator.
  const unified = preparePath(path).path;
  const segments = unified.slice(rootLength(unified)).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "its path has an empty, . or .. segment";
  }
  return undefined;
}

/**
 * Whether `text` is the 24-character UTC instant `toISOString` writes, and a
 * real one. The shape alone isn't: `Date` rolls 30 February over to 2 March
 * and hour 24 to the next day, so a restore would set a time no row named.
 * Checked by arithmetic, not by a `Date` round trip: on every file row of
 * every parse, that cost about 25 times the shape regex, and this about 5.
 * @param {string} text
 * @returns {boolean}
 */
export const isInstant = (text) => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text)) {
    return false;
  }
  /** @param {number} at - Where a field starts in `YYYY-MM-DDTHH:MM:SS` */
  const field = (at) => Number(text.slice(at, at === 0 ? 4 : at + 2));
  const year = field(0);
  const month = field(5);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    field(8) >= 1 &&
    field(8) <= (days[month - 1] ?? 0) &&
    field(11) <= 23 &&
    field(14) <= 59 &&
    field(17) <= 59
  );
};

/**
 * A row's five fields, as {@link rowFields} splits them.
 * @typedef {[string, string, string, string, string]} Fields
 */

/**
 * Read an s3cab file, a snapshot or a deletion record, by the rules every one
 * of them follows (guide/format.md, "Valid and invalid files"), handing each
 * row to `onRow`, and say why the file isn't valid, if it isn't. Each kind
 * decides what that costs: a snapshot is refused, a deletion record
 * distrusted, its well-formed rows still counting. So the read never stops at
 * a fault, and an S3 body is always consumed whole, never aborted mid-request.
 *
 * - Every line is strict UTF-8 on its own: an LF byte is never part of another
 *   character, so a line that doesn't decode costs that line alone. A BOM needs
 *   no exception: the trim removes U+FEFF.
 * - The heading row is first. A first line that isn't it is still read as a
 *   row, so a record whose heading was deleted keeps its first row.
 * - The `.` is last, with its LF (ADR-0106), so a cut that loses any row loses
 *   it too: the completeness check (ADR-0082), which gzip can't stand in for,
 *   since an uncompressed record has no trailer and text cut before
 *   compression is complete gzip.
 * - Nothing follows the `.`, a blank line or a stray second `.` included, and
 *   no line between is blank (ADR-0101).
 * - A type starting with neither `@` nor `#` is one a restore might need
 *   (ADR-0103), so unknown unless it is `-`, which `onRow` judges: a file row
 *   belongs in a snapshot and nowhere else.
 *
 * The last piece of the input has no LF after it, so it is never read as a
 * row: it is empty when the file ends with one, and otherwise a line cut short.
 * A tear is not detectable from the line itself — one inside a snapshot's path
 * column leaves four populated fields and a filename that stops short, which
 * would file a real hash under a prefix of a real path.
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} input - The file's bytes, decompressed
 * @param {(fields: Fields, line: string) => string | undefined} onRow - Every
 *   row before the `.`; returns what is wrong with the row, if that makes the
 *   file invalid, as a predicate of "line N" ("is a malformed …")
 * @param {object} [options]
 * @param {boolean} [options.tolerant] - A work file's read (ADR-0092): its run never reached a `.`, so a missing one, and a last line cut short, are no fault
 * @returns {Promise<string | undefined>} The first fault in the file, as a clause, for a file that isn't valid
 */
export async function parseS3cabFile(input, onRow, { tolerant = false } = {}) {
  /** @type {string | undefined} */
  let fault;
  let number = 0;
  let ended = false;

  /** @param {Buffer} bytes - One line, without its LF */
  const readLine = (bytes) => {
    number++;
    if (!isUtf8(bytes)) {
      fault ??= `line ${number} isn't UTF-8 text`;
      return;
    }
    const line = bytes.toString("utf8");
    if (number === 1) {
      if (isHeadingRow(line)) {
        return;
      }
      fault ??= "the first line isn't the @S3CAB FORMAT heading row";
    }
    const fields = rowFields(line);
    const [type] = fields;
    if (ended) {
      fault ??= `line ${number} follows the closing "." line`;
    } else if (line === TERMINATOR) {
      ended = true;
    } else if (type === TERMINATOR) {
      // Not an unknown type from a newer s3cab, which is what the last branch
      // would say: the closing line has been edited.
      fault ??= `line ${number} is more than the closing "."`;
    } else if (line.trim() === "") {
      fault ??= `line ${number} is blank`;
    } else if (type.startsWith("@") || type.startsWith("#") || type === FILE) {
      const rowFault = onRow(fields, line);
      if (rowFault) {
        fault ??= `line ${number} ${rowFault}`;
      }
    } else {
      fault ??=
        `line ${number} has an unknown row type ` +
        `'${showControlChars(type)}', so a newer s3cab ` +
        `wrote it, or it isn't an s3cab file`;
    }
  };

  /** @type {Buffer | undefined} */
  let held;
  for await (const bytes of byteLines(input)) {
    if (held) {
      readLine(held);
    }
    held = bytes;
  }
  if (!tolerant && held) {
    // Without the `.`, a last piece is the cut the missing `.` reports, unless
    // it is all there is and can't be the start of the heading row.
    if (ended && held.length > 0) {
      fault ??= `line ${number + 1} follows the closing "." line`;
    } else if (number === 0 && !HEADING.startsWith(held.toString("utf8"))) {
      fault ??= "the first line isn't the @S3CAB FORMAT heading row";
    }
  }
  if (!ended && !tolerant) {
    fault ??= 'the closing "." line is missing, so the file was cut short';
  }
  return fault;
}

/**
 * A byte stream's lines, split on LF alone and undecoded — a CR stays in its
 * line, where it refuses the row (ADR-0101). The last piece is whatever
 * follows the final LF: empty when the stream ends with one. A line's pieces
 * are joined once, at its LF, so a line spanning many chunks costs one copy.
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} input
 * @returns {AsyncGenerator<Buffer>}
 */
async function* byteLines(input) {
  /** @type {Buffer[]} The pieces of a line no LF has ended yet */
  let pending = [];
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let lf = bytes.indexOf(10); lf !== -1; lf = bytes.indexOf(10, start)) {
      const piece = bytes.subarray(start, lf);
      yield pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      start = lf + 1;
    }
    if (start < bytes.length) {
      pending.push(bytes.subarray(start));
    }
  }
  yield Buffer.concat(pending);
}

/**
 * Whether `line` is the {@link HEADING} row, padding aside — every s3cab file's
 * first line (ADR-0101).
 * @param {string} line
 */
const isHeadingRow = (line) => {
  const [type, col2, size, time, url] = rowFields(line);
  return (
    type === S3CAB &&
    col2 === FORMAT &&
    size === "size" &&
    time === "time" &&
    url === HEADING_URL
  );
};

/**
 * A row's five fields (guide/format.md). The leading four are space-padded so
 * the raw file reads as columns, and come back trimmed. The last never is,
 * because a filename may begin or end with a space, and it is the whole rest of
 * the line: a tab in a hand-edited path must reach `pathFault` and be refused,
 * not cut the path short at the tab.
 * @param {string} line
 * @returns {Fields}
 */
const rowFields = (line) => {
  const [a = "", b = "", c = "", d = "", ...rest] = line.split("\t");
  return [a.trim(), b.trim(), c.trim(), d.trim(), rest.join("\t")];
};

/**
 * `path` with a trailing separator, the mark of a folder (ADR-0098). A root
 * already has one.
 * @param {string} path
 */
const asFolder = (path) => (path.endsWith(sep) ? path : path + sep);

// How long the row generator runs before handing the event loop a turn, so an
// interrupt can be heard (see `propsRows`). Measured, the handler then runs
// within 0–101ms of the signal; without it, not before the pass has ended.
const CONCEDE_MS = 100;

/**
 * Wrap a props-computing function into the snapshot row generator: yields
 * `[path, Props]` per file, or `[path, Error]` when hashing fails — the latter
 * becomes an `#error` row (via `stringifySnapshot`), so an unreadable file is
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
 *
 * **And this is where the interrupt is given the chance to arrive at all**
 * ([ADR-0093](../../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md)).
 * `parkOnInterrupt`'s handler is JavaScript, so it runs only when the event loop
 * turns — the second, force-quitting press included — and on a set of small
 * files this pipeline never turns it: every stage is an `async` function whose
 * work is synchronous (`lstatSync`, `readFileSync`, `crypto.hash`), so each
 * `await` queues a microtask and the queue never drains. Without a turn the
 * signal sits unhandled until the pass ends, and `aborted` below is never true
 * while there is anything left to stop. So the generator concedes the loop
 * itself, every `CONCEDE_MS`, just before the check that reads the result. On
 * time, not a file count: at 1ms a file every 50 would do, at 10ms a file it
 * would starve again. One clock read per file and one `setImmediate` per tenth
 * of a second — over ten 8,060-file runs, less than the run-to-run spread.
 * @param {(path: string) => Promise<Props>} getProps
 * @param {AbortSignal} signal - Stop cleanly when aborted (the park-on-interrupt request)
 * @returns {(paths: AsyncIterable<string>) => AsyncGenerator<SnapshotRow>}
 */
function propsRows(getProps, signal) {
  return async function* (paths) {
    let conceded = performance.now();
    for await (const path of paths) {
      const now = performance.now();
      if (now - conceded >= CONCEDE_MS) {
        conceded = now;
        await yieldToLoop();
      }
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
 * Convert snapshot data to TSV lines: the heading row and `preamble` first, then
 * a `-` row per file (an `#error` row for one that couldn't be hashed), then
 * `@SNAPSHOT FILES`, `SIZE` and `FINISH` and the closing `.` (ADR-0098,
 * ADR-0106). Every snapshot body ends here, so the line that proves the file
 * wasn't cut short is emitted in exactly one place.
 *
 * `signal` is the same park-on-interrupt signal `propsRows` reads, handed one
 * link further down the pipeline. Aborted, the file stops after its last
 * `-` row with no trailer at all: the `.` means the file is complete, and a
 * parked one isn't (ADR-0067).
 *
 * `FILES` and `SIZE` are counted here, from the rows as they pass, so they are
 * exact. `FINISH`'s instant is minted here too, when the last row landed,
 * unless `finish` gives one, with the run's duration since `start` beside it
 * for people.
 * @param {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} snapshot - Snapshot entries (a lookup Map, or the props pipeline stream)
 * @param {object} options
 * @param {string} options.start - The run's `@SNAPSHOT START` instant, which `FINISH`'s duration counts from
 * @param {string} [options.preamble] - Rows that go before the objects, already formatted
 * @param {AbortSignal} [options.signal] - The park-on-interrupt signal; aborted means this file stops part-way
 * @param {string} [options.finish] - `FINISH`'s instant, in place of the clock's, for a snapshot that must come out the same every time it is written
 * @yields {string} TSV line
 * @returns {AsyncGenerator<string>} TSV lines
 */
export async function* stringifySnapshot(
  snapshot,
  { start, preamble = "", signal, finish },
) {
  yield HEADING + preamble;
  let files = 0;
  let size = 0;
  for await (const [path, props] of snapshot) {
    if (Error.isError(props)) {
      yield errorLine(props.message, path);
      continue;
    }
    files++;
    size += props.size;
    yield formatLine(FILE, props.hash, props.size, props.mtime, path);
  }
  if (signal?.aborted) {
    return;
  }
  const end = finish ?? completionInstant();
  yield property(SNAPSHOT, "FILES", String(files)) +
    property(SNAPSHOT, "SIZE", `${size} (${formatByteValue(size)})`) +
    property(
      SNAPSHOT,
      "FINISH",
      shortDuration(Date.parse(end) - Date.parse(start)),
      end,
    ) +
    `${TERMINATOR}\n`;
}

/**
 * The rows that follow the heading in every s3cab file (ADR-0107): the spec it
 * follows, then the `@CLIENT` rows saying which program wrote it, which
 * release, and from which home. The deletion record opens with them too
 * (ADR-0102).
 * @returns {string}
 */
export const openingRows = () =>
  property(S3CAB, "SPEC", SPEC_DATE) +
  property(CLIENT, "NAME", "s3cab") +
  property(CLIENT, "VERSION", pkg.version) +
  property(CLIENT, "HOME", asFolder(s3cabDir()));

/**
 * Format one TSV line at the fixed column widths (ADR-0098): the type unpadded
 * (ADR-0103: Excel keeps padding in the cell, which defeats `=COUNTIF(A:A,"-")`),
 * col2 64, the size 12 right-aligned, the time 24, then the ragged last column.
 * A col2 longer than its width overflows rather than being cut. The deletion
 * record's padder too (ADR-0102).
 * @param {string} type - The row's type
 * @param {string} col2 - A hash, a property, or a per-path row's wide text
 * @param {string|number} size - Size in bytes, or blank
 * @param {string} time - An instant, or blank
 * @param {string} last - The path, or the property's value
 * @returns {string} Formatted snapshot line
 */
export function formatLine(type, col2, size, time, last) {
  // The width counts code points (guide/format.md), where `padEnd` counts UTF-16
  // units: a surrogate pair, such as an emoji in an `#excluded` pattern, is two.
  const pairs = col2.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return (
    `${type}\t${col2.padEnd(64 + pairs)}\t${String(size).padStart(12)}\t` +
    `${time.padEnd(24)}\t${last}\n`
  );
}

/**
 * A whole-snapshot row: one fact, its property in col2 and its value last, an
 * instant in the time column. Spelled out (ADR-0100), since only people read
 * the values.
 * @param {string} type - `@S3CAB`, `@CLIENT`, `@SET` or `@SNAPSHOT`
 * @param {string} name - The property
 * @param {string} value
 * @param {string} [time] - An instant, for a property that has one
 * @returns {string}
 */
const property = (type, name, value, time = "") =>
  formatLine(type, name, "", time, showControlChars(value));

/**
 * An `#error` row: a path the walk couldn't check or hash, with the error's
 * message. Surfaced on read (into `Snapshot.errors`) so `compare` reports the
 * path rather than mistaking it for deleted. Both fields spelled out
 * (ADR-0100): a message can span lines.
 * @param {string} reason - The error message
 * @param {string} path - The path
 * @returns {string}
 */
const errorLine = (reason, path) =>
  formatLine(ERROR, showControlChars(reason), "", "", showControlChars(path));
