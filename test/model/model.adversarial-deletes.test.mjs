import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { holdSet } from "../helpers/hold-set.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { RepoModel, sha256 } from "./harness/model.mjs";
import {
  backup,
  cleanup,
  deleteHashes,
  forget,
  upload,
  writeSet,
} from "./harness/seam.mjs";

// After the seam, so they bind its mocks.
const { find } = await import("../../src/commands/find.mjs");
const { renderCleanup, renderFind } = await import("../../src/render.mjs");

// An adversarial read of the paths that delete from the bucket (2026-11-14,
// proposals/bugs.md): each test asserts what a command says it does, on a
// sequence its own tests don't reach.

const BUCKET = "model-bucket";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number} */
let savedExitCode;
/** @type {FakeS3} */
let fake;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = /** @type {number} */ (process.exitCode ?? 0);
  process.exitCode = 0;
  clockHolder.current = new VirtualClock(Date.UTC(2026, 0, 5));
  fake = new FakeS3();
  backendHolder.current = fake;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode;
});

/**
 * Point s3cab at a machine's own home under the test root.
 * @param {string} root
 * @param {string} machine
 */
const useHome = (root, machine) => {
  process.env.S3CAB_HOME = join(root, machine, ".s3cab");
};

/**
 * A data directory, registered as a set the current home holds.
 * @param {string} root
 * @param {string} set
 * @param {string} dirName
 * @returns {Promise<string>} the data directory (canonical)
 */
const makeSet = async (root, set, dirName) => {
  mkdirSync(join(root, dirName), { recursive: true });
  const dir = realpathSync.native(join(root, dirName));
  const { claimPath } = writeSet(set, { dirs: [dir], bucket: BUCKET });
  await holdSet(BUCKET, set, claimPath);
  return dir;
};

/**
 * The current home's snapshots folder for a set.
 * @param {string} set
 */
const localSnapshots = (set) =>
  join(String(process.env.S3CAB_HOME), "sets", set, "snapshots");

/** The deletion record's first index: the key a bucket's first `delete` writes. */
const FIRST_RECORD = "objects.deleted-1.tsv";

