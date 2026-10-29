import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  bucket,
  bucketViolations,
  claimSet,
  inspector,
  lockKeys,
  makeTree,
  nextZone,
  release,
  restoreAndCompare,
  s3cab,
  s3cabAsync,
  seedSet,
  unlockAll,
  uploadLockPath,
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
// Each case names its verdict up front and the mechanism that makes it safe.
// For an upload against a cleanup or delete, that mechanism is the locks in
// the bucket (ADR-0112): a run writes its lock before anything that decides
// what to skip or delete, then lists `locks/`, so of two runs that would
// cross, at least one sees the other and refuses.

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
    .filter((key) => key.endsWith(".tsv.gz"));
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

/**
 * Crash orphans: a backup of `home`'s set killed between its last object and
 * the manifest leaves every object uploaded, no snapshot — and its upload
 * lock, which a kill never removes and which would turn every cleanup away.
 * The lock is cleared the way a person clears a lock whose run they know is
 * dead (`unlock`), and the set's `.upload.lock` is deleted by hand — a person
 * would run `--resume`, but that is a backup, and the cases want the orphans
 * without one. The orphans stay.
 * @param {string} home
 * @param {string} set
 * @returns {Promise<number>} how many objects the killed run left
 */
async function crashOrphans(home, set) {
  const killed = s3cab(["backup", set], {
    home,
    tz: nextZone(),
    kill: "1:PUT:^/snapshots/",
  });
  assert.notEqual(killed.status, 0);
  const stale = await lockKeys();
  assert.equal(stale.length, 1, `the killed run's lock (${stale.join(", ")})`);
  assert.match(stale[0] ?? "", /^locks\/upload-/);
  assert.equal((await unlockAll(home)).length, 1);
  rmSync(uploadLockPath(home, set));
  return (await objectKeys()).length;
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
    await claimSet(homeA, "seta");
    await claimSet(homeB, "setb");
    const expected = captureTree([data]);

    // A lists the (empty) store and parks before its first object PUT — its
    // upload plan is now stale. B then backs up the same content to its own
    // set, storing every object A still intends to upload. Uploads never
    // exclude each other: B's lock is beside A's.
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

    assert.deepEqual(await lockKeys(), []);
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

  it("same set, same snapshot name, a takeover between holder check and publish: the manifest no-clobber race has exactly one winner", async () => {
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
    await claimSet(homeA, "s");

    // Same fixed zone → same minute-precision snapshot name (the two spawns
    // are seconds apart). A parks before the manifest PUT, its holder check
    // already passed; B takes the set over and parks there too. Both now
    // believe they hold it (ADR-0108's race gap); A commits first.
    const tz = "Etc/GMT-1";
    const a = await holdAt(["backup", "s"], {
      scratch,
      id: "a",
      home: homeA,
      tz,
      hold: "1:PUT:^/snapshots/",
    });
    await claimSet(homeB, "s");
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
    // unreferenced object, which is legal store shape (cleanup's to reclaim).
    // The loser removed its lock on the way out, like the winner.
    assert.deepEqual(await lockKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
  });
});

