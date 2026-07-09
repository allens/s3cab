import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRACE_MS, planCleanup } from "./cleanup.mjs";

// Pure unit tests for cleanup's diff core — the orphan set-difference, the grace
// window, and the missing/damaged/unreadable tallies — with no S3 and no injected
// clock (the S3 reads are integration-tested via remote.integration.test.mjs; the
// command shell's aborts/prompt/deletes are covered in commands/cleanup.test.mjs).
// See docs/design/backup.md.

/**
 * Build a per-set referenced map from a compact spec: `{ set: { hash: [{ path,
 * size, snapshots }] } }`. `size` may be an array to record one path at several
 * sizes (a torn snapshot file). `unreadable` staged per set via a second arg.
 * @param {Record<string, Record<string, { path: string, size: number | number[], snapshots: string[] }[]>>} spec
 * @param {Record<string, { snapshot: string, reason: string }[]>} [unreadableBySet]
 */
function refs(spec, unreadableBySet = {}) {
  const bySet = new Map();
  for (const [set, hashes] of Object.entries(spec)) {
    const referenced = new Map();
    for (const [hash, paths] of Object.entries(hashes)) {
      const pathMap = new Map();
      for (const { path, size, snapshots } of paths) {
        pathMap.set(path, {
          sizes: new Set(Array.isArray(size) ? size : [size]),
          snapshots: new Set(snapshots),
        });
      }
      referenced.set(hash, { paths: pathMap });
    }
    bySet.set(set, {
      referenced,
      snapshotsChecked: 1,
      unreadable: unreadableBySet[set] ?? [],
    });
  }
  return bySet;
}

const NOW = 1_700_000_000_000; // fixed clock so the grace window is deterministic
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (/** @type {number} */ d) => new Date(NOW - d * DAY);

/** @param {[string, number, Date?][]} rows - [hash, size, lastModified?] */
const store = (rows) =>
  new Map(
    rows.map(([hash, size, lastModified]) => [hash, { size, lastModified }]),
  );

describe("planCleanup", () => {
  it("returns orphans past the grace window and protects those within it", () => {
    const referenced = refs({
      photos: { kept: [{ path: "/k", size: 10, snapshots: ["s1"] }] },
    });
    const stored = store([
      ["kept", 10, daysAgo(30)], // referenced — never an orphan
      ["old-orphan", 100, daysAgo(8)], // unreferenced, past grace
      ["new-orphan", 999, daysAgo(1)], // unreferenced, within grace
    ]);

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.deepEqual(plan.orphanHashes, ["old-orphan"]);
    assert.equal(plan.reclaimableBytes, 100);
    assert.equal(plan.withinGrace, 1);
    assert.equal(plan.storedObjects, 3);
    assert.equal(plan.referencedObjects, 1);
    assert.equal(plan.missing, 0);
    assert.equal(plan.damaged, 0);
  });

  it("treats the grace window as a strict floor measured from now", () => {
    const stored = store([
      ["exactly-grace", 1, new Date(NOW - GRACE_MS)], // ageMs === GRACE_MS → not < → orphan
      ["just-inside", 1, new Date(NOW - GRACE_MS + 1)], // ageMs < GRACE_MS → protected
    ]);

    const plan = planCleanup(refs({}), stored, { now: NOW });

    assert.deepEqual(plan.orphanHashes, ["exactly-grace"]);
    assert.equal(plan.withinGrace, 1);
  });

  it("protects an object with no lastModified (treated as brand new)", () => {
    const stored = store([["ageless", 5, undefined]]);

    const plan = planCleanup(refs({}), stored, { now: NOW });

    assert.deepEqual(plan.orphanHashes, []);
    assert.equal(plan.withinGrace, 1);
  });

  it("counts a missing hash referenced by several sets once", () => {
    // The same referenced-but-absent object in two sets is one lost object.
    const referenced = refs({
      photos: {
        "shared-missing": [{ path: "/p", size: 1, snapshots: ["s1"] }],
      },
      docs: { "shared-missing": [{ path: "/d", size: 1, snapshots: ["s1"] }] },
    });

    const plan = planCleanup(referenced, store([]), { now: NOW });

    assert.equal(plan.missing, 1);
    assert.equal(plan.referencedObjects, 1);
  });

  it("flags a stored object at the wrong size as damaged, not missing or orphaned", () => {
    const referenced = refs({
      photos: { kept: [{ path: "/k", size: 1, snapshots: ["s1"] }] },
    });
    const stored = store([["kept", 999, daysAgo(30)]]); // recorded 1, stored 999

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
    assert.deepEqual(plan.orphanHashes, []); // it's referenced
  });

  it("flags a hash damaged when any of its paths disagrees on size (torn snapshot file)", () => {
    // One hash under two paths recorded at different sizes; stored matches only /a.
    const referenced = refs({
      photos: {
        h: [
          { path: "/a", size: 1, snapshots: ["s1"] },
          { path: "/b", size: 2, snapshots: ["s1"] },
        ],
      },
    });
    const stored = store([["h", 1, daysAgo(30)]]);

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
  });

  it("surfaces unreadable snapshots structurally (the command decides to abort)", () => {
    const referenced = refs(
      { photos: { kept: [{ path: "/k", size: 1, snapshots: ["s1"] }] } },
      { photos: [{ snapshot: "bad", reason: "boom" }] },
    );
    const stored = store([["orphan", 1, daysAgo(9)]]);

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.deepEqual(plan.unreadable, [
      { set: "photos", snapshot: "bad", reason: "boom" },
    ]);
    // The plan still computes — it never throws; interlock policy is the command's.
    assert.deepEqual(plan.orphanHashes, ["orphan"]);
  });

  it("defaults now to the wall clock when omitted", () => {
    // A very old orphan is past grace under any real clock — proves the default fires.
    const stored = store([["ancient", 1, new Date(0)]]);

    const plan = planCleanup(refs({}), stored);

    assert.deepEqual(plan.orphanHashes, ["ancient"]);
  });
});
