import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  bucket,
  bucketViolations,
  inspector,
  makeTree,
  nextZone,
  restoreAndCompare,
  s3cab,
  seedSet,
  wipeBucket,
} from "./harness.mjs";
import { captureTree } from "../model/harness/model.mjs";

// The interruption half of the crash/concurrency harness (prompt #4 of
// docs/agents/s3cab-fable-prompts.md): hard-kill the real CLI, as a real
// child process against the real crash bucket, at every request boundary
// where a multi-step transition can be torn — then assert the repository is
// restorable, that no snapshot references a missing object, and observe what
// re-running the command does.
//
// Kill points are named by protocol step (killswitch.mjs matches
// "<n>:<METHOD>:<pathRegex>" against the S3 data plane), derived from the
// audited request schedule of each command:
//
//   backup (first): LIST objects/ → PUT objects/<hash> ×N → PUT
//     snapshots/<set>/<name>.tsv.zst (commit point) → PUT sets/<set>/dirs.txt
//     → DELETE sets/<set>/exclude.txt (config push, best-effort)
//   multipart object: HEAD objects/<hash> → POST ?uploads → PUT ?partNumber=N
//     ×parts → POST ?uploadId= (complete)
//   cleanup: GET listings + manifests → DELETE objects/<hash> ×orphans
//   forget: GET listing → GET manifests (unrestorable scan; skipped by
//     --force) → DELETE snapshots/... ×named
//
// Each case wipes the sole-owner bucket, builds fresh homes/trees, runs, and
// checks the bucket through the independent inspector + parser only.

const SCRATCH = resolve("test", ".tmp-crash");