describe("concurrency: cleanup vs in-flight backup", () => {
  it("cleanup beside a held backup is refused by the upload lock, so the orphans the backup reuses survive", async () => {
    const scratch = freshScratch("bc-refused");
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
    await claimSet(homeA, "s");

    // Machine A crashes: four orphans, no snapshot.
    assert.equal(await crashOrphans(homeA, "s"), 4);

    // Machine B takes the set over, backs up the same content, skips the
    // stored orphans, and parks before its manifest PUT — the §1 window, wide
    // open, with B's upload lock standing in it.
    await claimSet(homeB, "s");
    const b = await holdAt(["backup", "s"], {
      scratch,
      id: "b",
      home: homeB,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
    });

    // cleanup writes its delete lock, looks, sees B's upload lock, removes
    // its own and refuses: nothing deleted, nothing left behind, and the
    // refusal names the run it met.
    const cleanup = s3cab(["cleanup", bucket, "--force"], { home: homeA });
    assert.notEqual(
      cleanup.status,
      0,
      "cleanup must refuse beside a running backup",
    );
    assert.match(
      cleanup.stderr,
      /Can't clean up right now — a backup or upload is running on bucket/,
    );
    assert.match(cleanup.stderr, /backup of set 's'/);
    assert.match(cleanup.stderr, /--wait/);
    assert.equal((await objectKeys()).length, 4, "nothing was deleted");
    const standing = await lockKeys();
    assert.equal(standing.length, 1, `only B's lock (${standing.join(", ")})`);
    assert.match(standing[0] ?? "", /^locks\/upload-/);

    release(b.gate);
    const bDone = await b.done;
    assert.equal(bDone.status, 0, bDone.stderr);
    assert.deepEqual(await lockKeys(), [], "B removed its lock");
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);

    // Nothing running: cleanup goes ahead, and finds every object referenced.
    const again = s3cab(["cleanup", bucket, "--force"], { home: homeA });
    assert.equal(again.status, 0, again.stderr);
    assert.equal((await objectKeys()).length, 4);
    assert.deepEqual(await lockKeys(), []);
  });

  it("cleanup --wait holds no lock while it waits, goes once the backup is done, and sweeps only what is still unreferenced", async () => {
    const scratch = freshScratch("bc-wait");
    await wipeBucket();
    const homeA = join(scratch, "homeA");
    const homeB = join(scratch, "homeB");
    const data = join(scratch, "data");
    makeTree(data, { ...TREE, "z.txt": "only the crashed run had this" });
    for (const home of [homeA, homeB]) {
      mkdirSync(home, { recursive: true });
    }
    seedSet(homeA, "s", [data]);
    seedSet(homeB, "s", [data]);
    await claimSet(homeA, "s");

    // Five orphans; z.txt then goes away, so B references four of them and
    // the fifth is a true orphan for cleanup to find.
    assert.equal(await crashOrphans(homeA, "s"), 5);
    rmSync(join(data, "z.txt"));

    await claimSet(homeB, "s");
    const b = await holdAt(["backup", "s"], {
      scratch,
      id: "b",
      home: homeB,
      tz: nextZone(),
      hold: "1:PUT:^/snapshots/",
    });

    // --wait: the first look finds B's lock; the run removes its own, says
    // what it is waiting for, and sleeps. The hold parks it after a real
    // WAIT_MS, before it writes its lock again for the second look — the
    // moment that shows the sleep was lock-free.
    const cleanup = await holdAt(["cleanup", bucket, "--force", "--wait"], {
      scratch,
      id: "cleanup",
      home: homeA,
      hold: "2:PUT:^/locks/delete-",
      log: join(scratch, "trace-cleanup.log"),
      tag: "CLEANUP",
    });
    assert.equal(
      (await objectKeys()).length,
      5,
      "nothing deleted while waiting",
    );
    const standing = await lockKeys();
    assert.deepEqual(
      standing.filter((key) => key.startsWith("locks/delete-")),
      [],
      `no delete lock is held while waiting (${standing.join(", ")})`,
    );

    release(b.gate);
    const bDone = await b.done;
    assert.equal(bDone.status, 0, bDone.stderr);
    release(cleanup.gate);
    const cleanupDone = await cleanup.done;
    assert.equal(cleanupDone.status, 0, cleanupDone.stderr);
    assert.match(
      cleanupDone.stderr,
      /Waiting for 1 running upload to finish before cleaning up:\n {2}backup of set 's'/,
    );

    // B's four are referenced by its snapshot; the fifth went.
    assert.equal((await objectKeys()).length, 4, "only the true orphan swept");
    assert.deepEqual(await lockKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);
  });

  it("backup beside a held cleanup is refused by the delete lock, leaving no lock of its own", async () => {
    const scratch = freshScratch("cb-refused");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);
    await claimSet(home, "s");
    assert.equal(await crashOrphans(home, "s"), 4);

    // cleanup wrote its lock, looked, topped up, and parks before its first
    // DELETE: the window where a backup that reused the orphans would
    // publish references to objects about to go.
    const cleanup = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "cleanup",
      home,
      hold: "1:DELETE:^/objects/",
    });

    // The backup writes its upload lock, looks, sees the delete lock, takes
    // its lock back — bucket and local — and refuses before deciding anything.
    const refused = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.notEqual(refused.status, 0, "backup must refuse beside a cleanup");
    assert.match(
      refused.stderr,
      /Can't back up right now — a cleanup or delete is running on bucket/,
    );
    assert.match(refused.stderr, /\n {2}cleanup by \S+, started /);
    assert.ok(
      !existsSync(uploadLockPath(home, "s")),
      "the refused backup took its local lock back",
    );
    const standing = await lockKeys();
    assert.equal(
      standing.length,
      1,
      `only the cleanup's lock (${standing.join(", ")})`,
    );
    assert.match(standing[0] ?? "", /^locks\/delete-/);
    assert.deepEqual(await manifestKeys(), [], "nothing was published");

    release(cleanup.gate);
    const cleanupDone = await cleanup.done;
    assert.equal(cleanupDone.status, 0, cleanupDone.stderr);
    assert.deepEqual(await objectKeys(), [], "the orphans were swept");
    assert.deepEqual(await lockKeys(), []);

    // The backup then uploads everything afresh: the orphans it would have
    // reused are gone, which costs time, never data.
    const backup = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal((await objectKeys()).length, 4);
    assert.deepEqual(await lockKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);
  });

  it("write first, look second: a backup and a cleanup that both wrote before either looked both see the other and refuse", async () => {
    const scratch = freshScratch("wf-both-written");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);
    await claimSet(home, "s");
    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);

    // Each parks between its lock's PUT and its LIST of locks/: both locks
    // stand before either looks. The rule that matters most — write first,
    // look second — means neither can miss the other; the price is that
    // both refuse, which the ADR accepts over either going ahead.
    const backup = await holdAt(["backup", "s"], {
      scratch,
      id: "backup",
      home,
      tz: nextZone(),
      hold: "1:GET:prefix=locks",
    });
    const cleanup = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "cleanup",
      home,
      hold: "1:GET:prefix=locks",
    });
    const standing = await lockKeys();
    assert.equal(standing.length, 2, standing.join(", "));

    release(backup.gate);
    release(cleanup.gate);
    const [backupDone, cleanupDone] = await Promise.all([
      backup.done,
      cleanup.done,
    ]);
    assert.notEqual(backupDone.status, 0, "the backup saw the delete lock");
    assert.match(backupDone.stderr, /a cleanup or delete is running/);
    assert.notEqual(cleanupDone.status, 0, "the cleanup saw the upload lock");
    assert.match(cleanupDone.stderr, /a backup or upload is running/);

    // Both took their locks back; nothing changed in the store.
    assert.deepEqual(await lockKeys(), []);
    assert.ok(!existsSync(uploadLockPath(home, "s")));
    assert.equal((await manifestKeys()).length, 1);
    assert.equal((await objectKeys()).length, 4);
    assert.deepEqual(await bucketViolations(), []);
  });

  it("forget + cleanup under a held incremental backup: forget goes ahead, cleanup is refused, the baseline-trusted refs survive", async () => {
    const scratch = freshScratch("bfc-baseline-trust");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);
    await claimSet(home, "s");

    // Backup 1 establishes the baseline.
    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.gz".length,
    );
    assert.ok(m1);

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

    // Inside the window: forget the baseline (no lock — it deletes manifests,
    // never objects), then try to sweep. The old objects are unreferenced
    // now, and only backup 2's upload lock stands between them and cleanup.
    const forget = s3cab(
      ["forget", "--set", "s", /** @type {string} */ (m1), "--force"],
      { home },
    );
    assert.equal(forget.status, 0, forget.stderr);
    const cleanup = s3cab(["cleanup", bucket, "--force"], { home });
    assert.notEqual(cleanup.status, 0, "cleanup must refuse");
    assert.match(cleanup.stderr, /a backup or upload is running/);
    assert.equal((await objectKeys()).length, 5, "nothing swept");

    release(b2.gate);
    const b2Done = await b2.done;
    assert.equal(b2Done.status, 0, b2Done.stderr);
    assert.deepEqual(await lockKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
    const { violations } = restoreAndCompare({
      set: "s",
      scratch,
      expected: captureTree([data]),
      dirs: [data],
    });
    assert.deepEqual(violations, []);
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
    await claimSet(home, "s");

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.gz".length,
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
    // is still stored (reclaiming is exclusively cleanup's, behind the lock).
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
    await claimSet(home, "s");

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    const m1 = (await manifestKeys())[0]?.slice(
      "snapshots/s/".length,
      -".tsv.gz".length,
    );
    assert.ok(m1);

    // cleanup reads the snapshot listing + manifests, then parks before its
    // objects LIST. Everything it will sweep is decided by what it already
    // read — which still includes the manifest forget is about to delete.
    const cleanup = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "cleanup",
      home,
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
    // The next cleanup run sweeps them — correctly.
    assert.equal(
      (await objectKeys()).length,
      4,
      "the objects survive this cleanup run",
    );
    assert.deepEqual(await lockKeys(), []);
    assert.deepEqual(await bucketViolations(), []);
  });

  it("cleanup vs cleanup is safe: independent plans, idempotent deletes, locks that ignore each other", async () => {
    const scratch = freshScratch("cc-idempotent");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    makeTree(data, TREE);
    mkdirSync(home, { recursive: true });
    seedSet(home, "s", [data]);
    await claimSet(home, "s");
    assert.equal(await crashOrphans(home, "s"), 4);

    // Both park before their first orphan DELETE with identical plans, then
    // race the same delete list. Each wrote its delete lock and saw the
    // other's, which deletes ignore (ADR-0090 makes crossing safe).
    const one = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "one",
      home,
      hold: "1:DELETE:^/objects/",
    });
    const two = await holdAt(["cleanup", bucket, "--force"], {
      scratch,
      id: "two",
      home,
      hold: "1:DELETE:^/objects/",
    });
    assert.equal((await lockKeys()).length, 2, "both delete locks stand");
    release(one.gate);
    release(two.gate);
    const [oneDone, twoDone] = await Promise.all([one.done, two.done]);
    assert.equal(oneDone.status, 0, oneDone.stderr);
    assert.equal(twoDone.status, 0, twoDone.stderr);

    // Safe, and the mechanism is S3 DeleteObject idempotency: deleting an
    // already-deleted key answers 204, so overlapping sweeps of the same
    // plan cannot fail each other or leave anything behind.
    assert.deepEqual(await objectKeys(), []);
    assert.deepEqual(await lockKeys(), []);
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
    await claimSet(home, "s");

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    makeTree(data, { "f.txt": "second snapshot filler" });
    const second = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(second.status, 0, second.stderr);
    const names = (await manifestKeys()).map((key) =>
      key.slice("snapshots/s/".length, -".tsv.gz".length),
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
    // 204 no-op. Observed cost: both runs report the snapshot forgotten, and
    // both file an audit record for one deletion — cosmetic, worth knowing,
    // not damage.
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
    // simultaneous conditional PUTs of snapshots/race.info as two real
    // processes get.
    const a = await holdAt(
      ["setup", "--set", "race", "--bucket", bucket, data],
      { scratch, id: "a", home: homeA, hold: "1:PUT:^/snapshots/race\\.info" },
    );
    const b = await holdAt(
      ["setup", "--set", "race", "--bucket", bucket, data],
      { scratch, id: "b", home: homeB, hold: "1:PUT:^/snapshots/race\\.info" },
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
