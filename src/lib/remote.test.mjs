import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteObject, listObjects } from "./s3.mjs";
import { readSnapshot } from "./snapshot-file.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";
import {
  listRemoteNamespaces,
  listRemoteSnapshots,
  readLatestRemoteSnapshot,
  remoteSnapshotsPrefix,
  uploadCandidates,
  uploadSnapshot,
} from "./remote.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

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

// The gated uploadSnapshot tests below write the per-bucket objects cache; each
// points S3CAB_HOME at a temp dir (useTempHome) to isolate it, mirroring
// sets.test.mjs. HOME is left alone so they can still resolve AWS credentials
// from ~/.aws.
const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

// S3 test strategy (docs/specs/backup.md slice 3, decided 2026-06-13): the
// S3-touching code is exercised against a real test bucket, gated on
// `S3CAB_TEST_BUCKET` (+ ambient AWS credentials) and skipped with a message
// when unset — so local/offline/fork runs stay green and real coverage runs
// only where the bucket is wired. The pure name-sorting these listers reuse is
// covered without a bucket by list.test.mjs (via `snapshotNames`); ordering
// against real seeded snapshots follows in step 4, once the uploader can seed
// them naturally (and tear them down).
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

describe("remoteSnapshotsPrefix", () => {
  it("places a set's snapshots under snapshots/<namespace>/", () => {
    assert.equal(
      remoteSnapshotsPrefix("user@host/photos"),
      "snapshots/user@host/photos/",
    );
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
  it("returns no snapshots for a namespace that has none yet", async () => {
    // A unique namespace no backup has ever written to, so the listing is
    // empty without seeding or cleanup.
    const namespace = `test@s3cab/empty-${Date.now()}`;
    assert.deepEqual(
      await listRemoteSnapshots(/** @type {string} */ (TEST_BUCKET), namespace),
      [],
    );
    // A set with no remote snapshot yet diffs against an empty lookup, so every
    // target hash is a candidate (its first backup uploads everything).
    assert.deepEqual(
      await readLatestRemoteSnapshot(
        /** @type {string} */ (TEST_BUCKET),
        namespace,
      ),
      { name: undefined, lookup: new Map() },
    );
  });
});

describe("uploadSnapshot (real bucket)", { skip }, () => {
  it("uploads objects then the snapshot, and refuses to overwrite an existing one", async () => {
    await using dir = await mkTmpDir();
    // useTempHome isolates the objects cache this writes; AWS credentials must
    // therefore come from the *environment* (CI/OIDC), since it redirects HOME
    // away from any ~/.aws config.
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const namespace = `test@s3cab/upload-${Date.now()}`;
    const name = "2025-01-15T1030";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    const fileB = join(contentDir, "b.txt");
    // Unique content → unique hashes, so the shared objects/ store stays
    // isolated from other runs and teardown deletes exactly what we made.
    writeFileSync(fileA, `alpha ${namespace}`);
    writeFileSync(fileB, `beta ${namespace}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA, fileB]);

    const { entries: target } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...target.values()].map((p) => p.hash))];

    try {
      const result = await uploadSnapshot({
        bucket,
        namespace,
        snapshotDir,
        name,
      });
      assert.equal(result.candidates, hashes.length);
      assert.equal(result.uploaded, hashes.length);

      // The snapshot is present (uploaded last) and its objects exist.
      assert.deepEqual(await listRemoteSnapshots(bucket, namespace), [name]);
      for (const hash of hashes) {
        const keys = [];
        for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
          if (o.Key) keys.push(o.Key);
        }
        assert.ok(keys.includes(`objects/${hash}`), `object ${hash} missing`);
      }

      // Re-backing-up the same name uploads nothing (all objects now in the
      // latest remote snapshot) and errors on the immutable snapshot.
      await assert.rejects(
        () => uploadSnapshot({ bucket, namespace, snapshotDir, name }),
        /already backed up/,
      );
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`,
      );
    }
  });
});

describe("listRemoteNamespaces (real bucket)", { skip }, () => {
  it("surfaces the user@machine/set prefix of a seeded snapshot", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const namespace = `test@s3cab/ns-${Date.now()}`;
    const name = "2025-02-20T0900";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const file = join(contentDir, "a.txt");
    writeFileSync(file, `ns-disco ${namespace}`);
    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [file]);
    const { entries } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      await uploadSnapshot({ bucket, namespace, snapshotDir, name });
      const found = await listRemoteNamespaces(bucket);
      assert.ok(
        found.includes(namespace),
        `expected ${namespace} among ${found.join(", ")}`,
      );
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`,
      );
    }
  });
});
