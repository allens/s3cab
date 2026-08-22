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
    listObjects: async function* () {}, // an empty store
    putText: async () => {},
    getText: async () => undefined,
    // The baseline-identity probe (ADR-0084) finds every remote snapshot
    // absent, so no baseline is ever trusted and each backup LISTs the store.
    getStream: async () => {
      throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    },
    isObjectNotFound: (/** @type {unknown} */ error) =>
      Error.isError(error) && error.name === "NoSuchKey",
    deleteObject: async () => {},
    // Imported by objects.mjs (storedObjectSize); no test here calls it.
    objectSize: async () => undefined,
  },
});

const { backup } = await import("./backup.mjs");
const { writeSet } = await import("../lib/sets.mjs");
const { listSnapshotNames, readSnapshot } =
  await import("../lib/snapshot-file.mjs");
const { writeSnapshot } = await import("../../test/helpers/write-snapshot.mjs");

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

// What a finished run reports (ADR-0078), measured by the real engine rather
// than a faked one — the figures are only worth anything if they are the pass's
// own, and the files-versus-objects gap below is exactly what makes an object
// count a bad answer to "what did that do?".
describe("backup's run report (real engine)", () => {
  const data = (/** @type {string} */ root) =>
    realpathSync.native(join(root, "data"));

  it("counts the files it went through, apart from the objects it sent", async () => {
    await using dir = await mkTmpDir();
    oneSet(dir.path);

    const result = await backup("photos");

    assert.equal(result.bucket, "b");
    // Three files, 15 bytes read — but two of them share their content, so only
    // two objects and 10 bytes ever went over the wire. Reporting the transfer
    // alone would have called this a two-file backup.
    assert.equal(result.files, 3);
    assert.equal(result.bytes, 15);
    assert.equal(result.uploaded, 2);
    assert.equal(result.uploadedBytes, 10);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    // Nothing to reuse on a first backup, so every file was really read.
    assert.equal(result.hashedFiles, 3);
    assert.equal(result.hashedBytes, 15);
    // Both halves of the pass are measured, and neither can be negative — the
    // scan half is the pass minus the sending (ADR-0078 §9).
    assert.ok(result.scanMs >= 0);
    assert.ok(result.uploadMs >= 0);
    // A first backup runs no diff at all (§7).
    assert.equal(result.comparison, null);
  });

  it("counts what it really read, apart from what it only checked", async () => {
    // The figure that tells a routine pass from one that re-read the whole set.
    // Every file is unchanged against the baseline, so all three hashes are
    // reused and not a byte is opened — while `files`/`bytes` still describe
    // the set in full.
    await using dir = await mkTmpDir();
    const snapshotDir = oneSet(dir.path);
    await writeSnapshot(
      snapshotDir,
      "2020-01-01T0900",
      ["a.txt", "b.txt", "copy.txt"],
      data(dir.path),
    );

    const result = await backup("photos");

    assert.equal(result.files, 3);
    assert.equal(result.bytes, 15);
    assert.equal(result.hashedFiles, 0);
    assert.equal(result.hashedBytes, 0);
  });

  it("names the destination bucket in the preamble", async () => {
    // Until this, the only line naming the bucket was the store LIST's, which
    // fires only when there is no trusted baseline — so s3cab said where the
    // backup was going on the first run and never again (ADR-0078 §11).
    await using dir = await mkTmpDir();
    oneSet(dir.path);
    /** @type {string[]} */
    const said = [];
    const warn = mock.method(console, "warn", (/** @type {unknown[]} */ ...m) =>
      said.push(m.join(" ")),
    );

    try {
      await backup("photos");
    } finally {
      warn.mock.restore();
    }

    assert.match(said.join("\n"), /^Storing objects in 's3:\/\/b'$/m);
  });

  it("diffs the snapshot it just wrote against the baseline already in memory", async () => {
    // The summary and the command it prints have to be the same computation, or
    // "1 added" over a listing of none is a trust bug (ADR-0078 §8).
    await using dir = await mkTmpDir();
    const snapshotDir = oneSet(dir.path);
    const root = data(dir.path);
    // A baseline taken before `copy.txt` existed.
    await writeSnapshot(
      snapshotDir,
      "2020-01-01T0900",
      ["a.txt", "b.txt"],
      root,
    );

    const result = await backup("photos");

    assert.equal(result.comparison?.since, "2020-01-01T0900");
    assert.equal(result.comparison?.until, result.snapshot);
    assert.deepEqual(
      result.comparison?.added.map((entry) => entry.path),
      [join(root, "copy.txt")],
    );
    // It is a copy of content the backup already holds, which is why nothing
    // about it was uploaded — the diff says so rather than calling it new.
    assert.deepEqual(result.comparison?.added[0]?.duplicates, [
      join(root, "a.txt"),
    ]);
  });
});
