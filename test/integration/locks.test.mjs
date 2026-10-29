import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unlock } from "../../src/commands/unlock.mjs";
import { getText } from "../../src/lib/s3.mjs";
import {
  describeLock,
  listLocks,
  removeLock,
  writeLock,
} from "../../src/lib/locks.mjs";
import { bucket } from "../helpers/integration.mjs";

// A lock's round trip through a real bucket (ADR-0112): the no-overwrite PUT,
// the body as `.info` is read, the LIST + GET listing, the idempotent DELETE,
// and `unlock` removing one by id. The interplay — an upload lock turning a
// cleanup away, `--wait`, the sweep of a dead run's lock — is the crash
// tier's (test/crash/concurrency.test.mjs), on its sole-owner bucket: this
// one is shared, and a delete lock planted here would turn away every upload
// another file is running at the same moment.

describe("locks (real bucket)", () => {
  it("writes, lists, describes and removes a lock", async () => {
    const lock = await writeLock(bucket, {
      kind: "upload",
      command: "backup",
      set: `locks-${Date.now()}`,
    });
    try {
      assert.match(lock.id, /^upload-\d{8}T\d{6}\.\d{3}Z$/);
      assert.equal(
        await getText(`s3://${bucket}/locks/${lock.id}`),
        `COMMAND=backup\nSET=${lock.set}\nBY=${lock.by}\nOS=${process.platform}\nPID=${process.pid}\nSTARTED=${lock.started}\n`,
      );

      const locks = await listLocks(bucket);
      const listed = locks.find(({ id }) => id === lock.id);
      assert.deepEqual(listed, lock, "the listing reads back what was written");
      assert.match(
        describeLock(/** @type {typeof lock} */ (listed)),
        new RegExp(
          `^backup of set '${lock.set}' by .+, started .+ — ${lock.id}$`,
        ),
      );
    } finally {
      await removeLock(bucket, lock.id);
    }

    const after = await listLocks(bucket);
    assert.equal(
      after.some(({ id }) => id === lock.id),
      false,
      "removed",
    );
    await removeLock(bucket, lock.id); // already gone: not an error
  });

  it("unlock removes the lock it is given by id", async () => {
    const lock = await writeLock(bucket, {
      kind: "upload",
      command: "upload",
      set: `locks-${Date.now()}`,
    });
    try {
      const result = await unlock([lock.id], { bucket, force: true });

      assert.equal(result.removed, true);
      assert.deepEqual(
        result.locks.map(({ id }) => id),
        [lock.id],
        "exactly the lock named, whatever else the shared bucket holds",
      );
      const after = await listLocks(bucket);
      assert.equal(
        after.some(({ id }) => id === lock.id),
        false,
      );
    } finally {
      await removeLock(bucket, lock.id);
    }
  });
});
