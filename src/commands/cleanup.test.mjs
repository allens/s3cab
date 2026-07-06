import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** @import { ReferencedResult } from "../lib/verify.mjs" */

// Offline tests for `cleanup`: the S3 reads/writes (referencedObjects,
// listStoredObjects, deleteStoredObject) and the prompt are faked at the lib
// seam; the object ages are staged as Dates so the 7-day grace window is
// exercised without waiting. cleanup computes its missing/damaged/orphan tallies
// directly from the two enumerations (hash level). Mocks first, then a dynamic
// import.

/** @type {Map<string, ReferencedResult>} */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number, lastModified?: Date }[]} */
let storedObjects = [];
/** @type {string[]} */
let deleteCalls = [];
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
 * A ReferencedResult referencing exactly `hashes` (each recorded at size 1),
 * from one snapshot.
 * @param {string[]} hashes
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 */
const ref = (hashes, unreadable = []) => ({
  referenced: new Map(
    hashes.map((hash) => [
      hash,
      {
        paths: new Map([
          [`/${hash}`, { sizes: new Set([1]), snapshots: new Set(["s1"]) }],
        ]),
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
  });

  it("--delete removes past-grace orphans, leaving referenced and grace-protected objects", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) },
      { hash: "new-orphan", size: 5, lastModified: daysAgo(1) },
    ];

    const result = await cleanup("b", { delete: true });

    // Only the past-grace orphan goes; kept (referenced) and new-orphan (within
    // grace) stay.
    assert.deepEqual(deleteCalls, ["old-orphan"]);
    assert.equal(result.deleted, 1);
  });

  it("counts a missing hash referenced by several sets once", async () => {
    // The same object referenced-but-absent in two sets is one missing object,
    // not two — the report counts distinct hashes.
    referencedBySet.set("photos", ref(["shared-missing"]));
    referencedBySet.set("docs", ref(["shared-missing"]));
    storedObjects = []; // referenced by both sets, stored by neither

    const result = await cleanup("b");
    assert.equal(result.missingObjects, 1);
  });

  it("warns about an object stored at the wrong size, but does not count it missing or orphaned", async () => {
    // "kept" is recorded at size 1 (the ref helper) but stored at 999 — damaged,
    // not missing (it exists) and not orphaned (it's referenced). Cleanup only
    // flags it and points at verify for the per-file detail.
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [{ hash: "kept", size: 999, lastModified: daysAgo(30) }];

    /** @type {string[]} */
    const warnings = [];
    const warn = mock.method(console, "warn", (/** @type {string} */ m) =>
      warnings.push(m),
    );
    try {
      const result = await cleanup("b");
      assert.equal(result.missingObjects, 0);
      assert.equal(result.orphanObjects, 0);
      assert.ok(
        warnings.some((w) => /wrong size/.test(w)),
        "warns about the wrong-size object",
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("flags a hash damaged when any of its paths disagrees on size (torn manifest)", async () => {
    // One hash under two paths recorded at different sizes; stored matches only
    // the first path. cleanup must still flag it — it checks every path's size,
    // not just the first (or a torn manifest's wrong size would go unwarned).
    referencedBySet.set("photos", {
      referenced: new Map([
        [
          "h",
          {
            paths: new Map([
              ["/a", { sizes: new Set([1]), snapshots: new Set(["s1"]) }],
              ["/b", { sizes: new Set([2]), snapshots: new Set(["s1"]) }],
            ]),
          },
        ],
      ]),
      snapshotsChecked: 1,
      unreadable: [],
    });
    storedObjects = [{ hash: "h", size: 1, lastModified: daysAgo(30) }];

    /** @type {string[]} */
    const warnings = [];
    const warn = mock.method(console, "warn", (/** @type {string} */ m) =>
      warnings.push(m),
    );
    try {
      const result = await cleanup("b");
      assert.equal(result.missingObjects, 0);
      assert.ok(
        warnings.some((w) => /wrong size/.test(w)),
        "warns about the torn-manifest hash",
      );
    } finally {
      warn.mock.restore();
    }
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
  });
});
