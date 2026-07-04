import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCorruptSnapshotError,
  setHasFindings,
  verifySet,
} from "./verify.mjs";

// Pure unit tests for verify's diff core — the four finding classes and the
// error classifier — with no S3 (the S3 reads are integration-tested via
// remote.test.mjs / the gated bucket). See docs/design/backup.md.

/**
 * Build a ReferencedResult from a compact spec: `{ hash: [size(s), [snapshot(s)], examplePath?] }`.
 * @param {Record<string, [number | number[], string[], string?]>} spec
 * @param {{ snapshotsChecked?: number, unreadable?: { snapshot: string, reason: string }[] }} [meta]
 */
function ref(spec, { snapshotsChecked = 1, unreadable = [] } = {}) {
  const referenced = new Map();
  for (const [hash, [sizes, snapshots, examplePath]] of Object.entries(spec)) {
    referenced.set(hash, {
      sizes: new Set(Array.isArray(sizes) ? sizes : [sizes]),
      snapshots: new Set(snapshots),
      examplePath: examplePath ?? `/data/${hash}`,
    });
  }
  return { referenced, snapshotsChecked, unreadable };
}

describe("isCorruptSnapshotError", () => {
  it("treats a snapshot-parse assertion as corruption (a finding)", () => {
    const error = new assert.AssertionError({ message: "Malformed line" });
    assert.equal(isCorruptSnapshotError(error), true);
  });

  it("treats a zstd decompression failure as corruption (a finding)", () => {
    const error = Object.assign(new Error("Unknown frame descriptor"), {
      code: "ZSTD_error_prefix_unknown",
    });
    assert.equal(isCorruptSnapshotError(error), true);
  });

  it("does NOT treat an operational S3 error as corruption (it aborts)", () => {
    const notFound = Object.assign(new Error("nope"), { name: "NoSuchKey" });
    assert.equal(isCorruptSnapshotError(notFound), false);
    assert.equal(isCorruptSnapshotError(new Error("network down")), false);
    assert.equal(isCorruptSnapshotError("not even an error"), false);
  });
});

describe("verifySet", () => {
  it("reports no findings when every referenced object is stored at its size", () => {
    const referenced = ref({
      aaa: [10, ["2026-06-12T0915"]],
      bbb: [20, ["2026-06-12T0915", "2026-06-11T0915"]],
    });
    const stored = new Map([
      ["aaa", 10],
      ["bbb", 20],
      ["ccc", 99], // an orphan — not this set's concern
    ]);

    const report = verifySet("photos", referenced, stored);

    assert.equal(report.set, "photos");
    assert.equal(report.snapshotsChecked, 1);
    assert.equal(report.referencedObjects, 2);
    assert.deepEqual(report.missingObjects, []);
    assert.deepEqual(report.sizeMismatches, []);
    assert.deepEqual(report.conflictingRows, []);
    assert.deepEqual(report.unreadableSnapshots, []);
    assert.equal(setHasFindings(report), false);
  });

  it("flags a referenced hash absent from the store as missing", () => {
    const referenced = ref({ aaa: [10, ["s1"], "/data/a.txt"] });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(report.missingObjects, [
      { hash: "aaa", size: 10, snapshots: ["s1"], examplePath: "/data/a.txt" },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("flags a stored object whose size differs from the snapshot's", () => {
    const referenced = ref({ aaa: [10, ["s1"], "/data/a.txt"] });
    const stored = new Map([["aaa", 7]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.sizeMismatches, [
      {
        hash: "aaa",
        expectedSize: 10,
        storedSize: 7,
        snapshots: ["s1"],
        examplePath: "/data/a.txt",
      },
    ]);
    assert.deepEqual(report.missingObjects, []);
  });

  it("flags a hash recorded with different sizes, and does not double-report it as a mismatch", () => {
    // Same content hash, two sizes across snapshots — a corrupt snapshot file.
    const referenced = ref({ aaa: [[10, 20], ["s1", "s2"], "/data/a.txt"] });
    const stored = new Map([["aaa", 10]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.conflictingRows, [
      {
        hash: "aaa",
        sizes: [10, 20],
        snapshots: ["s1", "s2"],
        examplePath: "/data/a.txt",
      },
    ]);
    // Conflicting makes "expected" ambiguous, so it is NOT also a size mismatch.
    assert.deepEqual(report.sizeMismatches, []);
  });

  it("still reports a conflicting hash as missing when the object is absent", () => {
    const referenced = ref({ aaa: [[10, 20], ["s1", "s2"]] });
    const report = verifySet("photos", referenced, new Map());

    assert.equal(report.conflictingRows.length, 1);
    assert.equal(report.missingObjects.length, 1);
  });

  it("passes unreadable snapshots through and counts them as findings", () => {
    const referenced = ref(
      { aaa: [10, ["s1"]] },
      { snapshotsChecked: 1, unreadable: [{ snapshot: "s0", reason: "boom" }] },
    );
    const stored = new Map([["aaa", 10]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.unreadableSnapshots, [
      { snapshot: "s0", reason: "boom" },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("sorts findings by hash for deterministic output", () => {
    const referenced = ref({
      ccc: [1, ["s1"]],
      aaa: [1, ["s1"]],
      bbb: [1, ["s1"]],
    });
    const report = verifySet("photos", referenced, new Map());
    assert.deepEqual(
      report.missingObjects.map((f) => f.hash),
      ["aaa", "bbb", "ccc"],
    );
  });
});
