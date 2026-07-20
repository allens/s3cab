import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCorruptSnapshotError,
  setHasFindings,
  verifySet,
} from "./verify.mjs";

// Pure unit tests for verify's diff core — the per-path `problems` model and the
// error classifier — with no S3 (the S3 reads are integration-tested via
// test/integration/remote.test.mjs / the gated bucket). See docs/design/backup.md.

/**
 * Build a ReferencedResult from a compact spec: each hash maps to its list of
 * referencing paths `{ path, size, snapshots }`. `size` may be an array to record
 * a single path at several sizes (a torn snapshot file).
 * @param {Record<string, { path: string, size: number | number[], snapshots: string[] }[]>} spec
 * @param {{ snapshotsChecked?: number, unreadable?: { snapshot: string, reason: string }[] }} [meta]
 */
function ref(spec, { snapshotsChecked = 1, unreadable = [] } = {}) {
  const referenced = new Map();
  for (const [hash, paths] of Object.entries(spec)) {
    const pathMap = new Map();
    for (const { path, size, snapshots } of paths) {
      pathMap.set(path, {
        sizes: new Set(Array.isArray(size) ? size : [size]),
        snapshots: new Set(snapshots),
      });
    }
    referenced.set(hash, { paths: pathMap });
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

describe("verifySet with a deletion record", () => {
  const RECORD = new Map([["gone", { deletedOn: "2026-07-19T1422" }]]);

  it("partitions missing into expected (recorded) vs unexplained", () => {
    const referenced = ref({
      gone: [
        { path: "/deleted-on-purpose.txt", size: 10, snapshots: ["s1"] },
        { path: "/deleted-copy.txt", size: 10, snapshots: ["s2"] },
      ],
      lost: [{ path: "/vanished.txt", size: 20, snapshots: ["s1"] }],
    });
    const report = verifySet("photos", referenced, new Map(), RECORD);
    // The recorded hash's paths are context, with the record's date...
    assert.deepEqual(report.expectedMissing, [
      {
        path: "/deleted-copy.txt",
        snapshots: ["s2"],
        deletedOn: "2026-07-19T1422",
      },
      {
        path: "/deleted-on-purpose.txt",
        snapshots: ["s1"],
        deletedOn: "2026-07-19T1422",
      },
    ]);
    // ...while the unrecorded absence stays the alarming problem it always was.
    assert.deepEqual(report.problems, [
      { path: "/vanished.txt", problem: "missing", snapshots: ["s1"] },
    ]);
  });

  it("expected-missing alone is not a finding — the cron alarm stays quiet", () => {
    const referenced = ref({
      gone: [{ path: "/deleted.txt", size: 10, snapshots: ["s1"] }],
    });
    const report = verifySet("photos", referenced, new Map(), RECORD);
    assert.equal(setHasFindings(report), false);
  });

  it("a recorded hash that is stored anyway gets the normal checks, not a skip", () => {
    // Content re-backed-up after a delete: the record entry is moot. The
    // stored object still gets the size cross-check — a wrong size must not
    // hide behind a stale record entry.
    const referenced = ref({
      gone: [{ path: "/back-again.txt", size: 10, snapshots: ["s9"] }],
    });
    const stored = new Map([["gone", 7]]);
    const report = verifySet("photos", referenced, stored, RECORD);
    assert.deepEqual(report.expectedMissing, []);
    assert.equal(report.problems[0]?.problem, "wrong-size");
  });
});

describe("verifySet", () => {
  it("reports no problems when every referenced path is stored at its size", () => {
    const referenced = ref({
      aaa: [{ path: "/a.txt", size: 10, snapshots: ["s1"] }],
      bbb: [{ path: "/b.txt", size: 20, snapshots: ["s1", "s0"] }],
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
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.unreadableSnapshots, []);
    assert.equal(setHasFindings(report), false);
  });

  it("reports every path of a hash absent from the store as missing", () => {
    // A missing object referenced by two files yields two `missing` rows — all
    // affected files, no object grouping.
    const referenced = ref({
      aaa: [
        { path: "/a.txt", size: 10, snapshots: ["s1"] },
        { path: "/copy/a.txt", size: 10, snapshots: ["s1", "s2"] },
      ],
    });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(report.problems, [
      { path: "/a.txt", problem: "missing", snapshots: ["s1"] },
      { path: "/copy/a.txt", problem: "missing", snapshots: ["s1", "s2"] },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("flags a stored object whose size differs from the recorded size as wrong-size", () => {
    const referenced = ref({
      aaa: [{ path: "/a.txt", size: 10, snapshots: ["s1"] }],
    });
    const stored = new Map([["aaa", 7]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, [
      {
        path: "/a.txt",
        problem: "wrong-size",
        snapshots: ["s1"],
        recordedSize: 10,
        storedSize: 7,
      },
    ]);
  });

  it("attributes a size conflict to the exact file that disagrees with storage", () => {
    // Same content under two paths, recorded at different sizes — a torn
    // snapshot file (the old "conflicting rows" case). The stored object has one real
    // size; only the file whose recorded size differs is a wrong-size problem.
    const referenced = ref({
      aaa: [
        { path: "/right.txt", size: 10, snapshots: ["s1"] },
        { path: "/wrong.txt", size: 20, snapshots: ["s2"] },
      ],
    });
    const stored = new Map([["aaa", 10]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, [
      {
        path: "/wrong.txt",
        problem: "wrong-size",
        snapshots: ["s2"],
        recordedSize: 20,
        storedSize: 10,
      },
    ]);
  });

  it("reports every path as missing when a size-conflicting hash's object is absent", () => {
    // Object gone → the size conflict is moot; both files are simply missing.
    const referenced = ref({
      aaa: [
        { path: "/right.txt", size: 10, snapshots: ["s1"] },
        { path: "/wrong.txt", size: 20, snapshots: ["s2"] },
      ],
    });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(
      report.problems.map((p) => [p.path, p.problem]),
      [
        ["/right.txt", "missing"],
        ["/wrong.txt", "missing"],
      ],
    );
  });

  it("flags a torn same-path size — one path recorded at two sizes — against storage", () => {
    // The same path recorded at two sizes across snapshots (content fixes size,
    // so this is a torn snapshot file). Only the recorded size that disagrees with the
    // one stored object is a problem; the matching one is not.
    const referenced = ref({
      aaa: [{ path: "/a.txt", size: [10, 20], snapshots: ["s1", "s2"] }],
    });
    const stored = new Map([["aaa", 10]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, [
      {
        path: "/a.txt",
        problem: "wrong-size",
        snapshots: ["s1", "s2"],
        recordedSize: 20,
        storedSize: 10,
      },
    ]);
  });

  it("orders two problems for the same path deterministically (a file that changed hash)", () => {
    // One path under two content hashes across snapshots, both missing — two rows
    // share (path, problem), so the sort must tie-break (here on snapshots) rather
    // than fall back to hash-encounter order.
    const referenced = ref({
      h2: [{ path: "/a", size: 5, snapshots: ["s2"] }],
      h1: [{ path: "/a", size: 5, snapshots: ["s1"] }],
    });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(report.problems, [
      { path: "/a", problem: "missing", snapshots: ["s1"] },
      { path: "/a", problem: "missing", snapshots: ["s2"] },
    ]);
  });

  it("passes unreadable snapshots through and counts them as findings", () => {
    const referenced = ref(
      { aaa: [{ path: "/a.txt", size: 10, snapshots: ["s1"] }] },
      { snapshotsChecked: 1, unreadable: [{ snapshot: "s0", reason: "boom" }] },
    );
    const stored = new Map([["aaa", 10]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.unreadableSnapshots, [
      { snapshot: "s0", reason: "boom" },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("sorts problems by path for deterministic output", () => {
    const referenced = ref({
      h1: [{ path: "/c", size: 1, snapshots: ["s1"] }],
      h2: [{ path: "/a", size: 1, snapshots: ["s1"] }],
      h3: [{ path: "/b", size: 1, snapshots: ["s1"] }],
    });
    const report = verifySet("photos", referenced, new Map());
    assert.deepEqual(
      report.problems.map((p) => p.path),
      ["/a", "/b", "/c"],
    );
  });
});
