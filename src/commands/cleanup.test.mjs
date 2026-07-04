import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// Offline tests for `cleanup`: the S3 reads/writes (referencedObjects,
// listStoredObjects, deleteStoredObject, writeObjectsCache) and the prompt are
// faked at the lib seam; the object ages are staged as Dates so the 7-day grace
// window is exercised without waiting. verifySet (the reused damage diff) runs
// for real — it's pure. Mocks first, then a dynamic import.

/** @type {Map<string, import("../lib/verify.mjs").ReferencedResult>} */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number, lastModified?: Date }[]} */
let storedObjects = [];
/** @type {string[]} */
let deleteCalls = [];
/** @type {string[][]} */
let cacheWrites = [];
let promptAnswer = false;
let promptCalls = 0;

mock.module("../lib/remote.mjs", {
  exports: { referencedObjects: async () => referencedBySet },
});
mock.module("../lib/objects.mjs", {
  exports: {
    listStoredObjects: async function* () {
      for (const object of storedObjects) {
        yield object;
      }
    },
    deleteStoredObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
    ) => {
      deleteCalls.push(hash);
    },
    writeObjectsCache: async (
      /** @type {string} */ _bucket,
      /** @type {Iterable<string>} */ hashes,
    ) => {
      cacheWrites.push([...hashes]);
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

const { cleanup } = await import("./cleanup.mjs");

/**
 * A ReferencedResult referencing exactly `hashes`, from one snapshot.
 * @param {string[]} hashes
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 */
const ref = (hashes, unreadable = []) => ({
  referenced: new Map(
    hashes.map((hash) => [
      hash,
      {
        sizes: new Set([1]),
        snapshots: new Set(["s1"]),
        examplePath: `/${hash}`,
      },
    ]),
  ),
  snapshotsChecked: 1,
  unreadable,
});

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (/** @type {number} */ d) => new Date(Date.now() - d * DAY);

/** @type {boolean | undefined} */
let savedTTY;
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
beforeEach(() => {
  savedTTY = stdin.isTTY;
  stdin.isTTY = false; // non-interactive by default → no prompt
  referencedBySet = new Map();
  storedObjects = [];
  deleteCalls = [];
  cacheWrites = [];
  promptAnswer = false;
  promptCalls = 0;
});
afterEach(() => {
  stdin.isTTY = savedTTY;
});

describe("cleanup command", () => {
  it("requires a bucket", async () => {
    await assert.rejects(
      () => cleanup(),
      /Missing required argument: <bucket>/,
    );
  });

  it("dry run reports orphans past the grace window without deleting", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) }, // referenced
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) }, // past grace
      { hash: "new-orphan", size: 999, lastModified: daysAgo(1) }, // within grace
    ];

    const result = await cleanup("b");

    assert.equal(result.orphanObjects, 1); // only old-orphan
    assert.equal(result.reclaimableBytes, 100);
    assert.equal(result.withinGrace, 1); // new-orphan protected
    assert.equal(result.deleted, 0);
    assert.deepEqual(deleteCalls, []);
    assert.deepEqual(cacheWrites, []); // dry run never rewrites the cache
  });

  it("--delete removes past-grace orphans and rewrites the cache from stored − deleted", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) },
      { hash: "new-orphan", size: 5, lastModified: daysAgo(1) },
    ];

    const result = await cleanup("b", { delete: true });

    assert.deepEqual(deleteCalls, ["old-orphan"]);
    assert.equal(result.deleted, 1);
    // Cache rewritten to everything still stored (kept + the grace-protected new-orphan).
    assert.equal(cacheWrites.length, 1);
    const [firstWrite] = cacheWrites;
    assert.ok(firstWrite);
    assert.deepEqual(firstWrite.sort(), ["kept", "new-orphan"]);
  });

  it("--delete refuses when referenced objects are missing", async () => {
    referencedBySet.set("photos", ref(["kept", "gone"]));
    storedObjects = [{ hash: "kept", size: 10, lastModified: daysAgo(30) }];

    await assert.rejects(
      () => cleanup("b", { delete: true }),
      /Refusing to delete[\s\S]*missing[\s\S]*s3cab verify b/,
    );
    assert.deepEqual(deleteCalls, []);
  });

  it("aborts both modes on an unreadable snapshot", async () => {
    referencedBySet.set(
      "photos",
      ref(["kept"], [{ snapshot: "bad", reason: "boom" }]),
    );
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    // Even a dry run aborts — the orphan numbers would be lies.
    await assert.rejects(() => cleanup("b"), /Can't compute orphans safely/);
    await assert.rejects(() => cleanup("b", { delete: true }), /verify b/);
    assert.deepEqual(deleteCalls, []);
  });

  it("--delete on a TTY deletes nothing when the user declines", async () => {
    stdin.isTTY = true;
    promptAnswer = false;
    referencedBySet.set("photos", ref([]));
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    const result = await cleanup("b", { delete: true });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, []);
    assert.equal(result.deleted, 0);
    assert.deepEqual(cacheWrites, []); // declined → no cache rewrite
  });
});
