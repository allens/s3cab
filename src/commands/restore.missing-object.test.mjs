import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// Offline tests for restore's degrade-on-a-missing-object behaviour: one object
// absent from the bucket must not abort the run. The S3 reads are faked at the
// lib seam (docs/design/testing.md), so the skip, the continue, the end report
// and the exit-code side effect are pinned without a bucket — but the restore
// *planning* (lib/restore.mjs) and the real filesystem writes are left alone, so
// the dedupe interaction (a `copy` step whose source fetch failed) is exercised
// for real. Argument validation lives in restore.test.mjs; the round trip
// against a real bucket in test/integration/backup-restore-roundtrip.test.mjs.
// Module-mock ordering (objects.test.mjs) applies: mocks first, then a dynamic
// import of the command.

const BUCKET = "my-backups";

/** Hash → what `getObject` does with it; anything absent here downloads fine. */
/** @type {Map<string, Error>} */
let failures = new Map();
/** @type {string[]} Hashes `getObject` was actually asked for, in order. */
let fetched = [];
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();
/** How many times the records were fetched — laziness evidence (0 on a clean run). */
let recordReads = 0;

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string} */ name) => ({ name, bucket: BUCKET }),
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["2026-07-19T1200"],
    readRemoteSnapshot: async () => snapshot,
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    getObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
      /** @type {string} */ destPath,
    ) => {
      fetched.push(hash);
      const failure = failures.get(hash);
      if (failure) {
        throw failure;
      }
      // The real getObject lands the file; the restore loop then sets its mtime,
      // so a fake that wrote nothing would fail for the wrong reason.
      await writeFile(destPath, hash);
    },
  },
});
// The fetch is faked above at `objects.mjs`, so nothing here reaches the store
// itself — but restore's degrade branch keys on `isObjectNotFound`'s verdict,
// and the stencil's default is the real name-based predicate.
mock.module("../lib/s3.mjs", { exports: s3Seam() });
mock.module("../lib/deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => {
      recordReads++;
      return deletionRecords;
    },
  },
});

const { restore } = await import("./restore.mjs");

/**
 * The snapshot every test restores: four files under one member root, two of
 * them (`gone.txt`, `gone-copy.txt`) sharing content — so `planRestore` makes
 * the second a `copy` from wherever the first landed.
 */
const snapshot = {
  entries: new Map([
    [
      "/data/first.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "aaa" },
    ],
    [
      "/data/gone.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "bbb" },
    ],
    [
      "/data/gone-copy.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "bbb" },
    ],
    [
      "/data/last.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "ccc" },
    ],
  ]),
  dirs: ["/data"],
};

/** @param {string} name */
const named = (name) => Object.assign(new Error(name), { name });

/** @type {number | string | null | undefined} */
let savedExitCode;
/** @type {string} */
let output;
beforeEach(() => {
  savedExitCode = process.exitCode;
  failures = new Map();
  fetched = [];
  deletionRecords = new Map();
  recordReads = 0;
  output = mkdtempSync(join(tmpdir(), "s3cab-restore-"));
});
afterEach(() => {
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
  rmSync(output, { recursive: true, force: true }); // don't leak the temp dir
});

/** Where `--output` re-roots `/data/<name>` to. */
const dest = (/** @type {string} */ name) => join(output, "data", name);

describe("restore with an object missing from the bucket", () => {
  it("skips the file, restores the rest, and reports every missing path", async () => {
    failures.set("bbb", named("NoSuchKey"));

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.restored, [dest("first.txt"), dest("last.txt")]);
    assert.deepEqual(result.missing, [dest("gone.txt"), dest("gone-copy.txt")]);
    assert.deepEqual(result.skipped, []);
    // The run really continued: the file *after* the failure is on disk.
    assert.equal(readFileSync(dest("last.txt"), "utf8"), "ccc");
  });

  it("exits 1 so a failed restore can't look like a clean one", async () => {
    failures.set("bbb", named("NoSuchKey"));
    await restore([], { set: "photos", output });
    assert.equal(process.exitCode, 1);
  });

  it("does not re-fetch — or copy from — content already found missing", async () => {
    // `gone-copy.txt` is a `copy` step pointing at `gone.txt`, which was never
    // written. Attempting it would throw ENOENT and abort the run; it must be
    // recorded as the same casualty instead.
    failures.set("bbb", named("NoSuchKey"));
    await restore([], { set: "photos", output });
    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
  });

  it("treats a provider's HEAD-style NotFound as missing too", async () => {
    failures.set("ccc", named("NotFound"));
    const result = await restore([], { set: "photos", output });
    assert.deepEqual(result.missing, [dest("last.txt")]);
  });

  it("still aborts on a failure that isn't an absent object", async () => {
    // A credentials or integrity failure is wrong about the run, not about one
    // file — swallowing it would restore nothing and report success.
    failures.set("bbb", named("AccessDenied"));
    await assert.rejects(restore([], { set: "photos", output }), {
      name: "AccessDenied",
    });
    assert.equal(process.exitCode, savedExitCode);
  });

  it("leaves the exit code alone when nothing is missing", async () => {
    const result = await restore([], { set: "photos", output });
    assert.deepEqual(result.missing, []);
    assert.equal(result.bucket, BUCKET);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("never fetches the deletion records on a clean run — laziness is the happy path's price of zero", async () => {
    await restore([], { set: "photos", output });
    assert.equal(recordReads, 0);
  });
});

describe("restore with deliberately deleted content (ADR-0064)", () => {
  it("reports a recorded absence as deleted-with-date, not missing, and exits 0", async () => {
    failures.set("bbb", named("NoSuchKey"));
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await restore([], { set: "photos", output });

    // Both paths of the deduped content are the same deliberate casualty —
    // including the `copy` twin that was never attempted.
    assert.deepEqual(result.deleted, [
      { path: dest("gone.txt"), deletedOn: "2026-07-19T14:22:41.000Z" },
      { path: dest("gone-copy.txt"), deletedOn: "2026-07-19T14:22:41.000Z" },
    ]);
    assert.deepEqual(result.missing, []);
    // Deliberate ≠ fault: the record explains the gap, so the run is clean.
    assert.equal(process.exitCode, savedExitCode);
    // The rest still restored.
    assert.equal(readFileSync(dest("last.txt"), "utf8"), "ccc");
  });

  it("fetches the records once, however many objects are absent", async () => {
    failures.set("bbb", named("NoSuchKey"));
    failures.set("ccc", named("NoSuchKey"));
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    await restore([], { set: "photos", output });

    assert.equal(recordReads, 1);
  });

  it("an unrecorded absence beside a recorded one still exits 1", async () => {
    failures.set("bbb", named("NoSuchKey")); // recorded
    failures.set("ccc", named("NoSuchKey")); // unexplained
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(
      result.deleted.map((d) => d.path),
      [dest("gone.txt"), dest("gone-copy.txt")],
    );
    assert.deepEqual(result.missing, [dest("last.txt")]);
    assert.equal(process.exitCode, 1);
  });
});
