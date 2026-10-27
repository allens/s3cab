import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { lstat, utimes } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { platform, stderr } from "node:process";

import { copyFileAtomic } from "./atomic-file.mjs";
import { readDeletionRecords } from "./deletion-record.mjs";
import { IntegrityError } from "./error.mjs";
import { statProps } from "./file-props.mjs";
import { formatCount } from "./format.mjs";
import { getObject } from "./objects.mjs";
import {
  foldsCase,
  pathMatcher,
  preparePath,
  rootLength,
} from "./path-match.mjs";
import { createProgress } from "./progress.mjs";
import { listRemoteSnapshots, readRemoteSnapshot } from "./remote.mjs";
import { isObjectNotFound } from "./s3.mjs";
import { shellCommand } from "./style.mjs";

/** @import { Props, Snapshot, SnapshotEntries } from "./snapshot-file.mjs" */
/** @import { BackupSet } from "./sets.mjs" */
/** @import { RecordedDeletion } from "./deletion-record.mjs" */

/**
 * What a restore did with each file it was asked for (`restore`, and `extract`
 * with where the item landed).
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
 * @property {string} [to] - Where `extract` put the item
 */

/**
 * Whether `dest` puts a `:` in a name on Windows. NTFS doesn't refuse one, it
 * reads `a:b.txt` as stream `b.txt` of a file `a`: a copy succeeds into that
 * hidden stream (measured). So the name is caught here, before anything is
 * written. Keyed on the path's shape, like `foldsCase`; a backup made on Linux
 * reaches one only through `--output`.
 * @param {string} dest
 * @returns {boolean}
 */
const putsColonInName = (dest) =>
  foldsCase(dest) && dest.slice(win32.parse(dest).root.length).includes(":");

/**
 * One target's step. `skip`, `refuse` and `block` leave `dest` alone; `write`
 * restores content `hash` to it and gives it the snapshot's `mtime`, as stored.
 * A `refuse` for a path with no destination at all names the snapshot path.
 * @typedef {{ action: "skip", dest: string }
 *   | { action: "refuse", dest: string }
 *   | { action: "block", dest: string }
 *   | { action: "write", dest: string, hash: string, mtime: string }} RestoreStep
 */

/**
 * Decide what to do with each restore target, without touching the disk or the
 * network. A target whose destination is already a folder is `block`ed, since
 * no `overwrite` replaces one, and before a download it couldn't land; one
 * whose destination exists otherwise is `skip`ped unless `overwrite`; one with
 * no destination (`reroot`'s `undefined`), or whose name the destination can't
 * hold as a file (`putsColonInName`), is `refuse`d; every other target is a
 * `write`.
 *
 * Not where identical content is deduplicated, because only the restore loop
 * knows where content actually landed: a write can fail without ending the run
 * (ADR-0086).
 *
 * Pure and order-preserving, like `selectEntries`/`reroot`: `stat` is
 * injected so this is unit-testable without touching the filesystem.
 * @param {SnapshotEntries} entries - Source path → `{ hash, mtime }`
 * @param {string[]} targets - Snapshot source paths to restore, in order
 * @param {(source: string) => string | undefined} destFor - Maps a source path to its destination
 * @param {object} options
 * @param {(dest: string) => { isDirectory(): boolean } | undefined} options.stat - What is at `dest` already, or `undefined` for nothing
 * @param {boolean} [options.overwrite] - Overwrite an existing destination instead of skipping it
 * @returns {RestoreStep[]} One step per target, in input order
 */
export function planRestore(
  entries,
  targets,
  destFor,
  { stat, overwrite = false },
) {
  /** @type {RestoreStep[]} */
  const plan = [];
  for (const source of targets) {
    const dest = destFor(source);
    if (dest === undefined) {
      plan.push({ dest: source, action: "refuse" });
      continue;
    }
    if (putsColonInName(dest)) {
      plan.push({ dest, action: "refuse" });
      continue;
    }
    const there = stat(dest);
    if (there?.isDirectory()) {
      plan.push({ dest, action: "block" });
    } else if (there && !overwrite) {
      plan.push({ dest, action: "skip" });
    } else {
      const { hash, mtime } = /** @type {Props} */ (entries.get(source));
      plan.push({ dest, action: "write", hash, mtime });
    }
  }
  return plan;
}

/**
 * Select which of a snapshot's paths a restore should write, given the paths
 * the user named. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the snapshot stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected:
 * `--all`.
 *
 * Pure and order-preserving (returns the input subset in iteration order) so the
 * restore loop's reporting is deterministic and this is unit-testable without S3.
 * @param {Iterable<string>} paths - The snapshot's file paths
 * @param {string[]} filters - Positional path filters (empty = match all)
 * @returns {string[]} The subset of `paths` to restore, in input order
 */
