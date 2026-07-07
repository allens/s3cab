import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// This whole file mocks the s3.mjs seam, per docs/design/testing.md ("mock at s3.mjs,
// not the AWS SDK"): the object store's listing logic and — crucially —
// `getObject`'s integrity check run here with zero AWS, on every push. The
// real-bucket happy path is covered separately by restore.integration.test.mjs's gated
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
    // Imported by objects.mjs (deleteStoredObject); no test here calls it.
    deleteObject: async () => {},
  },
});
const { getObject, listObjectHashes, listStoredObjects } =
  await import("./objects.mjs");

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

describe("listObjectHashes", () => {
  it("strips the objects/ prefix and skips a zero-byte folder marker", async () => {
    // `objects/` is the console-created folder-marker key; it must not surface
    // as an empty hash (a blank line / blank cache entry).
    listedObjects = [
      { Key: "objects/" },
      { Key: "objects/aaa" },
      { Key: "objects/bbb" },
    ];
    assert.deepEqual(await Array.fromAsync(listObjectHashes("my-bucket")), [
      "aaa",
      "bbb",
    ]);
  });
});

describe("listStoredObjects", () => {
  it("yields each object's hash and LIST size, skipping the folder marker", async () => {
    listedObjects = [
      { Key: "objects/", Size: 0 },
      { Key: "objects/aaa", Size: 10 },
      { Key: "objects/bbb", Size: 2048 },
    ];
    const out = await Array.fromAsync(
      listStoredObjects("my-bucket"),
      ({ hash, size }) => ({ hash, size }),
    );
    assert.deepEqual(out, [
      { hash: "aaa", size: 10 },
      { hash: "bbb", size: 2048 },
    ]);
  });

  it("defaults a missing Size to 0", async () => {
    listedObjects = [{ Key: "objects/aaa" }];
    const out = await Array.fromAsync(
      listStoredObjects("my-bucket"),
      ({ hash, size }) => ({ hash, size }),
    );
    assert.deepEqual(out, [{ hash: "aaa", size: 0 }]);
  });

  it("passes through LastModified as lastModified (for cleanup's grace window)", async () => {
    const when = new Date("2026-01-02T03:04:05Z");
    listedObjects = [{ Key: "objects/aaa", Size: 5, LastModified: when }];
    assert.deepEqual(await Array.fromAsync(listStoredObjects("my-bucket")), [
      { hash: "aaa", size: 5, lastModified: when },
    ]);
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
