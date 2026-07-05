import { existsSync, mkdirSync } from "node:fs";
import { copyFile, utimes } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { stderr } from "node:process";
import { loadSet } from "../lib/env.mjs";
import { requireArg } from "../lib/error.mjs";
import { createProgress } from "../lib/progress.mjs";
import { getObject } from "../lib/objects.mjs";
import { listRemoteSnapshots, readRemoteSnapshot } from "../lib/remote.mjs";
import { planRestore, reroot, selectEntries } from "../lib/restore.mjs";

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
 * or duplicated files) is downloaded once and copied to the rest. The snapshot-
 * last upload invariant guarantees every referenced object exists, so there is
 * no pre-flight; a genuinely missing object surfaces as a failed download.
 *
 * `--output <dir>` re-roots instead of restoring to original locations: each
 * member directory's contents land under `<dir>/<root-basename>/…` (see `reroot`).
 * That recovers a backup whose absolute paths don't fit this machine — a
 * different drive layout, or another OS entirely — and is the only mode that
 * accepts non-absolute-on-this-platform paths.
 *
 * The set must have an existing remote backup. Unlike the everyday commands,
 * `<set>` is required — no sole-set default (ADR-0040): restore is the rare,
 * carefully considered command, and requiring the name removes the set-or-path
 * ambiguity a leading optional positional would create.
 *
 * @typedef {Object} RestoreResult
 * @property {string} set - The set restored
 * @property {string} snapshot - The snapshot restored from
 * @property {string[]} restored - Paths written
 * @property {string[]} skipped - Existing paths left untouched (rerun with --overwrite to replace)
 *
 * @param {string} [setName] - Backup set to restore (required)
 * @param {string[]} [paths] - Positional path filters (empty = restore everything)
 * @param {{ snapshot?: string, overwrite?: boolean, output?: string, debug?: boolean }} [options]
 * @returns {Promise<RestoreResult>}
 */
export async function restore(setName, paths = [], options = {}) {
  requireArg(setName, "set");
  const set = loadSet(setName);

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
        `Snapshot '${name}' has ${notAbsolute.length} path(s) that aren't absolute ` +
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

  // On a terminal the counter overwrites itself in place; redirected, each
  // update is its own plain line (`logLines`) — the TTY gate, the in-place
  // redraw, and the closing newline (drawn only when there was one, even if a
  // download throws mid-loop) all live in lib/progress.mjs. `using` runs that
  // teardown on any scope exit, so an error mid-loop still leaves the cursor on
  // a fresh line before its message prints.
  using progress = createProgress(stderr, { logLines: true });
  let done = 0;
  for (const step of plan) {
    if (step.action === "skip") {
      skipped.push(step.dest);
    } else {
      mkdirSync(dirname(step.dest), { recursive: true });
      if (step.action === "copy") {
        await copyFile(/** @type {string} */ (step.from), step.dest);
      } else {
        await getObject(
          set.bucket,
          /** @type {string} */ (step.hash),
          step.dest,
        );
      }
      const when = new Date(/** @type {string} */ (step.mtime));
      await utimes(step.dest, when, when);
      restored.push(step.dest);
    }

    done++;
    if (done % 50 === 0 || done === plan.length) {
      progress.update(`Restoring ${done}/${plan.length}...`);
    }
  }

  return { set: set.name, snapshot: name, restored, skipped };
}
