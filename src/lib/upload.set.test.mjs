import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, it, mock } from "node:test";
import { fileProps } from "./file-props.mjs";
import { uploadLockSeam } from "../../test/helpers/lock-seam.mjs";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";

/** @import { UploadLockArgs } from "../../test/helpers/lock-seam.mjs" */
/** @import { BackupSet } from "./sets.mjs" */
/** @import { SnapshotRow } from "./snapshot-file.mjs" */
/** @import { SnapshotBaseline } from "./snapshot.mjs" */

// `uploadSet`, the fused pass behind `backup` (ADR-0069): what's already
// stored is settled *before* anything is hashed, the object uploader rides
// inside the snapshot write, and the manifest goes up last — all under the
// upload lock (ADR-0112). The snapshot engine is faked (its `generateSnapshot`
// here drains the rows it is given through the transform it is handed), the
// lock is test/helpers/lock-seam.mjs's passthrough reporting into `events`, and
// the s3.mjs seam records every request, so the requests the bucket sees are
// the evidence of the order. Mocks first, then a dynamic import.

/** @type {string[]} every seam request and engine call, in order */
let events = [];
/** @type {Map<string, Buffer>} bytes `getStream` serves per URI — a miss throws NoSuchKey */
let remoteFiles = new Map();
/** @type {string[]} hashes the store LIST yields */
let storeHashes = [];
/** @type {Error | undefined} let every object PUT fail */
let putError;
/** @type {SnapshotBaseline} what the faked `readBaseline` returns */
let baseline;
/** @type {Record<string, unknown>[]} the options each `readBaseline` call got */
let baselineCalls = [];
/** @type {SnapshotRow[]} the rows the faked pass streams through the uploader */
let rows = [];
/** @type {Record<string, unknown> | undefined} the options `generateSnapshot` got */
let generateOptions;
/** @type {UploadLockArgs[]} what the lock was asked to hold */
let lockCalls = [];

mock.module("./s3.mjs", {
  exports: s3Seam({
    getStream: async (/** @type {string} */ uri) => {
      events.push(`get:${uri}`);
      const bytes = remoteFiles.get(uri);
      if (!bytes) {
        throw Object.assign(new Error(`no such key: ${uri}`), {
          name: "NoSuchKey",
        });
      }
      return Readable.from([bytes]);
    },
    putFile: async (/** @type {string} */ _path, /** @type {string} */ uri) => {
      events.push(`put:${uri}`);
      if (putError && uri.includes("/objects/")) {
        throw putError;
      }
      return true;
    },
    listObjects: async function* (/** @type {string} */ uri) {
      events.push(`list:${uri}`);
      for (const hash of storeHashes) {
        yield { Key: `objects/${hash}` };
      }
    },
  }),
});
mock.module("./deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => ({ deleted: new Map(), invalid: [] }),
  },
});
mock.module("./set-marker.mjs", {
  exports: {
    assertHeld: async () => {
      events.push("assertHeld");
    },
  },
});
mock.module("./locks.mjs", {
  exports: uploadLockSeam({
    held: (args) => lockCalls.push(args),
    event: (name) => events.push(name),
  }),
});
mock.module("./snapshot.mjs", {
  exports: {
    readBaseline: async (
      /** @type {object} */ _set,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      events.push("readBaseline");
      baselineCalls.push(options);
      return baseline;
    },
    generateSnapshot: async (
      /** @type {object} */ _set,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      events.push("generateSnapshot");
      generateOptions = options;
      const through =
        /** @type {(rows: SnapshotRow[]) => AsyncIterable<SnapshotRow>} */ (
          options.through
        );
      for await (const row of through(rows)) {
        void row;
      }
      return {
        name: "20260102T0900",
        path: "snaps/20260102T0900.tsv.gz",
        files: rows.length,
        bytes: 0,
        hashedFiles: rows.length,
        hashedBytes: 0,
        errors: [],
        elapsedMs: 9,
        roots: [],
      };
    },
  },
});

