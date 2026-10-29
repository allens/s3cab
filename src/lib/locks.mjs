import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isENOENT } from "./error.mjs";
import { countOf, elapsedSince, localMoment } from "./format.mjs";
import { deleteObject, getText, listObjects, putText } from "./s3.mjs";
import { infoFields } from "./set-marker.mjs";
import { shellCommand } from "./style.mjs";
import { userAtMachine } from "./user-at-machine.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// The locks that keep uploads and deletes apart, on any machine
// ([ADR-0112](../../docs/adr/0112-bucket-locks.md)): a `locks/<kind>-<instant>`
// object per running upload (`backup`, every `upload` form) or delete
// (`cleanup`, `delete`). Uploads don't exclude each other, and neither do
// deletes. The rule both sides follow is **write first, look second**: a run
// writes its own lock, *then* lists `locks/`, so two runs that start together
// each see the other's lock and at worst both refuse. A lock never expires —
// its age says nothing about whether its run is alive.
//
// The two guards here, `holdUploadLock` and `holdDeleteLock`, are taken inside
// the lib operations that decide what to skip or delete (upload.mjs,
// cleanup.mjs, delete.mjs), never by the commands that call them: a command
// cannot upload or delete without passing through one of those, so no command
// carries a "takes the lock" flag.
//
// An upload for a set also keeps a local file, the set's `.upload.lock`, for as
// long as its bucket lock exists: created atomically (the work file's `wx`,
// ADR-0048), holding the bucket lock's id and nothing else. A crashed run's
// lock must clear itself, but only a run that *knows* the lock is dead may
// remove it, and nothing in the bucket can know: the local file is how the
// set's next upload on this machine knows which lock was its own, and
// `--resume` is the user's word that nothing is running. A run that finished
// but could not remove its bucket lock renames the file to `.upload.unlock`,
// the removal it owes, which the next upload of the set pays before it starts.

const LOCKS_PREFIX = "locks/";

/** @typedef {"upload" | "delete"} LockKind */

/**
 * One lock as the bucket holds it: its id (the key without `locks/`) and the
 * `KEY=value` lines inside, read as `.info` is. The lines are for people and
 * messages — no rule matches on them, and a lock whose body is missing a line
 * is still a lock.
 * @typedef {Object} Lock
 * @property {string} id - `<kind>-<instant>`, e.g. `upload-20261027T140205.123Z`
 * @property {LockKind} kind
 * @property {string} command - What is running (`COMMAND`)
 * @property {string} [set] - The set it runs for (`SET`); absent for `upload --bucket` and every delete
 * @property {string} by - `user@machine` (`BY`)
 * @property {string} started - The key's instant in the extended form (`STARTED`)
 */

/**
 * The set an upload runs for, as far as the lock is concerned: its name for
 * the `SET` line and the two local files.
 * @typedef {Pick<BackupSet, "name" | "uploadLockPath" | "uploadUnlockPath">} LockedSet
 */

/**
 * @param {string} bucket
 * @param {string} id
 */
const lockUri = (bucket, id) => `s3://${bucket}/${LOCKS_PREFIX}${id}`;

/**
 * The id a lock taken now gets: the kind, then the instant in ISO 8601's basic
 * form (a colon in a key needs escaping when a request is signed). Spun until
 * the instant moves on from `after`, so a retry after a 412 never re-mints the
 * id that just lost.
 * @param {LockKind} kind
 * @param {string} [after] - The instant of the id someone else took
 * @returns {{ id: string, started: string }}
 */
function freshLockId(kind, after) {
  let { instant } = localMoment("seconds");
  while (instant === after) {
    ({ instant } = localMoment("seconds"));
  }
  const basic = instant.replaceAll("-", "").replaceAll(":", "");
  return { id: `${kind}-${basic}`, started: instant };
}

/**
 * @param {Omit<Lock, "id" | "kind">} lock
 * @returns {string}
 */
const formatLock = ({ command, set, by, started }) =>
  `COMMAND=${command}\n` +
  (set === undefined ? "" : `SET=${set}\n`) +
  `BY=${by}\nSTARTED=${started}\n`;

