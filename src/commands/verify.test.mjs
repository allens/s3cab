import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { enumeration } from "../../test/helpers/enumeration.mjs";

/** @import { ReferencedResult } from "../lib/referenced.mjs" */

// Offline tests for verify's command orchestration — the glue on top of the pure
// diff. The bucket scan (`scanBucket`) is faked at the lib seam so the per-set
// report, the { bucket, sets } shape, and the exit-code side effect are locked
// down without a bucket; its referenced enumeration is built by the shared
// `enumeration` fixture (paths spelled `/data/<hash>` so the reported paths read
// back to their hash). The scan's own read order is pinned in
// lib/bucket-scan.test.mjs, the real S3 path by test/integration/remote.test.mjs's
// gated `referencedObjects` test, and the pure diff by verify.test.mjs.
// Module-mock ordering (objects.test.mjs) applies: mocks first, then a dynamic
// import of the command.

/** @type {Map<string, ReferencedResult>} referenced per set */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number }[]} */
let storedObjects = [];
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();

mock.module("../lib/bucket-scan.mjs", {
  exports: {
    scanBucket: async () => ({
      referencedBySet,
      stored: new Map(storedObjects.map(({ hash, size }) => [hash, { size }])),
      deleted: deletionRecords,
    }),
  },
});

const { verify } = await import("./verify.mjs");

/** @type {number | string | null | undefined} */
let savedExitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
  referencedBySet = new Map();
  storedObjects = [];
  deletionRecords = new Map();
});
afterEach(() => {
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
});

describe("verify command", () => {
  it("requires a bucket, failing fast before any S3 touch", async () => {
    await assert.rejects(() => verify(), /Missing required argument: bucket/);
  });

  it("reports a clean bucket and leaves the exit code untouched", async () => {
    referencedBySet = enumeration({
      photos: { s1: { "/data/aaa": ["aaa", 10] } },
    });
    storedObjects = [{ hash: "aaa", size: 10 }];

    const result = await verify("my-backups");

    assert.equal(result.bucket, "my-backups");
    assert.equal(result.sets.length, 1);
    const [report] = result.sets;
    assert.ok(report);
    assert.equal(report.set, "photos");
    assert.deepEqual(report.problems, []);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("does not report orphans — they are cleanup's concern, not verify's", async () => {
    // `orphan` is stored but referenced by no snapshot. verify simply ignores it
    // (no orphan count, no exactness flag on the result); its result is just
    // { bucket, sets }, and a stored-but-unreferenced object is not a finding.
    referencedBySet = enumeration({
      photos: { s1: { "/data/aaa": ["aaa", 10] } },
    });
    storedObjects = [
      { hash: "aaa", size: 10 },
      { hash: "orphan", size: 5 },
    ];

    const result = await verify("my-backups");

    assert.deepEqual(Object.keys(result).sort(), ["bucket", "sets"]);
    assert.equal(process.exitCode, savedExitCode); // clean → untouched
  });

  it("an unreadable snapshot is a finding (exit 1), surfaced on its set", async () => {
    referencedBySet = enumeration(
      { photos: { s1: { "/data/aaa": ["aaa", 10] } } },
      { photos: [{ snapshot: "s0", reason: "boom" }] },
    );
    storedObjects = [{ hash: "aaa", size: 10 }];

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.deepEqual(report.unreadableSnapshots, [
      { snapshot: "s0", reason: "boom" },
    ]);
    assert.equal(process.exitCode, 1);
  });

  it("sets exit code 1 when any set has a missing object", async () => {
    referencedBySet = enumeration({
      photos: { s1: { "/data/gone": ["gone", 10] } },
    });
    storedObjects = []; // the referenced object is not stored

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.deepEqual(report.problems, [
      { path: "/data/gone", problem: "missing", snapshots: ["s1"] },
    ]);
    assert.equal(process.exitCode, 1);
  });

  it("reports a recorded deletion as expected-missing and leaves the exit code untouched", async () => {
    referencedBySet = enumeration({
      photos: { s1: { "/data/gone": ["gone", 10] } },
    });
    storedObjects = []; // absent — but the record explains it
    deletionRecords.set("gone", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.expectedMissing, [
      {
        path: "/data/gone",
        snapshots: ["s1"],
        deletedOn: "2026-07-19T14:22:41.000Z",
      },
    ]);
    // The whole point of the partition: `verify || alert` stays quiet after a
    // deliberate delete.
    assert.equal(process.exitCode, savedExitCode);
  });

  it("still exits 1 when an unexplained absence sits beside a recorded one", async () => {
    referencedBySet = enumeration({
      photos: {
        s1: { "/data/gone": ["gone", 10], "/data/lost": ["lost", 20] },
      },
    });
    storedObjects = [];
    deletionRecords.set("gone", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.equal(report.expectedMissing.length, 1);
    assert.deepEqual(report.problems, [
      { path: "/data/lost", problem: "missing", snapshots: ["s1"] },
    ]);
    assert.equal(process.exitCode, 1);
  });

  it("reports per set, sorted by set name", async () => {
    referencedBySet = enumeration({
      photos: { s1: { "/data/aaa": ["aaa", 10] } },
      docs: { s2: { "/data/bbb": ["bbb", 20] } },
    });
    storedObjects = [
      { hash: "aaa", size: 10 },
      { hash: "bbb", size: 20 },
    ];

    const result = await verify("my-backups");

    assert.deepEqual(
      result.sets.map((s) => s.set),
      ["docs", "photos"], // sorted by set name
    );
    assert.equal(process.exitCode, savedExitCode); // clean → untouched
  });
});
