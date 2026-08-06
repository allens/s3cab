import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// The fused pass end to end, with only the S3 seam faked (docs/design/testing.md:
// "mock at s3.mjs, not the AWS SDK"). Everything under it is real — the walk, the
// hashing, the snapshot writer — so `putUris` is honest evidence of *when* each
// object went up relative to the snapshot, which is the whole of ADR-0069. Its
// sibling backup.test.mjs fakes the libs to check the wiring; this one runs them.

/** @type {string[]} URIs PUT, in call order. */
let putUris = [];
/** @type {Error | undefined} Let every PUT fail, to drive the failure path. */
let putError;

mock.module("../lib/s3.mjs", {
  exports: {
    putFile: async (/** @type {string} */ _path, /** @type {string} */ uri) => {
      putUris.push(uri);
      if (putError) {
        throw putError;
      }
      return true;
    },
    objectExists: async () => false, // no baseline to trust on a first backup
    listObjects: async function* () {}, // an empty store
    putText: async () => {},
    getText: async () => undefined,
    getStream: async () => {
      throw new Error("unexpected getStream in a backup test");
    },
    deleteObject: async () => {},
    isObjectNotFound: () => true,
  },
});

const { backup } = await import("./backup.mjs");
const { writeSet } = await import("../lib/sets.mjs");
const { listSnapshotNames, readSnapshot } =
  await import("../lib/snapshot-file.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const sha = (/** @type {string} */ content) =>
  crypto.hash("sha256", Buffer.from(content), "hex");

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  putUris = [];
  putError = undefined;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A set of three files, two of which share their content.
 * @param {string} root - A disposable directory to build the set and its home in
 * @returns {string} the set's snapshot store
 */
const oneSet = (root) => {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "a.txt"), "hello");
  writeFileSync(join(data, "b.txt"), "world");
  writeFileSync(join(data, "copy.txt"), "hello"); // same content as a.txt
  const home = useTempHome(root);
  writeSet("photos", { dirs: [realpathSync.native(data)], bucket: "b" });
  return join(home, ".s3cab", "sets", "photos", "snapshots");
};

describe("backup (fused snapshot + upload, real engine)", () => {
  it("PUTs each distinct object during the hash pass and the snapshot last", async () => {
    await using dir = await mkTmpDir();
    const snapshotDir = oneSet(dir.path);

    const result = await backup("photos");

    // Objects first, snapshot last — and identical content uploaded once.
    assert.deepEqual(putUris, [
      `s3://b/objects/${sha("hello")}`,
      `s3://b/objects/${sha("world")}`,
      `s3://b/snapshots/photos/${result.snapshot}.tsv.zst`,
    ]);
    assert.equal(result.candidates, 2);
    assert.equal(result.uploaded, 2);

    // The snapshot the fused pass wrote records all three files, exactly as a
    // plain `snapshot` would have.
    const { entries } = await readSnapshot(snapshotDir, result.snapshot);
    assert.equal(entries.size, 3);
  });

  it("leaves the complete local snapshot behind when the transfers fail", async () => {
    // The cheap-retry invariant: the stat-and-hash pass is never thrown away, so
    // the fix is `upload <set> --snapshot <name>`, not a whole fresh backup.
    await using dir = await mkTmpDir();
    const snapshotDir = oneSet(dir.path);
    putError = new Error("connection reset");

    await assert.rejects(backup("photos"), (/** @type {Error} */ error) => {
      assert.match(error.message, /connection reset/);
      assert.match(error.message, /s3cab upload photos --snapshot /);
      return true;
    });

    // No manifest went up (only the one failed object attempt) …
    assert.equal(putUris.length, 1);
    // … but the snapshot is on disk, complete, with every file in it.
    const name = listSnapshotNames(snapshotDir).at(0);
    assert.ok(name, "expected the local snapshot to have landed");
    const { entries } = await readSnapshot(snapshotDir, name);
    assert.equal(entries.size, 3);
    assert.ok(existsSync(join(snapshotDir, `${name}.tsv.zst`)));
  });
});
