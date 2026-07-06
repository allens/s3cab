import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";

// Offline tests for `backup`'s orchestration — it takes a fresh snapshot, then
// resolves the change-detection baseline and hands both to `upload()` (ADR-0044,
// docs/design/backup.md): the set's previous local snapshot as `--since`, or
// nothing on a first backup (→ `upload` LISTs). The set resolver, snapshot
// writer, and `upload` are faked at the module seam; `listSnapshotNames` runs for
// real against a temp dir of datestamped stub files, so the "which previous
// snapshot" logic under test is the real one. Mocks first, then a dynamic import
// (objects.test.mjs ordering rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string }} */
let fakeSet = { name: "photos", bucket: "b", snapshotsDir: "" };
/** @type {[string | undefined, Record<string, unknown>][]} */
let uploadCalls = [];
/** @type {[string, object][]} */
let snapshotCalls = [];
/** @type {(() => void) | undefined} the file a fresh `snapshot()` writes */
let onSnapshot;

mock.module("../lib/env.mjs", {
  exports: { loadSet: () => fakeSet },
});
mock.module("./snapshot.mjs", {
  exports: {
    snapshot: async (
      /** @type {string} */ set,
      /** @type {object} */ options,
    ) => {
      snapshotCalls.push([set, options]);
      onSnapshot?.();
    },
  },
});
mock.module("./upload.mjs", {
  exports: {
    upload: async (
      /** @type {string | undefined} */ set,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      uploadCalls.push([set, options]);
      return {
        mode: "snapshot",
        set,
        snapshot: options.snapshot,
        candidates: 0,
        uploaded: 0,
      };
    },
  },
});

const { backup } = await import("./backup.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const stub = (/** @type {string} */ dir, /** @type {string} */ name) =>
  writeFileSync(join(dir, `${name}.tsv.zst`), "");

beforeEach(() => {
  uploadCalls = [];
  snapshotCalls = [];
  onSnapshot = undefined;
});

describe("backup baseline resolution", () => {
  it("takes a fresh snapshot, then hands upload the fresh name + prior latest as --since", async () => {
    await using dir = await mkTmpDir();
    stub(dir.path, "2026-01-01T0900");
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };
    // A fresh snapshot() writes the newest file; backup reads its name back.
    onSnapshot = () => stub(dir.path, "2026-01-02T0900");

    const result = await backup("photos");

    assert.deepEqual(snapshotCalls, [["photos", {}]]);
    assert.equal(uploadCalls.length, 1);
    assert.deepEqual(uploadCalls[0], [
      "photos",
      { snapshot: "2026-01-02T0900", since: "2026-01-01T0900" },
    ]);
    assert.equal(result.snapshot, "2026-01-02T0900");
  });

  it("passes no baseline on a first backup (only the fresh snapshot exists → upload LISTs)", async () => {
    await using dir = await mkTmpDir();
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };
    // First backup: the dir starts empty; snapshot() writes the only snapshot.
    onSnapshot = () => stub(dir.path, "2026-01-01T0900");

    await backup("photos");

    assert.equal(uploadCalls[0]?.[1].snapshot, "2026-01-01T0900");
    assert.equal(uploadCalls[0]?.[1].since, undefined);
  });

  it("returns the upload result's counts under the backed-up set + snapshot", async () => {
    await using dir = await mkTmpDir();
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };
    onSnapshot = () => stub(dir.path, "2026-01-01T0900");

    const result = await backup("photos");

    assert.deepEqual(result, {
      set: "photos",
      snapshot: "2026-01-01T0900",
      candidates: 0,
      uploaded: 0,
    });
  });
});
