import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatForcedReport,
  formatUnrestorableReport,
  formatUnrestorableSummary,
  planUnrestorable,
} from "./unrestorable.mjs";

/** @import { ReferencedResult } from "./verify.mjs" */

// `planUnrestorable` is pure, so these assert on returned data with no mocked seams —
// the point of keeping the computation out of the command (as planCleanup does).
// The two properties under test are the ones the design calls load-bearing: the
// check is bucket-wide, and it is computed over the whole selection at once.

/**
 * Build a referenced enumeration the shape `referencedObjects` returns, from a
 * compact literal: set → path → { hash, size, snapshots }.
 * @param {Record<string, Record<string, { hash: string, size?: number, snapshots: string[] }>>} spec
 * @param {Record<string, { snapshot: string, reason: string }[]>} [unreadable]
 * @returns {Map<string, ReferencedResult>}
 */
function enumeration(spec, unreadable = {}) {
  /** @type {Map<string, ReferencedResult>} */
  const bySet = new Map();
  for (const [set, paths] of Object.entries(spec)) {
    /** @type {ReferencedResult["referenced"]} */
    const referenced = new Map();
    for (const [path, { hash, size = 100, snapshots }] of Object.entries(
      paths,
    )) {
      let entry = referenced.get(hash);
      if (!entry) {
        entry = { paths: new Map() };
        referenced.set(hash, entry);
      }
      entry.paths.set(path, {
        sizes: new Set([size]),
        snapshots: new Set(snapshots),
      });
    }
    bySet.set(set, {
      referenced,
      snapshotsChecked: 0,
      unreadable: unreadable[set] ?? [],
    });
  }
  return bySet;
}

