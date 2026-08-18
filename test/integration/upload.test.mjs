import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

      // Re-uploading the same name uploads nothing — its objects are all in
      // the store — and, because the remote manifest is byte-identical to the
      // local file, the 412 reads as its own earlier success and the publish
      // succeeds quietly (ADR-0084).
      const reRun = await uploadSnapshot({
        bucket,
        set,
        snapshotDir,
        name: first,
      });
      assert.equal(reRun.uploaded, 0);
      assert.deepEqual(await listRemoteSnapshots(bucket, set), [second, first]);

      // But the same name holding *different* bytes is still the immutability
      // error: rewrite the local `first` manifest (an extra file changes its
      // rows — removed first, since the writer refuses same-name overwrites)
      // and the remote copy no longer matches.
      rmSync(join(snapshotDir, `${first}.tsv.zst`));
      await writeSnapshot(snapshotDir, first, [fileA, fileB, fileC]);
      await assert.rejects(
        () => uploadSnapshot({ bucket, set, snapshotDir, name: first }),
        /the name was already taken when we wrote it/,
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

  it("re-uploads an object its forgotten baseline claimed stored — the baseline-trust check", async () => {
    // The HIGH baseline-trust bug (proposals/bugs.md): backup, forget that
    // remote snapshot, cleanup deletes its now-orphan object — then a second
    // backup of the unchanged file used to trust the stale local baseline,
    // skip the object, and publish a snapshot referencing a missing object.
    // The fix reads the baseline's remote copy (byte-identity, ADR-0084):
    // gone remotely → distrust it, LIST instead.
    await using dir = await mkTmpDir();
    const set = `trust-${Date.now()}`;
    const first = "2025-01-15T1030";
    const second = "2025-01-15T1130";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const file = join(contentDir, "kept.txt");
    // Unique content → unique hash, so the shared store stays isolated.
    writeFileSync(file, `kept ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    // The file is unchanged between the snapshots — the second records the
    // same hash without re-reading, exactly the repro's stale-baseline shape.
    await writeSnapshot(snapshotDir, first, [file]);
    await writeSnapshot(snapshotDir, second, [file]);

    const { entries } = await readSnapshot(snapshotDir, first);
    const props = entries.get(file);
    assert(props, "the file should be in the snapshot");
    const hash = props.hash;

    try {
      // Backup one: the object and the snapshot go up.
      const firstResult = await uploadSnapshot({
        bucket,
        set,
        snapshotDir,
        name: first,
      });
      assert.equal(firstResult.uploaded, 1);

      // Forget the remote snapshot, then "cleanup" its now-orphan object —
      // the delete/cleanup dance, done directly. Local history is untouched.
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${first}.tsv.zst`,
      );
      await deleteObject(`s3://${bucket}/objects/${hash}`);

      // Backup two, unchanged file, --since the forgotten baseline: the
      // baseline must be distrusted and the object re-uploaded — never a
      // published snapshot referencing a missing object.
      const secondResult = await uploadSnapshot({
        bucket,
        set,
        snapshotDir,
        name: second,
        since: first,
      });
      assert.equal(secondResult.candidates, 1);
      assert.equal(secondResult.uploaded, 1);

      // The published snapshot's object really is back in the store.
      assert.deepEqual(await listRemoteSnapshots(bucket, set), [second]);
      const keys = [];
      for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
        if (o.Key) {
          keys.push(o.Key);
        }
      }
      assert.deepEqual(keys, [`objects/${hash}`]);
    } finally {
      await deleteObject(`s3://${bucket}/objects/${hash}`);
      for (const name of [first, second]) {
        await deleteObject(
          `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
        );
      }
    }
  });

  it("fails when a file drifts mid-backup — no snapshot published, drifted object never stored", async () => {
    await using dir = await mkTmpDir();
    const set = `drift-${Date.now()}`;
    const name = "2025-01-15T1030";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const stable = join(contentDir, "stable.txt");
    const drifting = join(contentDir, "drifting.txt");
    // Unique content → unique hashes, so the shared store stays isolated.
    writeFileSync(stable, `stable ${set}`);
    writeFileSync(drifting, `original ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    // stable first, drifting second: stable's object goes up, drifting's is
    // skipped, and the run fails at the end without publishing (ADR-0069 — a
    // drifted file costs that one file, not the other files' bytes).
    await writeSnapshot(snapshotDir, name, [stable, drifting]);

    const { entries } = await readSnapshot(snapshotDir, name);
    const stableProps = entries.get(stable);
    const driftProps = entries.get(drifting);
    assert(stableProps && driftProps, "both files should be in the snapshot");
    const stableHash = stableProps.hash;
    const driftHash = driftProps.hash;

    // The file changes after the snapshot but before its turn to upload.
    writeFileSync(drifting, `changed, and now a longer body ${set}`);

    try {
      await assert.rejects(
        () => uploadSnapshot({ bucket, set, snapshotDir, name }),
        /while the backup was running/,
      );

      // The snapshot was withheld — nothing published, so the objects-first/
      // snapshot-last invariant stays absolute (no snapshot references an
      // object we couldn't store correctly).
      assert.deepEqual(await listRemoteSnapshots(bucket, set), []);

      // The drifted file's current bytes were never PUT under the snapshot's
      // old-content hash — the corruption this guard exists to prevent.
      const driftKeys = [];
      for await (const o of listObjects(
        `s3://${bucket}/objects/${driftHash}`,
      )) {
        if (o.Key) {
          driftKeys.push(o.Key);
        }
      }
      assert.equal(
        driftKeys.length,
        0,
        "the drifted object must not be stored",
      );
    } finally {
      // stable.txt's object may have gone up before the abort (objects-first);
      // delete whatever landed. No snapshot to remove — none was published.
      for (const hash of [stableHash, driftHash]) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
    }
  });
});