export function selectEntries(paths, filters) {
  const matches = pathMatcher(filters);
  return matches ? [...paths].filter(matches) : [...paths];
}

/**
 * How far a disk may round a modification time before the restore counts it as
 * not kept: FAT's step, the coarsest in common use. exFAT keeps 10ms, HFS+ and
 * WSL's view of a Windows drive whole seconds; a time off by less is reported
 * once, as a count, and exits 0. Past it the time is wrong, not rounded.
 */
export const COARSEST_DISK_MS = 2000;

/**
 * The names below a path's root, as `preparePath` unified it.
 * @param {string} unified
 * @returns {string[]}
 */
const namesOf = (unified) =>
  unified.slice(rootLength(unified)).split(posix.sep).filter(Boolean);

/**
 * `names` as folders under `base`, or `undefined` where a Windows `base` can't
 * hold them. The reader refuses a `.`/`..` segment (ADR-0101), but splits on
 * `/` alone. Windows also reads a POSIX name's `\` as a separator, so
 * `back\slash.txt` would land as a folder and `a\..\..\x` outside `base`, once
 * `join` resolves the `..`. Every segment is checked, since all of them become
 * folders.
 * @param {string} base - Absolute
 * @param {string[]} names
 * @returns {string | undefined}
 */
export const placeUnder = (base, names) =>
  foldsCase(base) && names.some((name) => name.includes("\\"))
    ? undefined
    : join(base, ...names);

/**
 * Build the path re-rooter for `restore --output <dir>`: each file lands at its
 * full original path under `<dir>`, its root turned into a folder
 * ([ADR-0109](../../docs/adr/0109-restore-output-keeps-the-full-path.md)) — a
 * drive keeps its letter (`C:\Users\a.jpg` → `<dir>/C/Users/a.jpg`), a share goes
 * under `UNC`, as Windows' own long-path form does (`\\nas\x\a.jpg` →
 * `<dir>/UNC/nas/x/a.jpg`), and a POSIX path keeps its segments. Where a file
 * lands depends on its own path alone, not on the others restored.
 *
 * Separator-agnostic, so a Windows snapshot re-roots correctly on POSIX and vice
 * versa: paths are split by `path-match.mjs`'s `preparePath` — both separators
 * where a path is Windows-shaped, `/` alone otherwise, so a literal backslash in
 * a POSIX filename stays one segment instead of being read as a separator. The
 * destination is rebuilt with this platform's separator under `output`. Pure and
 * side-effect-free (unit-testable without S3), like `selectEntries`.
 * @param {string} output - The `--output` directory
 * @returns {(path: string) => string | undefined} Maps a snapshot path to its
 *   destination, or `undefined` for one it can't place
 */
export function reroot(output) {
  const outDir = resolve(output);
  return (path) => {
    const { path: unified, foldCase } = preparePath(path);
    // Relative only in a hand-edited snapshot, which the reader refuses.
    if (!foldCase && !unified.startsWith("/")) {
      return undefined;
    }
    // A drive's `C:` is no name a Windows folder can have, so it takes the
    // letter, in the one case Windows reads both as; `UNC` is three letters, so
    // no drive folder can meet a share's.
    const root = unified.startsWith("//")
      ? ["UNC"]
      : foldCase
        ? [unified.charAt(0).toUpperCase()]
        : [];
    return placeUnder(outDir, [...root, ...namesOf(unified)]);
  };
}

/**
 * The name `extract` gives an item it isn't told one for: its last name, or a
 * drive root's letter, upper case as `reroot` gives it. `undefined` for `/`,
 * which has none.
 * @param {string} item - The file or folder, as named on the command line
 * @returns {string | undefined}
 */
export function itemName(item) {
  const { path, foldCase } = preparePath(item);
  return (
    namesOf(path).at(-1) ??
    (foldCase && !path.startsWith("//")
      ? path.charAt(0).toUpperCase()
      : undefined)
  );
}

/**
 * Build the path mapper for `extract`: the item lands as `to`, and everything
 * under it keeps its own names below that
 * ([ADR-0111](../../docs/adr/0111-extract-copies-one-item-out.md)). The item
 * is counted in names, as `selectEntries` matched it, so a trailing separator
 * or another case on a Windows path changes nothing. Pure, like `reroot`.
 * @param {string} item - The file or folder, as named on the command line
 * @param {string} to - Absolute: `<output>/<name>`
 * @returns {(path: string) => string | undefined} Maps a snapshot path under
 *   `item` to its destination, or `undefined` for one it can't place
 */
