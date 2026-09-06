import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** @import { ReferencedResult } from "../lib/referenced.mjs" */

// Offline tests for the `cleanup` *command shell*: the bucket scan
// (scanBucket), the S3 writes (deleteStoredObject, compactDeletionRecords) and
// the prompt are faked at the lib seam, so these cover what the command adds
// around the pure plan — the two abort interlocks, the act-by-default / `-n`
// split, the non-interactive `--force` gate, the TTY prompt, and the delete
// loop (ADR-0064's destructive-command pattern). The orphan/grace/missing/
// damaged *arithmetic* is unit-tested without mocks in lib/cleanup.test.mjs
// (planCleanup); the scan's read order in lib/bucket-scan.test.mjs. Mocks
// first, then a dynamic import.

/** @type {Map<string, ReferencedResult>} */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number, lastModified?: Date }[]} */
let storedObjects = [];
/** @type {string[]} */
let deleteCalls = [];
let promptAnswer = false;
let promptCalls = 0;
/** What the confirmation actually asked — the count in it is what a user checks. */
let promptMessage = "";
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();
/** @type {{ referenced: Set<string>, deletesSoFar: number }[]} compaction calls, with how many object deletes preceded each */
let compactCalls = [];
/** What the mocked compaction reports back to the command. */
let compactResult = { files: 0, rows: 0, trimmed: 0 };

