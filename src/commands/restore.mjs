import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { lstat, utimes } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { platform, stderr } from "node:process";
import { copyFileAtomic } from "../lib/atomic-file.mjs";
import { readDeletionRecords } from "../lib/deletion-record.mjs";
import { loadSet } from "../lib/env.mjs";
import { IntegrityError, requireArg } from "../lib/error.mjs";
import { statProps } from "../lib/file-props.mjs";
import { countOf, formatCount } from "../lib/format.mjs";
import { foldsCase } from "../lib/path-match.mjs";
import { createProgress } from "../lib/progress.mjs";
import { getObject } from "../lib/objects.mjs";
import { listRemoteSnapshots, readRemoteSnapshot } from "../lib/remote.mjs";
import {
  COARSEST_DISK_MS,
  planRestore,
  reroot,
  selectEntries,
} from "../lib/restore.mjs";
import { isObjectNotFound } from "../lib/s3.mjs";
import { shellCommand } from "../lib/style.mjs";

/** @import { RecordedDeletion } from "../lib/deletion-record.mjs" */

// The `restore` command (docs/design/backup.md): pull a set's files back from the
// cloud. Remote-only by nature — local snapshots record only hashes; the file
// *content* lives solely in the bucket's `objects/<sha256>` store — so there is
// no `--remote` flag (like `status`).

/**
 * Restore a set's files from a remote backup (docs/design/backup.md). Reads the
 * chosen remote snapshot (latest, or `--snapshot <name>`) and writes each file
 * back to the **original absolute path** it was captured from, **never touching
 * an existing file** (it is reported skipped) unless `--overwrite` is given — so
 * the empty-disk and the "I deleted a directory" cases both just work and a
 * careless restore can't destroy newer work. Positional `paths…` filter what is
 * restored (see `selectEntries`); with none, the whole snapshot is restored.
 *
 * Each object is fetched and integrity-checked by `getObject` (its SHA-256
 * must match the snapshot's hash), then given the snapshot's mtime — required, since
 * the snapshot diff is mtime-based. Content shared across several paths (moved
 * or duplicated files) is downloaded once and copied to the rest.
 *
 * The snapshot-last upload invariant means every referenced object should exist,
 * so there is no pre-flight — but when one is **absent from the bucket anyway**
 * that file is **skipped and the run continues**, with every unproduced path
 * reported together at the end. Aborting on the first one was the worse failure:
 * a disaster recovery would stop dead partway through, leaving the thousands of
 * intact files unrestored until the user retried past each casualty in turn.
 * The **deletion record** (ADR-0064) then splits the absences: a recorded hash
 * was **deliberately deleted** (`s3cab delete`) — reported with its date, and
 * alone it leaves **exit 0** (deliberate ≠ fault, like `verify`) — while an
 * unexplained absence (an out-of-band deletion, a lifecycle rule, a broken
 * invariant) stays a loud `missing` with **exit 1**. The records are fetched
 * lazily, on the first absent object, so the happy path pays nothing.
 *
 * A **corrupt** object — present, but its bytes don't hash to its key — is the
 * same kind of casualty as an unexplained absence: the file is reported
 * `corrupt`, nothing is written for it, the run continues, and it exits 1
 * (guide/format.md's restorer rule). So is a name this filesystem **refuses** —
 * a backup taken on Linux can hold a name Windows forbids, and one taken on
 * Windows a name too long for Linux — reported `refused`, exit 1. (Some names
 * are refused before anything is written, since NTFS would misread them rather
 * than refuse them — see `planRestore`.) So is a path whose snapshot row
 * the reader refused (ADR-0101) — reported `invalid`, exit 1, never guessed at.
 * So is a file that something already on disk is in the way of — a file where
 * one of its folders should be, or a folder where it should be — reported
 * `blocked`, exit 1. So is a file whose modification time this filesystem can't
 * hold: it is written, but the time it kept is reported, `clamped`, exit 1 (APFS
 * stores 2262 for a year-2300 time, and says nothing). A time it merely rounds,
 * by less than two seconds (FAT, exFAT), is counted, `coarseTimes`, and exits 0.
 * Nothing else about one file degrades: any other failure (network,
 * credentials, a full disk) still aborts, since it is wrong about the *run*, not
 * about one file.
 *
 * A snapshot from a case-sensitive source can also list two paths **this**
 * volume folds into one file (letter case; APFS's Unicode normalization). The
 * first such path is restored; each later one is reported `collided` with
 * **exit 1** rather than silently overwriting it — detection keyed on the
 * filesystem's own equivalence, never on string folding (ADR-0086).
 *
 * `--output <dir>` re-roots instead of restoring to original locations: each
 * member directory's contents land under a folder named for it (see `reroot`).
 * That recovers a backup whose absolute paths don't fit this machine — a
 * different drive layout, or another OS entirely — and is the only mode that
 * accepts non-absolute-on-this-platform paths.
 *
 * The set must have an existing remote backup. Unlike the everyday commands, the
 * set is required — no sole-set default (ADR-0040): restore is the rare,
 * carefully considered command, and requiring the name removes the set-or-path
 * ambiguity a leading optional positional would create. It is named by `--set`
 * rather than a positional because the paths are the bulk operand
 * ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)).
 *
 * @typedef {Object} RestoreResult
 * @property {string} set - The set restored
 * @property {string} bucket - The repository bucket it was restored from
 * @property {string} snapshot - The snapshot restored from
 * @property {string[]} restored - Paths written
 * @property {string[]} skipped - Existing paths left untouched (rerun with --overwrite to replace)
 * @property {string[]} collided - Paths not written because this filesystem treats them as the same file as a path already restored (letter case, Unicode normalization — ADR-0086)
 * @property {string[]} missing - Paths not restored because their content is absent with no explanation
 * @property {string[]} corrupt - Paths not restored because their stored content is damaged (it doesn't hash to its key)
 * @property {string[]} refused - Paths not restored because this filesystem won't create a file by that name (a character it forbids, or longer than it accepts)
 * @property {string[]} blocked - Paths not restored because something already on disk is in the way: a file where one of its folders should be, or a folder where it should be
 * @property {{ path: string, kept: string }[]} clamped - Paths written whose modification time this filesystem couldn't hold, each with the time it kept instead
 * @property {number} coarseTimes - How many files were written with a time this filesystem rounded, by less than two seconds
 * @property {{ path: string, reason: string }[]} invalid - Paths not restored because the snapshot's row for them isn't valid (ADR-0101), each with why
 * @property {{ path: string, deletedOn: string }[]} deleted - Paths not restored because their content was deliberately deleted (the deletion record explains them)
 *
 * @param {string[]} [paths] - Positional path filters (empty = restore everything)
 * @param {{ set?: string, snapshot?: string, overwrite?: boolean, output?: string, debug?: boolean }} [options] - `set` (required) is the backup set to restore
 * @returns {Promise<RestoreResult>}
 */
