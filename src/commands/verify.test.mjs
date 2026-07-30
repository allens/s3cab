import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** @import { ReferencedResult } from "../lib/referenced.mjs" */

// Offline tests for verify's command orchestration — the glue on top of the pure
// diff. The two S3 reads (`referencedObjects`, `listStoredObjects`) are faked at
// the lib seam so the per-set report, the { bucket, sets } shape, and the
// exit-code side effect are locked down without a bucket. The real S3 path is
// covered by test/integration/remote.test.mjs's gated `referencedObjects` test; the pure diff by
// verify.test.mjs. Module-mock ordering (objects.test.mjs) applies: mocks first,
// then a dynamic import of the command.

/** @type {Map<string, ReferencedResult>} referenced per set */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number }[]} */
let storedObjects = [];
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();

mock.module("../lib/remote.mjs", {
  exports: {
    referencedObjects: async () => referencedBySet,
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    listStoredObjects: async function* () {
      for (const object of storedObjects) {
        yield object;
      }
    },
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => deletionRecords,
  },
});

const { verify } = await import("./verify.mjs");

/**
 * A ReferencedResult from `{ hash: [size, [snapshot(s)]] }` — one path per hash,
 * `/data/<hash>` — plus optional unreadable-snapshot findings.
 * @param {Record<string, [number, string[]]>} spec
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 */
const ref = (spec, unreadable = []) => ({
  referenced: new Map(
    Object.entries(spec).map(([hash, [size, snapshots]]) => [
      hash,
      {
        paths: new Map([
          [
            `/data/${hash}`,
            { sizes: new Set([size]), snapshots: new Set(snapshots) },
          ],
        ]),
      },
    ]),
  ),
  snapshotsChecked: 1,
  unreadable,
});

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
    referencedBySet.set("photos", ref({ aaa: [10, ["s1"]] }));
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
    referencedBySet.set("photos", ref({ aaa: [10, ["s1"]] }));
    storedObjects = [
      { hash: "aaa", size: 10 },
      { hash: "orphan", size: 5 },
    ];

    const result = await verify("my-backups");

    assert.deepEqual(Object.keys(result).sort(), ["bucket", "sets"]);
    assert.equal(process.exitCode, savedExitCode); // clean → untouched
  });

  it("an unreadable snapshot is a finding (exit 1), surfaced on its set", async () => {
    referencedBySet.set(
      "photos",
      ref({ aaa: [10, ["s1"]] }, [{ snapshot: "s0", reason: "boom" }]),
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
    referencedBySet.set("photos", ref({ gone: [10, ["s1"]] }));
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
    referencedBySet.set("photos", ref({ gone: [10, ["s1"]] }));
    storedObjects = []; // absent — but the record explains it
    deletionRecords.set("gone", { deletedOn: "2026-07-19T1422" });

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.expectedMissing, [
      { path: "/data/gone", snapshots: ["s1"], deletedOn: "2026-07-19T1422" },
    ]);
    // The whole point of the partition: `verify || alert` stays quiet after a
    // deliberate delete.
    assert.equal(process.exitCode, savedExitCode);
  });

  it("still exits 1 when an unexplained absence sits beside a recorded one", async () => {
    referencedBySet.set(
      "photos",
      ref({ gone: [10, ["s1"]], lost: [20, ["s1"]] }),
    );
    storedObjects = [];
    deletionRecords.set("gone", { deletedOn: "2026-07-19T1422" });

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
    referencedBySet.set("photos", ref({ aaa: [10, ["s1"]] }));
    referencedBySet.set("docs", ref({ bbb: [20, ["s2"]] }));
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
