import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// Offline tests for `delete`: the S3 reads/writes (listRemoteSnapshots,
// deleteRemoteSnapshot), the set resolver (loadSet), and the prompt are faked at
// the lib seam, and the TTY gate is driven via process.stdin.isTTY — so the
// required-arg guards, the existence check, and the confirm/skip logic are locked
// down without a bucket or a terminal. The real delete is covered by
// test/integration/remote.test.mjs's gated round-trip. Mocks first, then a dynamic import.

/** @type {{ name: string, bucket: string }} */
let fakeSet = { name: "photos", bucket: "b1" };
/** @type {string[]} */
let remoteSnapshots = [];
/** @type {[string, string, string][]} */
let deleteCalls = [];
/** @type {boolean} */
let promptAnswer = false;
/** @type {number} */
let promptCalls = 0;

mock.module("../lib/env.mjs", {
  exports: { loadSet: () => fakeSet },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => remoteSnapshots,
    deleteRemoteSnapshot: async (
      /** @type {string} */ bucket,
      /** @type {string} */ set,
      /** @type {string} */ name,
    ) => {
      deleteCalls.push([bucket, set, name]);
    },
  },
});
mock.module("../lib/prompt.mjs", {
  exports: {
    promptYesNo: async () => {
      promptCalls++;
      return promptAnswer;
    },
  },
});

const { deleteSnapshot } = await import("./delete.mjs");

// isInteractive() reads .isTTY off the stream; poke it directly to drive the gate.
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);

/** @type {boolean | undefined} */
let savedTTY;
beforeEach(() => {
  savedTTY = stdin.isTTY;
  fakeSet = { name: "photos", bucket: "b1" };
  remoteSnapshots = ["2026-06-12T0915", "2026-06-11T0915"];
  deleteCalls = [];
  promptAnswer = false;
  promptCalls = 0;
});
afterEach(() => {
  stdin.isTTY = savedTTY;
});

describe("delete command", () => {
  it("requires --set", async () => {
    // The snapshot is the operand; the set is addressed by a flag (ADR-0062).
    await assert.rejects(
      () => deleteSnapshot(["2026-06-12T0915"], {}),
      /Missing required argument: --set/,
    );
  });

  it("requires a snapshot operand", async () => {
    await assert.rejects(
      () => deleteSnapshot([], { set: "photos" }),
      /Missing required argument: <snapshot>/,
    );
  });

  it("deletes several snapshots in one run, after a single prompt", async () => {
    // Snapshots are the bulk operand (ADR-0062): one run, one confirmation.
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await deleteSnapshot(
      ["2026-06-12T0915", "2026-06-11T0915"],
      { set: "photos" },
    );

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [
      ["b1", "photos", "2026-06-12T0915"],
      ["b1", "photos", "2026-06-11T0915"],
    ]);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["2026-06-12T0915", "2026-06-11T0915"],
      deleted: true,
    });
  });

  it("validates every name before deleting any, so a typo late in the list costs nothing", async () => {
    // The whole selection is checked up front: a bad third name must not leave
    // the first two already deleted (the deletions are not undoable).
    await assert.rejects(
      () =>
        deleteSnapshot(["2026-06-12T0915", "2099-01-01T0000"], {
          set: "photos",
        }),
      /Snapshot '2099-01-01T0000' is not backed up for set 'photos'/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("errors helpfully when the snapshot isn't backed up", async () => {
    await assert.rejects(
      () => deleteSnapshot(["2099-01-01T0000"], { set: "photos" }),
      /not backed up for set 'photos'[\s\S]*s3cab list photos --remote/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("deletes without prompting when non-interactive", async () => {
    stdin.isTTY = false;
    const result = await deleteSnapshot(["2026-06-12T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 0);
    assert.deepEqual(deleteCalls, [["b1", "photos", "2026-06-12T0915"]]);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["2026-06-12T0915"],
      deleted: true,
    });
  });

  it("deletes on a TTY when the user confirms", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await deleteSnapshot(["2026-06-12T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [["b1", "photos", "2026-06-12T0915"]]);
    assert.equal(result.deleted, true);
  });

  it("deletes nothing on a TTY when the user declines", async () => {
    stdin.isTTY = true;
    promptAnswer = false;
    const result = await deleteSnapshot(["2026-06-12T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, []);
    assert.equal(result.deleted, false);
  });
});