/**
 * @param {string} id
 * @param {string} text
 * @returns {Lock | undefined} `undefined` for a key under `locks/` that names neither kind
 */
function parseLock(id, text) {
  const kind = id.startsWith("upload-")
    ? "upload"
    : id.startsWith("delete-")
      ? "delete"
      : undefined;
  if (kind === undefined) {
    return undefined;
  }
  const fields = infoFields(text);
  return {
    id,
    kind,
    command: fields.COMMAND ?? "",
    set: fields.SET,
    by: fields.BY ?? "",
    started: fields.STARTED ?? "",
  };
}

/**
 * Write a lock of `kind` with a no-overwrite PUT and return it. A 412 is read
 * back: the same bytes are this run's own earlier write, retried after a lost
 * response, so the lock is ours; anything else means another run took that
 * instant, and a fresh one is tried. `beforePut` runs with each id before its
 * PUT — the local file records the id *before* the bucket has it, so a crash
 * at any point leaves the id behind.
 * @param {string} bucket
 * @param {{ kind: LockKind, command: string, set?: string }} args
 * @param {(id: string) => void} [beforePut]
 * @returns {Promise<Lock>}
 */
export async function writeLock(bucket, { kind, command, set }, beforePut) {
  const by = userAtMachine();
  /** @type {string | undefined} */
  let taken;
  for (;;) {
    const { id, started } = freshLockId(kind, taken);
    const body = formatLock({ command, set, by, started });
    beforePut?.(id);
    const wrote = await putText(lockUri(bucket, id), body, { noClobber: true });
    if (wrote) {
      return { id, kind, command, set, by, started };
    }
    const existing = await getText(lockUri(bucket, id));
    if (existing === body) {
      return { id, kind, command, set, by, started };
    }
    taken = started;
  }
}

/**
 * Every lock in the bucket, oldest first. One LIST and one GET each; a key
 * that vanished between the two was a lock that just ended, and is skipped.
 * @param {string} bucket
 * @returns {Promise<Lock[]>}
 */
export async function listLocks(bucket) {
  /** @type {string[]} */
  const ids = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${LOCKS_PREFIX}`)) {
    const id = Key?.slice(LOCKS_PREFIX.length);
    if (id) {
      ids.push(id);
    }
  }
  /** @type {Lock[]} */
  const locks = [];
  for (const id of ids.sort()) {
    const text = await getText(lockUri(bucket, id));
    if (text === undefined) {
      continue;
    }
    const lock = parseLock(id, text);
    if (lock) {
      locks.push(lock);
    }
  }
  return locks;
}

/**
 * Remove a lock by id. One already gone is not an error, which is what lets a
 * recorded id be cleared without looking first.
 * @param {string} bucket
 * @param {string} id
 * @returns {Promise<void>}
 */
export function removeLock(bucket, id) {
  return deleteObject(lockUri(bucket, id));
}

/**
 * A lock in plain words, for a refusal or `unlock`'s listing: what is running,
 * for which set, from which machine, since when, and the id to name it by.
 * @param {Lock} lock
 * @returns {string}
 */
export function describeLock(lock) {
  const { command, set, by, started } = lock;
  let since = started;
  try {
    since = `${started} (${elapsedSince(Temporal.Instant.from(started))} ago)`;
  } catch {
    // Not an instant: a hand-made lock. Shown as written.
  }
  return (
    `${command || "a run"}${set === undefined ? "" : ` of set '${set}'`}` +
    ` by ${by || "an unknown machine"}, started ${since}` +
    ` — ${lock.id}`
  );
}

/**
 * @param {Lock[]} locks
 * @returns {string}
 */
const lockLines = (locks) =>
  locks.map((lock) => `  ${describeLock(lock)}`).join("\n");

/**
 * The verb and the goal a refusal is framed by (ADR-0030), per command.
 * @param {string} command
 */
const goalOf = (command) =>
  ({
    backup: { cant: "back up", doing: "a backup" },
    upload: { cant: "upload", doing: "an upload" },
    cleanup: { cant: "clean up", doing: "cleaning up" },
    delete: { cant: "delete", doing: "deleting" },
  })[command] ?? { cant: command, doing: command };

/** @param {unknown} error */
const reason = (error) =>
  Error.isError(error) ? error.message : String(error);

/**
 * An upload refused because a delete is running (step 4 of ADR-0112's upload).
 * Nothing has been touched: the run's own lock was removed before this is
 * raised.
 * @param {string} bucket
 * @param {string} command
 * @param {Lock[]} deletes - The delete locks seen
 * @returns {Error}
 */
const deleteRunningError = (bucket, command, deletes) =>
  new Error(
    `Can't ${goalOf(command).cant} right now — a cleanup or delete is running ` +
      `on bucket '${bucket}', and ${goalOf(command).doing} while it runs could ` +
      `lose files:\n${lockLines(deletes)}\n\n` +
      `Try again once it has finished. If it was stopped without finishing ` +
      `and left its lock behind, remove the lock with:\n` +
      `  ${shellCommand(`s3cab unlock --bucket ${bucket}`)}`,
  );

