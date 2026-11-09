import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enumeration } from "../../test/helpers/enumeration.mjs";
import { setHasFindings, verifyHasFindings, verifySet } from "./verify.mjs";

/** @import { ReferencedResult } from "./referenced.mjs" */
/** @import { SnapshotRows } from "../../test/helpers/enumeration.mjs" */
/** @import { Versioning } from "./s3.mjs" */

// Pure unit tests for verify's diff core — the per-path `problems` model — with
// no S3 (the S3 reads are integration-tested via test/integration/remote.test.mjs
// / the gated bucket). See docs/design/backup.md. The enumeration's own
// vocabulary, including the damage classifier, is pinned in referenced.test.mjs.

/**
 * One set's enumeration from its snapshots — `verifySet` takes a single set, so
 * the bucket-wide Map the shared builder returns is unwrapped here.
 * @param {Record<string, SnapshotRows>} snapshots - snapshot name → its rows
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 * @returns {ReferencedResult}
 */
function enumerated(snapshots, unreadable) {
  const set = enumeration(
    { photos: snapshots },
    unreadable && { photos: unreadable },
  ).get("photos");
  assert.ok(set);
  return set;
}

/**
 * The bucket's stored objects as `scanBucket` hands them over, from `hash →
 * LIST size` (the age the scan also carries is cleanup's, not this diff's).
 * @param {Record<string, number>} sizes
 */
const store = (sizes) =>
  new Map(Object.entries(sizes).map(([hash, size]) => [hash, { size }]));

describe("verifySet with a deletion record", () => {
  const RECORD = new Map([["gone", { deletedOn: "2026-07-19T14:22:41.000Z" }]]);

  it("partitions missing into expected (recorded) vs unexplained", () => {
    const referenced = enumerated({
      s1: {
        "/deleted-on-purpose.txt": ["gone", 10],
        "/vanished.txt": ["lost", 20],
      },
      s2: { "/deleted-copy.txt": ["gone", 10] },
    });
    const report = verifySet("photos", referenced, new Map(), RECORD);
    // The recorded hash's paths are context, with the record's date...
    assert.deepEqual(report.expectedMissing, [
      {
        path: "/deleted-copy.txt",
        snapshots: ["s2"],
        deletedOn: "2026-07-19T14:22:41.000Z",
      },
      {
        path: "/deleted-on-purpose.txt",
        snapshots: ["s1"],
        deletedOn: "2026-07-19T14:22:41.000Z",
      },
    ]);
    // ...while the unrecorded absence stays the alarming problem it always was.
    assert.deepEqual(report.problems, [
      { path: "/vanished.txt", problem: "missing", snapshots: ["s1"] },
    ]);
  });

  it("expected-missing alone is not a finding — the cron alarm stays quiet", () => {
    const referenced = enumerated({ s1: { "/deleted.txt": ["gone", 10] } });
    const report = verifySet("photos", referenced, new Map(), RECORD);
    assert.equal(setHasFindings(report), false);
  });

  it("a recorded hash that is stored anyway gets the normal checks, not a skip", () => {
    // Content re-backed-up after a delete: the record entry is moot. The
    // stored object still gets the size cross-check — a wrong size must not
    // hide behind a stale record entry.
    const referenced = enumerated({ s9: { "/back-again.txt": ["gone", 10] } });
    const stored = store({ gone: 7 });
    const report = verifySet("photos", referenced, stored, RECORD);
    assert.deepEqual(report.expectedMissing, []);
    assert.equal(report.problems[0]?.problem, "wrong-size");
  });
});

