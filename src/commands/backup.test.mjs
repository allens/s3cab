import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { CompareResult } from "../lib/compare.mjs" */

// Offline tests for `backup`'s orchestration — it takes a fresh snapshot, whose
// returned diff names both sides (the compareSnapshots contract): `until` IS the
// fresh snapshot and `since` the previous local latest, the change-detection
// baseline handed to `upload()` (ADR-0044, docs/design/backup.md). Nothing is
// re-read from disk, so backup and snapshot can't disagree. Then it best-effort
// re-publishes the set's config to the remote marker (ADR-0052). The set
// resolver, snapshot command, `upload`, and `pushSetConfig` are faked at the
// module seam. Mocks first, then a dynamic import (objects.test.mjs ordering rule).

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
/** @type {CompareResult} what the fake snapshot() returns */
let snapshotResult;

/**
 * A minimal CompareResult, as `snapshot()` returns: only `until`/`since` are
 * consumed by backup, the rest is the honest empty diff shape.
 * @param {string} until
 * @param {string | null} since
 * @returns {CompareResult}
 */
const diffResult = (until, since) => ({
  setName: "photos",
  dirs: [],
  since,
  until,
  added: [],
  moved: [],
  modified: [],
  deleted: [],
  errors: [],
});

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
      return snapshotResult;
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

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  fakeSet = { name: "photos", bucket: "b", snapshotsDir: "", dirs: [] };
  uploadCalls = [];
  snapshotCalls = [];
  pushCalls = [];
  pushFails = undefined;
  snapshotResult = diffResult("2026-01-01T0900", null);
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
  it("hands upload the diff's fresh name (until) and previous latest (since)", async () => {
    snapshotResult = diffResult("2026-01-02T0900", "2026-01-01T0900");

    const result = await backup("photos");

    assert.deepEqual(snapshotCalls, [["photos", {}]]);
    assert.equal(uploadCalls.length, 1);
    assert.deepEqual(uploadCalls[0], [
      "photos",
      { snapshot: "2026-01-02T0900", since: "2026-01-01T0900" },
    ]);
    assert.equal(result.snapshot, "2026-01-02T0900");
  });

  it("passes no baseline on a first backup (the diff's since is null → upload LISTs)", async () => {
    snapshotResult = diffResult("2026-01-01T0900", null);

    await backup("photos");

    assert.equal(uploadCalls[0]?.[1].snapshot, "2026-01-01T0900");
    assert.equal(uploadCalls[0]?.[1].since, undefined);
  });

  it("passes no baseline when the diff's since is the fresh snapshot itself (S3CAB_DEBUG same-minute overwrite)", async () => {
    // A same-minute overwrite makes the previous latest the fresh name; diffing
    // the snapshot against itself would plan zero objects and break the
    // objects-first/snapshot-last invariant — so backup falls back to the LIST.
    snapshotResult = diffResult("2026-01-01T0900", "2026-01-01T0900");

    await backup("photos");

    assert.equal(uploadCalls[0]?.[1].snapshot, "2026-01-01T0900");
    assert.equal(uploadCalls[0]?.[1].since, undefined);
  });

  it("returns the upload result's counts under the backed-up set + snapshot", async () => {
    snapshotResult = diffResult("2026-01-01T0900", null);

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
      snapshotsDir: "",
      dirs: ["/home/me/Photos"],
    };

    await backup("photos");

    assert.deepEqual(pushCalls, [
      ["b", "photos", { dirs: ["/home/me/Photos"], exclude: undefined }],
    ]);
  });

  it("warns but does not fail the backup when the config re-sync fails (best-effort)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
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
