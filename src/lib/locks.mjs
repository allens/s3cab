import { readlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { countOf, elapsedSince, localMoment } from "./format.mjs";
import { deleteObject, getText, listObjects, putText } from "./s3.mjs";
import { infoFields } from "./set-marker.mjs";
import { shellCommand } from "./style.mjs";
import { userAtMachine } from "./user-at-machine.mjs";

// The locks that keep uploads and deletes apart, on any machine
// ([ADR-0112](../../docs/adr/0112-bucket-locks.md)): a `locks/<kind>-<instant>`
// object per running upload (`backup`, every `upload` form) or delete
// (`cleanup`, `delete`). Uploads don't exclude each other, and neither do
// deletes. The rule both sides follow is **write first, look second**: a run
// writes its own lock, *then* lists `locks/`, so two runs that start together
// each see the other's lock and at worst both refuse.
//
// A lock never expires — its age says nothing about whether its run is alive.
// What does say so is the process: the body names the machine, the process
// table and the pid, and a run removes any lock from its own machine and
// process table whose process is gone. Every other leftover is `unlock`'s, a
// person's word.
//
// The two guards here, `holdUploadLock` and `holdDeleteLock`, are taken inside
// the lib operations that decide what to skip or delete (upload.mjs,
// cleanup.mjs, delete.mjs), never by the commands that call them: a command
// cannot upload or delete without passing through one of those, so no command
// carries a "takes the lock" flag.

const LOCKS_PREFIX = "locks/";

/** @typedef {"upload" | "delete"} LockKind */

/**
 * One lock as the bucket holds it: its id (the key without `locks/`) and the
 * `KEY=value` lines inside, read as `.info` is. The lines are for people and
 * messages — no rule matches on them, and a lock whose body is missing a line
 * is still a lock — except `BY`, `OS`, `PIDNS` and `PID` together, which say
 * whose process holds it.
 * @typedef {Object} Lock
 * @property {string} id - `<kind>-<instant>`, e.g. `upload-20261027T140205.123Z`
 * @property {LockKind} kind
 * @property {string} command - What is running (`COMMAND`)
 * @property {string} [set] - The set it runs for (`SET`); absent for `upload --bucket` and every delete
 * @property {string} by - `user@machine` (`BY`)
 * @property {string} [os] - The OS whose process table `pid` is in (`OS`, `process.platform`); absent in a hand-made lock
 * @property {string} [pidns] - On Linux, which of the machine's process tables (`PIDNS`, {@link pidNamespace}); absent elsewhere
 * @property {number} [pid] - The process holding it (`PID`); absent in a hand-made lock
 * @property {string} started - The key's instant in the extended form (`STARTED`)
 */

/**
 * @param {string} bucket
 * @param {string} id
 */
const lockUri = (bucket, id) => `s3://${bucket}/${LOCKS_PREFIX}${id}`;

/**
 * The id a lock taken now gets: the kind, then the instant in ISO 8601's basic
 * form (a colon in a key needs escaping when a request is signed).
 * @param {LockKind} kind
 * @returns {{ id: string, started: string }}
 */
function freshLockId(kind) {
  const { instant } = localMoment("seconds");
  const basic = instant.replaceAll("-", "").replaceAll(":", "");
  return { id: `${kind}-${basic}`, started: instant };
}

/**
 * This process's pid namespace on Linux, the target of `/proc/self/ns/pid`
 * (`pid:[4026531836]`); `undefined` elsewhere. Each WSL distro and each
 * container has a process table of its own under the one hostname, and this
 * is what tells them apart. A Linux with no such link (a kernel without pid
 * namespaces, a chroot without `/proc`) has one process table, so `undefined`
 * there too: throwing would stop every upload and delete.
 * @returns {string | undefined}
 */
function pidNamespace() {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}

/**
 * @param {Omit<Lock, "id" | "kind" | "os" | "pid"> & { os: string, pid: number }} lock
 * @returns {string}
 */
const formatLock = ({ command, set, by, os, pidns, pid, started }) =>
  `COMMAND=${command}\n` +
  (set === undefined ? "" : `SET=${set}\n`) +
  `BY=${by}\n` +
  `OS=${os}\n` +
  (pidns === undefined ? "" : `PIDNS=${pidns}\n`) +
  `PID=${pid}\n` +
  `STARTED=${started}\n`;

/**
 * @param {string} id
 * @returns {LockKind | undefined} `undefined` for a key under `locks/` that names neither kind
 */
const kindOf = (id) =>
  id.startsWith("upload-")
    ? "upload"
    : id.startsWith("delete-")
      ? "delete"
      : undefined;

/**
 * @param {string} id
 * @param {LockKind} kind
 * @param {string} text
 * @returns {Lock}
 */
function parseLock(id, kind, text) {
  const fields = infoFields(text);
  const pid = Number(fields.PID);
  return {
    id,
    kind,
    command: fields.COMMAND ?? "",
    set: fields.SET,
    by: fields.BY ?? "",
    os: fields.OS,
    pidns: fields.PIDNS,
    pid: fields.PID && Number.isInteger(pid) ? pid : undefined,
    started: fields.STARTED ?? "",
  };
}

/**
 * Write a lock of `kind` with a no-overwrite PUT and return it. A 412 is read
 * back: the same bytes are this run's own earlier write, retried after a lost
 * response, so the lock is ours; anything else means another run took that
 * instant, and a fresh one is tried a millisecond on. The pid in the body is
 * what tells two runs of one command on one machine apart.
 * @param {string} bucket
 * @param {{ kind: LockKind, command: string, set?: string }} args
 * @returns {Promise<Lock>}
 */
export async function writeLock(bucket, { kind, command, set }) {
  const by = userAtMachine();
  const os = process.platform;
  const pidns = pidNamespace();
  const pid = process.pid;
  for (;;) {
    const { id, started } = freshLockId(kind);
    const body = formatLock({ command, set, by, os, pidns, pid, started });
    const wrote = await putText(lockUri(bucket, id), body, { noClobber: true });
    if (wrote) {
      return { id, kind, command, set, by, os, pidns, pid, started };
    }
    const existing = await getText(lockUri(bucket, id));
    if (existing === body) {
      return { id, kind, command, set, by, os, pidns, pid, started };
    }
    await sleep(1);
  }
}

/**
 * Every lock in the bucket, oldest first. One LIST, then the GETs at once; a
 * key that vanished between the two was a lock that just ended, and is skipped.
 * @param {string} bucket
 * @returns {Promise<Lock[]>}
 */
export async function listLocks(bucket) {
  /** @type {{ id: string, kind: LockKind }[]} */
  const keys = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${LOCKS_PREFIX}`)) {
    const id = Key?.slice(LOCKS_PREFIX.length) ?? "";
    const kind = kindOf(id);
    if (kind) {
      keys.push({ id, kind });
    }
  }
  // By the instant, not the whole id: the kind comes first in the id, and
  // would put every delete before every upload.
  const instantOf = (/** @type {string} */ id) => id.slice(id.indexOf("-") + 1);
  keys.sort((a, b) => instantOf(a.id).localeCompare(instantOf(b.id)));
  const texts = await Promise.all(
    keys.map(({ id }) => getText(lockUri(bucket, id))),
  );
  /** @type {Lock[]} */
  const locks = [];
  for (const [i, text] of texts.entries()) {
    const { id, kind } = /** @type {{ id: string, kind: LockKind }} */ (
      keys[i]
    );
    if (text !== undefined) {
      locks.push(parseLock(id, kind, text));
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
 * for which set, from which machine and system, since when, and the id to name
 * it by. The system (`OS`, `PIDNS`) is what tells a Windows lock from a WSL one
 * under the same `user@machine`, before a person removes either.
 * @param {Lock} lock
 * @returns {string}
 */
export function describeLock(lock) {
  const { command, set, by, os, pidns, pid, started } = lock;
  const system = [os, pidns, pid === undefined ? undefined : `pid ${pid}`]
    .filter(Boolean)
    .join(", ");
  let since = started;
  try {
    since = `${started} (${elapsedSince(Temporal.Instant.from(started))} ago)`;
  } catch {
    // Not an instant: a hand-made lock. Shown as written.
  }
  return (
    `${command || "a run"}${set === undefined ? "" : ` of set '${set}'`}` +
    ` by ${by || "an unknown machine"}` +
    `${system ? ` (${system})` : ""}, started ${since}` +
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
 * which this error is the alternative to — as "the same command again", since
 * the user's other options (`--force`, the hashes) aren't known here.
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
      `Try again once it has finished, or run the same command again with ` +
      `--wait to let this run wait for it.\n` +
      `If it was stopped without finishing and left its lock behind, remove ` +
      `the lock with:\n` +
      `  ${shellCommand(`s3cab unlock --bucket ${bucket}`)}`,
  );

/**
 * Whether a process of this machine is still running. `ESRCH` is the one
 * answer that means gone; `EPERM` (another user's process) means alive.
 * @param {number} pid
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH";
  }
}

/**
 * The locks whose runs are alive: every lock in the bucket, minus the ones
 * from this machine and process table whose process is gone, which are
 * removed on the way, each said so. Another machine's lock is always taken as
 * alive — `user@machine` is the identity, so two machines with one name and
 * user would judge each other's locks (ADR-0112's accepted gap). The OS and
 * pid namespace are part of the match because WSL, each of its distros and
 * each container report the host's name, often its user, with a process table
 * of their own. A reused pid reads as alive, which errs toward keeping a lock,
 * never removing a live one.
 * @param {string} bucket
 * @returns {Promise<Lock[]>}
 */
async function liveLocks(bucket) {
  const here = userAtMachine();
  const pidns = pidNamespace();
  const locks = await listLocks(bucket);
  /** @type {Lock[]} */
  const live = [];
  for (const lock of locks) {
    const mine =
      lock.by === here && lock.os === process.platform && lock.pidns === pidns;
    if (mine && lock.pid !== undefined && !processAlive(lock.pid)) {
      await removeLock(bucket, lock.id);
      console.warn(
        `Removed the lock a stopped run left in bucket '${bucket}': ` +
          describeLock(lock),
      );
      continue;
    }
    live.push(lock);
  }
  return live;
}

/**
 * Run `fn` with `lock` held, and remove the lock however `fn` ends. A removal
 * that fails is said, with the `unlock` command, and doesn't fail the run.
 *
 * Not an interrupt handler that removes the lock on Ctrl+C: `fn`'s requests
 * may still be in flight, and a run on another machine could start under
 * them. A Ctrl+C leaves the lock, as a crash does, for the next run on this
 * system (machine, OS and pid namespace) to remove once the process is gone. (During the snapshot write,
 * Ctrl+C parks the work file and ends `fn` cleanly, so the lock goes here.)
 * @template T
 * @param {string} bucket
 * @param {Lock} lock
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function hold(bucket, lock, fn) {
  try {
    return await fn();
  } finally {
    try {
      await removeLock(bucket, lock.id);
    } catch (removal) {
      console.warn(lockLeft(bucket, lock, removal));
    }
  }
}

/**
 * The run's lock could not be removed.
 * @param {string} bucket
 * @param {Lock} lock
 * @param {unknown} cause
 */
const lockLeft = (bucket, lock, cause) =>
  `Couldn't remove this run's lock from bucket '${bucket}' ` +
  `(${reason(cause)}). Until it goes, every ` +
  `${lock.kind === "upload" ? "cleanup and delete" : "backup and upload"} ` +
  `of the bucket is refused. The next backup, upload, cleanup or delete ` +
  `on this same system should remove it, once it can tell this run has ` +
  `stopped; to remove it yourself:\n` +
  `  ${shellCommand(`s3cab unlock --bucket ${bucket} ${lock.id}`)}`;

/**
 * Run `work` as an upload under ADR-0112's rules: write the upload lock
 * **before anything that decides what to skip**, list `locks/`, refuse on any
 * live delete lock, run, then remove the lock — on any failure the run
 * survives too.
 *
 * Everything `work` sees in the bucket stays there until it ends, because no
 * delete can start meanwhile: that is what makes a baseline, a store LIST, a
 * `--since` skip-list or a conditional PUT's 412 safe to act on.
 * @template T
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.command - What is running, for the lock's `COMMAND` line and the messages
 * @param {string} [args.set] - The set the upload is for; absent for `upload --bucket`
 * @param {() => Promise<T>} work - The upload itself
 * @returns {Promise<T>}
 */
export async function holdUploadLock({ bucket, command, set }, work) {
  const lock = await writeLock(bucket, { kind: "upload", command, set });
  return hold(bucket, lock, async () => {
    const live = await liveLocks(bucket);
    const deletes = live.filter(({ kind }) => kind === "delete");
    if (deletes.length > 0) {
      throw deleteRunningError(bucket, command, deletes);
    }
    return work();
  });
}

/** How long a `--wait` sleeps between looks at `locks/`. */
export const WAIT_MS = 30_000;

/**
 * Run `work` as a delete under ADR-0112's rules: write the delete lock, list
 * `locks/`, refuse on any live upload lock (naming each), run, then remove the
 * lock — on any failure the run survives too. With
 * `wait`, a refusal becomes a wait: the lock is removed while waiting
 * (holding it would turn away every backup that starts meanwhile), the run
 * says which locks it is waiting on, sleeps {@link WAIT_MS}, and writes its
 * lock again, without limit, saying so again whenever the list changes.
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
  /** @type {string | undefined} what the last wait message named */
  let waitingOn;
  for (;;) {
    const lock = await writeLock(bucket, { kind: "delete", command });
    /** @type {{ value: T } | { uploads: Lock[] }} */
    const outcome = await hold(bucket, lock, async () => {
      const live = await liveLocks(bucket);
      const uploads = live.filter(({ kind }) => kind === "upload");
      if (uploads.length > 0) {
        return { uploads };
      }
      return { value: await work() };
    });
    if ("value" in outcome) {
      return outcome.value;
    }
    if (!wait) {
      throw uploadRunningError(bucket, command, outcome.uploads);
    }
    const ids = outcome.uploads.map(({ id }) => id).join(" ");
    if (ids !== waitingOn) {
      waitingOn = ids;
      console.warn(
        `Waiting for ${countOf(outcome.uploads.length, "running upload")} to ` +
          `finish before ${goalOf(command).doing}:\n${lockLines(outcome.uploads)}`,
      );
    }
    await sleep(WAIT_MS);
  }
}