/**
 * A delete refused because an upload is running (step 3 of ADR-0112's delete).
 * The run's own lock was removed before this is raised. Offers `--wait`,
 * which this error is the alternative to.
 * @param {string} bucket
 * @param {string} command
 * @param {Lock[]} uploads - The upload locks seen
 * @returns {Error}
 */
const uploadRunningError = (bucket, command, uploads) =>
  new Error(
    `Can't ${goalOf(command).cant} right now — a backup or upload is running ` +
      `on bucket '${bucket}', and ${goalOf(command).doing} while it runs ` +
      `could delete files it needs:\n${lockLines(uploads)}\n\n` +
      `Try again once it has finished, or let this run wait for it:\n` +
      `  ${shellCommand(
        command === "cleanup"
          ? `s3cab cleanup ${bucket} --wait`
          : `s3cab delete --bucket ${bucket} --wait <hash>...`,
      )}\n` +
      `If it was stopped without finishing and left its lock behind, remove ` +
      `the lock with:\n` +
      `  ${shellCommand(`s3cab unlock --bucket ${bucket}`)}`,
  );

/**
 * The run's work is done, but its lock is still in the bucket. Raised only
 * where no later run will clear it: a delete, or `upload --bucket`.
 * @param {string} bucket
 * @param {Lock} lock
 * @param {unknown} cause
 * @returns {Error}
 */
const lockLeftError = (bucket, lock, cause) =>
  new Error(
    `Finished, but couldn't remove this run's lock from bucket '${bucket}' ` +
      `(${reason(cause)}). Until it is removed, every ` +
      `${lock.kind === "upload" ? "cleanup and delete" : "backup and upload"} ` +
      `of this bucket is refused.\n\n` +
      `Remove it with:\n` +
      `  ${shellCommand(`s3cab unlock --bucket ${bucket} ${lock.id}`)}`,
    { cause },
  );

/**
 * The set's `.upload.lock` exists: an upload is live, or one was killed. Never
 * auto-broken — the user is the liveness check, as for the work file
 * (ADR-0048, ADR-0092).
 * @param {string} set
 * @param {string} lockPath
 * @returns {Error}
 */
const uploadInProgressError = (set, lockPath) =>
  new Error(
    `A backup or upload of set '${set}' is already running on this computer — ` +
      `or a previous one was interrupted and left its lock behind ` +
      `(${lockPath}).\n\n` +
      `If no backup or upload of this set is running now, run the same ` +
      `command again with --resume.`,
  );

/**
 * The id the file holds, or `undefined` for an empty one (a crash between the
 * create and the id's write).
 * @param {string} path
 * @returns {string | undefined}
 */
const readLockId = (path) => readFileSync(path, "utf8").trim() || undefined;

/**
 * Create the set's `.upload.lock` — `wx`, so the kernel refuses a second one
 * (ADR-0048). Under `resume` an existing file is taken over: the bucket lock
 * it names is removed first, since the user has said that run is dead.
 * @param {string} bucket
 * @param {LockedSet} set
 * @param {boolean} resume
 * @returns {Promise<void>}
 */
