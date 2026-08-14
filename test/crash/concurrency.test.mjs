import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  bucket,
  bucketViolations,
  inspector,
  makeTree,
  nextZone,
  release,
  restoreAndCompare,
  s3cab,
  s3cabAsync,
  seedSet,
  waitForFile,
  wipeBucket,
} from "./harness.mjs";
import { captureTree } from "../model/harness/model.mjs";

/** @import { ChildOptions } from "./harness.mjs" */

// The concurrency half of prompt #4: genuinely multi-process — every actor is
// the real CLI in its own child process with its own `S3CAB_HOME` (a separate
// simulated machine), against the one real crash bucket. Determinism comes
// from killswitch holds: a child parks *before issuing* its nth matching S3
// request (writing a "reached" marker, then polling for a gate file), so the
// interleaving under test is forced, not hoped for.
//
// Each case names its verdict up front: a scenario that is *safe* names the
// mechanism that makes it safe; a scenario that *breaks* is a pin of the
// residual hole (proposals/concurrency-and-locking.md §1) — those assertions
// flip when a fix lands, exactly like test/model/model.findings.test.mjs.

const SCRATCH = resolve("test", ".tmp-concurrency");

/** Fresh per-case scratch dir. @param {string} name */
function freshScratch(name) {
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TREE = {
  "a.txt": "alpha content",
  "b.txt": "beta content",
  "sub/c.txt": "gamma content",
  "sub/d.txt": "delta content",
};

/** Objects currently under objects/. */
async function objectKeys() {
  return (await inspector.listAll(bucket))
    .map(({ key }) => key)
    .filter((key) => key.startsWith("objects/"));
}

/** Manifests currently under snapshots/. */
async function manifestKeys() {
  return (await inspector.listAll(bucket))
    .map(({ key }) => key)
    .filter((key) => key.startsWith("snapshots/"));
}

/**
 * Start a held child and wait until it parks at its hold point.
 * @param {string[]} args
 * @param {ChildOptions & { scratch: string, id: string }} options
 */
async function holdAt(args, { scratch, id, ...child }) {
  const gate = join(scratch, `${id}.gate`);
  const reached = join(scratch, `${id}.reached`);
  const running = s3cabAsync(args, {
    ...child,
    holdGate: gate,
    holdReached: reached,
  });
  await waitForFile(reached);
  return { ...running, gate };
}

describe("concurrency: backup vs backup", () => {
  it("different sets, shared content: the object-PUT race is safe (content addressing + benign 412)", async () => {
    const scratch = freshScratch("bb-shared-content");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }
    seedSet(homeA, "seta", [data]);
    seedSet(homeB, "setb", [data]);
    const expected = captureTree([data]);

    // A lists the (empty) store and parks before its first object PUT — its
    // upload plan is now stale. B then backs up the same content to its own
    // set, storing every object A still intends to upload.
    const a = await holdAt(["backup", "seta"], {
      scratch,
      id: "a",
      home: homeA,
      tz: nextZone(),
      hold: "1:PUT:^/objects/",
      log: join(scratch, "trace-a.log"),
      tag: "A",
    });
    const b = s3cab(["backup", "setb"], { home: homeB, tz: nextZone() });
    assert.equal(b.status, 0, b.stderr);

    // A resumes: every object PUT hits an existing key. The no-clobber
    // conditional PUT answers 412, which src/lib/s3.mjs:putFile treats as
    // "already stored" — the mechanism that makes cross-machine dedup safe.
    release(a.gate);
    const aDone = await a.done;
    assert.equal(aDone.status, 0, aDone.stderr);

    assert.deepEqual(await bucketViolations(), []);
    for (const set of ["seta", "setb"]) {
      const { violations } = restoreAndCompare({
        set,
        scratch,
        expected,
        dirs: [data],
      });
      assert.deepEqual(violations, [], `restore of '${set}'`);
    }
  });

  it("same set, same snapshot name: the manifest no-clobber race has exactly one winner", async () => {
    const scratch = freshScratch("bb-same-name");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const dataA = join(scratch, "dataA");
    const dataB = join(scratch, "dataB");
    makeTree(dataA, TREE);
    makeTree(dataB, { ...TREE, "sub/d.txt": "DIFFERENT delta on machine B" });
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }
    seedSet(homeA, "s", [dataA]);
    seedSet(homeB, "s", [dataB]);

    // Same fixed zone → same minute-precision snapshot name (the two spawns
    // are seconds apart). Both park before the manifest PUT; A commits first.
    const tz = "Etc/GMT-1";
    const a = await holdAt(["backup", "s"], {
      scratch,
      id: "a",
      home: homeA,
      tz,
      hold: "1:PUT:^/snapshots/",
    });
    const b = await holdAt(["backup", "s"], {
      scratch,
      id: "b",
      home: homeB,
      tz,
      hold: "1:PUT:^/snapshots/",
    });
    release(a.gate);
    const aDone = await a.done;
    assert.equal(aDone.status, 0, aDone.stderr);
    release(b.gate);
    const bDone = await b.done;

    const manifests = await manifestKeys();
    if (bDone.status === 0 && manifests.length === 2) {
      // The two spawns straddled a minute boundary, so the names never
      // collided and there was no race to lose. Rare; rerun covers it.
      console.warn(
        "  [bb-same-name] minute boundary crossed — inconclusive run",
      );
      return;
    }

    // The no-clobber manifest PUT (IfNoneMatch: "*") is the atomic gate:
    // exactly one manifest exists and the loser failed loudly.
    assert.equal(manifests.length, 1, manifests.join(", "));
    assert.notEqual(bDone.status, 0, "the losing racer must not exit 0");
    console.warn(
      `  [bb-same-name] loser stderr tail: ${bDone.stderr.trim().split("\n").slice(-6).join(" | ")}`,
    );

    // B's differing object was already uploaded before the hold — an
    // unreferenced object inside the grace window, which is legal store shape.
    assert.deepEqual(await bucketViolations(), []);
  });
});

