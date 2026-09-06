import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enumeration } from "../../test/helpers/enumeration.mjs";
import { GRACE_MS, planCleanup } from "./cleanup.mjs";

// Pure unit tests for cleanup's diff core — the orphan set-difference, the grace
// window, and the missing/damaged/unreadable tallies — with no S3 and no injected
// clock (the S3 reads are integration-tested via test/integration/remote.test.mjs; the
// command shell's aborts/prompt/deletes are covered in commands/cleanup.test.mjs).
// See docs/design/backup.md.

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
    const referenced = enumeration({
      photos: { s1: { "/k": ["kept", 10] } },
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

    const plan = planCleanup(enumeration({}), stored, { now: NOW });

    assert.deepEqual(plan.orphanHashes, ["exactly-grace"]);
    assert.equal(plan.withinGrace, 1);
  });

  it("protects an object with no lastModified (treated as brand new)", () => {
    const stored = store([["ageless", 5, undefined]]);

    const plan = planCleanup(enumeration({}), stored, { now: NOW });

    assert.deepEqual(plan.orphanHashes, []);
    assert.equal(plan.withinGrace, 1);
  });

  it("counts a missing hash referenced by several sets once", () => {
    // The same referenced-but-absent object in two sets is one lost object.
    const referenced = enumeration({
      photos: { s1: { "/p": ["shared-missing", 1] } },
      docs: { s1: { "/d": ["shared-missing", 1] } },
    });

    const plan = planCleanup(referenced, store([]), { now: NOW });

    assert.equal(plan.missing, 1);
    assert.equal(plan.referencedObjects, 1);
  });

  it("does not count a recorded deletion as missing — deliberately absent (ADR-0064)", () => {
    // Without this, the first path-scoped `delete` would trip interlock #2
    // ("repository is losing data") on every cleanup reclaim forever.
    const referenced = enumeration({
      photos: { s1: { "/deleted": ["gone", 1], "/vanished": ["lost", 1] } },
    });

    const plan = planCleanup(referenced, store([]), {
      now: NOW,
      deleted: new Set(["gone"]),
    });

    assert.equal(plan.missing, 1); // only the unexplained absence counts
  });

  it("flags a stored object at the wrong size as damaged, not missing or orphaned", () => {
    const referenced = enumeration({
      photos: { s1: { "/k": ["kept", 1] } },
    });
    const stored = store([["kept", 999, daysAgo(30)]]); // recorded 1, stored 999

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
    assert.deepEqual(plan.orphanHashes, []); // it's referenced
  });

  it("flags a hash damaged when any of its paths disagrees on size (torn snapshot file)", () => {
    // One hash under two paths recorded at different sizes; stored matches only /a.
    const referenced = enumeration({
      photos: { s1: { "/a": ["h", 1], "/b": ["h", 2] } },
    });
    const stored = store([["h", 1, daysAgo(30)]]);

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
  });

  it("counts a hash damaged when a LATER set records the wrong size (cross-set)", () => {
    // Same content in two sets; set 'a' records the right size, set 'b' a torn one.
    // The first-set-wins short-circuit must not hide the later disagreement.
    const referenced = enumeration({
      a: { s1: { "/a": ["h", 10] } },
      b: { s1: { "/b": ["h", 999] } },
    });
    const stored = store([["h", 10, daysAgo(30)]]); // stored matches only /a

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
  });

  it("surfaces unreadable snapshots structurally (the command decides to abort)", () => {
    const referenced = enumeration(
      { photos: { s1: { "/k": ["kept", 1] } } },
      { photos: [{ snapshot: "bad", reason: "boom" }] },
    );
    const stored = store([["orphan", 1, daysAgo(9)]]);

    const plan = planCleanup(referenced, stored, { now: NOW });

    assert.deepEqual(plan.unreadable, ["photos/bad"]);
    // The plan still computes — it never throws; interlock policy is the command's.
    assert.deepEqual(plan.orphanHashes, ["orphan"]);
  });

  it("defaults now to the wall clock when omitted", () => {
    // A very old orphan is past grace under any real clock — proves the default fires.
    const stored = store([["ancient", 1, new Date(0)]]);

    const plan = planCleanup(enumeration({}), stored);

    assert.deepEqual(plan.orphanHashes, ["ancient"]);
  });
});
