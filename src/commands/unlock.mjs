import { requireArg } from "../lib/error.mjs";
import { countOf } from "../lib/format.mjs";
import { describeLock, listLocks, removeLock } from "../lib/locks.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { validateBucketName } from "../lib/sets.mjs";
import { isInteractive, shellCommand } from "../lib/style.mjs";

/** @import { Lock } from "../lib/locks.mjs" */

/**
 * Remove locks a stopped run left in the bucket
 * ([ADR-0112](../../docs/adr/0112-bucket-locks.md)). A lock never expires —
 * its age says nothing about whether its run is alive. A run clears for
 * itself any lock from its own system (machine, OS and pid namespace) whose
 * process is gone; a leftover from any other system is this command's, where
 * a person says it is dead.
 *
 * It lists every lock in plain words (what is running, for which set, from
 * which machine and system, since when), warns what removing a live one does, and asks
 * y/N. It removes **exactly the locks it showed**, never one written after:
 * the listing is the thing confirmed. Ids narrow the listing to the locks
 * named. Without a terminal it needs `--force` and ids; `--force` always
 * needs ids, so nothing can remove a lock nobody looked at. An id that names
 * no lock is reported, the others are still removed, and the run exits 1.
 *
 * @typedef {Object} UnlockResult
 * @property {string} bucket - The repository bucket
 * @property {Lock[]} locks - The locks listed (all of them, or the ones the ids named)
 * @property {string[]} unknown - Ids that named no lock
 * @property {boolean} removed - Whether `locks` were removed (false on a dry run or a declined confirmation)
 *
 * @param {string[]} [ids] - Lock ids to remove, as a refusal or the listing prints them; none lists every lock
 * @param {{ bucket?: string, "dry-run"?: boolean, force?: boolean }} [options]
 * @returns {Promise<UnlockResult>}
 */
export async function unlock(ids = [], options = {}) {
  requireArg(options.bucket, "bucket");
  const bucket = /** @type {string} */ (options.bucket);
  validateBucketName(bucket);
  const dryRun = Boolean(options["dry-run"]);
  const force = Boolean(options.force);

  // The gates, before any S3 traffic. `--force` with no ids would remove
  // whatever happens to be there, unseen; a dry run removes nothing.
  if (force && !dryRun && ids.length === 0) {
    throw new Error(
      `--force removes locks without showing them first, so it needs their ` +
        `ids.\n\n` +
        `List the locks, and remove the ones you choose:\n` +
        `  ${shellCommand(`s3cab unlock --bucket ${bucket}`)}`,
    );
  }
  if (!dryRun && !force && !isInteractive(process.stdin)) {
    throw new Error(
      `Removing a lock needs a confirmation, and there is no terminal to ask ` +
        `on.\n\n` +
        `List the locks:\n` +
        `  ${shellCommand(`s3cab unlock --bucket ${bucket} --dry-run`)}\n\n` +
        `Or name the ones to remove and skip the prompt:\n` +
        `  ${shellCommand(`s3cab unlock --bucket ${bucket} --force <id>...`)}`,
    );
  }

  const all = await listLocks(bucket);
  const wanted = new Set(ids);
  const locks = ids.length === 0 ? all : all.filter(({ id }) => wanted.has(id));
  const known = new Set(locks.map(({ id }) => id));
  const unknown = ids.filter((id) => !known.has(id));
  const result = { bucket, locks, unknown, removed: false };

  if (unknown.length > 0) {
    console.warn(
      `No lock named ${unknown.length === 1 ? "this" : "these"} in bucket ` +
        `'${bucket}' — already removed, or mistyped:\n` +
        unknown.map((id) => `  ${id}`).join("\n"),
    );
    process.exitCode = 1;
  }

  if (locks.length === 0) {
    console.warn(
      ids.length === 0
        ? `No locks in bucket '${bucket}' — nothing is running, and nothing ` +
            `was left behind.`
        : `Nothing to remove.`,
    );
    return result;
  }

  // Pre-decision output goes to stdout here rather than through `render`
  // (ADR-0043), which only runs after the command returns — past the point of
  // no return. What a dry run shows is this same listing.
  console.log(
    `${countOf(locks.length, "lock")} in bucket '${bucket}':\n` +
      locks.map((lock) => `  ${describeLock(lock)}`).join("\n"),
  );

  if (dryRun) {
    console.warn(`Dry run — nothing removed.`);
    return result;
  }

  if (!force && isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `\nA lock whose command is still running keeps a cleanup or delete ` +
        `from removing what that backup needs — or a backup from storing ` +
        `what that cleanup is removing. Remove one only when you know its ` +
        `command has stopped.\n` +
        `Remove ${locks.length === 1 ? "this lock" : `these ${locks.length} locks`}?`,
    );
    if (!ok) {
      console.warn("Cancelled — nothing was removed.");
      return result;
    }
  }

  for (const { id } of locks) {
    await removeLock(bucket, id);
  }
  return { ...result, removed: true };
}