const { uploadSet } = await import("./upload.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const sha = (/** @type {string} */ content) =>
  crypto.hash("sha256", Buffer.from(content), "hex");

/**
 * A set in a temp dir, with one file to back up and its row for the pass.
 * @param {string} dirPath
 */
const fixture = async (dirPath) => {
  // Absolute, as the walk would spell them: a snapshot keys on the path.
  const content = resolve(dirPath, "content");
  const snapshotsDir = resolve(dirPath, "snapshots");
  mkdirSync(content, { recursive: true });
  mkdirSync(snapshotsDir, { recursive: true });
  const file = join(content, "photo.raw");
  writeFileSync(file, "original bytes");
  const props = await fileProps(file);
  rows = [[file, props]];
  /** @type {BackupSet} */
  const set = {
    name: "photos",
    bucket: "b",
    dir: dirPath,
    dirs: [content],
    dirsPath: join(dirPath, "dirs.txt"),
    envPath: join(dirPath, "env"),
    snapshotsDir,
    excludePath: join(dirPath, "exclude.txt"),
    claimPath: join(dirPath, "claim"),
  };
  return { set, file, props, hash: sha("original bytes") };
};

const objectUri = (/** @type {string} */ hash) => `s3://b/objects/${hash}`;
const manifestUri = "s3://b/snapshots/photos/20260102T0900.tsv.gz";

beforeEach(() => {
  events = [];
  remoteFiles = new Map();
  storeHashes = [];
  putError = undefined;
  baseline = { previousErrors: new Map() }; // a first backup
  baselineCalls = [];
  rows = [];
  generateOptions = undefined;
  lockCalls = [];
});

describe("uploadSet (the fused pass)", () => {
  it("settles what's stored before hashing, uploads inside the pass, publishes the manifest last — under the lock", async () => {
    await using dir = await mkTmpDir();
    const { set, hash } = await fixture(dir.path);

    const result = await uploadSet(set);

    assert.deepEqual(events, [
      "lock",
      "readBaseline",
      // A first backup: the store is LISTed before a single file is hashed, so
      // a credentials or network problem surfaces in seconds.
      "list:s3://b/objects/",
      "generateSnapshot",
      // The object ships inside the pass…
      `put:${objectUri(hash)}`,
      // …and the manifest only once the pipeline has drained, after the
      // holder check the format requires.
      "assertHeld",
      `put:${manifestUri}`,
      "unlock",
    ]);
    // The uploader rides *inside* the snapshot write — that is the fusion —
    // and the whole of `readBaseline`'s result is forwarded, not picked apart.
    assert.ok(generateOptions?.through, "the upload transform was passed");
    assert.equal(generateOptions?.baseline, baseline);
    assert.deepEqual(baselineCalls, [{ rehash: undefined, resume: undefined }]);
    const { sendingMs, pass, ...rest } = result;
    assert.equal(pass.name, "20260102T0900");
    assert.deepEqual(rest, {
      baseline,
      candidates: 1,
      uploaded: 1,
      uploadedBytes: "original bytes".length,
    });
    assert.ok(sendingMs >= 0);
  });

  it("holds the upload lock for the set, as a backup", async () => {
    await using dir = await mkTmpDir();
    const { set } = await fixture(dir.path);

    await uploadSet(set, { resume: true });

    assert.deepEqual(lockCalls, [
      { bucket: "b", command: "backup", set: "photos" },
    ]);
  });

  it("passes --rehash and --resume to the baseline read, --debug to the pass", async () => {
    await using dir = await mkTmpDir();
    const { set } = await fixture(dir.path);

    await uploadSet(set, { rehash: true, resume: true, debug: true });

    assert.deepEqual(baselineCalls, [{ rehash: true, resume: true }]);
    assert.equal(generateOptions?.debug, true);
  });

  it("skips against a baseline the cloud still holds byte-for-byte, with no store LIST (ADR-0084)", async () => {
    await using dir = await mkTmpDir();
    const { set, file, props, hash } = await fixture(dir.path);
    const since = "20260101T0900";
    await writeSnapshot(set.snapshotsDir, since, [file]);
    const baselineUri = `s3://b/snapshots/photos/${since}.tsv.gz`;
    remoteFiles.set(
      baselineUri,
      readFileSync(join(set.snapshotsDir, `${since}.tsv.gz`)),
    );
    baseline = {
      name: since,
      previous: new Map([[file, props]]),
      previousErrors: new Map(),
    };

    const result = await uploadSet(set);

    // The one GET is the trust check; the file's hash is in the trusted
    // baseline, so its object is never attempted.
    assert.deepEqual(
      events.filter((e) => e.startsWith("get:") || e.startsWith("list:")),
      [`get:${baselineUri}`],
    );
    assert.ok(!events.includes(`put:${objectUri(hash)}`));
    assert.equal(result.candidates, 0);
  });

  it("reports an upload failure without publishing the manifest, pointing at the cheap retry", async () => {
    // The local snapshot landed (generateSnapshot returned), so the fix is to
    // re-send the objects — not to re-hash the whole set.
    await using dir = await mkTmpDir();
    const { set } = await fixture(dir.path);
    putError = new Error("connection reset");

    await assert.rejects(uploadSet(set), (/** @type {Error} */ error) => {
      assert.match(error.message, /connection reset/);
      assert.match(
        error.message,
        /s3cab upload photos --snapshot 20260102T0900/,
      );
      assert.equal(error.cause, putError);
      return true;
    });

    assert.ok(!events.includes(`put:${manifestUri}`), "no manifest");
    assert.equal(events.at(-1), "unlock", "the lock is released on failure");
  });

  it("raises the drift error, not the resume advice — a drifted file needs a fresh backup", async () => {
    // A drifted row can never be reconciled with the file as it now stands, so
    // wrapping it in the "carry on where it stopped" advice would send the user
    // at a retry that must fail.
    await using dir = await mkTmpDir();
    const { set, file } = await fixture(dir.path);
    writeFileSync(file, "different, longer bytes"); // drifts after hashing

    await assert.rejects(uploadSet(set), (/** @type {Error} */ error) => {
      assert.match(error.message, /Couldn't back up '.*photo\.raw'/);
      assert.match(error.message, /while the backup was running/);
      assert.match(error.message, /s3cab backup photos/);
      assert.doesNotMatch(error.message, /--snapshot/);
      return true;
    });

    assert.ok(!events.some((e) => e.startsWith("put:")), "nothing stored");
  });

  it("blames the dropped link, not an earlier drift, when both happened", async () => {
    // One first-wins slot let a drift on an early row speak for a dead
    // network met on a later one, so the user was sent at a fresh backup when
    // the actual problem was the link.
    await using dir = await mkTmpDir();
    const { set, file } = await fixture(dir.path);
    const other = join(dir.path, "content", "other.raw");
    writeFileSync(other, "other bytes");
    rows.push([other, await fileProps(other)]);
    writeFileSync(file, "different, longer bytes"); // row 1 drifts
    putError = new Error("connection reset"); // row 2's PUT then dies

    await assert.rejects(uploadSet(set), (/** @type {Error} */ error) => {
      assert.match(error.message, /connection reset/);
      assert.match(error.message, /--snapshot 20260102T0900/);
      return true;
    });
  });
});
