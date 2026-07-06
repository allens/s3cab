import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";

// Offline tests for `backup`'s orchestration — specifically the change-detection
// baseline it resolves and hands to `uploadSnapshot` (docs/design/backup.md): the
// set's previous local snapshot, or nothing on a first backup (→ the uploader
// LISTs). The set resolver, snapshot writer, and uploader are faked at the lib
// seam; `listSnapshotNames` runs for real against a temp dir of datestamped stub
// files, so the "which previous snapshot" logic under test is the real one. Mocks
// first, then a dynamic import (objects.test.mjs ordering rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string }} */
let fakeSet = { name: "photos", bucket: "b", snapshotsDir: "" };
/** @type {Record<string, unknown>[]} */
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
mock.module("../lib/remote.mjs", {
  exports: {
    uploadSnapshot: async (/** @type {Record<string, unknown>} */ args) => {
      uploadCalls.push(args);
      return { name: args.name, candidates: 0, uploaded: 0 };
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
  it("diffs against the previous local snapshot (--snapshot on an existing one)", async () => {
    await using dir = await mkTmpDir();
    stub(dir.path, "2026-01-01T0900");
    stub(dir.path, "2026-01-02T0900");
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };

    const result = await backup("photos", { snapshot: "2026-01-02T0900" });

    assert.deepEqual(snapshotCalls, []); // --snapshot skips taking a fresh one
    assert.equal(uploadCalls.length, 1);
    assert.deepEqual(uploadCalls[0], {
      bucket: "b",
      set: "photos",
      snapshotDir: dir.path,
      name: "2026-01-02T0900",
      since: "2026-01-01T0900",
    });
    assert.equal(result.snapshot, "2026-01-02T0900");
  });

  it("passes no baseline on a first backup (no previous snapshot → the uploader LISTs)", async () => {
    await using dir = await mkTmpDir();
    stub(dir.path, "2026-01-01T0900");
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };

    await backup("photos", { snapshot: "2026-01-01T0900" });

    assert.equal(uploadCalls[0]?.since, undefined);
  });

  it("takes a fresh snapshot, then diffs it against the prior latest local one", async () => {
    await using dir = await mkTmpDir();
    stub(dir.path, "2026-01-01T0900");
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path };
    // A fresh snapshot() writes the newest file; backup reads its name back.
    onSnapshot = () => stub(dir.path, "2026-01-02T0900");

    const result = await backup("photos");

    assert.deepEqual(snapshotCalls, [["photos", {}]]);
    assert.equal(uploadCalls[0]?.name, "2026-01-02T0900");
    assert.equal(uploadCalls[0]?.since, "2026-01-01T0900");
    assert.equal(result.snapshot, "2026-01-02T0900");
  });
});
