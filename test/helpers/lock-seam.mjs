// The `locks.mjs` seam as a stencil, for the unit tests of the operations that
// run under a bucket lock (ADR-0112). The lock itself is unit-tested in
// lib/locks.test.mjs; here a hold is a passthrough that records what it was
// asked to hold and brackets the work with a "lock" and an "unlock" event, so a
// suite's own event list shows its PUTs and deletes running inside the hold.
// `unlock` is recorded in a `finally`, as the real hold removes its lock: a
// throw out of the work still ends the hold.
//
// One export per hold, each faking only its own, not one fake for both: a
// module that took the other hold must fail to link. Nothing else catches that
// swap — it typechecks (the upload hold's `command` is any string) and a shared
// passthrough would record the same args and events.
//
// It covers the two holds only, not the `unlock` command's
// `listLocks`/`removeLock`/`describeLock`, which no suite fakes — so it has no
// surface test like test/s3-seam.test.mjs. The `Pick`s below are its check: a
// hold whose signature drifts from production's fails `npm run typecheck`.

/**
 * @typedef {typeof import("../../src/lib/locks.mjs")} Locks
 * @typedef {Parameters<Locks["holdUploadLock"]>[0]} UploadLockArgs
 * @typedef {Parameters<Locks["holdDeleteLock"]>[0]} DeleteLockArgs
 */

/**
 * Where a hold reports to.
 * @template A
 * @typedef {object} Recorder
 * @property {(args: A) => void} held - Called with each hold's args
 * @property {(event: "lock" | "unlock") => void} event - Called entering and
 *   leaving the hold, for the suite's ordered event list
 */

/**
 * @template A
 * @param {Recorder<A>} record
 * @returns {<T>(args: A, work: () => Promise<T>) => Promise<T>}
 */
const passthrough =
  ({ held, event }) =>
  async (args, work) => {
    held(args);
    event("lock");
    try {
      return await work();
    } finally {
      event("unlock");
    }
  };

/**
 * `locks.mjs` for a module that takes the upload lock.
 * @param {Recorder<UploadLockArgs>} record
 * @returns {Pick<Locks, "holdUploadLock">}
 */
export const uploadLockSeam = (record) => ({
  holdUploadLock: passthrough(record),
});

/**
 * `locks.mjs` for a module that takes the delete lock.
 * @param {Recorder<DeleteLockArgs>} record
 * @returns {Pick<Locks, "holdDeleteLock">}
 */
export const deleteLockSeam = (record) => ({
  holdDeleteLock: passthrough(record),
});
