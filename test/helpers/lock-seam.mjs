// The `locks.mjs` seam as a stencil, for the unit tests of the operations that
// run under a bucket lock (ADR-0112). The lock itself is unit-tested in
// lib/locks.test.mjs; here each hold is a passthrough that records what it was
// asked to hold and brackets the work with a "lock" and an "unlock" event, so a
// suite's own event list shows the PUTs and deletes running inside the hold.
// `unlock` is recorded in a `finally`, as the real hold removes its lock: a
// throw out of the work still ends the hold.

/**
 * The seam's surface: the two holds, typed from the real module so a fake
 * whose signature drifts from production's fails `npm run typecheck`. Not the
 * module's whole export list — `unlock` reads and removes locks through
 * `listLocks`/`removeLock`/`describeLock`, which no suite fakes.
 * @typedef {Pick<
 *   typeof import("../../src/lib/locks.mjs"),
 *   "holdUploadLock" | "holdDeleteLock"
 * >} LockSeam
 */

/**
 * What either hold was asked to hold.
 * @typedef {Parameters<LockSeam["holdUploadLock"]>[0]
 *   | Parameters<LockSeam["holdDeleteLock"]>[0]} LockArgs
 */

/**
 * Both holds as passthroughs that report to the suite.
 * @param {object} record
 * @param {(args: LockArgs) => void} record.held - Called with each hold's args
 * @param {(event: "lock" | "unlock") => void} record.event - Called entering and
 *   leaving the hold, for the suite's ordered event list
 * @returns {LockSeam}
 */
export function lockSeam({ held, event }) {
  /**
   * @template T
   * @param {LockArgs} args
   * @param {() => Promise<T>} work
   */
  const hold = async (args, work) => {
    held(args);
    event("lock");
    try {
      return await work();
    } finally {
      event("unlock");
    }
  };
  return { holdUploadLock: hold, holdDeleteLock: hold };
}