describe("verifySet with an archived object", () => {
  it("flags every path of an object in an archive tier as archived — a restore can't read it", () => {
    // A lifecycle rule moved the object to Glacier: it is stored, at the
    // right size, and a GET fails on it until it is restored from the
    // archive, so every file whose content it holds is a finding.
    const referenced = enumerated({
      s1: { "/a.txt": ["aaa", 10], "/copy/a.txt": ["aaa", 10] },
    });
    const stored = new Map([["aaa", { size: 10, storageClass: "GLACIER" }]]);
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, [
      {
        path: "/a.txt",
        problem: "archived",
        snapshots: ["s1"],
        storageClass: "GLACIER",
      },
      {
        path: "/copy/a.txt",
        problem: "archived",
        snapshots: ["s1"],
        storageClass: "GLACIER",
      },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("reads GLACIER_IR as stored — instant retrieval, the class s3cab itself writes", () => {
    const referenced = enumerated({ s1: { "/a.txt": ["aaa", 10] } });
    const stored = new Map([["aaa", { size: 10, storageClass: "GLACIER_IR" }]]);
    const report = verifySet("photos", referenced, stored);
    assert.deepEqual(report.problems, []);
  });
});

describe("verifySet", () => {
  it("reports no problems when every referenced path is stored at its size", () => {
    const referenced = enumerated({
      s1: { "/a.txt": ["aaa", 10], "/b.txt": ["bbb", 20] },
    });
    const stored = store({
      aaa: 10,
      bbb: 20,
      ccc: 99, // an orphan — not this set's concern
    });

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
    const referenced = enumerated({
      s1: { "/a.txt": ["aaa", 10], "/copy/a.txt": ["aaa", 10] },
      s2: { "/copy/a.txt": ["aaa", 10] },
    });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(report.problems, [
      { path: "/a.txt", problem: "missing", snapshots: ["s1"] },
      { path: "/copy/a.txt", problem: "missing", snapshots: ["s1", "s2"] },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("flags a stored object whose size differs from the recorded size as wrong-size", () => {
    const referenced = enumerated({ s1: { "/a.txt": ["aaa", 10] } });
    const stored = store({ aaa: 7 });
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
    const referenced = enumerated({
      s1: { "/right.txt": ["aaa", 10] },
      s2: { "/wrong.txt": ["aaa", 20] },
    });
    const stored = store({ aaa: 10 });
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
    const referenced = enumerated({
      s1: { "/right.txt": ["aaa", 10] },
      s2: { "/wrong.txt": ["aaa", 20] },
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
    const referenced = enumerated({
      s1: { "/a.txt": ["aaa", 10] },
      s2: { "/a.txt": ["aaa", 20] },
    });
    const stored = store({ aaa: 10 });
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
    // than fall back to hash-encounter order. s2 is listed first so that h2 is
    // encountered before h1 and encounter order alone would come out wrong.
    const referenced = enumerated({
      s2: { "/a": ["h2", 5] },
      s1: { "/a": ["h1", 5] },
    });
    const report = verifySet("photos", referenced, new Map());

    assert.deepEqual(report.problems, [
      { path: "/a", problem: "missing", snapshots: ["s1"] },
      { path: "/a", problem: "missing", snapshots: ["s2"] },
    ]);
  });

  it("passes unreadable snapshots through and counts them as findings", () => {
    const referenced = enumerated({ s1: { "/a.txt": ["aaa", 10] } }, [
      { snapshot: "s0", reason: "boom" },
    ]);
    const stored = store({ aaa: 10 });
    const report = verifySet("photos", referenced, stored);

    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.unreadableSnapshots, [
      { snapshot: "s0", reason: "boom" },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("reports a row the reader refused as an invalid path, with why (ADR-0101)", () => {
    const reason = "its size isn't a whole number of bytes";
    const referenced = {
      ...enumerated({ s1: { "/a.txt": ["aaa", 10] } }),
      invalid: [{ snapshot: "s1", path: "/b.txt", reason }],
    };
    const report = verifySet("photos", referenced, store({ aaa: 10 }));

    assert.deepEqual(report.problems, [
      { path: "/b.txt", problem: "invalid", snapshots: ["s1"], reason },
    ]);
    assert.equal(setHasFindings(report), true);
  });

  it("a run is clean only with a set, and every set clean (ADR-0117)", () => {
    // The one rule the command's exit code and the renderer's verdict share.
    const clean = verifySet(
      "photos",
      enumerated({ s1: { "/a.txt": ["aa", 1] } }),
      new Map([["aa", { size: 1 }]]),
    );
    const empty = verifySet("docs", enumerated({}), new Map());
    const versioning = { state: /** @type {const} */ ("enabled") };
    assert.equal(verifyHasFindings({ sets: [], versioning }), true);
    assert.equal(verifyHasFindings({ sets: [clean], versioning }), false);
    assert.equal(verifyHasFindings({ sets: [clean, empty], versioning }), true);
  });

  it("of the versioning states, only suspended is a finding (ADR-0118)", () => {
    const clean = verifySet(
      "photos",
      enumerated({ s1: { "/a.txt": ["aa", 1] } }),
      new Map([["aa", { size: 1 }]]),
    );
    /** @type {Versioning[]} */
    const quiet = [
      { state: "enabled" },
      { state: "never-enabled" },
      { state: "unknown", reason: "AccessDenied" },
    ];
    for (const versioning of quiet) {
      assert.equal(
        verifyHasFindings({ sets: [clean], versioning }),
        false,
        versioning.state,
      );
    }
    assert.equal(
      verifyHasFindings({ sets: [clean], versioning: { state: "suspended" } }),
      true,
    );
  });

  it("a set with no snapshot read is a finding, not a clean set", () => {
    // Its marker is in the bucket and its snapshots are gone: nothing was
    // verified, which a `verify || alert` cron job exists to notice.
    const report = verifySet("photos", enumerated({}), new Map());
    assert.equal(report.snapshotsChecked, 0);
    assert.deepEqual(report.problems, []);
    assert.equal(setHasFindings(report), true);
  });

  it("sorts problems by path for deterministic output", () => {
    const referenced = enumerated({
      s1: { "/c": ["h1", 1], "/a": ["h2", 1], "/b": ["h3", 1] },
    });
    const report = verifySet("photos", referenced, new Map());
    assert.deepEqual(
      report.problems.map((p) => p.path),
      ["/a", "/b", "/c"],
    );
  });
});