describe("planUnrestorable", () => {
  it("reports content the surviving snapshots no longer reference", () => {
    const plan = planUnrestorable(
      enumeration({
        photos: {
          "a.jpg": { hash: "h1", size: 500, snapshots: ["s1"] },
          "b.jpg": { hash: "h2", size: 300, snapshots: ["s1", "s2"] },
        },
      }),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1", "s2"] },
    );

    // h1 goes (only s1 had it); h2 stays (s2 survives and still references it).
    assert.equal(plan.totalFiles, 1);
    assert.equal(plan.totalBytes, 500);
    assert.equal(plan.totalObjects, 1);
    assert.deepEqual(
      plan.entries.map((e) => e.path),
      ["a.jpg"],
    );
  });

  it("does not report content another set still references — the check is bucket-wide", () => {
    // Dedup is global (ADR-0013): answering from the target set alone would call
    // h1 orphaned while `docs` still needs it. This is the lie the design names.
    const plan = planUnrestorable(
      enumeration({
        photos: { "a.jpg": { hash: "h1", snapshots: ["s1"] } },
        docs: { "copy.jpg": { hash: "h1", snapshots: ["d1"] } },
      }),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1"] },
    );

    assert.equal(plan.totalFiles, 0);
    assert.equal(plan.totalObjects, 0);
    assert.deepEqual(plan.entries, []);
  });

  it("reports content shared by the selection only when all of them go", () => {
    // Computed over the whole selection at once: h1 is referenced by both s1 and
    // s2, so it is orphaned by deleting the pair — while evaluating either alone
    // against the current state reports zero.
    const spec = {
      photos: { "a.jpg": { hash: "h1", size: 700, snapshots: ["s1", "s2"] } },
    };

    const one = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s1"],
      remoteSnapshots: ["s1", "s2"],
    });
    assert.equal(one.totalFiles, 0);

    const both = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s1", "s2"],
      remoteSnapshots: ["s1", "s2"],
    });
    assert.equal(both.totalFiles, 1);
    // Referenced by two of the selected snapshots → the shared line, not either row.
    assert.equal(both.sharedFiles, 1);
    assert.equal(both.sharedBytes, 700);
    assert.deepEqual(
      both.bySnapshot.map((s) => s.files),
      [0, 0],
    );
  });

  it("attributes single-snapshot content to that snapshot, and is order-independent", () => {
    const spec = {
      photos: {
        "only-s1.jpg": { hash: "h1", size: 100, snapshots: ["s1"] },
        "only-s2.jpg": { hash: "h2", size: 200, snapshots: ["s2"] },
        "shared.jpg": { hash: "h3", size: 400, snapshots: ["s1", "s2"] },
      },
    };
    const forward = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s1", "s2"],
      remoteSnapshots: ["s1", "s2"],
    });
    const reversed = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s2", "s1"],
      remoteSnapshots: ["s1", "s2"],
    });

    assert.deepEqual(
      forward.bySnapshot.map(({ snapshot, files, bytes }) => ({
        snapshot,
        files,
        bytes,
      })),
      [
        { snapshot: "s1", files: 1, bytes: 100 },
        { snapshot: "s2", files: 1, bytes: 200 },
      ],
    );
    assert.equal(forward.sharedFiles, 1);
    assert.equal(forward.sharedBytes, 400);
    assert.equal(forward.totalFiles, 3);
    assert.equal(forward.totalBytes, 700);

    // The same selection yields the same numbers whichever order it was given in
    // — what attribution-by-reference-count buys over sequential simulation.
    assert.deepEqual(
      [...reversed.bySnapshot].sort((a, b) =>
        a.snapshot.localeCompare(b.snapshot),
      ),
      forward.bySnapshot,
    );
    assert.equal(reversed.sharedFiles, forward.sharedFiles);
    assert.equal(reversed.totalBytes, forward.totalBytes);
  });

  it("counts bytes once per object but files per path", () => {
    // Dedup stores one copy however many paths point at it, so the two figures
    // deliberately do not scale together.
    const plan = planUnrestorable(
      enumeration({
        photos: {
          "a.jpg": { hash: "h1", size: 900, snapshots: ["s1"] },
          "duplicate.jpg": { hash: "h1", size: 900, snapshots: ["s1"] },
        },
      }),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1"] },
    );

    assert.equal(plan.totalFiles, 2);
    assert.equal(plan.totalObjects, 1);
    assert.equal(plan.totalBytes, 900);
  });

  it("flags the deletion that takes out a set's last remote snapshot", () => {
    const spec = {
      photos: {
        "a.jpg": { hash: "h1", snapshots: ["s1"] },
        "b.jpg": { hash: "h2", snapshots: ["s2"] },
      },
    };
    const all = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s1", "s2"],
      remoteSnapshots: ["s1", "s2"],
    });
    assert.equal(all.lastOfSet, true);

    const some = planUnrestorable(enumeration(spec), {
      set: "photos",
      snapshots: ["s1"],
      remoteSnapshots: ["s1", "s2"],
    });
    assert.equal(some.lastOfSet, false);
  });

  it("passes unreadable snapshots through as data rather than throwing", () => {
    // The command decides what to do about them — a warning here, not cleanup's
    // abort, because delete never acts on this set.
    const plan = planUnrestorable(
      enumeration(
        { photos: { "a.jpg": { hash: "h1", snapshots: ["s1"] } } },
        { photos: [{ snapshot: "s9", reason: "zstd" }] },
      ),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1"] },
    );

    assert.deepEqual(plan.unreadable, [
      { set: "photos", snapshot: "s9", reason: "zstd" },
    ]);
  });

  it("treats a set with no readable snapshots as referencing nothing", () => {
    const plan = planUnrestorable(enumeration({ docs: {} }), {
      set: "photos",
      snapshots: ["s1"],
      remoteSnapshots: ["s1"],
    });

    assert.equal(plan.totalFiles, 0);
    assert.equal(plan.lastOfSet, true);
  });

  it("shows the largest recorded size when a torn snapshot disagrees", () => {
    // Never understate what is at stake before a deletion; the disagreement
    // itself is verify's finding, and must not derail the preview.
    const referenced = enumeration({
      photos: { "a.jpg": { hash: "h1", size: 100, snapshots: ["s1"] } },
    });
    const entry = referenced.get("photos")?.referenced.get("h1");
    entry?.paths.get("a.jpg")?.sizes.add(4000);

    const plan = planUnrestorable(referenced, {
      set: "photos",
      snapshots: ["s1"],
      remoteSnapshots: ["s1"],
    });
    assert.equal(plan.totalBytes, 4000);
  });
});

