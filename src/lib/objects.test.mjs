import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// This whole file mocks the s3.mjs seam, per docs/design/testing.md ("mock at s3.mjs,
// not the AWS SDK"): the object store's pure file/cache logic and — crucially —
// `getObject`'s integrity check run here with zero AWS, on every push. The
// real-bucket happy path is covered separately by restore.test.mjs's gated
// round-trip (restore fetches every object through `getObject`).
//
// Module mocking has a load-bearing ordering rule (verified): a static `import`
// of objects.mjs would bind the *real* s3.mjs before the mock is set, and a
// later dynamic import returns that cached binding. So the mock is registered
// first and objects.mjs is imported dynamically below — there is deliberately no
// static import of it. The runner needs `--experimental-test-module-mocks` (set
// on the `test`/`test:coverage*` scripts).

// `getObject` streams `createS3ReadStream(uri)` and verifies its bytes; the fake
// yields whatever the current test stages here. listObjects/putFile are stubbed
// only because objects.mjs imports them (a mock module exports exactly these) —
// no test in this file calls them.
let streamedBytes = Buffer.alloc(0);
/** @type {import("@aws-sdk/client-s3")._Object[]} */
let listedObjects = [];
mock.module("./s3.mjs", {
  exports: {
    createS3ReadStream: () => Readable.from(streamedBytes),
    listObjects: async function* () {
      for (const object of listedObjects) {
        yield object;
      }
    },
    putFile: async () => true,
  },
});
const {
  getObject,
  knownObjects,
  listObjectHashes,
  listStoredObjects,
  objectsCachePath,
  recordObjects,
  writeObjectsCache,
} = await import("./objects.mjs");

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

describe("objects cache", () => {
  // The cache derives its path from s3cabDir() at call time and keeps no module
  // state, so each test just points S3CAB_HOME at a temp dir (useTempHome),
  // mirroring sets.test.mjs.
  it("is an empty set when the cache file does not exist", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    assert.deepEqual(knownObjects("my-bucket"), new Set());
  });

  it("round-trips recorded hashes", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    recordObjects("my-bucket", ["h1", "h2"]);
    assert.deepEqual(knownObjects("my-bucket"), new Set(["h1", "h2"]));
  });

  it("records additively across calls", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    recordObjects("my-bucket", ["h1"]);
    recordObjects("my-bucket", ["h2", "h3"]);
    assert.deepEqual(knownObjects("my-bucket"), new Set(["h1", "h2", "h3"]));
  });

  it("keeps each bucket's cache separate", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    recordObjects("bucket-a", ["h1"]);
    recordObjects("bucket-b", ["h2"]);
    assert.deepEqual(knownObjects("bucket-a"), new Set(["h1"]));
    assert.deepEqual(knownObjects("bucket-b"), new Set(["h2"]));
  });

  it("trims whitespace and blank lines and deduplicates on read", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    mkdirSync(join(home, ".s3cab"), { recursive: true });
    writeFileSync(objectsCachePath("my-bucket"), "h1\n\n  h2  \nh1\n");
    assert.deepEqual(knownObjects("my-bucket"), new Set(["h1", "h2"]));
  });

  it("recording nothing leaves no cache file", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    recordObjects("my-bucket", []);
    assert.deepEqual(knownObjects("my-bucket"), new Set());
  });

  it("writeObjectsCache replaces the cache, shrinking it", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // A rewrite (verify's heal path) must drop entries an append never would —
    // the cached-but-absent poison the cache rewrite exists to cure.
    recordObjects("my-bucket", ["h1", "h2", "stale"]);
    await writeObjectsCache("my-bucket", ["h1", "h2"]);
    assert.deepEqual(knownObjects("my-bucket"), new Set(["h1", "h2"]));
  });

  it("writeObjectsCache leaves no temp file behind", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await writeObjectsCache("my-bucket", ["h1"]);
    assert.ok(!existsSync(objectsCachePath("my-bucket") + ".s3cab-tmp"));
  });

  it("writeObjectsCache cleans up the temp file when the write fails", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    // Make the rename fail: a directory sits where the cache file should go, so
    // the temp write succeeds but rename-over-a-directory throws.
    const cachePath = objectsCachePath("my-bucket");
    mkdirSync(join(home, ".s3cab"), { recursive: true });
    mkdirSync(cachePath, { recursive: true });

    await assert.rejects(() => writeObjectsCache("my-bucket", ["h1"]));
    assert.ok(
      !existsSync(cachePath + ".s3cab-tmp"),
      "the temp file must be cleaned up on failure",
    );
  });

  it("places the cache at ~/.s3cab/objects.<bucket>", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    assert.equal(
      objectsCachePath("my-bucket"),
      join(home, ".s3cab", "objects.my-bucket"),
    );
  });

  it("rejects a bucket name that is not a single path segment", () => {
    assert.throws(() => objectsCachePath("a/b"), /not a single path segment/);
  });
});

describe("listObjectHashes", () => {
  it("strips the objects/ prefix and skips a zero-byte folder marker", async () => {
    // `objects/` is the console-created folder-marker key; it must not surface
    // as an empty hash (a blank line / blank cache entry).
    listedObjects = [
      { Key: "objects/" },
      { Key: "objects/aaa" },
      { Key: "objects/bbb" },
    ];
    const out = [];
    for await (const hash of listObjectHashes("my-bucket")) {
      out.push(hash);
    }
    assert.deepEqual(out, ["aaa", "bbb"]);
  });
});

describe("listStoredObjects", () => {
  it("yields each object's hash and LIST size, skipping the folder marker", async () => {
    listedObjects = [
      { Key: "objects/", Size: 0 },
      { Key: "objects/aaa", Size: 10 },
      { Key: "objects/bbb", Size: 2048 },
    ];
    const out = [];
    for await (const object of listStoredObjects("my-bucket")) {
      out.push(object);
    }
    assert.deepEqual(out, [
      { hash: "aaa", size: 10 },
      { hash: "bbb", size: 2048 },
    ]);
  });

  it("defaults a missing Size to 0", async () => {
    listedObjects = [{ Key: "objects/aaa" }];
    const out = [];
    for await (const object of listStoredObjects("my-bucket")) {
      out.push(object);
    }
    assert.deepEqual(out, [{ hash: "aaa", size: 0 }]);
  });
});

describe("getObject integrity", () => {
  const content = "the real object bytes";
  const hash = createHash("sha256").update(content).digest("hex");

  it("writes the object when its content matches the hash", async () => {
    await using dir = await mkTmpDir();
    streamedBytes = Buffer.from(content);
    const dest = join(dir.path, "out.bin");

    await getObject("my-bucket", hash, dest);

    assert.equal(readFileSync(dest, "utf8"), content);
    // No temp sibling left behind.
    assert.ok(!existsSync(join(dir.path, ".out.bin.s3cab-tmp")));
  });

  it("rejects a content/hash mismatch and leaves nothing behind", async () => {
    await using dir = await mkTmpDir();
    // The stored bytes don't hash to the requested key — the silent-data-loss
    // case design #1 exists to catch.
    streamedBytes = Buffer.from("tampered bytes, not the real content");
    const dest = join(dir.path, "out.bin");

    await assert.rejects(
      () => getObject("my-bucket", hash, dest),
      /Integrity check failed/,
    );
    assert.ok(!existsSync(dest), "a mismatched object must not be placed");
    assert.ok(
      !existsSync(join(dir.path, ".out.bin.s3cab-tmp")),
      "the temp file must be cleaned up",
    );
  });
});