describe("concurrency: cleanup vs in-flight backup", () => {
  it("real grace window: crash orphans a fresh backup reuses are protected (safe arm)", async () => {
    const scratch = freshScratch("bc-real-grace");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }
    seedSet(homeA, "s", [data]);
    seedSet(homeB, "s", [data]);

    // Machine A crashes between its last object and the manifest: four
    // orphans, no snapshot.
    const killed = s3cab(["backup", "s"], {
      home: homeA,
      tz: nextZone(),
      kill: "1:PUT:^/snapshots/",
    });
    assert.notEqual(killed.status, 0);
    assert.equal((await objectKeys()).length, 4);

    // Machine B backs up the same content, skips the stored orphans, and
    // parks before its manifest PUT — the §1 window, wide open.
    const b = await holdAt(["backup", "s"], {
      scratch,
      id: "b",
      home: homeB,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
    });

    // cleanup with the REAL seven-day grace runs right through the window.
    const cleanup = s3cab(["cleanup", bucket, "--force"], { home: homeA });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(
      (await objectKeys()).length,
      4,
      "grace must protect the minutes-old orphans",
    );

    release(b.gate);
    const bDone = await b.done;
    assert.equal(bDone.status, 0, bDone.stderr);

    // Safe, and the mechanism is GRACE_MS: an unreferenced object is only
    // swept once it is 7 days old, which no in-flight backup window spans.
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);
  });

  it("PIN §1 residual hole: aged orphans a held backup reuses are swept, publishing dangling refs", async () => {
    const scratch = freshScratch("bc-residual-hole");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }
    seedSet(homeA, "s", [data]);
    seedSet(homeB, "s", [data]);

    // Crash orphans again — but this time aged past a compressed grace
    // (labeled time compression: S3CAB_XGRACE_MS rewrites GRACE_MS in the
    // cleanup child only; the interleaving is the production one).
    const killed = s3cab(["backup", "s"], {
      home: homeA,
      tz: nextZone(),
      kill: "1:PUT:^/snapshots/",
    });
    assert.notEqual(killed.status, 0);
    await new Promise((r) => setTimeout(r, 6_000));

    const b = await holdAt(["backup", "s"], {
      scratch,
      id: "b",
      home: homeB,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
      log: join(scratch, "trace-b.log"),
      tag: "B",
    });

    const cleanup = s3cab(["cleanup", bucket, "--force"], {
      home: homeA,
      graceMs: "4000",
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal((await objectKeys()).length, 0, "the aged orphans were swept");

    // B publishes a manifest whose every reference was just deleted — and
    // exits 0, telling the user the backup succeeded.
    release(b.gate);
    const bDone = await b.done;
    assert.equal(
      bDone.status,
      0,
      "PIN: the doomed backup reports success (flips when a fix lands)",
    );

    const violations = await bucketViolations();
    assert.ok(
      violations.some((v) => /dangl|missing/i.test(v)),
      `PIN: the published manifest dangles (got: ${violations.join("; ") || "none"})`,
    );
    const { violations: restoreViolations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.ok(
      restoreViolations.length > 0,
      "PIN: the snapshot is unrestorable — data loss presented as success",
    );
  });

  it("PIN §1 sharpening: forget+cleanup under a held incremental backup strands its baseline-trusted refs", async () => {
    const scratch = freshScratch("bfc-baseline-trust");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);

    // Backup 1 establishes the baseline; age its objects past the compressed
    // grace the cleanup below will run with.
    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.zst".length,
    );
    assert.ok(m1);
    await new Promise((r) => setTimeout(r, 12_000));

    // Backup 2 (one new file): the baseline trust check HEADs the manifest —
    // it exists — so the four old objects are skipped, then it parks before
    // its own manifest PUT.
    makeTree(data, { "f.txt": "fresh file for backup 2" });
    const b2 = await holdAt(["backup", "s"], {
      scratch,
      id: "b2",
      home,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
      log: join(scratch, "trace-b2.log"),
      tag: "B2",
    });

    // Inside the window: forget the baseline, then sweep. The old objects are
    // now unreferenced and aged out; backup 2's fresh f.txt object is inside
    // grace and survives.
    const forget = s3cab(
      ["forget", "--set", "s", /** @type {string} */ (m1), "--force"],
      { home },
    );
    assert.equal(forget.status, 0, forget.stderr);
    const cleanup = s3cab(["cleanup", bucket, "--force"], {
      home,
      graceMs: "8000",
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(
      (await objectKeys()).length,
      1,
      "the four baseline objects swept; the fresh one kept",
    );

    release(b2.gate);
    const b2Done = await b2.done;
    assert.equal(
      b2Done.status,
      0,
      "PIN: the doomed incremental reports success (flips when a fix lands)",
    );
    const violations = await bucketViolations();
    assert.ok(
      violations.some((v) => /dangl|missing/i.test(v)),
      `PIN: baseline-trusted refs dangle (got: ${violations.join("; ") || "none"})`,
    );
  });
});