async function takeLocalLock(bucket, set, resume) {
  try {
    writeFileSync(set.uploadLockPath, "", { flag: "wx" });
    return;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
      throw error;
    }
  }
  if (!resume) {
    throw uploadInProgressError(set.name, set.uploadLockPath);
  }
  const dead = readLockId(set.uploadLockPath);
  if (dead) {
    await removeLock(bucket, dead);
  }
  writeFileSync(set.uploadLockPath, "");
}

/**
 * Pay the removal a finished upload left owed (`.upload.unlock`), once this
 * run holds `.upload.lock`. One that fails again is left for the next run,
 * said so, and the run goes on: its own lock is what it is here for.
 * @param {string} bucket
 * @param {LockedSet} set
 * @returns {Promise<void>}
 */
async function clearOwedUnlock(bucket, set) {
  /** @type {string | undefined} */
  let owed;
  try {
    owed = readLockId(set.uploadUnlockPath);
  } catch (error) {
    if (isENOENT(error)) {
      return;
    }
    throw error;
  }
  if (owed) {
    try {
      await removeLock(bucket, owed);
    } catch (error) {
      console.warn(
        `Couldn't remove the lock '${owed}' an earlier upload left in bucket ` +
          `'${bucket}' (${reason(error)}); the next backup or upload of set ` +
          `'${set.name}' will try again.`,
      );
      return;
    }
  }
  rmSync(set.uploadUnlockPath);
}

/**
 * Whether the file still holds this run's id. A user who deleted a live run's
 * file let a second upload start; without this check the first run's end would
 * remove or rename the second run's file, and the next upload would then
 * remove a live lock.
 * @param {string} path
 * @param {string} id
 */
function holdsOwnId(path, id) {
  try {
    return readLockId(path) === id;
  } catch {
    return false;
  }
}

/**
 * Run `work` as an upload under ADR-0112's rules: take the set's local lock
 * (for an upload with a set), write the upload lock **before anything that
 * decides what to skip**, list `locks/`, refuse on any delete lock, run, then
 * remove the lock — on any failure the run survives too. Only a hard stop
 * leaves it, and then `--resume` (for a set) or `unlock` clears it.
 *
 * Everything `work` sees in the bucket stays there until it ends, because no
 * delete can start meanwhile: that is what makes a baseline, a store LIST, a
 * `--since` skip-list or a conditional PUT's 412 safe to act on.
 * @template T
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.command - What is running, for the lock's `COMMAND` line and the messages
 * @param {LockedSet} [args.set] - The set the upload is for; absent for `upload --bucket`
 * @param {boolean} [args.resume] - The user's word that no upload of the set is running: take a leftover local lock over
 * @param {() => Promise<T>} work - The upload itself
 * @returns {Promise<T>}
 */
export async function holdUploadLock({ bucket, command, set, resume }, work) {
  if (set) {
    await takeLocalLock(bucket, set, Boolean(resume));
    await clearOwedUnlock(bucket, set);
  }
  /** @type {Lock} */
  let lock;
  try {
    lock = await writeLock(
      bucket,
      { kind: "upload", command, set: set?.name },
      (id) => {
        if (set) {
          writeFileSync(set.uploadLockPath, `${id}\n`);
        }
      },
    );
  } catch (error) {
    // The PUT failed from here, which is not the same as not landing: the
    // last id tried may be in the bucket. For a set the file already holds
    // it, so it becomes the removal the next upload pays.
    if (set) {
      if (readLockId(set.uploadLockPath)) {
        renameSync(set.uploadLockPath, set.uploadUnlockPath);
      } else {
        rmSync(set.uploadLockPath);
      }
    }
    throw error;
  }

  const releaseLocal = () => {
    if (set && holdsOwnId(set.uploadLockPath, lock.id)) {
      rmSync(set.uploadLockPath);
    }
  };

  /** @type {Lock[]} */
  let locks;
  try {
    locks = await listLocks(bucket);
  } catch (error) {
    await removeLock(bucket, lock.id);
    releaseLocal();
    throw error;
  }
  const deletes = locks.filter(({ kind }) => kind === "delete");
  if (deletes.length > 0) {
    await removeLock(bucket, lock.id);
    releaseLocal();
    throw deleteRunningError(bucket, command, deletes);
  }

  /** @type {T} */
  let result;
  try {
    result = await work();
  } catch (error) {
    try {
      await removeLock(bucket, lock.id);
      releaseLocal();
    } catch (removal) {
      leaveLock(bucket, lock, set, removal);
    }
    throw error;
  }
  try {
    await removeLock(bucket, lock.id);
  } catch (removal) {
    leaveLock(bucket, lock, set, removal);
    if (!set) {
      throw lockLeftError(bucket, lock, removal);
    }
    return result;
  }
  releaseLocal();
  return result;
}

