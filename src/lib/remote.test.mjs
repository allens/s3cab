import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadEnv } from "./env.mjs";
import { deleteObject, listObjects, putData } from "./s3.mjs";
import { readSnapshot } from "./snapshot-file.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";
import {
  deleteRemoteSnapshot,
  downloadRemoteSnapshots,
  listRemoteSnapshots,
  readLatestRemoteSnapshot,
  referencedObjects,
  remoteSnapshotsPrefix,
  uploadCandidates,
  uploadSnapshot,
} from "./remote.mjs";

/**
 * Build a snapshot lookup from a path→hash map — only the hash matters to
 * `uploadCandidates`, so size/mtime are filler.
 * @param {Record<string, string>} pathToHash
 * @returns {import("./snapshot-file.mjs").SnapshotEntries}
 */
const lookup = (pathToHash) =>
  new Map(
    Object.entries(pathToHash).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

// The gated tests below work entirely off an explicit temp `snapshotDir`, so they
// keep no s3cab home; they resolve AWS credentials from the ambient chain (CI/OIDC
// or a local ~/.aws profile).
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

// S3 test strategy (docs/design/testing.md): the S3-touching code is exercised
// against a real test bucket, gated on `S3CAB_TEST_BUCKET` (+ ambient AWS
// credentials) and skipped with a message when unset — so local/offline/fork
// runs stay green and real coverage runs only where the bucket is wired. The
// pure name-sorting these listers reuse is covered without a bucket by
// list.test.mjs (via `snapshotNames`).
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

// These gated suites call the S3 ops directly (no CLI entry point), so they must
// trip the env-loaded flag client() asserts (ADR-0022) — ambient AWS credentials
// supply the real creds; this just sets the flag. At module scope so it runs
// before the file-level beforeEach snapshots process.env (afterEach then keeps it).
if (TEST_BUCKET) {
  loadEnv();
}

describe("remoteSnapshotsPrefix", () => {
  it("places a set's snapshots under snapshots/<set>/", () => {
    assert.equal(remoteSnapshotsPrefix("photos"), "snapshots/photos/");
  });
});

describe("uploadCandidates", () => {
  it("returns hashes in target but not in remote", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const remote = lookup({ "a.txt": "h1" });
    assert.deepEqual([...uploadCandidates(target, remote)].sort(), [
      "h2",
      "h3",
    ]);
  });

  it("treats an empty remote (a set's first backup) as: everything is a candidate", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    assert.deepEqual([...uploadCandidates(target, new Map())].sort(), [
      "h1",
      "h2",
    ]);
  });

  it("counts a hash under several paths once", () => {
    const target = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    assert.deepEqual([...uploadCandidates(target, new Map())].sort(), [
      "h1",
      "h2",
    ]);
  });

  it("matches on content — a file that only moved or was renamed is not re-uploaded", () => {
    const target = lookup({ "new/place.txt": "h1" });
    const remote = lookup({ "old/place.txt": "h1" });
    assert.deepEqual([...uploadCandidates(target, remote)], []);
  });

  it("returns nothing when every target hash is already present remotely", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const remote = lookup({ x: "h1", y: "h2", z: "h3" });
    assert.deepEqual([...uploadCandidates(target, remote)], []);
  });
});

describe("remote snapshot listing (real bucket)", { skip }, () => {
  it("returns no snapshots for a set that has none yet", async () => {
    // A unique set name no backup has ever written to, so the listing is
    // empty without seeding or cleanup.
    const set = `empty-${Date.now()}`;
    assert.deepEqual(
      await listRemoteSnapshots(/** @type {string} */ (TEST_BUCKET), set),
      [],
    );
    // A set with no remote snapshot yet diffs against an empty lookup, so every
    // target hash is a candidate (its first backup uploads everything).
    assert.deepEqual(
      await readLatestRemoteSnapshot(/** @type {string} */ (TEST_BUCKET), set),
      { name: undefined, lookup: new Map() },
    );
  });
});

