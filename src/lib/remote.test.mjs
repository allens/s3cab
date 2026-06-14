import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteObject, listObjects, putFile } from "./s3.mjs";
import { readSnapshot, writeSnapshot } from "./snapshot-file.mjs";
import {
  appendObjectsCache,
  downloadObject,
  latestRemoteSnapshot,
  listRemoteNamespaces,
  listRemoteSnapshots,
  objectsCachePath,
  readObjectsCache,
  remoteSnapshotsPrefix,
  uploadCandidates,
  uploadSnapshot,
} from "./remote.mjs";

/**
 * Build a snapshot lookup from a path→hash map — only the hash matters to
 * `uploadCandidates`, so size/mtime are filler.
 * @param {Record<string, string>} pathToHash
 * @returns {import("./snapshot-file.mjs").SnapshotLookup}
 */
const lookup = (pathToHash) =>
  new Map(
    Object.entries(pathToHash).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

// The objects cache derives its path from homedir() at call time and keeps no
// module state, so each test just points homedir() at a temp dir (USERPROFILE
// on Windows, HOME on POSIX — set both), mirroring sets.test.mjs.
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

/**
 * Point homedir() at a temp home under the disposable root.
 * @param {string} root
 */
function useTempHome(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

// S3 test strategy (specs/backup.md slice 3, decided 2026-06-13): the
// S3-touching code is exercised against a real test bucket, gated on
// `S3CAB_TEST_BUCKET` (+ ambient AWS credentials) and skipped with a message
// when unset — so local/offline/fork runs stay green and real coverage runs
// only where the bucket is wired. The pure name-sorting these listers reuse is
// covered without a bucket by list.test.mjs (via `snapshotNames`); ordering
// against real seeded manifests follows in step 4, once the uploader can seed
// them naturally (and tear them down).
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

describe("remoteSnapshotsPrefix", () => {
  it("places a set's manifests under snapshots/<namespace>/", () => {
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

describe("objects cache", () => {
  it("is an empty set when the cache file does not exist", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    assert.deepEqual(readObjectsCache("my-bucket"), new Set());
  });

  it("round-trips appended hashes", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    appendObjectsCache("my-bucket", ["h1", "h2"]);
    assert.deepEqual(readObjectsCache("my-bucket"), new Set(["h1", "h2"]));
  });

  it("appends additively across calls", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    appendObjectsCache("my-bucket", ["h1"]);
    appendObjectsCache("my-bucket", ["h2", "h3"]);
    assert.deepEqual(
      readObjectsCache("my-bucket"),
      new Set(["h1", "h2", "h3"]),
    );
  });

  it("keeps each bucket's cache separate", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    appendObjectsCache("bucket-a", ["h1"]);
    appendObjectsCache("bucket-b", ["h2"]);
    assert.deepEqual(readObjectsCache("bucket-a"), new Set(["h1"]));
    assert.deepEqual(readObjectsCache("bucket-b"), new Set(["h2"]));
  });

  it("trims whitespace and blank lines and deduplicates on read", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    mkdirSync(join(home, ".s3cab"), { recursive: true });
    writeFileSync(objectsCachePath("my-bucket"), "h1\n\n  h2  \nh1\n");
    assert.deepEqual(readObjectsCache("my-bucket"), new Set(["h1", "h2"]));
  });

  it("appending nothing leaves no cache file", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    appendObjectsCache("my-bucket", []);
    assert.deepEqual(readObjectsCache("my-bucket"), new Set());
  });

  it("places the cache beside the per-bucket env file", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    assert.equal(
      objectsCachePath("my-bucket"),
      join(home, ".s3cab", "objects.my-bucket"),
    );
  });

  it("rejects a bucket name containing a path separator", () => {
    assert.throws(() => objectsCachePath("a/b"), /path separator/);
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
    assert.equal(
      await latestRemoteSnapshot(
        /** @type {string} */ (TEST_BUCKET),
        namespace,
      ),
      undefined,
    );
  });
});

describe("uploadSnapshot (real bucket)", { skip }, () => {
  it("uploads objects then the manifest, and refuses to overwrite an existing one", async () => {
    await using dir = await mkTmpDir();
    // useTempHome isolates the objects cache this writes; AWS credentials must
    // therefore come from the *environment* (CI/OIDC), since it redirects HOME
    // away from any ~/.aws config.
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const namespace = `test@s3cab/upload-${Date.now()}`;
    const name = "2025-01-15T1030";

    const contentDir = join(dir.path, "content");
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

    const target = await readSnapshot(snapshotDir, name);
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

      // The manifest is present (uploaded last) and its objects exist.
      assert.deepEqual(await listRemoteSnapshots(bucket, namespace), [name]);
      for (const hash of hashes) {
        const keys = [];
        for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
          if (o.Key) keys.push(o.Key);
        }
        assert.ok(keys.includes(`objects/${hash}`), `object ${hash} missing`);
      }

      // Re-backing-up the same name uploads nothing (all objects now in the
      // latest remote manifest) and errors on the immutable manifest.
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
  it("surfaces the user@machine/set prefix of a seeded manifest", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const namespace = `test@s3cab/ns-${Date.now()}`;
    const name = "2025-02-20T0900";

    const contentDir = join(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const file = join(contentDir, "a.txt");
    writeFileSync(file, `ns-disco ${namespace}`);
    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [file]);
    const hashes = [
      ...new Set(
        [...(await readSnapshot(snapshotDir, name)).values()].map(
          (p) => p.hash,
        ),
      ),
    ];

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

describe("downloadObject (real bucket)", { skip }, () => {
  it("downloads and verifies an object, and rejects a corrupt one", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);

    // Seed an object at its true content-address, plus a "corrupt" one whose
    // bytes don't match the key it's stored under (the silent-data-loss case).
    const content = `gamma ${Date.now()}`;
    const hash = createHash("sha256").update(content).digest("hex");
    const wrongHash = createHash("sha256")
      .update("not the content")
      .digest("hex");
    const srcGood = join(dir.path, "good.txt");
    const srcBad = join(dir.path, "bad.txt");
    writeFileSync(srcGood, content);
    writeFileSync(srcBad, content); // stored under wrongHash → mismatch on read

    const restoreDir = join(dir.path, "restore");
    mkdirSync(restoreDir, { recursive: true });
    const goodDest = join(restoreDir, "good.txt");
    const badDest = join(restoreDir, "bad.txt");

    try {
      await putFile(srcGood, `s3://${bucket}/objects/${hash}`);
      await putFile(srcBad, `s3://${bucket}/objects/${wrongHash}`);

      await downloadObject(bucket, hash, goodDest);
      assert.equal(readFileSync(goodDest, "utf8"), content);

      // A hash mismatch must reject and leave nothing (no temp, no dest).
      await assert.rejects(
        () => downloadObject(bucket, wrongHash, badDest),
        /Integrity check failed/,
      );
      assert.ok(!existsSync(badDest), "corrupt download must not be placed");
      assert.ok(
        !existsSync(join(restoreDir, ".bad.txt.s3cab-tmp")),
        "temp file must be cleaned up",
      );
    } finally {
      await deleteObject(`s3://${bucket}/objects/${hash}`);
      await deleteObject(`s3://${bucket}/objects/${wrongHash}`);
    }
  });
});
