import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { holdSet } from "../helpers/hold-set.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { checkStore } from "./harness/invariants.mjs";
import { RepoModel, sha256 } from "./harness/model.mjs";
import {
  backup,
  cleanup,
  forget,
  snapshot,
  upload,
  verify,
  writeSet,
} from "./harness/seam.mjs";

// After the seam, so they bind its mocks.
const { status } = await import("../../src/commands/status.mjs");
const { renderStatus, renderVerify } = await import("../../src/render.mjs");

// An adversarial read of 9902ff4f (PR #506): each test asserts what that
// commit says is now true, on an input or interleaving its own tests don't
// reach.

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

describe("adversarial read of PR #506", () => {
  it("cleanup's top-up reads a snapshot that vanished under its scan and was published again with the same bytes", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "topup", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    const { snapshot: name } = await backup("topup");
    const key = `snapshots/topup/${name}.tsv.gz`;
    // A later snapshot keeps the set in the bucket once the first is
    // forgotten; with none, cleanup refuses over a set with no snapshots.
    clockHolder.current.advance(MINUTE_MS);
    writeFileSync(join(data, "a.txt"), "beta");
    await backup("topup");

    // The scan has listed `snapshots/`. Before it reads this key the holder
    // forgets the snapshot, so the scan's GET finds nothing and skips it: the
    // key is in the listing the top-up compares against, and its rows were
    // never read.
    const realGetStream = fake.getStream.bind(fake);
    let scanning = true;
    fake.getStream = async (uri) => {
      if (scanning && uri.endsWith(key)) {
        scanning = false;
        await forget([name], { set: "topup", force: true });
      }
      return realGetStream(uri);
    };
    // Then, before cleanup takes its delete lock, the holder puts it back from
    // the local file `forget` leaves in place: the same key, the same bytes,
    // the same ETag.
    const realPutText = fake.putText.bind(fake);
    let armed = true;
    fake.putText = async (uri, content, options) => {
      if (armed && uri.includes("/locks/delete-")) {
        armed = false;
        await upload("topup", { snapshot: name });
      }
      return realPutText(uri, content, options);
    };
    await cleanup(BUCKET, { force: true });

    assert.ok(
      await fake.peekBytes(BUCKET, key),
      "the snapshot is published when cleanup deletes",
    );
    const model = new RepoModel(BUCKET, fake);
    assert.deepEqual(
      await checkStore(model),
      [],
      "cleanup deleted content a published snapshot references",
    );
  });

  it("verify doesn't call a bucket verified when a set's snapshots and marker are gone and another set is fine", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const photos = await makeSet(root, "photos", "photos");
    writeFileSync(join(photos, "a.txt"), "alpha");
    await backup("photos");
    const docs = await makeSet(root, "docs", "docs");
    writeFileSync(join(docs, "d.txt"), "delta");
    await backup("docs");

    // Everything under the prefix `snapshots/photos` goes — what a lifecycle
    // rule or `aws s3 rm --recursive s3://b/snapshots/photos` matches: the
    // set's folder and its `.info` marker alike. Its objects stay, and so does
    // s3cab's own record of the set under `.s3cab/sets/photos/`.
    for (const { key } of await fake.listAll(BUCKET)) {
      if (key.startsWith("snapshots/photos")) {
        await fake.deleteKey(BUCKET, key);
      }
    }
    const left = (await fake.listAll(BUCKET)).map(({ key }) => key);
    assert.ok(
      left.includes(".s3cab/sets/photos/dirs.txt"),
      "the bucket still says there is a set called photos",
    );

    process.exitCode = 0;
    const result = await verify(BUCKET);

    assert.equal(
      process.exitCode,
      1,
      `a set with nothing left to restore from must not pass: ${renderVerify(result)}`,
    );
    assert.ok(
      result.sets.some(({ set }) => set === "photos"),
      "the set the bucket still has a record of is reported, not omitted",
    );
  });

  /**
   * A set with two snapshots of one file's two versions, then every snapshot
   * gone from the bucket: marker, config and objects all still there.
   * @param {string} root
   * @returns {Promise<{ names: string[], hashes: string[] }>}
   */
  const setWithLostSnapshots = async (root) => {
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    const versions = ["the first version", "the second version"];
    const names = [];
    for (const content of versions) {
      writeFileSync(join(data, "a.txt"), content);
      const { snapshot: name } = await backup("photos");
      names.push(name);
      clockHolder.current.advance(MINUTE_MS);
    }
    for (const { key } of await fake.listAll(BUCKET)) {
      if (key.startsWith("snapshots/photos/")) {
        await fake.deleteKey(BUCKET, key);
      }
    }
    return { names, hashes: versions.map((content) => sha256(content)) };
  };

  it("control: a set whose snapshots are gone from the bucket is whole again once the holder uploads its local copies", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const { names } = await setWithLostSnapshots(dir.path);

    for (const name of names) {
      await upload("photos", { snapshot: name });
    }

    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(await checkStore(new RepoModel(BUCKET, fake)), []);
  });

  it("cleanup doesn't empty the store of a set whose marker is there and whose snapshots are gone", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const { hashes } = await setWithLostSnapshots(dir.path);

    // `verify` now reports this bucket (`no snapshots`, exit 1, ADR-0117).
    // `cleanup` reads the same scan and sees a store nothing references.
    await cleanup(BUCKET, { force: true }).catch(() => {});

    const stored = (await fake.listAll(BUCKET)).map(({ key }) => key);
    assert.deepEqual(
      hashes.filter((hash) => !stored.includes(`objects/${hash}`)),
      [],
      "cleanup deleted every version the lost snapshots held; the holder's local copies can no longer bring the first back",
    );
  });

  it("verify can pass again after a set's snapshots were all forgotten on purpose", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const keep = await makeSet(root, "keep", "keep");
    writeFileSync(join(keep, "k.txt"), "kept");
    await backup("keep");
    const old = await makeSet(root, "old", "old");
    writeFileSync(join(old, "o.txt"), "no longer wanted");
    const { snapshot: name } = await backup("old");

    // The set is retired with s3cab's own command: forgetting its last
    // snapshot, and no backup of it will ever come.
    await forget([name], { set: "old", force: true });
    await cleanup(BUCKET, { force: true });

    process.exitCode = 0;
    const result = await verify(BUCKET);

    assert.equal(
      process.exitCode,
      0,
      `nothing is wrong with this bucket, and nothing s3cab offers makes this exit 0 again: ${renderVerify(result)}`,
    );
  });

  it("cleanup keeps what a snapshot under snapshots/ references, whatever its folder is called", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    const old = Buffer.from("only the 2025 snapshot has this");
    writeFileSync(join(data, "old.txt"), old);
    const { snapshot: first } = await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    renameSync(join(data, "old.txt"), join(data, "new.txt"));
    writeFileSync(join(data, "new.txt"), "this year's content");
    await backup("photos");

    // The user keeps last year's snapshot aside in a folder of their own
    // naming, which isn't a set's, before forgetting it from the live set.
    const bytes = await fake.peekBytes(
      BUCKET,
      `snapshots/photos/${first}.tsv.gz`,
    );
    assert.ok(bytes);
    await fake.putBytes(BUCKET, `snapshots/photos_2025/${first}.tsv.gz`, bytes);
    await forget([first], { set: "photos", force: true });

    await cleanup(BUCKET, { force: true });

    assert.ok(
      await fake.peekBytes(BUCKET, `objects/${sha256(old)}`),
      "cleanup deleted an object a snapshot file under snapshots/ still references",
    );
  });

  it("status doesn't say up to date when the newest snapshot sorts before a backed-up one", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    clockHolder.current.advance(105 * MINUTE_MS);
    const { snapshot: backedUp } = await backup("photos");

    // Daylight saving ends (snapshot.clock.test.mjs's first case): the clocks
    // go back an hour, and a rename and an offline snapshot 25 minutes on land
    // in no bucket, under a name that sorts before the backed-up one.
    clockHolder.current.advance(25 * MINUTE_MS);
    clockHolder.current.zone = "Etc/GMT+1";
    renameSync(join(data, "a.txt"), join(data, "b.txt"));
    await snapshot("photos");

    const report = await status("photos");

    assert.equal(
      report.snapshot,
      backedUp,
      "the older snapshot reads as latest",
    );
    assert.doesNotMatch(
      renderStatus(report),
      /up to date/,
      "the snapshot taken last is not in the bucket",
    );
  });

  it("status doesn't call a forgotten snapshot taken later because its file was written last", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    const { snapshot: first } = await backup("photos");
    clockHolder.current.advance(MINUTE_MS);
    writeFileSync(join(data, "a.txt"), "beta");
    await backup("photos");

    // The holder forgets the first snapshot, whose local file stays; a copy of
    // `~/.s3cab`, or a pull, which writes the newest first, leaves it the file
    // written last.
    await forget([first], { set: "photos", force: true });
    const later = new Date(Date.now() + 60 * MINUTE_MS);
    const home = String(process.env.S3CAB_HOME);
    const file = join(home, "sets", "photos", "snapshots", `${first}.tsv.gz`);
    utimesSync(file, later, later);

    const report = await status("photos");

    assert.deepEqual(report.takenLater, []);
    assert.match(renderStatus(report), /up to date$/);
  });

  it("status passes over an older local snapshot that won't read", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    clockHolder.current.advance(60 * MINUTE_MS);
    await backup("photos");

    // A failed backup's snapshot from a minute before, never uploaded, damaged.
    const home = String(process.env.S3CAB_HOME);
    const snapshots = join(home, "sets", "photos", "snapshots");
    writeFileSync(join(snapshots, "20260105T0059.tsv.gz"), "not gzip");

    const report = await status("photos");

    assert.match(renderStatus(report), /up to date$/);
  });

  it("status reads past an older local snapshot whose name isn't a real time", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    clockHolder.current.advance(60 * MINUTE_MS);
    const { snapshot: latest } = await backup("photos");

    // A copy saved by hand under a name with minute 60, which sorts just
    // before the latest's.
    const home = String(process.env.S3CAB_HOME);
    const snapshots = join(home, "sets", "photos", "snapshots");
    copyFileSync(
      join(snapshots, `${latest}.tsv.gz`),
      join(snapshots, "20260105T0060.tsv.gz"),
    );

    const report = await status("photos");

    assert.match(renderStatus(report), /up to date$/);
  });

  it("status doesn't say up to date when the bucket holds another machine's snapshot under the latest one's name", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;

    // Machine A backs up, then renames a file and snapshots offline a minute
    // later: local only, and every object it names is already stored.
    useHome(root, "mA");
    const dataA = await makeSet(root, "col", "dataA");
    writeFileSync(join(dataA, "a.txt"), "the same content");
    await backup("col");
    clockHolder.current.advance(MINUTE_MS);
    renameSync(join(dataA, "a.txt"), join(dataA, "renamed.txt"));
    await snapshot("col");

    // Machine B holds the set by then and backs up in the same minute: the
    // same name, another document (model.findings.test.mjs, ADR-0084).
    useHome(root, "mB");
    const dataB = await makeSet(root, "col", "dataB");
    writeFileSync(join(dataB, "a.txt"), "the same content");
    const { snapshot: theirs } = await backup("col");

    useHome(root, "mA");
    const report = await status("col");

    assert.equal(report.snapshot, theirs, "same minute, same name");
    assert.doesNotMatch(
      renderStatus(report),
      /up to date/,
      "A's latest snapshot is not in the bucket; B's is, under its name",
    );
    assert.equal(report.snapshotInBucket, "different");
  });
});
