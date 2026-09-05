import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

/** @import { _Object } from "@aws-sdk/client-s3" */

// This file mocks the s3.mjs and atomic-file.mjs seams, per docs/design/testing.md
// ("mock at s3.mjs, not the AWS SDK"): the object store's listing logic and
// `getObject`'s key-as-digest pairing run here with zero AWS, on every push. The
// download atomicity/integrity mechanics live below the seam, in atomic-file.mjs's
// `writeFileAtomic` — tested mock-free in atomic-file.test.mjs against an
// in-memory stream. The real-bucket happy path is covered separately by
// test/integration/backup-restore-roundtrip.test.mjs's gated round-trip (restore fetches every
// object through `getObject`).
//
// Module mocking has a load-bearing ordering rule (verified): a static `import`
// of objects.mjs would bind the *real* s3.mjs before the mock is set, and a
// later dynamic import returns that cached binding. So the mock is registered
// first and objects.mjs is imported dynamically below — there is deliberately no
// static import of it. The runner needs `--experimental-test-module-mocks` (set
// on the `test`/`test:coverage*` scripts).

// The fakes record what getObject asks of the seams: the URI opened and the
// writeFileAtomic destination/options.
/** @type {string | undefined} */
let requestedUri;
/** @type {{ destPath: string, options: object | undefined } | undefined} */
let download;
/** @type {_Object[]} */
let listedObjects = [];
/** @type {number | undefined} */
let headSize;
mock.module("./atomic-file.mjs", {
  exports: {
    writeFileAtomic: async (
      /** @type {string} */ destPath,
      /** @type {Readable} */ _source,
      /** @type {object} */ options,
    ) => {
      download = { destPath, options };
    },
  },
});
// The three reads objects.mjs makes on behalf of the functions under test. The
// PUT is deliberately left unmodelled: `putObject` is exercised through
// upload.mjs and against a real bucket, and a `putFile` stubbed to succeed here
// would be a claim about ADR-0083's guard that this file cannot make good on.
mock.module("./s3.mjs", {
  exports: s3Seam({
    getStream: async (/** @type {string} */ uri) => {
      requestedUri = uri;
      return Readable.from("");
    },
    listObjects: async function* () {
      for (const object of listedObjects) {
        yield object;
      }
    },
    objectSize: async (/** @type {string} */ uri) => {
      requestedUri = uri;
      return headSize;
    },
  }),
});
const { getObject, listObjectHashes, listStoredObjects, storedObjectSize } =
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
    // same value must reach writeFileAtomic as the expected digest — that is
    // what turns its generic integrity check into design #1's guarantee.
    await getObject("my-bucket", "abc123", "/restore/out.bin");

    assert.equal(requestedUri, "s3://my-bucket/objects/abc123");
    assert.deepEqual(download, {
      destPath: "/restore/out.bin",
      options: { hash: "abc123" },
    });
  });
});

describe("storedObjectSize", () => {
  it("HEADs objects/<hash> and returns the size", async () => {
    headSize = 42;
    assert.equal(await storedObjectSize("my-bucket", "abc123"), 42);
    assert.equal(requestedUri, "s3://my-bucket/objects/abc123");
  });

  it("returns undefined for a hash the bucket doesn't hold", async () => {
    headSize = undefined;
    assert.equal(await storedObjectSize("my-bucket", "abc123"), undefined);
  });
});