describe("adversarial read of the deletion paths", () => {
  // What `delete` removes in the tests below: a file that stays on disk, in
  // the set, and in the one snapshot left.
  const KEPT_ON_DISK = Buffer.from("deleted from the backups, still on disk");

  /**
   * A set with one snapshot left, and a deletion record whose only row names
   * content no snapshot references any more: it was deleted on purpose, and
   * the one snapshot that held it was forgotten since. The next cleanup trims
   * that row.
   * @param {string} root
   */
  const setWithDeadRecordRow = async (root) => {
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    const old = "last year's content, not wanted in any backup";
    writeFileSync(join(data, "a.txt"), old);
    writeFileSync(join(data, "b.txt"), KEPT_ON_DISK);
    const { snapshot: first } = await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    writeFileSync(join(data, "a.txt"), "this year's");
    await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    await deleteHashes([sha256(old)], { bucket: BUCKET, force: true });
    await forget([first], { set: "photos", force: true });
    clockHolder.current.advance(MINUTE_MS);
  };

  /**
   * Two cleanups run together, which nothing stops (deletes don't exclude
   * each other), and a `delete` lands between them: the first has read the
   * record and is about to remove the file it read when the second runs
   * whole, then the `delete`.
   */
  const deleteBetweenTwoCleanups = async () => {
    const realDelete = fake.deleteObject.bind(fake);
    let armed = true;
    fake.deleteObject = async (uri) => {
      if (armed && uri.endsWith(`/${FIRST_RECORD}`)) {
        armed = false;
        clockHolder.current.advance(1000);
        await cleanup(BUCKET, { force: true });
        clockHolder.current.advance(1000);
        await deleteHashes([sha256(KEPT_ON_DISK)], {
          bucket: BUCKET,
          force: true,
        });
      }
      return realDelete(uri);
    };
    await cleanup(BUCKET, { force: true });
    fake.deleteObject = realDelete;
  };

  it("control: content deleted on purpose is recorded, and stored again by the next backup", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    await setWithDeadRecordRow(dir.path);

    await cleanup(BUCKET, { force: true });
    clockHolder.current.advance(1000);
    await deleteHashes([sha256(KEPT_ON_DISK)], { bucket: BUCKET, force: true });

    const model = new RepoModel(BUCKET, fake);
    assert.ok((await model.deletedHashes()).has(sha256(KEPT_ON_DISK)));

    clockHolder.current.advance(MINUTE_MS);
    await backup("photos");
    assert.ok(await fake.peekBytes(BUCKET, `objects/${sha256(KEPT_ON_DISK)}`));
  });

  it("a cleanup doesn't remove the record of a delete that ran after it read the record", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    await setWithDeadRecordRow(dir.path);

    await deleteBetweenTwoCleanups();

    const model = new RepoModel(BUCKET, fake);
    assert.ok(
      (await model.deletedHashes()).has(sha256(KEPT_ON_DISK)),
      "the delete's record is gone, so the snapshot left names content missing with nothing to say it was deleted on purpose",
    );
  });

  it("a backup stores a file again after its deletion crossed two cleanups", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    await setWithDeadRecordRow(dir.path);
    await deleteBetweenTwoCleanups();

    // The file is still on disk and unchanged, and the snapshot before this
    // one, still in the bucket, lists it.
    clockHolder.current.advance(MINUTE_MS);
    const { snapshot: latest } = await backup("photos");

    assert.ok(
      await fake.peekBytes(BUCKET, `snapshots/photos/${latest}.tsv.gz`),
    );
    assert.ok(
      await fake.peekBytes(BUCKET, `objects/${sha256(KEPT_ON_DISK)}`),
      "the backup listed b.txt in its snapshot without storing its content",
    );
  });

  it("two cleanups that cross each report only what is true of the one orphan both removed", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    const old = "last year's content";
    writeFileSync(join(data, "a.txt"), old);
    const { snapshot: first } = await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    writeFileSync(join(data, "a.txt"), "this year's content, longer");
    await backup("photos");
    await forget([first], { set: "photos", force: true });
    clockHolder.current.advance(MINUTE_MS);

    // A second cleanup, from another terminal or machine, runs whole while
    // the first is about to delete the bucket's one orphan. S3's DELETE
    // answers alike whether or not the key was there, so neither run can
    // know which of them removed it.
    /** @type {string[]} */
    const reports = [];
    const realDelete = fake.deleteObject.bind(fake);
    let armed = true;
    fake.deleteObject = async (uri) => {
      if (armed && uri.includes("/objects/")) {
        armed = false;
        clockHolder.current.advance(1000);
        reports.push(renderCleanup(await cleanup(BUCKET, { force: true })));
      }
      return realDelete(uri);
    };
    reports.push(renderCleanup(await cleanup(BUCKET, { force: true })));
    fake.deleteObject = realDelete;

    assert.equal(
      await fake.peekBytes(BUCKET, `objects/${sha256(old)}`),
      undefined,
    );
    assert.equal(reports.length, 2);
    for (const report of reports) {
      assert.match(
        report,
        /^model-bucket: 1 orphaned object \(\d+B\) is no longer stored\.$/,
        "a run claims to have done what a crossing run may have done",
      );
    }
  });

  it("find --set warns when the object also backs a file in another attached set", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const shared = "the same film, kept in two sets";
    const photos = await makeSet(root, "photos", "photos");
    writeFileSync(join(photos, "raw.mov"), shared);
    await backup("photos");
    const docs = await makeSet(root, "docs", "docs");
    writeFileSync(join(docs, "keeper.mov"), shared);
    await backup("docs");

    // The list is what `delete` takes, and a delete removes the object from
    // the whole bucket, set 'docs' included: the warning is the only review.
    const narrowed = await find(["raw.mov"], { set: "photos" });

    assert.deepEqual(narrowed.files[0]?.objects[0]?.alsoBacks, [
      join(docs, "keeper.mov"),
    ]);
    assert.match(renderFind(narrowed), /also backs 1 other path/);
  });

  it("upload refuses a snapshot file under a name that isn't a snapshot's, which cleanup wouldn't count", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "only the snapshot kept aside has this");
    const { snapshot: first } = await backup("photos");

    // The user keeps that snapshot under a name that says why. Only a key
    // named `YYYYMMDDTHHMM.tsv.gz` protects its objects from a cleanup
    // (guide/format.md), so publishing this one would let cleanup delete
    // what it names once the dated snapshot is forgotten.
    copyFileSync(
      join(localSnapshots("photos"), `${first}.tsv.gz`),
      join(localSnapshots("photos"), "before-migration.tsv.gz"),
    );

    await assert.rejects(
      upload("photos", { snapshot: "before-migration" }),
      /Snapshot 'before-migration' not found/,
    );
    await assert.rejects(
      upload("photos", { snapshot: first, since: "before-migration" }),
      /Snapshot 'before-migration' not found/,
    );
    assert.equal(
      await fake.peekBytes(BUCKET, "snapshots/photos/before-migration.tsv.gz"),
      undefined,
    );
  });

  it("a backup that is running when the set's other snapshots are forgotten is still recorded", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "last year's content");
    const { snapshot: first } = await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    writeFileSync(join(data, "a.txt"), "this year's content, longer");

    // While the second backup is sending its first object, the holder prunes
    // the only older snapshot from another terminal.
    const realPutFile = fake.putFile.bind(fake);
    let armed = true;
    fake.putFile = async (path, uri, options) => {
      if (armed && uri.includes("/objects/")) {
        armed = false;
        await forget([first], { set: "photos", force: true });
      }
      return realPutFile(path, uri, options);
    };

    const { snapshot } = await backup("photos");

    assert.ok(
      await fake.peekBytes(BUCKET, `snapshots/photos/${snapshot}.tsv.gz`),
      "forgetting the set's only other snapshot took the set out under the backup",
    );
  });
});
