import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// Offline tests for `upload`'s command surface (ADR-0044): the fail-fast flag
// validation, and that each mode routes to the right plumbing with the right
// arguments (set-scoped vs raw --bucket for a single file; the snapshot uploader
// for --snapshot). The lib seams — set resolution, hashing, the object PUT, and
// the snapshot uploader — are faked so the test exercises `upload`'s own dispatch
// and validation, not S3. Mocks first, then a dynamic import (objects.test.mjs
// ordering rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string }} */
const fakeSet = {
  name: "photos",
  bucket: "set-bucket",
  snapshotsDir: "/snaps",
};
/** @type {(string | undefined)[]} */
let loadSetCalls = [];
/** @type {string[]} */
let propCalls = [];
/** @type {[string, string, string, { force?: boolean }][]} */
let putObjectCalls = [];
/** @type {Record<string, unknown>[]} */
let uploadSnapshotCalls = [];
let putResult = true;

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string | undefined} */ set) => {
      loadSetCalls.push(set);
      return fakeSet;
    },
  },
});
mock.module("./prop.mjs", {
  exports: {
    prop: async (/** @type {string} */ path) => {
      propCalls.push(path);
      return { hash: "abc123", size: 42 };
    },
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    objectKey: (/** @type {string} */ hash) => `objects/${hash}`,
    putObject: async (
      /** @type {string} */ bucket,
      /** @type {string} */ hash,
      /** @type {string} */ path,
      /** @type {object} */ options,
    ) => {
      putObjectCalls.push([bucket, hash, path, options]);
      return putResult;
    },
  },
});
mock.module("../lib/upload.mjs", {
  exports: {
    uploadSnapshot: async (/** @type {Record<string, unknown>} */ args) => {
      uploadSnapshotCalls.push(args);
      return { name: args.name, candidates: 5, uploaded: 2 };
    },
  },
});

const { upload } = await import("./upload.mjs");

beforeEach(() => {
  loadSetCalls = [];
  propCalls = [];
  putObjectCalls = [];
  uploadSnapshotCalls = [];
  putResult = true;
});

describe("upload validation", () => {
  it("rejects a set and --bucket together", async () => {
    await assert.rejects(
      upload("photos", { file: "f", bucket: "b" }),
      /either a set or --bucket, not both/,
    );
  });

  it("requires an explicit set when there is no --bucket (no sole-set default)", async () => {
    await assert.rejects(
      upload(undefined, { file: "f" }),
      /Missing required argument: set/,
    );
    assert.deepEqual(loadSetCalls, []); // never even resolves a set
  });

  it("rejects --file and --snapshot together (mutually exclusive modes)", async () => {
    await assert.rejects(
      upload("photos", { file: "f", snapshot: "2026-01-01T0900" }),
      /Pass either --file or --snapshot, not both/,
    );
    // The conflict is caught before either mode runs.
    assert.deepEqual(putObjectCalls, []);
    assert.deepEqual(uploadSnapshotCalls, []);
  });

  it("rejects --bucket without --file", async () => {
    await assert.rejects(
      upload(undefined, { bucket: "b", snapshot: "2026-01-01T0900" }),
      /--bucket uploads a single file/,
    );
  });

  it("rejects --force outside single-file mode", async () => {
    await assert.rejects(
      upload("photos", { snapshot: "2026-01-01T0900", force: true }),
      /--force applies only to --file uploads/,
    );
  });

  it("rejects --since outside snapshot mode", async () => {
    await assert.rejects(
      upload("photos", { file: "f", since: "2026-01-01T0900" }),
      /--since applies only to --snapshot uploads/,
    );
  });

  it("rejects neither --file nor --snapshot", async () => {
    await assert.rejects(
      upload("photos", {}),
      /Specify what to upload: --file <path> or --snapshot <name>/,
    );
    // A usage error thrown before any work — no set resolution, no PUT.
    assert.deepEqual(putObjectCalls, []);
    assert.deepEqual(uploadSnapshotCalls, []);
  });
});

describe("upload --file (single object)", () => {
  it("set-scoped: hashes, PUTs into the set's bucket, forwards --force", async () => {
    const result = await upload("photos", {
      file: "/tmp/big.iso",
      force: true,
    });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(propCalls, ["/tmp/big.iso"]);
    assert.deepEqual(putObjectCalls, [
      ["set-bucket", "abc123", "/tmp/big.iso", { force: true }],
    ]);
    assert.deepEqual(result, {
      mode: "file",
      hash: "abc123",
      size: 42,
      key: "objects/abc123",
      uploaded: true,
    });
  });

  it("raw --bucket: PUTs into the bucket with no set resolution", async () => {
    putResult = false;
    const result = await upload(undefined, {
      bucket: "raw-bucket",
      file: "/tmp/big.iso",
    });

    assert.deepEqual(loadSetCalls, []); // no set → ambient credentials
    assert.equal(putObjectCalls[0]?.[0], "raw-bucket");
    assert.equal(putObjectCalls[0]?.[3].force, undefined);
    assert.equal(result.mode, "file");
    assert.equal(result.uploaded, false);
  });
});

describe("upload --snapshot (a snapshot's objects)", () => {
  it("hands the snapshot uploader the set's bucket/dir, name, and --since baseline", async () => {
    const result = await upload("photos", {
      snapshot: "2026-01-02T0900",
      since: "2026-01-01T0900",
    });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(putObjectCalls, []); // snapshot mode never single-PUTs
    assert.equal(uploadSnapshotCalls.length, 1);
    assert.deepEqual(uploadSnapshotCalls[0], {
      bucket: "set-bucket",
      set: "photos",
      snapshotDir: "/snaps",
      name: "2026-01-02T0900",
      since: "2026-01-01T0900",
    });
    assert.deepEqual(result, {
      mode: "snapshot",
      set: "photos",
      snapshot: "2026-01-02T0900",
      candidates: 5,
      uploaded: 2,
    });
  });

  it("omits --since when none is given (uploader then LISTs)", async () => {
    await upload("photos", { snapshot: "2026-01-02T0900" });

    assert.equal(uploadSnapshotCalls[0]?.since, undefined);
  });
});