mock.module("../lib/bucket-scan.mjs", {
  exports: {
    scanBucket: async () => ({
      referencedBySet,
      stored: new Map(
        storedObjects.map(({ hash, ...object }) => [hash, object]),
      ),
      deleted: deletionRecords,
    }),
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
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
    promptYesNo: async (/** @type {string} */ message) => {
      promptCalls++;
      promptMessage = message;
      return promptAnswer;
    },
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: {
    compactDeletionRecords: async (
      /** @type {string} */ _bucket,
      /** @type {Set<string>} */ referenced,
    ) => {
      compactCalls.push({ referenced, deletesSoFar: deleteCalls.length });
      return compactResult;
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
  promptMessage = "";
  deletionRecords = new Map();
  compactCalls = [];
  compactResult = { files: 0, rows: 0, trimmed: 0 };
});
afterEach(() => {
  stdin.isTTY = savedTTY;
});

describe("cleanup command", () => {
  it("requires a bucket", async () => {
    await assert.rejects(() => cleanup(), /Missing required argument: bucket/);
  });

  it("refuses a non-interactive run without --force", async () => {
    // Acting deletes objects; with no terminal to confirm on, the intent must be
    // explicit. The refusal is up front, before any scan.
    referencedBySet.set("photos", ref([]));
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    await assert.rejects(
      () => cleanup("b"),
      /no terminal to confirm on[\s\S]*--force/,
    );
    assert.deepEqual(deleteCalls, []);
  });

  it("-n reports orphans past the grace window without deleting", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) }, // referenced
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) }, // past grace
      { hash: "new-orphan", size: 999, lastModified: daysAgo(1) }, // within grace
    ];

    const result = await cleanup("b", { "dry-run": true });

    assert.equal(result.orphanObjects, 1); // only old-orphan
    assert.equal(result.reclaimableBytes, 100);
    assert.equal(result.withinGrace, 1); // new-orphan protected
    assert.equal(result.deleted, 0);
    assert.deepEqual(deleteCalls, []);
  });

  it("--force removes past-grace orphans, leaving referenced and grace-protected objects", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) },
      { hash: "new-orphan", size: 5, lastModified: daysAgo(1) },
    ];

    const result = await cleanup("b", { force: true });

    // Only the past-grace orphan goes; kept (referenced) and new-orphan (within
    // grace) stay. --force reclaims without a prompt.
    assert.deepEqual(deleteCalls, ["old-orphan"]);
    assert.equal(result.deleted, 1);
    assert.equal(promptCalls, 0);
  });

  it("a bare run on a TTY deletes past-grace orphans once the user confirms", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) },
    ];

    const result = await cleanup("b");

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, ["old-orphan"]);
    assert.equal(result.deleted, 1);
    // The count is the part a user checks before typing `y`, so it reads as
    // English at one — not "1 orphaned object(s)".
    assert.match(promptMessage, /Delete 1 orphaned object \(100B\) from/);
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
      const result = await cleanup("b", { "dry-run": true });
      assert.equal(result.missingObjects, 0);
      assert.equal(result.orphanObjects, 0);
      assert.ok(
        warnings.some((w) => /1 object stored at the wrong size/.test(w)),
        "warns about the wrong-size object, counted in English",
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("the act path refuses when referenced objects are missing", async () => {
    referencedBySet.set("photos", ref(["kept", "gone"]));
    storedObjects = [{ hash: "kept", size: 10, lastModified: daysAgo(30) }];

    await assert.rejects(
      () => cleanup("b", { force: true }),
      /Refusing to delete: the repository is missing 1 referenced object[\s\S]*s3cab verify b/,
    );
    assert.deepEqual(deleteCalls, []);
  });

  it("the act path proceeds when every missing object is a recorded deletion (ADR-0064)", async () => {
    // The absence is deliberate (s3cab delete wrote it into the record), so the
    // repository is not "losing data" and the interlock must not trip forever.
    referencedBySet.set("photos", ref(["kept", "gone"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "orphan", size: 100, lastModified: daysAgo(9) },
    ];
    deletionRecords.set("gone", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await cleanup("b", { force: true });

    assert.equal(result.missingObjects, 0);
    assert.deepEqual(deleteCalls, ["orphan"]);
  });

  it("aborts both modes on an unreadable snapshot", async () => {
    referencedBySet.set(
      "photos",
      ref(["kept"], [{ snapshot: "bad", reason: "boom" }]),
    );
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    // Even a dry run aborts — the orphan numbers would be lies. --force does not
    // lift this interlock (unlike the confirmation).
    await assert.rejects(
      () => cleanup("b", { "dry-run": true }),
      /Can't clean up safely/,
    );
    await assert.rejects(() => cleanup("b", { force: true }), /verify b/);
    assert.deepEqual(deleteCalls, []);
  });

  it("a bare run on a TTY deletes nothing when the user declines", async () => {
    stdin.isTTY = true;
    promptAnswer = false;
    referencedBySet.set("photos", ref([]));
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    const result = await cleanup("b");

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, []);
    assert.equal(result.deleted, 0);
    // A declined run acted on nothing — housekeeping doesn't sneak in behind
    // the user's "no".
    assert.deepEqual(compactCalls, []);
  });

  it("an acting run compacts the record after the deletes, trimming against the referenced union (ADR-0090)", async () => {
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [
      { hash: "kept", size: 10, lastModified: daysAgo(30) },
      { hash: "old-orphan", size: 100, lastModified: daysAgo(8) },
    ];
    compactResult = { files: 2, rows: 3, trimmed: 1 };

    const result = await cleanup("b", { force: true });

    assert.equal(compactCalls.length, 1);
    // Trimming keys on *referenced* hashes (a snapshot still names it), never
    // on stored ones — the load-bearing direction: a row for a deleted object
    // must survive as long as any snapshot references its hash.
    assert.deepEqual(compactCalls[0]?.referenced, new Set(["kept"]));
    // ...and only after the orphan deletes, so a crash mid-run never leaves
    // the record trimmed against a state that didn't happen yet.
    assert.equal(compactCalls[0]?.deletesSoFar, deleteCalls.length);
    assert.equal(result.compactedRecordFiles, 2);
    assert.equal(result.trimmedRecordRows, 1);
  });

  it("compacts even when there is nothing to reclaim — cleanup is the record's one collector", async () => {
    stdin.isTTY = true; // and no prompt either: housekeeping needs no confirmation
    referencedBySet.set("photos", ref(["kept"]));
    storedObjects = [{ hash: "kept", size: 10, lastModified: daysAgo(30) }];
    compactResult = { files: 1, rows: 0, trimmed: 2 };

    const result = await cleanup("b");

    assert.equal(promptCalls, 0);
    assert.equal(compactCalls.length, 1);
    assert.equal(result.compactedRecordFiles, 1);
    assert.equal(result.trimmedRecordRows, 2);
  });

  it("a dry run never compacts", async () => {
    referencedBySet.set("photos", ref([]));
    storedObjects = [{ hash: "orphan", size: 1, lastModified: daysAgo(9) }];

    const result = await cleanup("b", { "dry-run": true });

    assert.deepEqual(compactCalls, []);
    assert.equal(result.compactedRecordFiles, 0);
    assert.equal(result.trimmedRecordRows, 0);
  });

  it("interlocks abort before any compaction — a suspect union must not trim", async () => {
    // Unreadable snapshot: the referenced union is incomplete, so trimming
    // against it could drop a row a live snapshot still needs.
    referencedBySet.set(
      "photos",
      ref(["kept"], [{ snapshot: "bad", reason: "boom" }]),
    );
    storedObjects = [{ hash: "kept", size: 1, lastModified: daysAgo(30) }];
    await assert.rejects(() => cleanup("b", { force: true }));
    assert.deepEqual(compactCalls, []);

    // Missing referenced object: the repository is losing data — not the
    // moment for housekeeping either.
    referencedBySet.set("photos", ref(["kept", "gone"]));
    await assert.rejects(() => cleanup("b", { force: true }));
    assert.deepEqual(compactCalls, []);
  });
});
