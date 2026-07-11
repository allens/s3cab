import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// This whole file mocks the s3.mjs seam, per docs/design/testing.md ("mock at s3.mjs,
// not the AWS SDK"): the object store's listing logic and `getObject`'s
// key-as-digest pairing run here with zero AWS, on every push. The download
// atomicity/integrity mechanics live below the seam, in s3.mjs's
// `downloadToFile` — tested mock-free in s3.test.mjs against an in-memory
// stream. The real-bucket happy path is covered separately by
// restore.integration.test.mjs's gated round-trip (restore fetches every
// object through `getObject`).
//
// Module mocking has a load-bearing ordering rule (verified): a static `import`
// of objects.mjs would bind the *real* s3.mjs before the mock is set, and a
// later dynamic import returns that cached binding. So the mock is registered
// first and objects.mjs is imported dynamically below — there is deliberately no
// static import of it. The runner needs `--experimental-test-module-mocks` (set
// on the `test`/`test:coverage*` scripts).

// The fakes record what getObject asks of the seam: the URI opened and the
// downloadToFile destination/options. putFile is stubbed only because
// objects.mjs imports it (a mock module exports exactly these) — no test in
// this file calls it.
/** @type {string | undefined} */
let requestedUri;
/** @type {{ destPath: string, options: object | undefined } | undefined} */
let download;
/** @type {import("@aws-sdk/client-s3")._Object[]} */
let listedObjects = [];
mock.module("./s3.mjs", {
  exports: {
    getStream: async (/** @type {string} */ uri) => {
      requestedUri = uri;
      return Readable.from("");
    },
    downloadToFile: async (
      /** @type {Readable} */ _source,
      /** @type {string} */ destPath,
      /** @type {object} */ options,
    ) => {
      download = { destPath, options };
    },
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

describe("getObject", () => {
  it("opens objects/<hash> and passes the key as the expected digest", async () => {
    // The layout policy in one pairing: the key *is* the content hash, so the
    // same value must reach downloadToFile as the expected digest — that is
    // what turns its generic integrity check into design #1's guarantee.
    await getObject("my-bucket", "abc123", "/restore/out.bin");

    assert.equal(requestedUri, "s3://my-bucket/objects/abc123");
    assert.deepEqual(download, {
      destPath: "/restore/out.bin",
      options: { sha256: "abc123" },
    });
  });
});