/**
 * The bucket lock could not be removed. For a set, rename `.upload.lock` to
 * `.upload.unlock` so the next upload of the set pays it, and say so; with no
 * set there is nothing to leave it for, and the caller raises `lockLeftError`.
 * @param {string} bucket
 * @param {Lock} lock
 * @param {LockedSet | undefined} set
 * @param {unknown} cause
 */
function leaveLock(bucket, lock, set, cause) {
  if (!set) {
    return;
  }
  if (holdsOwnId(set.uploadLockPath, lock.id)) {
    renameSync(set.uploadLockPath, set.uploadUnlockPath);
  }
  console.warn(
    `Couldn't remove this run's lock from bucket '${bucket}' ` +
      `(${reason(cause)}). The next backup or upload of set '${set.name}' ` +
      `will remove it; until then every cleanup and delete of the bucket is ` +
      `refused. Or remove it now with:\n` +
      `  ${shellCommand(`s3cab unlock --bucket ${bucket} ${lock.id}`)}`,
  );
}

/** How long a `--wait` sleeps between looks at `locks/`. */
export const WAIT_MS = 30_000;

/**
 * Run `work` as a delete under ADR-0112's rules: write the delete lock, list
 * `locks/`, refuse on any upload lock (naming each), run, then remove the lock
 * — on any failure the run survives too. With `wait`, a refusal becomes a
 * wait: the lock is removed while waiting (holding it would turn away every
 * backup that starts meanwhile), the run says which locks it is waiting on,
 * sleeps {@link WAIT_MS}, and writes its lock again, without limit, saying so
 * again whenever the list changes.
 *
 * Deletes never exclude each other (ADR-0090 makes crossing safe), so other
 * delete locks are ignored.
 * @template T
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {"cleanup" | "delete"} args.command - What is running, for the lock's `COMMAND` line and the messages
 * @param {boolean} [args.wait] - Wait for running uploads instead of refusing
 * @param {() => Promise<T>} work - The deletes themselves
 * @returns {Promise<T>}
 */
export async function holdDeleteLock({ bucket, command, wait }, work) {
  /** @type {Lock} */
  let lock;
  /** @type {string | undefined} what the last wait message named */
  let waitingOn;
  for (;;) {
    lock = await writeLock(bucket, { kind: "delete", command });
    /** @type {Lock[]} */
    let locks;
    try {
      locks = await listLocks(bucket);
    } catch (error) {
      await removeLock(bucket, lock.id);
      throw error;
    }
    const uploads = locks.filter(({ kind }) => kind === "upload");
    if (uploads.length === 0) {
      break;
    }
    await removeLock(bucket, lock.id);
    if (!wait) {
      throw uploadRunningError(bucket, command, uploads);
    }
    const ids = uploads.map(({ id }) => id).join(" ");
    if (ids !== waitingOn) {
      waitingOn = ids;
      console.warn(
        `Waiting for ${countOf(uploads.length, "running upload")} to finish ` +
          `before ${goalOf(command).doing}:\n${lockLines(uploads)}`,
      );
    }
    await sleep(WAIT_MS);
  }

  /** @type {T} */
  let result;
  try {
    result = await work();
  } catch (error) {
    try {
      await removeLock(bucket, lock.id);
    } catch (removal) {
      console.warn(
        `Couldn't remove this run's lock '${lock.id}' from bucket '${bucket}' ` +
          `(${reason(removal)}). Remove it with:\n` +
          `  ${shellCommand(`s3cab unlock --bucket ${bucket} ${lock.id}`)}`,
      );
    }
    throw error;
  }
  try {
    await removeLock(bucket, lock.id);
  } catch (removal) {
    throw lockLeftError(bucket, lock, removal);
  }
  return result;
}
