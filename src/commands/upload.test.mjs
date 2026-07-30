import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { beforeEach, describe, it, mock } from "node:test";

/** @import { Drift, FileChange } from "../lib/upload.mjs" */

// Offline tests for `upload`'s command surface (ADR-0044): the fail-fast flag
// validation, and that each mode routes to the right plumbing with the right
// arguments (set-scoped vs raw --bucket for a single file; the snapshot uploader
// for --snapshot; the folder seeder for --dir). The lib seams — set resolution,
// hashing, the object PUT, and the snapshot/dir uploaders — are faked so the test
// exercises `upload`'s own dispatch and validation, not S3. `--dir`'s existence
// check is real fs, so its tests point at a genuine directory (`tmpdir()`). Mocks
// first, then a dynamic import (objects.test.mjs ordering rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string, excludePath: string }} */
const fakeSet = {
  name: "photos",
  bucket: "set-bucket",
  snapshotsDir: "/snaps",
  excludePath: "/snaps/exclude.txt",
};
/** @type {(string | undefined)[]} */
let loadSetCalls = [];
/** @type {string[]} */
let propCalls = [];
/** @type {[string, string, string, { force?: boolean }][]} */
let putObjectCalls = [];
/** @type {Record<string, unknown>[]} */
let uploadSnapshotCalls = [];
/** @type {Record<string, unknown>[]} */
let uploadDirCalls = [];
/** @type {Drift[]} what the faked seeder reports skipping */
let dirSkipped = [];
/** @type {[string, object][]} */
let fileChangeCalls = [];
/** @type {FileChange | undefined} what the faked guard reports */
let fileChangeResult;
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
    uploadDir: async (/** @type {Record<string, unknown>} */ args) => {
      uploadDirCalls.push(args);
      return { candidates: 40, uploaded: 12, skipped: dirSkipped };
    },
    fileChange: async (
      /** @type {string} */ path,
      /** @type {object} */ recorded,
    ) => {
      fileChangeCalls.push([path, recorded]);
      return fileChangeResult;
    },
  },
});

const { upload } = await import("./upload.mjs");

beforeEach(() => {
  loadSetCalls = [];
  propCalls = [];
  putObjectCalls = [];
  uploadSnapshotCalls = [];
  uploadDirCalls = [];
  dirSkipped = [];
  fileChangeCalls = [];
  fileChangeResult = undefined;
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

  it("rejects two modes together (mutually exclusive: --file and --snapshot)", async () => {
    await assert.rejects(
      upload("photos", { file: "f", snapshot: "2026-01-01T0900" }),
      /Pass one of --file, --snapshot, or --dir/,
    );
    // The conflict is caught before either mode runs.
    assert.deepEqual(putObjectCalls, []);
    assert.deepEqual(uploadSnapshotCalls, []);
  });

  it("rejects two modes together (--file and --dir)", async () => {
    await assert.rejects(
      upload("photos", { file: "f", dir: tmpdir() }),
      /Pass one of --file, --snapshot, or --dir/,
    );
    assert.deepEqual(putObjectCalls, []);
    assert.deepEqual(uploadDirCalls, []);
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

  it("rejects no mode at all", async () => {
    await assert.rejects(
      upload("photos", {}),
      /Specify what to upload: --file <path>, --snapshot <name>, or --dir <path>/,
    );
    // A usage error thrown before any work — no set resolution, no PUT.
    assert.deepEqual(putObjectCalls, []);
    assert.deepEqual(uploadSnapshotCalls, []);
  });

  it("rejects --dir at a path that isn't a folder (before any seeding)", async () => {
    await assert.rejects(
      upload("photos", { dir: "/no/such/folder/xyz" }),
      /--dir needs a folder that exists: \/no\/such\/folder\/xyz/,
    );
    assert.deepEqual(uploadDirCalls, []);
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

// The confirmation guard on the single-file path. It has the same hash-then-PUT
// window the bulk paths do — the store trusts the hash on write, so a file edited
// in between would be stored under its previous content's hash and corrupt that
// object for every path that dedups to it. One file rather than thousands does not
// change that, so the invariant is shared even though the PUT loop is not.
describe("upload --file confirmation guard", () => {
  it("re-confirms the file against the props prop() returned, before the PUT", async () => {
    await upload("photos", { file: "/f/photo.raw" });

    assert.deepEqual(fileChangeCalls, [
      ["/f/photo.raw", { hash: "abc123", size: 42 }],
    ]);
    assert.equal(putObjectCalls.length, 1, "confirmed, so it was stored");
  });

  it("refuses to store a file that changed while it was being read", async () => {
    fileChangeResult = { reason: "changed" };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /changed while s3cab was reading it/,
    );
    assert.deepEqual(
      putObjectCalls,
      [],
      "the stale fingerprint was never used",
    );
  });

  it("names the retry with the set it was given", async () => {
    fileChangeResult = { reason: "removed" };

    await assert.rejects(() => upload("photos", { file: "/f/photo.raw" }), {
      message: /s3cab upload photos --file \/f\/photo\.raw/,
    });
  });

  it("names the retry with --bucket when that was how it was addressed", async () => {
    // The shared backup message can't serve here: there may be no set to name.
    fileChangeResult = { reason: "changed" };

    await assert.rejects(
      () => upload(undefined, { file: "/f/photo.raw", bucket: "raw-bucket" }),
      /s3cab upload --bucket raw-bucket --file/,
    );
  });

  it("keeps the errno in a parenthetical when the file went unreadable", async () => {
    fileChangeResult = { reason: "unreadable", cause: { code: "EACCES" } };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /could no longer be read \(EACCES\)/,
    );
  });

  it("guards --force too — it overwrites deliberately, it does not skip confirming", async () => {
    // --force is about clobbering an existing object (the repair hatch), not about
    // storing bytes under a fingerprint that no longer matches them.
    fileChangeResult = { reason: "changed" };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw", force: true }),
      /changed while s3cab was reading it/,
    );
    assert.deepEqual(putObjectCalls, []);
  });
});

describe("upload --dir (seed a folder's objects)", () => {
  it("hands the seeder the set's bucket, the folder, and the set's exclude path", async () => {
    const result = await upload("photos", { dir: tmpdir() });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(putObjectCalls, []); // dir mode never single-PUTs
    assert.equal(uploadDirCalls.length, 1);
    assert.deepEqual(uploadDirCalls[0], {
      bucket: "set-bucket",
      dir: tmpdir(),
      excludePath: "/snaps/exclude.txt",
    });
    assert.deepEqual(result, {
      mode: "dir",
      set: "photos",
      dir: tmpdir(),
      candidates: 40,
      uploaded: 12,
      skipped: [],
    });
  });

  it("passes the seeder's skipped files through to the result", async () => {
    // A skipped file is part of what the run did, so it belongs in the result the
    // render layer reports (and in --json) — not only on stderr.
    dirSkipped = [{ path: "/photos/live.raw", reason: "changed" }];

    const result = await upload("photos", { dir: tmpdir() });

    assert.equal(result.mode, "dir");
    assert.deepEqual(
      result.mode === "dir" ? result.skipped : undefined,
      dirSkipped,
    );
  });
});
