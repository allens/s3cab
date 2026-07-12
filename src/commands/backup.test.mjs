import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Offline tests for `backup`'s orchestration — it takes a fresh snapshot, then
// resolves the change-detection baseline and hands both to `upload()` (ADR-0044,
// docs/design/backup.md): the set's previous local snapshot as `--since`, or
// nothing on a first backup (→ `upload` LISTs). Then it best-effort re-publishes
// the set's config to the remote marker (ADR-0052). The set resolver, snapshot
// writer, `upload`, and `pushSetConfig` are faked at the module seam;
// `listSnapshotNames` runs for real against a temp dir of datestamped stub files,
// so the "which previous snapshot" logic under test is the real one. Mocks first,
// then a dynamic import (objects.test.mjs ordering rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string, dirs: string[] }} */
let fakeSet = { name: "photos", bucket: "b", snapshotsDir: "", dirs: [] };
/** @type {[string | undefined, Record<string, unknown>][]} */
let uploadCalls = [];
/** @type {[string, object][]} */
let snapshotCalls = [];
/** @type {[string, string, object][]} */
let pushCalls = [];
/** @type {(() => void) | undefined} let `pushSetConfig` throw, to test best-effort */
let pushFails;
/** @type {(() => void) | undefined} the file a fresh `snapshot()` writes */
let onSnapshot;

mock.module("../lib/env.mjs", {
  exports: { loadSet: () => fakeSet },
});
mock.module("../lib/set-marker.mjs", {
  exports: {
    pushSetConfig: async (
      /** @type {string} */ bucket,
      /** @type {string} */ set,
      /** @type {object} */ config,
    ) => {
      pushCalls.push([bucket, set, config]);
      pushFails?.();
    },
  },
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

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  uploadCalls = [];
  snapshotCalls = [];
  pushCalls = [];
  pushFails = undefined;
  onSnapshot = undefined;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("backup baseline resolution", () => {
  it("takes a fresh snapshot, then hands upload the fresh name + prior latest as --since", async () => {
    await using dir = await mkTmpDir();
    stub(dir.path, "2026-01-01T0900");
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path, dirs: [] };
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
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path, dirs: [] };
    // First backup: the dir starts empty; snapshot() writes the only snapshot.
    onSnapshot = () => stub(dir.path, "2026-01-01T0900");

    await backup("photos");

    assert.equal(uploadCalls[0]?.[1].snapshot, "2026-01-01T0900");
    assert.equal(uploadCalls[0]?.[1].since, undefined);
  });

  it("returns the upload result's counts under the backed-up set + snapshot", async () => {
    await using dir = await mkTmpDir();
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path, dirs: [] };
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

describe("backup config re-sync (ADR-0052)", () => {
  it("re-publishes the set's dirs + exclude to the remote marker after uploading", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path); // empty store → no exclude.txt → exclude: undefined
    fakeSet = {
      name: "photos",
      bucket: "b",
      snapshotsDir: dir.path,
      dirs: ["/home/me/Photos"],
    };
    onSnapshot = () => stub(dir.path, "2026-01-01T0900");

    await backup("photos");

    assert.deepEqual(pushCalls, [
      ["b", "photos", { dirs: ["/home/me/Photos"], exclude: undefined }],
    ]);
  });

  it("warns but does not fail the backup when the config re-sync fails (best-effort)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    fakeSet = { name: "photos", bucket: "b", snapshotsDir: dir.path, dirs: [] };
    onSnapshot = () => stub(dir.path, "2026-01-01T0900");
    pushFails = () => {
      throw new Error("marker push failed");
    };
    /** @type {string[]} */
    const warnings = [];
    const warn = mock.method(console, "warn", (/** @type {string} */ m) =>
      warnings.push(m),
    );

    // The objects + snapshot are already up, so backup still resolves with its
    // result; the marker just stays stale until the next backup.
    const result = await backup("photos");
    warn.mock.restore();

    assert.equal(result.snapshot, "2026-01-01T0900");
    assert.equal(pushCalls.length, 1); // it was attempted
    assert.match(
      warnings.join("\n"),
      /couldn't refresh this set's cloud config/i,
    );
  });
});
