import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// Offline tests for verify's command orchestration — the glue on top of the pure
// diff. The two S3 reads (`referencedObjects`, `listStoredObjects`) and the cache
// rewrite (`writeObjectsCache`) are faked at the lib seam so the per-set report,
// the exit-code side effect, and the exact orphan count are locked down without a
// bucket. The real S3 path is covered by remote.test.mjs's gated `referencedObjects`
// test; the pure diff by verify.test.mjs. Module-mock ordering (objects.test.mjs)
// applies: mocks first, then a dynamic import of the command.

/** @type {Map<string, import("../lib/verify.mjs").ReferencedResult>} referenced per set */
let referencedBySet = new Map();
/** @type {{ hash: string, size: number }[]} */
let storedObjects = [];
/** @type {{ bucket: string, hashes: string[] }[]} */
let cacheWrites = [];

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
    writeObjectsCache: async (
      /** @type {string} */ bucket,
      /** @type {Iterable<string>} */ hashes,
    ) => {
      cacheWrites.push({ bucket, hashes: [...hashes] });
    },
  },
});

const { verify } = await import("./verify.mjs");

/**
 * A ReferencedResult from `{ hash: [size, [snapshot(s)]] }`, plus optional
 * unreadable-snapshot findings.
 * @param {Record<string, [number, string[]]>} spec
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 */
const ref = (spec, unreadable = []) => ({
  referenced: new Map(
    Object.entries(spec).map(([hash, [size, snapshots]]) => [
      hash,
      {
        sizes: new Set([size]),
        snapshots: new Set(snapshots),
        examplePath: `/data/${hash}`,
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
  cacheWrites = [];
});
afterEach(() => {
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
});

describe("verify command", () => {
  it("requires a bucket, failing fast before any S3 touch", async () => {
    await assert.rejects(() => verify(), /Missing required argument: <bucket>/);
  });

  it("reports a clean bucket, rewrites its cache, and leaves the exit code untouched", async () => {
    referencedBySet.set("photos", ref({ aaa: [10, ["s1"]] }));
    storedObjects = [{ hash: "aaa", size: 10 }];

    const result = await verify("my-backups");

    assert.equal(result.bucket, "my-backups");
    assert.equal(result.sets.length, 1);
    const [report] = result.sets;
    assert.ok(report);
    assert.equal(report.set, "photos");
    assert.deepEqual(report.missingObjects, []);
    assert.equal(result.storedObjects, 1);
    assert.equal(result.orphanObjects, 0);
    assert.equal(result.orphanObjectsExact, true);
    // The cache is rewritten from the completed LIST.
    assert.deepEqual(cacheWrites, [{ bucket: "my-backups", hashes: ["aaa"] }]);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("marks the orphan count inexact when a snapshot is unreadable", async () => {
    // An unreadable snapshot's references are unknown, so `mystery` might be
    // referenced by it — the orphan count is an upper bound, and the flag says so.
    referencedBySet.set(
      "photos",
      ref({ aaa: [10, ["s1"]] }, [{ snapshot: "s0", reason: "boom" }]),
    );
    storedObjects = [
      { hash: "aaa", size: 10 },
      { hash: "mystery", size: 1 },
    ];

    const result = await verify("my-backups");

    assert.equal(result.orphanObjects, 1); // upper bound
    assert.equal(result.orphanObjectsExact, false);
    assert.equal(process.exitCode, 1); // an unreadable snapshot is a finding
  });

  it("sets exit code 1 when any set has a missing object", async () => {
    referencedBySet.set("photos", ref({ gone: [10, ["s1"]] }));
    storedObjects = []; // the referenced object is not stored

    const result = await verify("my-backups");

    const [report] = result.sets;
    assert.ok(report);
    assert.deepEqual(
      report.missingObjects.map((f) => f.hash),
      ["gone"],
    );
    assert.equal(process.exitCode, 1);
  });

  it("reports per set (sorted) and the exact bucket-wide orphan count", async () => {
    // Two sets in the bucket; one stored object is referenced by neither.
    referencedBySet.set("photos", ref({ aaa: [10, ["s1"]] }));
    referencedBySet.set("docs", ref({ bbb: [20, ["s2"]] }));
    storedObjects = [
      { hash: "aaa", size: 10 },
      { hash: "bbb", size: 20 },
      { hash: "orphan", size: 5 },
    ];

    const result = await verify("my-backups");

    assert.deepEqual(
      result.sets.map((s) => s.set),
      ["docs", "photos"], // sorted by set name
    );
    assert.equal(result.storedObjects, 3);
    assert.equal(result.orphanObjects, 1); // only "orphan"
    assert.equal(result.orphanObjectsExact, true);
    assert.equal(process.exitCode, savedExitCode); // clean → untouched
  });
});
