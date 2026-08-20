import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile, utimes } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { stderr } from "node:process";
import { readDeletionRecords } from "../lib/deletion-record.mjs";
import { loadSet } from "../lib/env.mjs";
import { requireArg } from "../lib/error.mjs";
import { countOf, formatCount } from "../lib/format.mjs";
import { createProgress } from "../lib/progress.mjs";
import { getObject } from "../lib/objects.mjs";
import { listRemoteSnapshots, readRemoteSnapshot } from "../lib/remote.mjs";
import { planRestore, reroot, selectEntries } from "../lib/restore.mjs";
import { isObjectNotFound } from "../lib/s3.mjs";

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
 * lazily, on the first absent object, so the happy path pays nothing. Only a
 * genuinely absent object degrades this way — an integrity mismatch or any
 * other failure (network, credentials) still aborts, since those are wrong about
 * the *run*, not about one file.
 *
 * A snapshot from a case-sensitive source can also list two paths **this**
 * volume folds into one file (letter case; APFS's Unicode normalization). The
 * first such path is restored; each later one is reported `collided` with
 * **exit 1** rather than silently overwriting it — detection keyed on the
 * filesystem's own equivalence, never on string folding (ADR-0086).
 *
 * `--output <dir>` re-roots instead of restoring to original locations: each
 * member directory's contents land under `<dir>/<root-basename>/…` (see `reroot`).
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
      `No backups for set '${set.name}'. Back one up with: s3cab backup ${set.name}`,
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

  const { entries, dirs } = await readRemoteSnapshot(
    set.bucket,
    set.name,
    name,
  );
  const targets = selectEntries(entries.keys(), paths);
  if (paths.length && targets.length === 0) {
    throw new Error(
      `No files in snapshot '${name}' matched: ${paths.join(", ")}`,
    );
  }

  // Where each snapshot path is written. `--output` re-roots under the chosen
  // dir (and so accepts any path, cross-OS included); otherwise files go back to
  // their original absolute location.
  /** @type {(path: string) => string} */
  let destFor = (path) => path;
  if (options.output) {
    destFor = reroot(dirs, options.output);
  } else {
    // Every target must be absolute on *this* platform before we touch the disk.
    // A snapshot captured on another OS (Windows paths on POSIX, say) or a
    // hand-edited one would otherwise write files relative to the cwd with
    // surprising names like `C:\Users\…` — refuse up front rather than scatter
    // them, and point at `--output` for the cross-OS case.
    const notAbsolute = targets.filter((path) => !isAbsolute(path));
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
    exists: existsSync,
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
  // Collision detection keys on the filesystem's own equivalence, never on
  // string folding (ADR-0086): a manifest written elsewhere can list two paths
  // this volume cannot tell apart — letter case (Windows, macOS default), or
  // Unicode normalization (APFS folds NFC/NFD) — and writing both would keep
  // only the last row's bytes while reporting both restored. So each written
  // file's canonical on-disk path is recorded, and a later target that already
  // *exists* (the volume's own answer, whatever its folding rules) and
  // canonicalizes into that record is a collision — reported, never written.
  // The per-file `realpathSync.native` is deliberate, not the walk-hot-path
  // mistake: this loop is download-bound, and no pure-string function can say
  // whether two names are one file — trusting strings is the bug this closes.
  /** @type {Set<string>} */
  const writtenCanonical = new Set();
  // Dests a collision left unwritten: a later `copy` step pointing at one
  // would read whatever survivor the name resolves to — the wrong bytes — so
  // it re-fetches from the store instead.
  /** @type {Set<string>} */
  const collidedDests = new Set();
  /** @type {{ path: string, deletedOn: string }[]} */
  const deleted = [];
  // Hashes whose fetch found nothing, with the deletion record's explanation if
  // it has one. `planRestore` points each repeat of a hash at wherever the
  // *first* one landed, so a failed fetch would leave every later `copy` of that
  // content reading a file that was never written — they are the same casualty,
  // and are recorded (under the first fetch's classification) rather than
  // attempted.
  /** @type {Map<string, RecordedDeletion | undefined>} */
  const absentHashes = new Map();
  // The deletion records, fetched once and only if an object turns up absent —
  // the happy path never pays for them.
  /** @type {Map<string, RecordedDeletion> | undefined} */
  let deletionRecords;
  /** @param {string} hash */
  const recordFor = async (hash) => {
    deletionRecords ??= await readDeletionRecords(set.bucket);
    return deletionRecords.get(hash);
  };
  /** @param {string} hash @param {string} dest */
  const reportAbsent = (hash, dest) => {
    const record = absentHashes.get(hash);
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
    const hash = /** @type {string} */ (step.hash);
    if (step.action === "skip") {
      skipped.push(step.dest);
    } else if (absentHashes.has(hash)) {
      reportAbsent(hash, step.dest);
    } else if (
      existsSync(step.dest) &&
      writtenCanonical.has(realpathSync.native(step.dest))
    ) {
      collided.push(step.dest);
      collidedDests.add(step.dest);
    } else {
      mkdirSync(dirname(step.dest), { recursive: true });
      let found = true;
      const from =
        step.action === "copy" ? /** @type {string} */ (step.from) : undefined;
      if (from !== undefined && !collidedDests.has(from)) {
        await copyFile(from, step.dest);
      } else {
        try {
          await getObject(set.bucket, hash, step.dest);
        } catch (error) {
          // Absent content, and only that: `isObjectNotFound` is the s3.mjs
          // spelling of "the key isn't there". Anything else — a hash mismatch
          // from writeFileAtomic, a network or credentials failure — is not
          // this one file's problem, so it propagates and aborts the run.
          if (!isObjectNotFound(error)) {
            throw error;
          }
          found = false;
        }
      }
      if (found) {
        writtenCanonical.add(realpathSync.native(step.dest));
        // Lossy below the millisecond, and not fixable here — don't try. `utimes`
        // takes seconds as a binary64 however it is spelled (a `Date` becomes
        // `getTime() / 1000`), and one ULP of that near a 2026 epoch is ~238ns, so
        // a stored `.674` lands as …674000024 where the filesystem keeps
        // nanoseconds. No arithmetic at this call site closes a gap smaller than
        // the representation, and `fs` exposes no nanosecond setter. NTFS hides it
        // (the error falls below its 100ns tick), which is why it went unseen until
        // clean-room run 2 compared `st_mtime_ns` on ext4. guide/format.md promises
        // the *millisecond* for exactly this reason.
        const when = new Date(/** @type {string} */ (step.mtime));
        await utimes(step.dest, when, when);
        restored.push(step.dest);
      } else {
        absentHashes.set(hash, await recordFor(hash));
        reportAbsent(hash, step.dest);
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

  // Unexplained absence or a name collision → exit 1, the same way `verify`
  // reports findings: set process.exitCode rather than throw, so the run's
  // report — including every file that *was* restored — still prints.
  // Deliberately-deleted skips alone leave exit 0 (ADR-0064): the record
  // proves the gap is intended, and a scripted restore should not alarm on a
  // decision its owner already made.
  if (missing.length || collided.length) {
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
    deleted,
  };
}
