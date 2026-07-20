import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deletionRows,
  formatDeletePreviewFile,
  formatDeleteSummary,
  planDelete,
} from "./delete.mjs";

/** @import { ReferencedResult } from "./verify.mjs" */

// planDelete is the safety-critical arithmetic of the deletion rework
// (ADR-0064): which stored objects the named paths doom, and — more important
// — which references *protect* an object from going. Pure, so every edge is
// pinned here with no mocks: the scope rule (participating sets only), the
// whole-selection evaluation, the --everywhere override and its
// resolve-in-scope-only constraint, and the no-match bookkeeping behind the
// loud error. The command shell around it is covered in
// commands/delete.test.mjs.

/**
 * A ReferencedResult from `{ hash: [path, ...] }` — every path recorded at
 * `size` (default 10), from one snapshot `s1`.
 * @param {Record<string, string[]>} spec
 * @param {{ size?: number, unreadable?: { snapshot: string, reason: string }[] }} [options]
 * @returns {ReferencedResult}
 */
const ref = (spec, { size = 10, unreadable = [] } = {}) => ({
  referenced: new Map(
    Object.entries(spec).map(([hash, paths]) => [
      hash,
      {
        paths: new Map(
          paths.map((path) => [
            path,
            { sizes: new Set([size]), snapshots: new Set(["s1"]) },
          ]),
        ),
      },
    ]),
  ),
  snapshotsChecked: 1,
  unreadable,
});

/** @param {[string, ReferencedResult][]} sets */
const bucket = (sets) => new Map(sets);