describe("concurrency: forget and cleanup", () => {
  it("backup vs forget alone is safe: forget never touches objects/", async () => {
    const scratch = freshScratch("bf-forget-only");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.zst".length,
    );
    assert.ok(m1);

    makeTree(data, { "f.txt": "fresh file for backup 2" });
    const b2 = await holdAt(["backup", "s"], {
      scratch,
      id: "b2",
      home,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
    });
    const forget = s3cab(
      ["forget", "--set", "s", /** @type {string} */ (m1), "--force"],
      { home },
    );
    assert.equal(forget.status, 0, forget.stderr);
    release(b2.gate);
    const b2Done = await b2.done;
    assert.equal(b2Done.status, 0, b2Done.stderr);

    // Safe, and the mechanism is forget's scope: it deletes only
    // snapshots/<set>/ keys, so every object the new manifest re-references
    // is still stored (reclaiming is exclusively cleanup's, behind grace).
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);
  });

  it("cleanup vs forget is safe: snapshots are read before objects, so a mid-run forget cannot expose refs", async () => {
    const scratch = freshScratch("cf-ordering-guard");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.zst".length,
    );
    assert.ok(m1);
    await new Promise((r) => setTimeout(r, 6_000));

    // cleanup reads the snapshot listing + manifests, then parks before its
    // objects LIST. Everything it will sweep is decided by what it already
    // read — which still includes the manifest forget is about to delete.
    const cleanup = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "cleanup",
      home,
      graceMs: "4000",
      hold: "1:GET:prefix=objects",
      log: join(scratch, "trace-cleanup.log"),
      tag: "CLEANUP",
    });
    const forget = s3cab(
      ["forget", "--set", "s", /** @type {string} */ (m1), "--force"],
      { home },
    );
    assert.equal(forget.status, 0, forget.stderr);
    release(cleanup.gate);
    const cleanupDone = await cleanup.done;
    assert.equal(cleanupDone.status, 0, cleanupDone.stderr);

    // Safe, and the mechanism is the ordering guard: snapshots read strictly
    // before the objects LIST means a concurrent forget makes cleanup
    // *conservative* (keeps now-unreferenced objects), never destructive.
    // The next cleanup run, after grace, sweeps them — correctly.
    assert.equal(
      (await objectKeys()).length,
      4,
      "the aged objects survive this cleanup run",
    );
    assert.deepEqual(await bucketViolations(), []);
  });

  it("cleanup vs cleanup is safe: independent plans, idempotent deletes", async () => {
    const scratch = freshScratch("cc-idempotent");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);

    const killed = s3cab(["backup", "s"], {
      home,
      tz: nextZone(),
      kill: "1:PUT:^/snapshots/",
    });
    assert.notEqual(killed.status, 0);
    await new Promise((r) => setTimeout(r, 6_000));

    // Both park before their first orphan DELETE with identical plans, then
    // race the same delete list.
    const one = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "one",
      home,
      graceMs: "4000",
      hold: "1:DELETE:^/objects/",
    });
    const two = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "two",
      home,
      graceMs: "4000",
      hold: "1:DELETE:^/objects/",
    });
    release(one.gate);
    release(two.gate);
    const [oneDone, twoDone] = await Promise.all([one.done, two.done]);
    assert.equal(oneDone.status, 0, oneDone.stderr);
    assert.equal(twoDone.status, 0, twoDone.stderr);

    // Safe, and the mechanism is S3 DeleteObject idempotency: deleting an
    // already-deleted key answers 204, so overlapping sweeps of the same
    // plan cannot fail each other or leave anything behind.
    assert.deepEqual(await objectKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
  });

  it("forget vs forget of the same snapshot is safe: idempotent deletes, double-reported", async () => {
    const scratch = freshScratch("ff-same-name");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    makeTree(data, { "f.txt": "second snapshot filler" });
    const second = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(second.status, 0, second.stderr);
    const names = (await manifestKeys()).map((key) =>
      key.slice("snapshots/s/".length, -".tsv.zst".length),
    );
    const target = /** @type {string} */ (names.sort()[0]);

    // Both pass the all-named-must-exist precheck (both list before either
    // deletes), park before the DELETE, then race it.
    const one = await holdAt(["forget", "--set", "s", target, "--force"], {
      scratch,
      id: "one",
      home,
      hold: "1:DELETE:^/snapshots/",
    });
    const two = await holdAt(["forget", "--set", "s", target, "--force"], {
      scratch,
      id: "two",
      home,
      hold: "1:DELETE:^/snapshots/",
    });
    release(one.gate);
    release(two.gate);
    const [oneDone, twoDone] = await Promise.all([one.done, two.done]);

    // Safe for the store: DeleteObject is idempotent, the loser's delete is a
    // 204 no-op. Observed cost: both runs report "Forgot …" and both file an
    // audit record for one deletion — cosmetic, worth knowing, not damage.
    assert.equal(oneDone.status, 0, oneDone.stderr);
    assert.equal(twoDone.status, 0, twoDone.stderr);
    assert.equal((await manifestKeys()).length, 1);
    assert.deepEqual(await bucketViolations(), []);
  });
});

