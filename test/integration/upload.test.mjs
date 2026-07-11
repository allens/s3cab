import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteObject, listObjects } from "../../src/lib/s3.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import {
  listRemoteSnapshots,
  remoteSnapshotsPrefix,
} from "../../src/lib/remote.mjs";
import { uploadSnapshot } from "../../src/lib/upload.mjs";
import { writeSnapshot } from "../helpers/write-snapshot.mjs";
import { bucket } from "../helpers/integration.mjs";

// The upload executor's S3 round-trip against a real test bucket (S3 test
// strategy, docs/design/testing.md). The gate/harness lives in the shared
// integration helper; the pure planner (`planUpload`) is covered without a
// bucket by upload.test.mjs. Works off an explicit temp `snapshotDir`, so it
// keeps no s3cab home and resolves AWS credentials from the ambient chain.
const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("uploadSnapshot (real bucket)", () => {
  it("first backup LISTs the store; a --since backup diffs against the local previous snapshot", async () => {
    await using dir = await mkTmpDir();
    const set = `upload-${Date.now()}`;
    const first = "2025-01-15T1030";
    const second = "2025-01-15T1130";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    const fileB = join(contentDir, "b.txt");
    const fileC = join(contentDir, "c.txt");
    // Unique content → unique hashes, so the shared objects/ store stays
    // isolated from other runs and teardown deletes exactly what we made.
    writeFileSync(fileA, `alpha ${set}`);
    writeFileSync(fileB, `beta ${set}`);
    writeFileSync(fileC, `gamma ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    // First snapshot: a.txt + b.txt. Second: a.txt (unchanged) + c.txt (new).
    await writeSnapshot(snapshotDir, first, [fileA, fileB]);
    await writeSnapshot(snapshotDir, second, [fileA, fileC]);

    const { entries: firstEntries } = await readSnapshot(snapshotDir, first);
    const { entries: secondEntries } = await readSnapshot(snapshotDir, second);
    const firstHashes = [
      ...new Set([...firstEntries.values()].map((p) => p.hash)),
    ];
    const secondHashes = [
      ...new Set([...secondEntries.values()].map((p) => p.hash)),
    ];
    // c.txt is the only content the second snapshot adds over the first.
    const newHashes = secondHashes.filter((h) => !firstHashes.includes(h));
    assert.equal(
      newHashes.length,
      1,
      "the second snapshot adds one new object",
    );
    const allHashes = [...new Set([...firstHashes, ...secondHashes])];

    try {
      // First backup: no --since → LIST the (empty) store, upload both objects.
      const firstResult = await uploadSnapshot({
        bucket,
        set,
        snapshotDir,
        name: first,
      });
      assert.equal(firstResult.candidates, firstHashes.length);
      assert.equal(firstResult.uploaded, firstHashes.length);

      // The snapshot is present (uploaded last) and its objects exist.
      assert.deepEqual(await listRemoteSnapshots(bucket, set), [first]);
      for (const hash of firstHashes) {
        const keys = [];
        for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
          if (o.Key) {
            keys.push(o.Key);
          }
        }
        assert.ok(keys.includes(`objects/${hash}`), `object ${hash} missing`);
      }

      // Second backup with --since first: only c.txt is new (a.txt is in the
      // baseline snapshot), so exactly one object is a candidate and uploaded.
      const secondResult = await uploadSnapshot({
        bucket,
        set,
        snapshotDir,
        name: second,
        since: first,
      });
      assert.equal(secondResult.candidates, 1);
      assert.equal(secondResult.uploaded, 1);

      // Re-uploading the same name (first-backup path) uploads nothing — its
      // objects are all in the store — and errors on the immutable snapshot.
      await assert.rejects(
        () => uploadSnapshot({ bucket, set, snapshotDir, name: first }),
        /already backed up/,
      );
    } finally {
      for (const hash of allHashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      for (const name of [first, second]) {
        await deleteObject(
          `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
        );
      }
    }
  });
});