describe("planDelete", () => {
  it("deletes content referenced only under the named paths, with its references and totals", () => {
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/doomed.txt", "/data/doomed-copy.txt"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    assert.equal(plan.deletable.length, 1);
    assert.equal(plan.deletable[0]?.hash, "aaa");
    assert.equal(plan.totalFiles, 2); // two paths, one object
    assert.equal(plan.totalBytes, 10); // bytes once per object, not per path
    assert.deepEqual(plan.survivors, []);
    assert.deepEqual(plan.unmatchedPaths, []);
    assert.deepEqual(plan.bySet, [{ set: "mine", files: 2, inScope: true }]);
  });

  it("protects content referenced by a set not in scope — even under the same path string", () => {
    // The cross-user guarantee: an unattached set's reference keeps the object,
    // and an identical absolute path over there is a namesake, not consent.
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/file.txt"] })],
        ["theirs", ref({ aaa: ["/data/file.txt"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    assert.deepEqual(plan.deletable, []);
    assert.equal(plan.survivors.length, 1);
    assert.deepEqual(plan.survivors[0], {
      path: "/data/file.txt",
      set: "mine",
      keptBy: { set: "theirs", path: "/data/file.txt" },
    });
    // The named path *did* match something, so it must not read as a typo.
    assert.deepEqual(plan.unmatchedPaths, []);
  });

  it("protects content the same set still references under a path outside the selection", () => {
    const plan = planDelete(
      bucket([["mine", ref({ aaa: ["/data/x.txt", "/keep/copy.txt"] })]]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    assert.deepEqual(plan.deletable, []);
    assert.deepEqual(plan.survivors[0]?.keptBy, {
      set: "mine",
      path: "/keep/copy.txt",
    });
  });

  it("deletes across participating sets in one run, counting a shared path once", () => {
    // Two of *my* sets both hold /data/x.txt — the "same folder backed up from
    // two of my machines" case bucket-wide matching exists for.
    const plan = planDelete(
      bucket([
        ["desktop", ref({ aaa: ["/data/x.txt"] })],
        ["laptop", ref({ aaa: ["/data/x.txt"] })],
      ]),
      { paths: ["/data"], scopeSets: ["desktop", "laptop"] },
    );
    assert.equal(plan.deletable.length, 1);
    assert.equal(plan.totalFiles, 1); // same path in two sets = one file
    assert.deepEqual(plan.bySet, [
      { set: "desktop", files: 1, inScope: true },
      { set: "laptop", files: 1, inScope: true },
    ]);
  });

  it("evaluates the whole selection at once — content shared by two named paths goes", () => {
    // Judged per path independently, each would see the other's reference as a
    // protector; over the selection, both are going, so nothing protects it.
    const plan = planDelete(
      bucket([["mine", ref({ aaa: ["/a/x.txt", "/b/y.txt"] })]]),
      { paths: ["/a", "/b"], scopeSets: ["mine"] },
    );
    assert.equal(plan.deletable.length, 1);
    // Matched by both named paths → attributed to the shared row, not either path.
    assert.deepEqual(
      plan.byPath.map((p) => p.files),
      [0, 0],
    );
    assert.equal(plan.sharedFiles, 2);
    assert.equal(plan.sharedBytes, 10);
  });

  it("attributes objects matched by exactly one named path to that path", () => {
    const plan = planDelete(
      bucket([["mine", ref({ aaa: ["/a/x.txt"], bbb: ["/b/y.txt"] })]]),
      { paths: ["/a", "/b"], scopeSets: ["mine"] },
    );
    assert.deepEqual(plan.byPath, [
      { path: "/a", files: 1, bytes: 10 },
      { path: "/b", files: 1, bytes: 10 },
    ]);
    assert.equal(plan.sharedFiles, 0);
  });

  it("--everywhere overrides protection, keeping every reference as a record row", () => {
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/secret.env"] })],
        ["theirs", ref({ aaa: ["/other/copy.env"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"], everywhere: true },
    );
    assert.equal(plan.deletable.length, 1);
    assert.deepEqual(plan.survivors, []);
    // The collateral set is named — the summary's WARNING and the record's rows
    // both come from here.
    assert.deepEqual(plan.bySet, [
      { set: "mine", files: 1, inScope: true },
      { set: "theirs", files: 1, inScope: false },
    ]);
    assert.equal(plan.totalFiles, 2); // their path becomes unrestorable too
    const refs = plan.deletable[0]?.refs ?? [];
    assert.deepEqual(
      refs.map((r) => [r.set, r.path, r.inSelection]),
      [
        ["mine", "/data/secret.env", true],
        ["theirs", "/other/copy.env", false],
      ],
    );
  });

  it("--everywhere still resolves paths in the participating sets only — a stranger's namesake content is untouched", () => {
    // theirs holds *different* content under the same path string; only the
    // content MY sets recorded there may be nuked.
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/secret.env"] })],
        ["theirs", ref({ bbb: ["/data/secret.env"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"], everywhere: true },
    );
    assert.deepEqual(
      plan.deletable.map((o) => o.hash),
      ["aaa"],
    );
  });

  it("reports named paths that match nothing — including one that only a stranger's set has", () => {
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/x.txt"] })],
        ["theirs", ref({ bbb: ["/elsewhere/y.txt"] })],
      ]),
      {
        paths: ["/data", "/typo", "/elsewhere"],
        scopeSets: ["mine"],
      },
    );
    // /typo names nothing anywhere; /elsewhere exists only out of scope — both
    // are "not backed up here" as far as this machine's delete is concerned.
    assert.deepEqual(plan.unmatchedPaths, ["/typo", "/elsewhere"]);
  });

  it("a blank or separator-only path matches nothing (never everything)", () => {
    const plan = planDelete(bucket([["mine", ref({ aaa: ["/data/x.txt"] })]]), {
      paths: ["", "/"],
      scopeSets: ["mine"],
    });
    assert.deepEqual(plan.deletable, []);
    assert.deepEqual(plan.unmatchedPaths, ["", "/"]);
  });

  it("a snapshot-name operand (old forget muscle memory) matches nothing", () => {
    const plan = planDelete(bucket([["mine", ref({ aaa: ["/data/x.txt"] })]]), {
      paths: ["2026-07-19T1422"],
      scopeSets: ["mine"],
    });
    assert.deepEqual(plan.unmatchedPaths, ["2026-07-19T1422"]);
  });

  it("reports the size as the largest any snapshot row records (never understate)", () => {
    /** @type {ReferencedResult} */
    const torn = {
      referenced: new Map([
        [
          "aaa",
          {
            paths: new Map([
              [
                "/data/x.txt",
                { sizes: new Set([10, 999]), snapshots: new Set(["s1", "s2"]) },
              ],
            ]),
          },
        ],
      ]),
      snapshotsChecked: 2,
      unreadable: [],
    };
    const plan = planDelete(bucket([["mine", torn]]), {
      paths: ["/data"],
      scopeSets: ["mine"],
    });
    assert.equal(plan.totalBytes, 999);
  });

  it("passes unreadable snapshots through as data for the command's interlock", () => {
    const plan = planDelete(
      bucket([
        [
          "mine",
          ref(
            { aaa: ["/data/x.txt"] },
            { unreadable: [{ snapshot: "s0", reason: "zstd" }] },
          ),
        ],
      ]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    assert.deepEqual(plan.unreadable, [
      { set: "mine", snapshot: "s0", reason: "zstd" },
    ]);
  });
});

describe("deletionRows", () => {
  it("emits one row per (hash, path), de-duplicated across sets and sorted by path", () => {
    const plan = planDelete(
      bucket([
        ["desktop", ref({ aaa: ["/data/b.txt", "/data/a.txt"] })],
        ["laptop", ref({ aaa: ["/data/a.txt"] })],
      ]),
      { paths: ["/data"], scopeSets: ["desktop", "laptop"] },
    );
    assert.deepEqual(deletionRows(plan), [
      { hash: "aaa", path: "/data/a.txt" },
      { hash: "aaa", path: "/data/b.txt" },
    ]);
  });
});

describe("formatDeleteSummary", () => {
  const context = { everywhere: false, reportPath: "/tmp/preview.txt" };

  it("says plainly when everything matched survives, and how to widen the scope", () => {
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/x.txt"] })],
        ["theirs", ref({ aaa: ["/other/y.txt"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    const text = formatDeleteSummary(plan, context);
    assert.match(text, /nothing to delete/);
    assert.match(text, /kept by set 'theirs' \(1 file\)/);
    assert.match(text, /s3cab reattach <set>/);
    assert.match(text, /Full list:\n {2}\/tmp\/preview\.txt$/);
  });

  it("tables the per-path breakdown with a total and names the sets losing files", () => {
    const plan = planDelete(
      bucket([["mine", ref({ aaa: ["/a/x.txt"], bbb: ["/b/y.txt"] })]]),
      { paths: ["/a", "/b"], scopeSets: ["mine"] },
    );
    const text = formatDeleteSummary(plan, context);
    assert.match(text, /files no backup could restore/);
    assert.match(text, /\/a +1 file +10B/);
    assert.match(text, /total +2 files +20B +\(2 stored objects\)/);
    assert.match(text, /Sets losing these files: mine \(2 files\)/);
    assert.doesNotMatch(text, /WARNING/);
  });

  it("shouts the out-of-scope sets an --everywhere run breaks", () => {
    const plan = planDelete(
      bucket([
        ["mine", ref({ aaa: ["/data/secret.env"] })],
        ["theirs", ref({ aaa: ["/other/copy.env"] })],
      ]),
      { paths: ["/data"], scopeSets: ["mine"], everywhere: true },
    );
    const text = formatDeleteSummary(plan, { ...context, everywhere: true });
    assert.match(
      text,
      /WARNING \(--everywhere\).*breaks restorability in sets not set up on this machine:\n {2}theirs {2}\(1 file\)/s,
    );
  });
});

describe("formatDeletePreviewFile", () => {
  it("banners that nothing happened, embeds the would-be record, then the survivors", () => {
    const plan = planDelete(
      bucket([
        [
          "mine",
          ref({ aaa: ["/data/x.txt"], bbb: ["/data/y.txt", "/keep/y.txt"] }),
        ],
      ]),
      { paths: ["/data"], scopeSets: ["mine"] },
    );
    const text = formatDeletePreviewFile(plan, "# the-record-body\n");
    assert.match(text, /^# PREVIEW — nothing has been deleted/);
    assert.ok(text.includes("# the-record-body"));
    assert.match(
      text,
      /# kept-by\tpath\nset 'mine': \/keep\/y\.txt\t\/data\/y\.txt/,
    );
  });
});