export function extractTo(item, to) {
  const depth = namesOf(preparePath(item).path).length;
  return (path) => placeUnder(to, namesOf(preparePath(path).path).slice(depth));
}

/**
 * The snapshot a restore reads: `wanted`, or the latest. One listing picks it
 * and checks `wanted` against what's really there (newest first), so a bad name
 * errors with the choices rather than failing later on a 404 mid-fetch.
 * @param {BackupSet} set
 * @param {string} [wanted] - `--snapshot`
 * @returns {Promise<{ name: string, snapshot: Snapshot }>}
 */
export async function chooseSnapshot(set, wanted) {
  const names = await listRemoteSnapshots(set.bucket, set.name);
  if (names.length === 0) {
    throw new Error(
      `No backups for set '${set.name}'.\n\n` +
        `Back one up with:\n` +
        `  ${shellCommand(`s3cab backup ${set.name}`)}`,
    );
  }
  if (wanted && !names.includes(wanted)) {
    throw new Error(
      `Snapshot '${wanted}' not found for set '${set.name}'.\n` +
        `Available snapshots (newest first):\n  ${names.join("\n  ")}`,
    );
  }
  // names is non-empty (guarded above), so the latest is defined.
  const name = wanted ?? /** @type {string} */ (names[0]);
  const snapshot = await readRemoteSnapshot(set.bucket, set.name, name);
  return { name, snapshot };
}

/**
 * The paths of snapshot `name` that `filters` select (see `selectEntries`), and
 * the rows the reader refused among them (ADR-0101): restored nowhere,
 * reported, exit 1. Filters that select nothing at all are an error naming them.
 * @param {Snapshot} snapshot
 * @param {string} name
 * @param {string[]} filters - Empty for `--all`
 * @returns {{ targets: string[], invalid: { path: string, reason: string }[] }}
 */
export function selectTargets({ entries, refused }, name, filters) {
  const targets = selectEntries(entries.keys(), filters);
  const invalid = selectEntries(refused.keys(), filters).map((path) => ({
    path,
    reason: /** @type {string} */ (refused.get(path)),
  }));
  if (filters.length && targets.length === 0 && invalid.length === 0) {
    throw new Error(
      `No files in snapshot '${name}' matched: ${filters.join(", ")}`,
    );
  }
  return { targets, invalid };
}

/**
 * Restore `targets` from snapshot `name` to wherever `destFor` puts each one,
 * **never touching an existing file** (it is reported skipped) unless
 * `overwrite` — so the empty-disk and the "I deleted a directory" cases both
 * just work and a careless restore can't destroy newer work.
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
 * @param {object} args
 * @param {BackupSet} args.set
 * @param {string} args.name - The snapshot's name
 * @param {Snapshot} args.snapshot
 * @param {{ targets: string[], invalid: { path: string, reason: string }[] }} args.selected - From `selectTargets`
 * @param {(path: string) => string | undefined} args.destFor - Where each target goes
 * @param {string} [args.outDir] - The folder `destFor` places everything under, if any: a link inside it is in the way, never followed
 * @param {boolean} [args.overwrite] - Replace existing files instead of skipping them
 * @returns {Promise<RestoreResult>}
 */