export async function restore(paths = [], options = {}) {
  requireArg(options.set, "set");
  const set = loadSet(options.set);

  // One listing picks the source and validates `--snapshot` against what's
  // really there (newest first), so a bad name errors loudly with the choices
  // rather than failing later on a 404 mid-fetch.
  const names = await listRemoteSnapshots(set.bucket, set.name);
  if (names.length === 0) {
    throw new Error(
      `No backups for set '${set.name}'.\n\n` +
        `Back one up with:\n` +
        `  ${shellCommand(`s3cab backup ${set.name}`)}`,
    );
  }
  if (options.snapshot && !names.includes(options.snapshot)) {
    throw new Error(
      `Snapshot '${options.snapshot}' not found for set '${set.name}'.\n` +
        `Available snapshots (newest first):\n  ${names.join("\n  ")}`,
    );
  }
  // names is non-empty (guarded above), so the latest is defined.
  const name = options.snapshot ?? /** @type {string} */ (names[0]);

  const snapshot = await readRemoteSnapshot(set.bucket, set.name, name);
  const { entries, dirs } = snapshot;
  const targets = selectEntries(entries.keys(), paths);
  // The rows the reader refused (ADR-0101): restored nowhere, reported, exit 1.
  const invalid = selectEntries(snapshot.refused.keys(), paths).map((path) => ({
    path,
    reason: /** @type {string} */ (snapshot.refused.get(path)),
  }));
  if (paths.length && targets.length === 0 && invalid.length === 0) {
    throw new Error(
      `No files in snapshot '${name}' matched: ${paths.join(", ")}`,
    );
  }

  // Where each snapshot path is written. `--output` re-roots under the chosen
  // dir (and so accepts any path, cross-OS included); otherwise files go back to
  // their original absolute location.
  /** @type {(path: string) => string | undefined} */
  let destFor = (path) => path;
  if (options.output) {
    destFor = reroot(dirs, targets, options.output);
  } else {
    // Every target must be absolute on *this* platform before we touch the disk.
    // A snapshot captured on another OS (Windows paths on POSIX, say) or a
    // hand-edited one would otherwise write files relative to the cwd with
    // surprising names like `C:\Users\…` — refuse up front rather than scatter
    // them, and point at `--output` for the cross-OS case. On Windows that means
    // a Windows-shaped path: `isAbsolute` takes a POSIX `/home/…` too, on the
    // current drive, with any `\` in its names read as a separator.
    const notAbsolute = targets.filter((path) =>
      platform === "win32" ? !foldsCase(path) : !isAbsolute(path),
    );
    if (notAbsolute.length) {
      throw new Error(
        `Snapshot '${name}' has ${countOf(notAbsolute.length, "path")} that ` +
          `${notAbsolute.length === 1 ? "isn't" : "aren't"} absolute ` +
          `on this system (e.g. ${notAbsolute.slice(0, 3).join(", ")}). The backup ` +
          `was likely made on a different OS; restore it here with --output <dir> ` +
          `to re-root under a directory you choose.`,
      );
    }
  }

  const plan = planRestore(entries, targets, destFor, {
    // The entry itself, not a link's target: a rename replaces a link to a
    // folder like any file (ext4; NTFS refuses a directory link, and
    // `isInTheWay` says so).
    stat: (dest) => statOrNothing(dest, lstatSync),
    overwrite: options.overwrite,
  });

  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const collided = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const corrupt = [];
  /** @type {string[]} */
  const refused = [];
  /** @type {string[]} */
  const blocked = [];
  /** @type {{ path: string, kept: string }[]} */
  const clamped = [];
  let coarseTimes = 0;
  // Collision detection keys on the filesystem's own equivalence, never on
  // string folding (ADR-0086): a manifest written elsewhere can list two paths
  // this volume cannot tell apart — letter case (Windows, macOS default), or
  // Unicode normalization (APFS folds NFC/NFD) — and writing both would keep
  // only the last row's bytes while reporting both restored. So each written
  // file's canonical on-disk path is recorded, and a later target that already
  // *exists* (the volume's own answer, whatever its folding rules) and
  // canonicalizes into that record is a collision — reported, never written.
  // A link at the target is no collision, wherever it points: the write's
  // rename replaces the link, never the file behind it. The per-file
  // `realpathSync.native` is deliberate, not the walk-hot-path mistake: this
  // loop is download-bound, and no pure-string function can say whether two
  // names are one file — trusting strings is the bug this closes.
  /** @type {Set<string>} */
  const writtenCanonical = new Set();
  // What became of each content hash this run has tried to write, shared by
  // every path that holds it. Once content lands, every later path holding it
  // is copied from there rather than downloaded again (#1). Content found
  // absent or corrupt is the same casualty for every later path, so it isn't
  // tried again. A collision, a refused name or a blocked path is the path's
  // failure, not the content's, so it records nothing and the next path holding
  // that content fetches it; nor does a skipped file, whose content is
  // unverified.
  /**
   * @type {Map<string,
   *   | { kind: "landed", dest: string }
   *   | { kind: "absent", record: RecordedDeletion | undefined }
   *   | { kind: "corrupt" }>}
   */
  const fateByHash = new Map();
  /** @type {{ path: string, deletedOn: string }[]} */
  const deleted = [];
  // The deletion records, fetched once and only if an object turns up absent —
  // the happy path never pays for them.
  /** @type {Map<string, RecordedDeletion> | undefined} */
  let deletionRecords;
  /** @param {string} hash */
  const recordFor = async (hash) => {
    if (!deletionRecords) {
      const records = await readDeletionRecords(set.bucket);
      deletionRecords = records.deleted;
    }
    return deletionRecords.get(hash);
  };
  /** @param {RecordedDeletion | undefined} record @param {string} dest */
  const reportAbsent = (record, dest) => {
    if (record) {
      deleted.push({ path: dest, deletedOn: record.deletedOn });
    } else {
      missing.push(dest);
    }
  };

  // On a terminal the counter overwrites itself in place; redirected, each
  // update is its own plain line (`logLines`) — the TTY gate, the in-place
  // redraw, and the closing newline (drawn only when there was one, even if a
  // download throws mid-loop) all live in lib/progress.mjs. `using` runs that
  // teardown on any scope exit, so an error mid-loop still leaves the cursor on
  // a fresh line before its message prints.
  using progress = createProgress(stderr, { logLines: true });
  // Grouped, and the running count padded to the total's width — the same shape
  // the backup pass's `progressLine` draws, and for the same reason: a counter
  // left to grow shuffles the line sideways every time it gains a digit, which
  // on a six-figure restore happens five times mid-run.
  const total = formatCount(plan.length);
  let done = 0;
  for (const step of plan) {
    const fate =
      step.action === "write" ? fateByHash.get(step.hash) : undefined;
    if (step.action === "skip") {
      skipped.push(step.dest);
    } else if (step.action === "refuse") {
      refused.push(step.dest);
    } else if (step.action === "block") {
      blocked.push(step.dest);
    } else if (fate?.kind === "absent") {
      reportAbsent(fate.record, step.dest);
    } else if (fate?.kind === "corrupt") {
      corrupt.push(step.dest);
    } else if (
      existsSync(step.dest) &&
      !lstatSync(step.dest).isSymbolicLink() &&
      writtenCanonical.has(realpathSync.native(step.dest))
    ) {
      collided.push(step.dest);
    } else {
      /** @type {"found" | "absent" | "corrupt" | "refused" | "blocked"} */
      let outcome = "found";
      const from = fate?.dest;
      try {
        mkdirSync(dirname(step.dest), { recursive: true });
        if (from !== undefined) {
          try {
            await copyFileAtomic(from, step.dest);
          } catch (error) {
            // A refused name and a source gone since it was written are the
            // same ENOENT. Whether the source is still there tells
            // them apart: if it is, the name was refused, and the catch below
            // says so; only a vanished source is worth a fetch, which would
            // otherwise download the whole object just to be refused.
            if (!isRefusedName(error) || existsSync(from)) {
              throw error;
            }
            await getObject(set.bucket, step.hash, step.dest);
          }
        } else {
          await getObject(set.bucket, step.hash, step.dest);
        }
      } catch (error) {
        // This one file's problem, and only that: absent content
        // (`isObjectNotFound`, the s3.mjs spelling of "the key isn't there"),
        // corrupt content (writeFileAtomic's digest check), or a name this
        // filesystem won't create — which can surface from the directory, the
        // download or a dedup copy — or something on disk in the way. Anything
        // else — a network or credentials failure, a full disk — is wrong
        // about the whole run, so it propagates and aborts.
        if (error instanceof IntegrityError) {
          outcome = "corrupt";
        } else if (isObjectNotFound(error)) {
          outcome = "absent";
        } else if (isRefusedName(error)) {
          outcome = "refused";
        } else if (isInTheWay(error, step.dest)) {
          outcome = "blocked";
        } else {
          throw error;
        }
      }
      if (outcome === "found") {
        writtenCanonical.add(realpathSync.native(step.dest));
        fateByHash.set(step.hash, { kind: "landed", dest: step.dest });
        // Lossy below the millisecond, and not fixable here — don't try. `utimes`
        // takes seconds as a binary64 however it is spelled (a `Date` becomes
        // `getTime() / 1000`), and one ULP of that near a 2026 epoch is ~238ns, so
        // a stored `.674` lands as …674000024 where the filesystem keeps
        // nanoseconds. No arithmetic at this call site closes a gap smaller than
        // the representation, and `fs` exposes no nanosecond setter. NTFS hides it
        // (the error falls below its 100ns tick), which is why it went unseen until
        // clean-room run 2 compared `st_mtime_ns` on ext4. guide/format.md promises
        // the *millisecond* for exactly this reason.
        const when = new Date(step.mtime);
        // NTFS can't hold a time before 1601 at all: an earlier one is EINVAL,
        // and 1601 itself is FILETIME 0, which Windows takes as "leave the time
        // alone". Either way the file is left with the restore's own time, and
        // reported like any other time not kept rather than stopping the
        // restore. Not left as it is: a dedup copy starts with its source's
        // time, which may be one `lstat` misreads on Windows (below).
        let settable = platform !== "win32" || when.getTime() > NTFS_EPOCH_MS;
        try {
          await utimes(step.dest, when, when);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EINVAL") {
            throw error;
          }
          settable = false;
        }
        if (!settable) {
          // eslint-disable-next-line no-restricted-syntax -- a stand-in mtime set on the file, not a recorded instant; what is reported is read back from `lstat` below
          const now = new Date();
          await utimes(step.dest, now, now);
        }
        // `utimes` succeeds for a time the filesystem can't hold and stores
        // another, so only reading it back shows it. Compared at the millisecond:
        // the sub-millisecond loss above rounds back to the stored value. Not on
        // Windows outside 1970–2106: there `lstat` wraps the seconds to 32 bits
        // (proposals/bugs.md) while NTFS holds the time, so every such file
        // would read as clamped.
        if (!settable || platform !== "win32" || readableOnWindows(when)) {
          const landed = await lstat(step.dest, { bigint: true });
          const kept = statProps(landed).mtime;
          const off = settable
            ? Math.abs(Date.parse(kept) - when.getTime())
            : Infinity;
          if (off >= COARSEST_DISK_MS) {
            clamped.push({ path: step.dest, kept });
          } else if (off > 0) {
            coarseTimes++;
          }
        }
        restored.push(step.dest);
      } else if (outcome === "absent") {
        const record = await recordFor(step.hash);
        fateByHash.set(step.hash, { kind: "absent", record });
        reportAbsent(record, step.dest);
      } else if (outcome === "corrupt") {
        fateByHash.set(step.hash, { kind: "corrupt" });
        corrupt.push(step.dest);
      } else if (outcome === "blocked") {
        blocked.push(step.dest);
      } else {
        refused.push(step.dest);
      }
    }

    done++;
    // On lib/progress.mjs' clock, plus the final tally unconditionally — the
    // last file has to be *offered*, whether or not a redraw is due, or the
    // counter closes reading one short of the total.
    if (progress.due() || done === plan.length) {
      progress.update(
        `Restoring ${formatCount(done).padStart(total.length)}/${total}…`,
      );
    }
  }

  // Unexplained absence, corrupt content, a name collision, a refused name, a
  // blocked path or a clamped time → exit 1, the same way `verify` reports
  // findings: set process.exitCode rather than throw, so the run's report —
  // including every file that *was* restored — still prints. Deliberately-deleted
  // skips alone leave exit 0 (ADR-0064): the record proves the gap is intended, and a
  // scripted restore should not alarm on a decision its owner already made.
  if (
    missing.length ||
    corrupt.length ||
    collided.length ||
    refused.length ||
    blocked.length ||
    clamped.length ||
    invalid.length
  ) {
    process.exitCode = 1;
  }

  return {
    set: set.name,
    bucket: set.bucket,
    snapshot: name,
    restored,
    skipped,
    collided,
    missing,
    corrupt,
    refused,
    blocked,
    clamped,
    coarseTimes,
    invalid,
    deleted,
  };
}

