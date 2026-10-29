import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
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
  restoreAndCompare,
  s3cab,
  seedSet,
  wipeBucket,
} from "./harness.mjs";
import { captureTree } from "../model/harness/model.mjs";
import { REQUESTS_IN_FLIGHT } from "../../src/lib/objects.mjs";

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
//   backup (first): GET snapshots/<set>.info (holder check) → PUT
//     locks/upload-<instant> → LIST locks/ → LIST objects/ → PUT
//     objects/<hash> ×N → GET snapshots/<set>.info (holder check) → PUT
//     snapshots/<set>/<name>.tsv.gz (commit point) → DELETE
//     locks/upload-<instant> → PUT .s3cab/sets/<set>/dirs.txt → DELETE
//     .s3cab/sets/<set>/exclude.txt (config push, best-effort)
//   multipart object: HEAD objects/<hash> → POST ?uploads → PUT ?partNumber=N
//     ×parts → POST ?uploadId= (complete)
//   cleanup: GET listings + manifests → PUT locks/delete-<instant> → LIST
//     locks/ → GET listing + new manifests (top-up) → DELETE objects/<hash>
//     ×orphans, REQUESTS_IN_FLIGHT at a time → DELETE locks/delete-<instant>
//   forget: GET snapshots/<set>.info (holder check) → GET listing → GET
//     manifests (unrestorable scan; skipped by --force) → DELETE
//     snapshots/... ×named
//
// A kill after a lock's PUT leaves the lock (ADR-0112): a lock never expires,
// but it names its machine and process, and every child here runs on this
// machine, so the next upload or delete sweeps it on its way in. Each case
// asserts the residue, then that the rerun swept it.
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

