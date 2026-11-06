import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";

/** @import { FileHandle } from "node:fs/promises" */
/** @import { StatOptions } from "node:fs" */

// withSnapshotFile when the ownership check itself can't run: the handle's
// `fstat` fails, or the `stat` by name fails with something other than ENOENT
// (a flaky disk, a network home share dropping mid-call). Neither is a
// takeover, and both used to leave the lock behind — the next run refused with
// `inProgressError` for a file holding nothing. Its own file, and a dotted
// aspect name (ADR-0049), because making those calls fail means mocking
// `node:fs/promises` before `snapshot-file.mjs` is loaded.

/** @param {string} code */
const fault = (code) =>
  Object.assign(new Error(`${code}: input/output error`), { code });

/** The lock path whose `stat` by name fails, if any. */
/** @type {string | undefined} */
let statFailsFor;
/** Whether the next `open` returns a handle whose `stat` fails. */
let handleStatFails = false;

// Everything else passes through, bar `constants`, which is non-configurable.
mock.module("node:fs/promises", {
  exports: {
    ...Object.fromEntries(
      Object.entries(realFsPromises).filter(([name]) => name !== "constants"),
    ),
    /**
     * @param {string} path
     * @param {StatOptions} [options]
     */
    stat: (path, options) => {
      if (path === statFailsFor) {
        return Promise.reject(fault("EIO"));
      }
      return realFsPromises.stat(path, options);
    },
    /** @type {typeof realFsPromises.open} */
    open: async (...args) => {
      const handle = await realFsPromises.open(...args);
      if (!handleStatFails) {
        return handle;
      }
      // Only what the failure path touches: the failing `stat`, then `close`.
      return /** @type {FileHandle} */ (
        /** @type {unknown} */ ({
          stat: () => Promise.reject(fault("EIO")),
          close: () => handle.close(),
        })
      );
    },
  },
});

const { withSnapshotFile } = await import("./snapshot-file.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const lockPath = (/** @type {string} */ dir) =>
  resolve(dir, ".snapshot.tsv.gz");

beforeEach(() => {
  statFailsFor = undefined;
  handleStatFails = false;
});

describe("withSnapshotFile when the ownership check can't run", () => {
  it("throws the stat's own failure, not a takeover, and still releases the lock", async () => {
    await using dir = await mkTmpDir();
    statFailsFor = lockPath(dir.path);

    await assert.rejects(
      withSnapshotFile(dir.path, "20260623T1000", async (s) => {
        s.end("x");
      }),
      (/** @type {NodeJS.ErrnoException} */ error) => {
        assert.equal(error.code, "EIO");
        assert.doesNotMatch(error.message, /took its work file/);
        return true;
      },
    );
    assert.ok(
      !existsSync(lockPath(dir.path)),
      "a check that can't run must not leave the lock for the next run",
    );
    assert.ok(!existsSync(resolve(dir.path, "20260623T1000.tsv.gz")));
  });

  it("releases the lock when the handle's own stat fails, so the next run succeeds", async () => {
    await using dir = await mkTmpDir();
    handleStatFails = true;

    await assert.rejects(
      withSnapshotFile(dir.path, "20260623T1000", async () => {}),
      (/** @type {NodeJS.ErrnoException} */ error) => error.code === "EIO",
    );
    assert.ok(
      !existsSync(lockPath(dir.path)),
      "a failure before anything is written must release the lock",
    );

    handleStatFails = false;
    const path = await withSnapshotFile(
      dir.path,
      "20260623T1000",
      async (s) => {
        s.end("x");
      },
    );
    assert.match(path, /20260623T1000\.tsv\.gz$/);
  });
});