/**
 * Whether Node's `lstat` on Windows reads `when` back as it is: its seconds
 * wrap as an unsigned 32-bit count, so only 1970 to 2106-02-07T06:28:16Z.
 * @param {Date} when
 */
const readableOnWindows = (when) =>
  when.getTime() >= 0 && when.getTime() < 2 ** 32 * 1000;

/** 1601-01-01T00:00:00Z, FILETIME 0: the earliest instant, and an unsettable one. */
const NTFS_EPOCH_MS = Date.UTC(1601, 0, 1);

/**
 * Whether the filesystem refused to create a path by its **name**. Every code
 * was measured, not assumed: NTFS answers the names it forbids (a control
 * character, any of `?*|<>"`, a component past 255 characters) with `ENOENT`;
 * ext4 answers a component past 255 bytes with `ENAMETOOLONG`. (A name NTFS
 * misreads instead never gets this far — see `planRestore`.) Only an
 * error naming a `path` counts, which is what makes it the filesystem's answer
 * rather than a code some other layer happens to share.
 * @param {unknown} error
 */
function isRefusedName(error) {
  const errno = /** @type {NodeJS.ErrnoException | undefined} */ (error);
  return (
    typeof errno?.path === "string" &&
    ["ENOENT", "ENAMETOOLONG"].includes(errno.code ?? "")
  );
}