describe("concurrency: setup vs setup", () => {
  it("claiming the same set name from two machines has exactly one winner", async () => {
    const scratch = freshScratch("ss-claim-race");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }

    // Both park before the claim PUT, then release together — as close to
    // simultaneous conditional PUTs of sets/race/dirs.txt as two real
    // processes get.
    const a = await holdAt(
      ["setup", "--set", "race", "--bucket", bucket, data],
      { scratch, id: "a", home: homeA, hold: "1:PUT:^/sets/" },
    );
    const b = await holdAt(
      ["setup", "--set", "race", "--bucket", bucket, data],
      { scratch, id: "b", home: homeB, hold: "1:PUT:^/sets/" },
    );
    release(a.gate);
    release(b.gate);
    const [aDone, bDone] = await Promise.all([a.done, b.done]);

    // The claim is a no-clobber conditional PUT (IfNoneMatch: "*"): S3
    // guarantees exactly one 200 and one 412 no matter how the PUTs land.
    const outcomes = [aDone, bDone];
    const winners = outcomes.filter((o) => o.status === 0);
    const losers = outcomes.filter((o) => o.status !== 0);
    assert.equal(winners.length, 1, "exactly one claim must win");
    assert.equal(losers.length, 1, "exactly one claim must lose");
    console.warn(
      `  [ss-claim-race] loser stderr tail: ${losers[0]?.stderr.trim().split("\n").slice(-6).join(" | ")}`,
    );
    assert.deepEqual(await bucketViolations(), []);
  });
});
