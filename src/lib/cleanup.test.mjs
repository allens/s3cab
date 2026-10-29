import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enumeration } from "../../test/helpers/enumeration.mjs";
import { planCleanup, topUp } from "./cleanup.mjs";

// Pure unit tests for cleanup's diff core — the orphan set-difference, the
// missing/damaged/unreadable tallies, and the top-up that takes a just-landed
// snapshot's objects back off the orphan list — with no S3 (the S3 reads are
// integration-tested via test/integration/remote.test.mjs; the command shell's
// aborts/prompt/deletes are covered in commands/cleanup.test.mjs, the lock in
// locks.test.mjs). See docs/design/backup.md.

/** @param {[string, number][]} rows - [hash, size] */
const store = (rows) => new Map(rows.map(([hash, size]) => [hash, { size }]));

describe("planCleanup", () => {
  it("returns every unreferenced object as an orphan, with the bytes they hold", () => {
    const referenced = enumeration({
      photos: { s1: { "/k": ["kept", 10] } },
    });
    const stored = store([
      ["kept", 10], // referenced — never an orphan
      ["orphan-1", 100],
      ["orphan-2", 999],
    ]);

    const plan = planCleanup(referenced, stored);

    assert.deepEqual(plan.orphanHashes, ["orphan-1", "orphan-2"]);
    assert.equal(plan.reclaimableBytes, 1099);
    assert.equal(plan.storedObjects, 3);
    assert.equal(plan.referencedObjects, 1);
    assert.equal(plan.missing, 0);
    assert.equal(plan.damaged, 0);
  });

  it("counts a missing hash referenced by several sets once", () => {
    // The same referenced-but-absent object in two sets is one lost object.
    const referenced = enumeration({
      photos: { s1: { "/p": ["shared-missing", 1] } },
      docs: { s1: { "/d": ["shared-missing", 1] } },
    });

    const plan = planCleanup(referenced, store([]));

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
      deleted: new Set(["gone"]),
    });

    assert.equal(plan.missing, 1); // only the unexplained absence counts
  });

  it("flags a stored object at the wrong size as damaged, not missing or orphaned", () => {
    const referenced = enumeration({
      photos: { s1: { "/k": ["kept", 1] } },
    });
    const stored = store([["kept", 999]]); // recorded 1, stored 999

    const plan = planCleanup(referenced, stored);

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
    assert.deepEqual(plan.orphanHashes, []); // it's referenced
  });

  it("flags a hash damaged when any of its paths disagrees on size (torn snapshot file)", () => {
    // One hash under two paths recorded at different sizes; stored matches only /a.
    const referenced = enumeration({
      photos: { s1: { "/a": ["h", 1], "/b": ["h", 2] } },
    });
    const stored = store([["h", 1]]);

    const plan = planCleanup(referenced, stored);

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
    const stored = store([["h", 10]]); // stored matches only /a

    const plan = planCleanup(referenced, stored);

    assert.equal(plan.damaged, 1);
    assert.equal(plan.missing, 0);
  });

  it("surfaces unreadable snapshots structurally (the command decides to abort)", () => {
    const referenced = enumeration(
      { photos: { s1: { "/k": ["kept", 1] } } },
      { photos: [{ snapshot: "bad", reason: "boom" }] },
    );
    const stored = store([["orphan", 1]]);

    const plan = planCleanup(referenced, stored);

    assert.deepEqual(plan.unreadable, ["photos/bad"]);
    // The plan still computes — it never throws; interlock policy is the command's.
    assert.deepEqual(plan.orphanHashes, ["orphan"]);
  });
});

// The top-up (ADR-0112): a backup that finished between the scan and the
// delete lock published a snapshot the plan never saw. Its objects were
// orphans to the plan; once read, they are referenced, and the keep-set the
// deletion record is trimmed against grows by the same hashes.
describe("topUp", () => {
  const stored = store([
    ["kept", 10],
    ["landed", 100], // a just-finished backup's object
    ["orphan", 7],
  ]);
  const plan = planCleanup(
    enumeration({ photos: { s1: { "/k": ["kept", 10] } } }),
    stored,
  );

  it("takes a newly referenced object off the orphan list and into the keep-set", () => {
    assert.deepEqual(plan.orphanHashes, ["landed", "orphan"]);

    const topped = topUp(
      plan,
      stored,
      enumeration({ photos: { s2: { "/new": ["landed", 100] } } }),
    );

    assert.deepEqual(topped.orphanHashes, ["orphan"]);
    assert.equal(topped.reclaimableBytes, 7);
    assert.deepEqual(topped.referencedHashes, new Set(["kept", "landed"]));
    assert.equal(topped.referencedObjects, 2);
  });

  it("changes nothing when no snapshot landed", () => {
    const topped = topUp(plan, stored, new Map());

    assert.deepEqual(topped.orphanHashes, plan.orphanHashes);
    assert.equal(topped.reclaimableBytes, plan.reclaimableBytes);
    assert.deepEqual(topped.referencedHashes, plan.referencedHashes);
  });

  it("leaves the plan it was given untouched", () => {
    topUp(
      plan,
      stored,
      enumeration({ photos: { s2: { "/new": ["landed", 100] } } }),
    );

    assert.deepEqual(plan.orphanHashes, ["landed", "orphan"]);
    assert.deepEqual(plan.referencedHashes, new Set(["kept"]));
  });
});