/**
 * Whether something already on disk is in the way of `dest`. Measured on NTFS
 * and ext4: a file where one of its folders should be is `EEXIST` from the
 * `mkdir` when it is the file's own folder, `ENOTDIR` when it is one further
 * up, on both; a folder where the file should be is `EPERM` on NTFS and
 * `EISDIR` on ext4, named for the *source* of the rename either way, and so
 * on NTFS is a directory link or junction, even one whose folder is gone.
 * `EPERM` is also plain permission denied, so that answer counts only when
 * `dest` really is a folder, or a link.
 * @param {unknown} error
 * @param {string} dest
 */
function isInTheWay(error, dest) {
  const code = /** @type {NodeJS.ErrnoException | undefined} */ (error)?.code;
  return (
    code === "EEXIST" ||
    code === "ENOTDIR" ||
    ((code === "EISDIR" || code === "EPERM") &&
      (statOrNothing(dest)?.isDirectory() === true ||
        statOrNothing(dest, lstatSync)?.isSymbolicLink() === true))
  );
}

/**
 * What is at `path`, or `undefined` for nothing — or for a `stat` that fails,
 * as `existsSync` reads one, so a check never replaces the error it was asked
 * about with its own.
 * @param {string} path
 * @param {typeof statSync} [stat] - `lstatSync` for the entry itself
 */
function statOrNothing(path, stat = statSync) {
  try {
    return stat(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}