describe("downloadRemoteSnapshots (real bucket)", { skip }, () => {
  it("returns 0 for a set with no remote snapshots", async () => {
    await using dir = await mkTmpDir();
    const set = `empty-dl-${Date.now()}`;
    const pulled = await downloadRemoteSnapshots(
      /** @type {string} */ (TEST_BUCKET),
      set,
      join(dir.path, "snapshots"),
    );
    assert.equal(pulled, 0);
  });

  it("pulls each manifest down byte-identically (the adoption sync, ADR-0027)", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const set = `dl-${Date.now()}`;
    const name = "2025-02-20T0900";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `gamma ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries: original } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...original.values()].map((p) => p.hash))];

    const destDir = join(dir.path, "pulled");
    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });

      const pulled = await downloadRemoteSnapshots(bucket, set, destDir);
      assert.equal(pulled, 1);

      // Verbatim copy: byte-identical to the local snapshot that was uploaded.
      assert.deepEqual(
        readFileSync(join(destDir, `${name}.tsv.zst`)),
        readFileSync(join(snapshotDir, `${name}.tsv.zst`)),
      );
      // And it parses back to the same entries, so a local compare/list can use it.
      const { entries: roundTripped } = await readSnapshot(destDir, name);
      assert.deepEqual(roundTripped, original);
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      );
    }
  });
});

describe("referencedObjects (real bucket)", { skip }, () => {
  it("unions a set's snapshot hashes and flags an unreadable snapshot", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const set = `ref-${Date.now()}`;
    const name = "2025-03-10T0800";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `refobj ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries } = await readSnapshot(snapshotDir, name);
    const [props] = [...entries.values()];
    assert.ok(props, "the seeded snapshot has one entry");
    const { hash, size } = props;
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    // A second, garbage snapshot object under a valid-looking name: it lists but
    // fails to decompress, so it must be recorded unreadable (not abort the run).
    const badName = "2025-03-10T0900";
    const badKey = `${remoteSnapshotsPrefix(set)}${badName}.tsv.zst`;

    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });
      await putData(`s3://${bucket}/${badKey}`, "not a zstd stream");

      // Bucket-wide, grouped by set: pick out the set this test wrote (the shared
      // test bucket may hold other sets from concurrent runs).
      const bySet = await referencedObjects(bucket);
      const result = bySet.get(set);
      assert.ok(result, "the test's set is present in the enumeration");
      const { referenced, snapshotsChecked, unreadable } = result;

      assert.equal(snapshotsChecked, 1);
      assert.deepEqual(
        unreadable.map((u) => u.snapshot),
        [badName],
      );
      const entry = referenced.get(hash);
      assert.ok(entry, "the referenced hash is present");
      const [first] = [...entry.paths]; // one path backs this content
      assert.ok(first, "the content has a referencing path");
      const [path, pathRef] = first;
      assert.ok(path.endsWith("a.txt"));
      assert.deepEqual([...pathRef.sizes], [size]);
      assert.deepEqual([...pathRef.snapshots], [name]);
    } finally {
      for (const h of hashes) {
        await deleteObject(`s3://${bucket}/objects/${h}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      );
      await deleteObject(`s3://${bucket}/${badKey}`);
    }
  });
});

describe("uploadSnapshot (real bucket)", { skip }, () => {
  it("first backup LISTs the store; a --since backup diffs against the local previous snapshot", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
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

describe("deleteRemoteSnapshot (real bucket)", { skip }, () => {
  it("removes just the snapshot, leaving its objects in place", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const set = `del-${Date.now()}`;
    const name = "2025-04-01T1200";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `delete-me ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });
      assert.deepEqual(await listRemoteSnapshots(bucket, set), [name]);

      await deleteRemoteSnapshot(bucket, set, name);

      // The snapshot is gone…
      assert.deepEqual(await listRemoteSnapshots(bucket, set), []);
      // …but the objects it referenced remain (delete never touches objects/).
      for (const hash of hashes) {
        const keys = [];
        for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
          if (o.Key) {
            keys.push(o.Key);
          }
        }
        assert.ok(
          keys.includes(`objects/${hash}`),
          `object ${hash} was removed`,
        );
      }
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      // Best-effort: the snapshot should already be gone from the test body.
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      ).catch(() => {});
    }
  });
});