/** Fresh per-case scratch dir. @param {string} name */
function freshScratch(name) {
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SMALL_TREE = {
  "a.txt": "alpha content",
  "b.txt": "beta content",
  "sub/c.txt": "gamma content",
  "sub/d.txt": "delta content",
};

/**
 * Assert a child run was killed before completing its command.
 * @param {ReturnType<typeof s3cab>} run
 * @param {string} label
 */
function assertKilled(run, label) {
  assert.notEqual(run.status, 0, `${label}: expected a killed run, got exit 0`);
  assert.ok(
    !run.stdout.includes("Backed up") &&
      !run.stdout.includes("Reclaimed") &&
      !run.stdout.includes("forgotten from set"),
    `${label}: killed run still reported success:\n${run.stdout}\n${run.stderr}`,
  );
}

/** The set's local work-file lock path. @param {string} home @param {string} set */
const lockPath = (home, set) =>
  join(home, "sets", set, "snapshots", ".snapshot.tsv.zst");

describe("interruption: backup", () => {
  /**
   * One torn-backup case: kill at `kill`, assert bucket invariants, then
   * assert the documented recovery path reaches a good backup.
   * @param {object} args
   * @param {string} args.name
   * @param {string} args.kill
   * @param {boolean} args.expectLockLeft - Killed mid-pipeline → the work-file
   *   lock survives and the rerun refuses until it is removed (the known
   *   hard-kill residue, proposals/concurrency-and-locking.md §2)
   * @param {boolean} args.expectManifest - Kill lands after the commit point
   */
  function tornBackupCase({ name, kill, expectLockLeft, expectManifest }) {
    it(name, async () => {
      const scratch = freshScratch(name.replaceAll(/[^a-z0-9-]/g, "-"));
      await wipeBucket();
      const home = join(scratch, "home");
      const data = join(scratch, "data");
      mkdirSync(home, { recursive: true });
      makeTree(data, SMALL_TREE);
      seedSet(home, "s", [data]);
      const expected = captureTree([data]);

      const killed = s3cab(["backup", "s"], {
        home,
        tz: nextZone(),
        kill,
        log: join(scratch, "trace.log"),
        tag: "killed",
      });
      assertKilled(killed, name);

      // The bucket must be healthy whatever the kill tore: legal keys only,
      // every object's bytes hash to its name, and no manifest referencing a
      // missing object.
      assert.deepEqual(await bucketViolations(), []);

      const manifests = (await inspector.listAll(bucket)).filter(({ key }) =>
        key.startsWith("snapshots/"),
      );
      assert.equal(
        manifests.length,
        expectManifest ? 1 : 0,
        `manifest presence after kill (${manifests.map((m) => m.key).join(", ")})`,
      );

      // Recovery. A kill inside the fused pipeline leaves the work-file lock
      // (ADR-0048's artifact; hard-kill residue is a documented open item),
      // so the rerun refuses loudly first — that refusal, and what it costs
      // (delete the file by hand, lose the interrupted hash pass), is
      // asserted as observed behaviour, not endorsed as ideal.
      let rerun = s3cab(["backup", "s"], { home, tz: nextZone() });
      if (expectLockLeft) {
        assert.notEqual(
          rerun.status,
          0,
          "rerun should refuse on the stale lock",
        );
        assert.match(
          rerun.stderr,
          /already in progress/,
          "the stale-lock refusal names the situation",
        );
        assert.ok(
          existsSync(lockPath(home, "s")),
          "the lock file is the residue",
        );
        unlinkSync(lockPath(home, "s"));
        rerun = s3cab(["backup", "s"], { home, tz: nextZone() });
      }
      assert.equal(
        rerun.status,
        0,
        `recovery backup failed:\n${rerun.stderr}\n${rerun.stdout}`,
      );

      assert.deepEqual(await bucketViolations(), []);
      const { violations } = restoreAndCompare({
        set: "s",
        scratch,
        expected,
        dirs: [data],
      });
      assert.deepEqual(
        violations,
        [],
        "post-recovery restore is byte-identical",
      );
    });
  }

  tornBackupCase({
    name: "kill before the first object PUT",
    kill: "1:PUT:^/objects/",
    expectLockLeft: true,
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill between object uploads",
    kill: "3:PUT:^/objects/",
    expectLockLeft: true,
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill between the last object and the manifest PUT",
    kill: "1:PUT:^/snapshots/",
    expectLockLeft: false, // the pipeline drained: the work file was renamed
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill after the commit point, before the config push",
    kill: "1:PUT:^/sets/",
    expectLockLeft: false,
    expectManifest: true,
  });
});

describe("interruption: multipart", () => {
  // 34MB → three parts at the 16MB part size: HEAD preflight, create,
  // 3 part PUTs, complete.
  const MULTIPART_TREE = { "big.bin": 34 * 1024 * 1024, "small.txt": "tiny" };

  /**
   * @param {object} args
   * @param {string} args.name
   * @param {string} args.kill
   */
  function tornMultipartCase({ name, kill }) {
    it(name, async () => {
      const scratch = freshScratch(name.replaceAll(/[^a-z0-9-]/g, "-"));
      await wipeBucket();
      const home = join(scratch, "home");
      const data = join(scratch, "data");
      mkdirSync(home, { recursive: true });
      makeTree(data, MULTIPART_TREE);
      seedSet(home, "mp", [data]);
      const expected = captureTree([data]);

      const killed = s3cab(["backup", "mp"], {
        home,
        tz: nextZone(),
        kill,
        log: join(scratch, "trace.log"),
        tag: "killed",
      });
      assertKilled(killed, name);

      // An uncompleted multipart upload must be invisible to the store: no
      // objects/ key, no manifest, only (possibly) a stranded upload that
      // the bucket lifecycle's AbortIncompleteMultipartUpload reaps.
      assert.deepEqual(await bucketViolations(), []);
      const keys = (await inspector.listAll(bucket)).map(({ key }) => key);
      assert.ok(
        !keys.some((key) => key.startsWith("snapshots/")),
        `no manifest may exist after ${name} (got ${keys.join(", ")})`,
      );
      const stranded = await inspector.listMultipartUploads(bucket);
      // Not asserted exact: the create-kill case strands nothing. Recorded
      // into the assertion message stream for the report instead.
      console.warn(
        `  [${name}] stranded multipart uploads: ${stranded.length}`,
      );

      // Recovery: clear the lock residue if the kill left it (any kill
      // inside the pipeline does), then a fresh backup must complete and
      // restore byte-identically — the stranded MPU must not get in its way.
      if (existsSync(lockPath(home, "mp"))) {
        unlinkSync(lockPath(home, "mp"));
      }
      const rerun = s3cab(["backup", "mp"], { home, tz: nextZone() });
      assert.equal(
        rerun.status,
        0,
        `recovery backup failed:\n${rerun.stderr}\n${rerun.stdout}`,
      );
      assert.deepEqual(await bucketViolations(), []);
      const { violations } = restoreAndCompare({
        set: "mp",
        scratch,
        expected,
        dirs: [data],
      });
      assert.deepEqual(
        violations,
        [],
        "post-recovery restore is byte-identical",
      );
    });
  }

  tornMultipartCase({
    name: "kill before CreateMultipartUpload",
    // The wire form carries a trailing "=" (`?uploads=`), unlike the S3 docs'
    // `?uploads` — anchor on it to avoid matching CompleteMultipartUpload's
    // `?uploadId=<id>`.
    kill: "1:POST:\\?uploads=$",
  });
  tornMultipartCase({
    name: "kill between part uploads",
    kill: "2:PUT:partNumber=",
  });
  tornMultipartCase({
    name: "kill before CompleteMultipartUpload",
    kill: "1:POST:uploadId=",
  });
});

describe("interruption: cleanup and forget", () => {
  it("kill mid-cleanup's delete pass, then re-run to completion", async () => {
    const scratch = freshScratch("cleanup-kill");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    mkdirSync(home, { recursive: true });
    makeTree(data, SMALL_TREE);
    seedSet(home, "s", [data]);

    // Manufacture genuine crash orphans: a backup killed at the commit
    // boundary leaves all four objects uploaded and no manifest.
    const killed = s3cab(["backup", "s"], {
      home,
      tz: nextZone(),
      kill: "1:PUT:^/snapshots/",
    });
    assertKilled(killed, "orphan-manufacturing backup");
    const orphanKeys = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.equal(orphanKeys.length, 4, "four crash orphans seeded");

    // Age them past a compressed grace window (labeled time compression —
    // GRACE_MS only; see killswitch.mjs). Production grace is 7 days; the
    // ordering and interlocks under test are identical.
    await new Promise((r) => setTimeout(r, 5_000));

    const graceMs = "3000";
    const cleanupKilled = s3cab(["cleanup", bucket, "--force"], {
      home,
      graceMs,
      kill: "2:DELETE:^/objects/",
      log: join(scratch, "trace.log"),
      tag: "cleanup-killed",
    });
    assertKilled(cleanupKilled, "cleanup kill");

    // Torn delete pass: some orphans gone, some left — but orphans are
    // unreferenced by definition, so the store must still be healthy.
    assert.deepEqual(await bucketViolations(), []);
    const remaining = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.equal(
      remaining.length,
      3,
      "exactly one orphan was deleted before the kill",
    );

    // Re-running is the recovery: same plan minus the already-deleted.
    const rerun = s3cab(["cleanup", bucket, "--force"], { home, graceMs });
    assert.equal(rerun.status, 0, `cleanup rerun failed:\n${rerun.stderr}`);
    const after = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.deepEqual(after, [], "rerun reclaimed the remaining orphans");
    assert.deepEqual(await bucketViolations(), []);
  });

  it("kill mid-forget between manifest DELETEs", async () => {
    const scratch = freshScratch("forget-kill");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    mkdirSync(home, { recursive: true });
    makeTree(data, SMALL_TREE);
    seedSet(home, "s", [data]);

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    makeTree(data, { "e.txt": "epsilon content" });
    const second = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(second.status, 0, second.stderr);
    const expectedAfter = captureTree([data]);

    const names = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("snapshots/s/"))
      .map((key) => key.slice("snapshots/s/".length, -".tsv.zst".length))
      .sort();
    assert.equal(names.length, 2);

    const killed = s3cab(["forget", "--set", "s", ...names, "--force"], {
      home,
      kill: "2:DELETE:^/snapshots/",
      log: join(scratch, "trace.log"),
      tag: "forget-killed",
    });
    assertKilled(killed, "forget kill");

    // One manifest gone, one left; its objects are all still stored
    // (forget never touches objects/), so the survivor must restore.
    assert.deepEqual(await bucketViolations(), []);
    const left = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("snapshots/s/"));
    assert.equal(
      left.length,
      1,
      "exactly one manifest was deleted before the kill",
    );
    // The names were given ascending, forget deletes in order, and the kill
    // landed before the second DELETE — so the survivor is the later
    // snapshot, and it must restore byte-identically to the second tree.
    const { violations: survivorRestore } = restoreAndCompare({
      set: "s",
      scratch,
      expected: expectedAfter,
      dirs: [data],
    });
    assert.deepEqual(survivorRestore, [], "the surviving snapshot restores");

    // Observed recovery shape: re-running with the *original* names refuses
    // (forget requires every named snapshot to exist before deleting any),
    // and the error lists what is really there — so the operator retries
    // with the survivor's name.
    const sameNames = s3cab(["forget", "--set", "s", ...names, "--force"], {
      home,
    });
    assert.notEqual(
      sameNames.status,
      0,
      "original names must refuse after the tear",
    );
    assert.match(sameNames.stderr, /not backed up/);

    const survivor = /** @type {string} */ (
      left[0]?.slice("snapshots/s/".length, -".tsv.zst".length)
    );
    const retry = s3cab(["forget", "--set", "s", survivor, "--force"], {
      home,
    });
    assert.equal(retry.status, 0, `survivor forget failed:\n${retry.stderr}`);
    assert.deepEqual(await bucketViolations(), []);

    // The objects stay restorable-by-hand (they are unreferenced now, which
    // cleanup may later reclaim — never this command).
    const objects = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.ok(objects.length > 0, "forget left the objects in place");
  });
});