describe("interruption: backup", () => {
  /**
   * One torn-backup case: kill at `kill`, assert bucket invariants, then
   * assert the documented recovery path reaches a good backup.
   * @param {object} args
   * @param {string} args.name
   * @param {string} args.kill
   * @param {boolean} args.expectLockLeft - Killed while the upload lock was
   *   held → the bucket lock survives, for the rerun to sweep
   * @param {boolean} args.expectWorkFile - Killed inside the fused pass → the
   *   work file survives, and the rerun refuses until `--resume` (ADR-0092)
   * @param {boolean} args.expectManifest - Kill lands after the commit point
   */
  function tornBackupCase({
    name,
    kill,
    expectLockLeft,
    expectWorkFile,
    expectManifest,
  }) {
    it(name, async () => {
      const scratch = freshScratch(name.replaceAll(/[^a-z0-9-]/g, "-"));
      await wipeBucket();
      const home = join(scratch, "home");
      const data = join(scratch, "data");
      mkdirSync(home, { recursive: true });
      makeTree(data, SMALL_TREE);
      seedSet(home, "s", [data]);
      await claimSet(home, "s");
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
        key.endsWith(".tsv.gz"),
      );
      assert.equal(
        manifests.length,
        expectManifest ? 1 : 0,
        `manifest presence after kill (${manifests.map((m) => m.key).join(", ")})`,
      );

      // Recovery. A kill while the upload lock is held leaves the run's lock
      // in the bucket; the rerun, from the same machine, sees its process is
      // gone and sweeps it on the way in. A kill inside the fused pass also
      // leaves the work file, which the rerun then refuses on until
      // `--resume` takes it over, reusing the parked hash work (ADR-0092).
      const stale = await lockKeys();
      if (expectLockLeft) {
        assert.equal(
          stale.length,
          1,
          `the killed run's bucket lock is the residue (${stale.join(", ")})`,
        );
        assert.match(stale[0] ?? "", /^locks\/upload-/);
      } else {
        assert.deepEqual(stale, [], "a kill after the unlock leaves no lock");
      }
      let rerun = s3cab(["backup", "s"], { home, tz: nextZone() });
      if (expectLockLeft) {
        assert.match(
          rerun.stderr,
          /Removed the lock a stopped run left in bucket/,
          "the rerun swept the dead lock on its way in",
        );
      }
      if (expectWorkFile) {
        assert.notEqual(
          rerun.status,
          0,
          "rerun should refuse on the work file",
        );
        assert.match(
          rerun.stderr,
          /same command again with --resume/,
          "the work-file refusal names the way out",
        );
        assert.deepEqual(
          await lockKeys(),
          [],
          "the refused rerun took its own lock back",
        );
        rerun = s3cab(["backup", "s", "--resume"], { home, tz: nextZone() });
      }
      assert.equal(
        rerun.status,
        0,
        `recovery backup failed:\n${rerun.stderr}\n${rerun.stdout}`,
      );
      assert.deepEqual(
        await lockKeys(),
        [],
        "the recovery removed the dead lock and its own",
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
    expectWorkFile: true,
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill between object uploads",
    kill: "3:PUT:^/objects/",
    expectLockLeft: true,
    expectWorkFile: true,
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill between the last object and the manifest PUT",
    kill: "1:PUT:^/snapshots/",
    expectLockLeft: true, // the pipeline drained, but the lock is held to the manifest
    expectWorkFile: false, // the work file was already renamed into place
    expectManifest: false,
  });
  tornBackupCase({
    name: "kill after the commit point, before the config push",
    kill: "1:PUT:^/\\.s3cab/",
    expectLockLeft: false, // the lock went before the config push
    expectWorkFile: false,
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
      await claimSet(home, "mp");
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
        !keys.some((key) => key.endsWith(".tsv.gz")),
        `no manifest may exist after ${name} (got ${keys.join(", ")})`,
      );
      const stranded = await inspector.listMultipartUploads(bucket);
      // Not asserted exact: the create-kill case strands nothing. Recorded
      // into the assertion message stream for the report instead.
      console.warn(
        `  [${name}] stranded multipart uploads: ${stranded.length}`,
      );

      // Recovery: every kill here lands inside the fused pass with the upload
      // lock held, so the rerun sweeps the dead lock and `--resume` takes the
      // work file over; then the backup must complete and restore
      // byte-identically — the stranded MPU must not get in its way.
      const stale = await lockKeys();
      assert.equal(stale.length, 1, `the dead lock (${stale.join(", ")})`);
      const rerun = s3cab(["backup", "mp", "--resume"], {
        home,
        tz: nextZone(),
      });
      assert.equal(
        rerun.status,
        0,
        `recovery backup failed:\n${rerun.stderr}\n${rerun.stdout}`,
      );
      assert.match(
        rerun.stderr,
        /Removed the lock a stopped run left in bucket/,
      );
      assert.deepEqual(await lockKeys(), []);
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
    // More orphans than cleanup keeps in flight, so the kill can land on a
    // DELETE that waited for a slot. With every DELETE dispatched at once, a
    // kill on any of them precedes every response, and nothing is torn.
    const orphans = REQUESTS_IN_FLIGHT + 10;
    makeTree(
      data,
      Object.fromEntries(
        Array.from({ length: orphans }, (_, i) => [`f${i}.txt`, `orphan ${i}`]),
      ),
    );
    seedSet(home, "s", [data]);
    await claimSet(home, "s");

    // Manufacture genuine crash orphans: a backup killed at the commit
    // boundary leaves every object uploaded and no manifest.
    const killed = s3cab(["backup", "s"], {
      home,
      tz: nextZone(),
      kill: "1:PUT:^/snapshots/",
    });
    assertKilled(killed, "orphan-manufacturing backup");
    const orphanKeys = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.equal(orphanKeys.length, orphans, "crash orphans seeded");
    // The killed backup's upload lock is left; cleanup, from the same
    // machine, sweeps it on its way in rather than turning away.
    assert.equal((await lockKeys()).length, 1);

    const cleanupKilled = s3cab(["cleanup", bucket, "--force"], {
      home,
      // The first DELETE dispatched only once an earlier one has completed.
      kill: `${REQUESTS_IN_FLIGHT + 1}:DELETE:^/objects/`,
      log: join(scratch, "trace.log"),
      tag: "cleanup-killed",
    });
    assertKilled(cleanupKilled, "cleanup kill");

    // Torn delete pass: some orphans gone, some left — but orphans are
    // unreferenced by definition, so the store must still be healthy. How many
    // of the in-flight DELETEs landed is a race; the bounds are not. The
    // killed run's delete lock stays (a legal key); the backup's was swept.
    assert.deepEqual(await bucketViolations(), []);
    const killedLock = await lockKeys();
    assert.equal(killedLock.length, 1, killedLock.join(", "));
    assert.match(killedLock[0] ?? "", /^locks\/delete-/);
    assert.match(
      cleanupKilled.stderr,
      /Removed the lock a stopped run left in bucket/,
    );
    const remaining = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.ok(
      remaining.length < orphans,
      "at least one orphan was deleted before the kill",
    );
    assert.ok(
      remaining.length >= orphans - REQUESTS_IN_FLIGHT,
      `the DELETEs never dispatched left their orphans (${remaining.length} remain)`,
    );

    // Re-running is the recovery: same plan minus the already-deleted. The
    // dead delete lock would turn every backup away; the rerun, from the
    // same machine, sweeps it along with the orphans.
    const rerun = s3cab(["cleanup", bucket, "--force"], { home });
    assert.equal(rerun.status, 0, `cleanup rerun failed:\n${rerun.stderr}`);
    const after = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("objects/"));
    assert.deepEqual(after, [], "rerun reclaimed the remaining orphans");
    assert.match(rerun.stderr, /Removed the lock a stopped run left in bucket/);
    assert.deepEqual(
      await lockKeys(),
      [],
      "the rerun removed the dead lock and its own",
    );
    assert.deepEqual(await bucketViolations(), []);

    // Nothing stands in a backup's way now.
    const backup = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(backup.status, 0, backup.stderr);
    assert.deepEqual(await lockKeys(), []);
  });

  it("kill mid-forget between manifest DELETEs", async () => {
    const scratch = freshScratch("forget-kill");
    await wipeBucket();
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    mkdirSync(home, { recursive: true });
    makeTree(data, SMALL_TREE);
    seedSet(home, "s", [data]);
    await claimSet(home, "s");

    const first = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(first.status, 0, first.stderr);
    makeTree(data, { "e.txt": "epsilon content" });
    const second = s3cab(["backup", "s"], { home, tz: nextZone() });
    assert.equal(second.status, 0, second.stderr);
    const expectedAfter = captureTree([data]);

    const names = (await inspector.listAll(bucket))
      .map(({ key }) => key)
      .filter((key) => key.startsWith("snapshots/s/"))
      .map((key) => key.slice("snapshots/s/".length, -".tsv.gz".length))
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
      left[0]?.slice("snapshots/s/".length, -".tsv.gz".length)
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