export async function restoreTargets({
  set,
  name,
  snapshot,
  selected: { targets, invalid },
  destFor,
  outDir,
  overwrite,
}) {
  const { entries, instant } = snapshot;
  const plan = planRestore(entries, targets, destFor, {
    // The entry itself, not a link's target: a rename replaces a link to a
    // folder like any file (ext4; NTFS refuses a directory link, and
    // `isInTheWay` says so).
    stat: (dest) => statOrNothing(dest, lstatSync),
    overwrite,
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
  /**
   * The deletion that explains this snapshot's missing object, if any: only a
   * row newer than its START (ADR-0064; the bucket-wide form is
   * `explainingDeletions`).
   * @param {string} hash
   */
  const recordFor = async (hash) => {
    if (!deletionRecords) {
      const records = await readDeletionRecords(set.bucket);
      deletionRecords = records.deleted;
    }
    const record = deletionRecords.get(hash);
    return record && instant !== undefined && record.deletedOn > instant
      ? record
      : undefined;
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
  /** @type {Map<string, boolean>} */
  const linkedFolders = new Map();
  for (const step of plan) {
    const fate =
      step.action === "write" ? fateByHash.get(step.hash) : undefined;
    // A refusal is reported as one whatever is on disk, and content already
    // found absent or corrupt is reported as that, a link or not. The link test
    // comes before the skip: the plan's `lstat` follows a link at a folder
    // position, so a file beyond one reads as already there.
    if (step.action === "refuse") {
      refused.push(step.dest);
    } else if (fate?.kind === "absent") {
      reportAbsent(fate.record, step.dest);
    } else if (fate?.kind === "corrupt") {
      corrupt.push(step.dest);
    } else if (
      outDir !== undefined &&
      linkedFolder(step.dest, outDir, linkedFolders)
    ) {
      blocked.push(step.dest);
    } else if (step.action === "skip") {
      skipped.push(step.dest);
    } else if (step.action === "block") {
      blocked.push(step.dest);
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
      const made = firstMissing(dirname(step.dest));
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
        // Before the abort below, too: a stopped run leaves no folder either.
        if (made !== undefined) {
          removeMade(dirname(step.dest), made);
        }
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
 * Whether a restore exits 1: an unexplained absence, corrupt content, a name
 * collision, a refused name, a blocked path, a clamped time or an invalid row.
 * The command sets `process.exitCode` rather than throw, the way `verify`
 * reports findings, so the run's report — every file that *was* restored
 * included — still prints. Deliberately-deleted skips alone leave exit 0
 * (ADR-0064): the record proves the gap is intended, and a scripted restore
 * should not alarm on a decision its owner already made.
 * @param {RestoreResult} result
 */
export const hasFaults = ({
  missing,
  corrupt,
  collided,
  refused,
  blocked,
  clamped,
  invalid,
}) =>
  Boolean(
    missing.length ||
    corrupt.length ||
    collided.length ||
    refused.length ||
    blocked.length ||
    clamped.length ||
    invalid.length,
  );

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
 * The outermost of `dir` and its parents that doesn't exist yet, or `undefined`
 * when `dir` does: the first folder a row's `mkdir` would make. Stops at a root,
 * which is its own `dirname`: an unmounted drive or an offline share never
 * exists, and the walk would never end.
 * @param {string} dir
 */
function firstMissing(dir) {
  let top;
  for (let at = dir; !existsSync(at); at = dirname(at)) {
    top = at;
    if (dirname(at) === at) {
      break;
    }
  }
  return top;
}

/**
 * Remove the folders a failed row made, `dir` up to `top`, so a folder is left
 * only where a file landed (guide/format.md). Each folder in that range was
 * made by this row, or never made by a `mkdir` that failed partway, so each
 * failed `rmdir` is passed over, whatever its code: the refused name itself
 * fails `ENOENT` on Windows but `ENAMETOOLONG` on Linux and macOS. `rmdir`
 * removes only an empty folder, and nothing above `top`, which was there
 * before the restore, is touched.
 * @param {string} dir
 * @param {string} top - The first folder the row made, from {@link firstMissing}
 */
function removeMade(dir, top) {
  for (let at = dir; ; at = dirname(at)) {
    try {
      rmdirSync(at);
    } catch {
      // Not made, or not empty: either way, not this row's to remove.
    }
    if (at === top || dirname(at) === at) {
      return;
    }
  }
}

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
 * Whether a link sits where one of `dest`'s folders inside `outDir` should be.
 * `mkdir` and the rename both follow one, so the file would land wherever the
 * link points, outside `<output>`. Links above `outDir` are the user's own
 * layout and are followed. Node's `lstat` calls a junction a link too.
 * @param {string} dest - A destination `reroot` or `extractTo` built under `outDir`
 * @param {string} outDir - `resolve(--output)`, the prefix they joined onto
 * @param {Map<string, boolean>} known - This run's answers per folder, so a
 *   re-run that skips every file still `lstat`s each folder once. Sound because
 *   restore never makes a link.
 * @returns {boolean}
 */
function linkedFolder(dest, outDir, known) {
  const dir = dirname(dest);
  // The root test is for a `dest` built under no `outDir`: the root is its own
  // `dirname`, so the climb would never end.
  if (dir === outDir || dirname(dir) === dir) {
    return false;
  }
  let linked = known.get(dir);
  if (linked === undefined) {
    linked =
      statOrNothing(dir, lstatSync)?.isSymbolicLink() === true ||
      linkedFolder(dir, outDir, known);
    known.set(dir, linked);
  }
  return linked;
}

/**
 * What is at `path`, or `undefined` for nothing — or for a `stat` that fails,
 * as `existsSync` reads one, so a check never replaces the error it was asked
 * about with its own.
 * @param {string} path
 * @param {typeof statSync} [stat] - `lstatSync` for the entry itself
 */
export function statOrNothing(path, stat = statSync) {
  try {
    return stat(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}