describe("formatUnrestorableSummary", () => {
  /** @param {string[]} snapshots */
  const planFor = (snapshots) =>
    planUnrestorable(
      enumeration({
        photos: {
          "only-s1.jpg": { hash: "h1", size: 1_000_000, snapshots: ["s1"] },
          "shared.jpg": {
            hash: "h3",
            size: 4_000_000,
            snapshots: ["s1", "s2"],
          },
        },
      }),
      { set: "photos", snapshots, remoteSnapshots: ["s1", "s2", "s3"] },
    );

  it("ends with the report file's absolute path on its own indented line", () => {
    const summary = formatUnrestorableSummary(planFor(["s1"]), {
      set: "photos",
      reportPath: "C:\\Users\\me\\.s3cab\\forget-unrestorable-preview.txt",
    });

    const lines = summary.split("\n");
    assert.equal(
      lines.at(-1),
      "  C:\\Users\\me\\.s3cab\\forget-unrestorable-preview.txt",
    );
    assert.equal(lines.at(-2), "Full list:");
  });

  it("uses the same table for one snapshot as for several", () => {
    // One layout whatever the count: the single case is a one-row table whose
    // total repeats it — redundant, never unclear, and one code path.
    const summary = formatUnrestorableSummary(planFor(["s1"]), {
      set: "photos",
      reportPath: "/tmp/r.txt",
    });

    // Only `only-s1.jpg` orphans: `shared.jpg` survives in s2, which isn't in
    // the selection. The row and the total are identical — the redundancy the
    // single case accepts in exchange for one layout and one code path.
    assert.match(summary, /^ {2}s1 +1 file +1\.0MB$/m);
    assert.match(summary, /^ {2}total unrestorable +1 file +1\.0MB$/m);
    // Nothing in the selection to share content with, so no shared line.
    assert.doesNotMatch(summary, /shared across/);
  });

  it("breaks several snapshots down per snapshot with a distinct shared line", () => {
    const summary = formatUnrestorableSummary(planFor(["s1", "s2"]), {
      set: "photos",
      reportPath: "/tmp/r.txt",
    });

    assert.match(summary, /^ {2}s1 +1 file +1\.0MB$/m);
    assert.match(summary, /^ {2}s2 +0 files +0B$/m);
    assert.match(summary, /^ {2}shared across 2 snapshots +1 file +4\.0MB$/m);
    assert.match(summary, /^ {2}total unrestorable +2 files +5\.0MB$/m);
  });

  it("warns when the deletion takes out the set's last snapshot", () => {
    const summary = formatUnrestorableSummary(planFor(["s1", "s2", "s3"]), {
      set: "photos",
      reportPath: "/tmp/r.txt",
    });

    assert.match(summary, /last remote snapshot of set 'photos'/);
    assert.match(summary, /nothing to restore from/);
  });

  it("says so plainly when nothing would become unrestorable", () => {
    const plan = planUnrestorable(
      enumeration({
        photos: { "a.jpg": { hash: "h1", snapshots: ["s1", "s2"] } },
      }),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1", "s2"] },
    );
    const summary = formatUnrestorableSummary(plan, {
      set: "photos",
      reportPath: "/tmp/r.txt",
    });

    assert.match(summary, /nothing would become unrestorable/);
    assert.match(summary, /also held elsewhere/);
  });

  it("caveats the numbers when a snapshot would not read", () => {
    const plan = planUnrestorable(
      enumeration(
        { photos: { "a.jpg": { hash: "h1", snapshots: ["s1"] } } },
        { photos: [{ snapshot: "s9", reason: "zstd" }] },
      ),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1"] },
    );
    const summary = formatUnrestorableSummary(plan, {
      set: "photos",
      reportPath: "/tmp/r.txt",
    });

    // The direction of the error is the part worth saying.
    assert.match(summary, /may overstate what becomes unrestorable/);
    assert.match(summary, /photos\/s9/);
  });
});

describe("formatUnrestorableReport", () => {
  it("lists every unrestorable file with the snapshots that referenced it, and no size", () => {
    const plan = planUnrestorable(
      enumeration({
        photos: {
          "b.jpg": { hash: "h2", size: 200, snapshots: ["s2"] },
          "a.jpg": { hash: "h1", size: 100, snapshots: ["s1", "s2"] },
        },
      }),
      { set: "photos", snapshots: ["s1", "s2"], remoteSnapshots: ["s1", "s2"] },
    );
    const report = formatUnrestorableReport(plan, {
      set: "photos",
      bucket: "b1",
      snapshots: ["s1", "s2"],
      generated: "2026-07-19T024107",
    });

    const rows = report.split("\n").filter((l) => l && !l.startsWith("#"));
    // Sorted by path, so the file is stable run to run. Two columns only —
    // a per-row size would invite a sum that overstates the space (dedup).
    assert.deepEqual(rows, ["s1,s2\ta.jpg", "s2\tb.jpg"]);
    assert.match(report, /# set: +photos/);
    assert.match(report, /# bucket: +b1/);
    assert.match(report, /s3cab cleanup b1/);
  });

  it("puts the only trustworthy total in the header, files and objects apart", () => {
    // Two paths, one object: the file count and the object count must differ, so
    // nobody reads the file count as a measure of space.
    const plan = planUnrestorable(
      enumeration({
        photos: {
          "a.jpg": { hash: "h1", size: 900, snapshots: ["s1"] },
          "copy.jpg": { hash: "h1", size: 900, snapshots: ["s1"] },
        },
      }),
      { set: "photos", snapshots: ["s1"], remoteSnapshots: ["s1"] },
    );
    const report = formatUnrestorableReport(plan, {
      set: "photos",
      bucket: "b1",
      snapshots: ["s1"],
      generated: "2026-07-19T024107",
    });

    assert.match(report, /# 2 files, holding 900B across 1 stored object\./);
    assert.match(report, /identical content is stored once/);
  });
});

describe("formatForcedReport", () => {
  it("records that a --force run happened and that the analysis is missing", () => {
    // An audit trail that silently omits the runs which bypassed the safety is
    // worse than one that names the gap.
    const report = formatForcedReport({
      set: "photos",
      bucket: "b1",
      snapshots: ["s1", "s2"],
      generated: "2026-07-19T024107",
    });

    assert.match(report, /no unrestorable check \(--force\)/);
    assert.match(report, /# snapshots: +s1, s2/);
    assert.match(report, /never computed/);
    assert.match(report, /s3cab cleanup b1/);
  });
});
