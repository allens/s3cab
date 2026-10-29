import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { beforeEach, describe, it, mock } from "node:test";
import { ChangedWhileReadError, ContentMismatchError } from "../lib/error.mjs";

/** @import { Drift, FileChange } from "../lib/upload.mjs" */

// Offline tests for `upload`'s command surface (ADR-0044): the fail-fast flag
// validation, and that each mode routes to the right plumbing with the right
// arguments (set-scoped vs raw --bucket for a single file; the snapshot uploader
// for --snapshot; the folder seeder for --dir). The lib seams — set resolution,
// hashing, and the three uploaders — are faked so the test exercises `upload`'s
// own dispatch and validation, not S3 (the guard, the PUT and the lock are the
// lib's, tested in lib/upload.test.mjs and lib/locks.test.mjs). `--dir`'s
// existence check is real fs, so its tests point at a genuine directory
// (`tmpdir()`). Mocks first, then a dynamic import (objects.test.mjs ordering
// rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string, excludePath: string, claimPath: string }} */
const fakeSet = {
  name: "photos",
  bucket: "set-bucket",
  snapshotsDir: "/snaps",
  excludePath: "/snaps/exclude.txt",
  claimPath: "/photos/claim",
};
/** @type {(string | undefined)[]} */
let loadSetCalls = [];
/** @type {string[]} */
let propCalls = [];
/** @type {Record<string, unknown>[]} */
let uploadFileCalls = [];
/** @type {[object, Record<string, unknown>][]} the set and args each snapshot upload got */
let uploadSnapshotCalls = [];
/** @type {[object, Record<string, unknown>][]} the set and args each folder seed got */
let uploadDirCalls = [];
/** @type {Drift[]} what the faked seeder reports skipping */
let dirSkipped = [];
/** @type {{ uploaded: boolean, change?: FileChange }} what the faked single-file upload reports */
let fileResult = { uploaded: true };
/** @type {Error | undefined} what the faked hashing throws */
let propError;

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
      if (propError) {
        throw propError;
      }
      return { hash: "abc123", size: 42 };
    },
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    objectKey: (/** @type {string} */ hash) => `objects/${hash}`,
  },
});
mock.module("../lib/upload.mjs", {
  exports: {
    uploadFile: async (/** @type {Record<string, unknown>} */ args) => {
      uploadFileCalls.push(args);
      return fileResult;
    },
    uploadSnapshot: async (
      /** @type {object} */ set,
      /** @type {Record<string, unknown>} */ args,
    ) => {
      uploadSnapshotCalls.push([set, args]);
      return { name: args.name, candidates: 5, uploaded: 2 };
    },
    uploadDir: async (
      /** @type {object} */ set,
      /** @type {Record<string, unknown>} */ args,
    ) => {
      uploadDirCalls.push([set, args]);
      return { candidates: 40, uploaded: 12, skipped: dirSkipped };
    },
  },
});

const { upload } = await import("./upload.mjs");

beforeEach(() => {
  loadSetCalls = [];
  propCalls = [];
  uploadFileCalls = [];
  uploadSnapshotCalls = [];
  uploadDirCalls = [];
  dirSkipped = [];
  fileResult = { uploaded: true };
  propError = undefined;
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
    assert.deepEqual(uploadFileCalls, []);
    assert.deepEqual(uploadSnapshotCalls, []);
  });

  it("rejects two modes together (--file and --dir)", async () => {
    await assert.rejects(
      upload("photos", { file: "f", dir: tmpdir() }),
      /Pass one of --file, --snapshot, or --dir/,
    );
    assert.deepEqual(uploadFileCalls, []);
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
    // A usage error thrown before any work — no set resolution, no upload.
    assert.deepEqual(uploadFileCalls, []);
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
  it("set-scoped: hashes, hands the set and its bucket to the uploader, forwards --force", async () => {
    const result = await upload("photos", {
      file: "/tmp/big.iso",
      force: true,
    });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(propCalls, ["/tmp/big.iso"]);
    assert.deepEqual(uploadFileCalls, [
      {
        bucket: "set-bucket",
        set: fakeSet, // the lock names the set
        path: "/tmp/big.iso",
        props: { hash: "abc123", size: 42 },
        force: true,
      },
    ]);
    assert.deepEqual(result, {
      mode: "file",
      hash: "abc123",
      size: 42,
      key: "objects/abc123",
      uploaded: true,
    });
  });

  it("raw --bucket: uploads into the bucket with no set resolution, and no set for the lock", async () => {
    fileResult = { uploaded: false };
    const result = await upload(undefined, {
      bucket: "raw-bucket",
      file: "/tmp/big.iso",
    });

    assert.deepEqual(loadSetCalls, []); // no set → ambient credentials
    assert.equal(uploadFileCalls[0]?.bucket, "raw-bucket");
    assert.equal(uploadFileCalls[0]?.set, undefined);
    assert.equal(uploadFileCalls[0]?.force, undefined);
    assert.equal(result.mode, "file");
    assert.equal(result.uploaded, false);
  });
});

