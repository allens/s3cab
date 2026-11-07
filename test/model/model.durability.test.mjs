import assert from "node:assert/strict";
import {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { holdSet } from "../helpers/hold-set.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import {
  backup,
  listSnapshotNames,
  snapshot,
  upload,
  verify,
  writeSet,
} from "./harness/seam.mjs";

// After the seam, so they bind its mocks.
const { status } = await import("../../src/commands/status.mjs");
const { renderStatus, renderVerify } = await import("../../src/render.mjs");

// The 2026-11-05 durability audits' defects (proposals/bugs.md rolls them up;
// ADR-0117 and ADR-0092 hold the decisions), a defect per test, each asserting
// what should be true of the outcome the user reads rather than of one fix's
// shape.

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
 * A set this machine holds, over a folder of the named files.
 * @param {string} root
 * @param {string[]} names
 * @returns {Promise<{ data: string, snapshotsDir: string }>}
 */
async function photosSet(root, names) {
  process.env.S3CAB_HOME = join(root, ".s3cab");
  const folder = join(root, "data");
  mkdirSync(folder);
  const data = realpathSync.native(folder);
  for (const name of names) {
    writeFileSync(join(data, name), `the content of ${name}`);
  }
  const { claimPath, snapshotsDir } = writeSet("photos", {
    dirs: [data],
    bucket: BUCKET,
  });
  await holdSet(BUCKET, "photos", claimPath);
  return { data, snapshotsDir };
}

describe("durability audit", () => {
  it("a backup alongside a --resume run publishes no damaged snapshot", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    await photosSet(dir.path, ["a.txt", "b.txt"]);

    // The first run stops on its first object until the second has reached one
    // of its own (or ended), so the second's work file is open at the lock name.
    const realPutFile = fake.putFile.bind(fake);
    let objectPuts = 0;
    /** @type {() => void} */
    let firstReady = () => {};
    const firstAtObject = new Promise((done) => {
      firstReady = () => done(undefined);
    });
    /** @type {() => void} */
    let secondReady = () => {};
    const secondAtObject = new Promise((done) => {
      secondReady = () => done(undefined);
    });
    /** @type {() => void} */
    let letSecondGo = () => {};
    const secondMayGo = new Promise((done) => {
      letSecondGo = () => done(undefined);
    });
    fake.putFile = async (path, uri, options) => {
      if (uri.includes("/objects/")) {
        objectPuts++;
        if (objectPuts === 1) {
          firstReady();
          await secondAtObject;
        } else if (objectPuts === 2) {
          secondReady();
          await secondMayGo;
        }
      }
      return realPutFile(path, uri, options);
    };

    const first = backup("photos");
    await firstAtObject;
    clockHolder.current.advance(MINUTE_MS);
    const second = backup("photos", { resume: true }).finally(secondReady);
    await first.catch(() => {}); // refusing would be a fine answer
    letSecondGo();
    await second.catch(() => {});

    const { sets } = await verify(BUCKET);
    assert.deepEqual(
      sets.flatMap(({ unreadableSnapshots }) => unreadableSnapshots),
      [],
    );
  });

  it("the retry a failed backup names doesn't hide a file it couldn't read", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const { data, snapshotsDir } = await photosSet(dir.path, [
      "a.txt",
      "m.txt",
      "z.txt",
    ]);

    // `z.txt` goes before its turn, so its row is an `#error`; then the link dies.
    fake.onPutFileRead = async (path) => {
      if (path.endsWith("a.txt")) {
        rmSync(join(data, "z.txt"));
      }
    };
    const realPutFile = fake.putFile.bind(fake);
    let linkUp = false;
    fake.putFile = async (path, uri, options) => {
      if (!linkUp && path.endsWith("m.txt")) {
        throw new Error("the network went away");
      }
      return realPutFile(path, uri, options);
    };
    await assert.rejects(backup("photos"), /carry on from where it stopped/);

    linkUp = true;
    process.exitCode = 0;
    const name = listSnapshotNames(snapshotsDir).at(0);
    await upload("photos", { snapshot: name });

    assert.equal(
      process.exitCode,
      1,
      "a published snapshot that omits a file exits 1, as backup's would",
    );
  });

  it("verify doesn't call a bucket verified without naming a set that has no snapshots", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    await photosSet(dir.path, ["a.txt"]);
    await backup("photos");
    for (const { key } of await fake.listAll(BUCKET)) {
      if (key.startsWith("snapshots/photos/")) {
        await fake.deleteKey(BUCKET, key);
      }
    }

    const result = await verify(BUCKET);

    assert.match(renderVerify(result), /photos/);
  });

  it("status doesn't say up to date while the latest snapshot isn't in the bucket", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const { data } = await photosSet(dir.path, ["a.txt"]);
    await backup("photos");

    clockHolder.current.advance(MINUTE_MS);
    renameSync(join(data, "a.txt"), join(data, "b.txt"));
    await snapshot("photos");

    const report = await status("photos");

    assert.equal(report.snapshotBackedUp, false);
    assert.doesNotMatch(renderStatus(report), /up to date/);
  });
});
