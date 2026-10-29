import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getText } from "../../src/lib/s3.mjs";
import {
  describeLock,
  listLocks,
  removeLock,
  writeLock,
} from "../../src/lib/locks.mjs";
import { bucket } from "../helpers/integration.mjs";

// A lock's round trip through a real bucket (ADR-0112): the no-overwrite PUT,
// the body as `.info` is read, the LIST + GET listing, the idempotent DELETE.
// The interplay — an upload lock turning a cleanup away, `--wait`, `unlock` —
// is the crash tier's (test/crash/concurrency.test.mjs), on its sole-owner
// bucket: this one is shared, and a delete lock planted here would turn away
// every upload another file is running at the same moment.

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
        `COMMAND=backup\nSET=${lock.set}\nBY=${lock.by}\nSTARTED=${lock.started}\n`,
      );

      const listed = (await listLocks(bucket)).find(({ id }) => id === lock.id);
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

    assert.equal(
      (await listLocks(bucket)).some(({ id }) => id === lock.id),
      false,
      "removed",
    );
    await removeLock(bucket, lock.id); // already gone: not an error
  });
});