describe("upload --snapshot (a snapshot's objects)", () => {
  it("hands the snapshot uploader the set, the name and the --since baseline", async () => {
    const result = await upload("photos", {
      snapshot: "2026-01-02T0900",
      since: "2026-01-01T0900",
    });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(uploadFileCalls, []); // snapshot mode never single-PUTs
    assert.deepEqual(uploadSnapshotCalls, [
      [fakeSet, { name: "2026-01-02T0900", since: "2026-01-01T0900" }],
    ]);
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

    assert.equal(uploadSnapshotCalls[0]?.[1].since, undefined);
  });

  it("takes a snapshot's filename as readily as its name", async () => {
    // Either spelling is to hand — `list` prints the name, the snapshots folder
    // holds the `.tsv.gz`. Both are canonicalized here, at the boundary, so the
    // strict resolver downstream only ever sees a bare name (and so does the
    // result, rather than echoing back whatever was typed).
    const result = await upload("photos", {
      snapshot: "2026-01-02T0900.tsv.gz",
      since: "2026-01-01T0900.tsv",
    });

    assert.equal(uploadSnapshotCalls[0]?.[1].name, "2026-01-02T0900");
    assert.equal(uploadSnapshotCalls[0]?.[1].since, "2026-01-01T0900");
    assert.equal(
      result.mode === "snapshot" && result.snapshot,
      "2026-01-02T0900",
    );
  });
});

// What a refused single file *means* is this command's to say: the uploader
// reports the change as data (there is no snapshot to reassure about, and under
// --bucket no set to name), and the message names the exact re-run.
describe("upload --file confirmation guard", () => {
  it("refuses to store a file that changed while it was being read", async () => {
    fileResult = { uploaded: false, change: { reason: "changed" } };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /changed while s3cab was reading it/,
    );
  });

  it("says the same of a file that changed size while it was hashed", async () => {
    propError = new ChangedWhileReadError("grew");

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /changed while s3cab was reading it[^]*s3cab upload photos --file "\/f\/photo\.raw"/,
    );
    assert.deepEqual(uploadFileCalls, [], "never reached the uploader");
  });

  it("says the same of a file that changed while it was sent", async () => {
    fileResult = {
      uploaded: false,
      change: {
        reason: "changed",
        cause: new ContentMismatchError("streamed as something else"),
      },
    };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /changed while s3cab was reading it[^]*s3cab upload photos --file "\/f\/photo\.raw"$/,
    );
  });

  it("names the retry with the set it was given", async () => {
    fileResult = { uploaded: false, change: { reason: "removed" } };

    await assert.rejects(() => upload("photos", { file: "/f/photo.raw" }), {
      message: /s3cab upload photos --file "\/f\/photo\.raw"/,
    });
  });

  it("quotes the path in the retry, so one with a space pastes whole", async () => {
    fileResult = { uploaded: false, change: { reason: "changed" } };

    await assert.rejects(
      () => upload("photos", { file: "/f/My Photos/x.raw" }),
      /s3cab upload photos --file "\/f\/My Photos\/x\.raw"$/,
    );
  });

  it("names the retry with --bucket when that was how it was addressed", async () => {
    // The shared backup message can't serve here: there may be no set to name.
    fileResult = { uploaded: false, change: { reason: "changed" } };

    await assert.rejects(
      () => upload(undefined, { file: "/f/photo.raw", bucket: "raw-bucket" }),
      /s3cab upload --bucket raw-bucket --file/,
    );
  });

  it("keeps the errno in a parenthetical when the file went unreadable", async () => {
    fileResult = {
      uploaded: false,
      change: { reason: "unreadable", cause: { code: "EACCES" } },
    };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw" }),
      /could no longer be read \(EACCES\)/,
    );
  });

  it("keeps --force in the retry, so the overwrite still happens", async () => {
    // Without it, the pasted retry finds the key's old object and stores nothing.
    fileResult = { uploaded: false, change: { reason: "changed" } };

    await assert.rejects(
      () => upload("photos", { file: "/f/photo.raw", force: true }),
      /s3cab upload photos --file "\/f\/photo\.raw" --force$/,
    );
  });
});

describe("upload --dir (seed a folder's objects)", () => {
  it("hands the seeder the set (its bucket and excludes) and the folder", async () => {
    const result = await upload("photos", { dir: tmpdir() });

    assert.deepEqual(loadSetCalls, ["photos"]);
    assert.deepEqual(uploadFileCalls, []); // dir mode never single-PUTs
    assert.deepEqual(uploadDirCalls, [[fakeSet, { dir: tmpdir() }]]);
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
