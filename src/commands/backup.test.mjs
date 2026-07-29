import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { FileChangedError } from "../lib/error.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { SnapshotRow } from "../lib/snapshot-file.mjs" */
/** @import { Drift } from "../lib/upload.mjs" */

// Offline tests for `backup`'s orchestration (ADR-0069): read the previous
// snapshot, decide what's already stored *before* hashing anything, run one
// fused pass with the object uploader spliced into the snapshot write, publish
// the manifest last, then best-effort re-publish the set's config to the remote
// marker (ADR-0052). The set resolver, the snapshot engine, the upload lib and
// `pushSetConfig` are faked at the module seam — what's under test is the wiring
// and its order. Mocks first, then a dynamic import (objects.test.mjs rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string, dirs: string[] }} */
let fakeSet = { name: "photos", bucket: "b", snapshotsDir: "snaps", dirs: [] };
/** @type {string[]} the ordered log of lib calls a run made */
let calls = [];
/** @type {{ name?: string, previous?: Map<string, object>, lookup?: Map<string, object> }} */
let baseline;
/** @type {Record<string, unknown>[]} the args each `storedHashes` call got */
let storedCalls = [];
/** @type {Record<string, unknown>[]} the args each `generateSnapshot` call got */
let generateCalls = [];
/** @type {Record<string, unknown>[]} the args each manifest upload got */
let manifestCalls = [];
/** @type {{ candidates: number, uploaded: number, drifted: Drift[], failure?: Error }} */
let outcome;
/** @type {{ drifted: Drift[], set: string }[]} calls into the drift-error factory */
let driftErrorCalls = [];
/** @type {(() => void) | undefined} let `pushSetConfig` throw, to test best-effort */
let pushFails;
/** @type {[string, string, object][]} */
let pushCalls = [];

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
      calls.push("pushSetConfig");
      pushCalls.push([bucket, set, config]);
      pushFails?.();
    },
  },
});
mock.module("../lib/snapshot.mjs", {
  exports: {
    readBaseline: async () => {
      calls.push("readBaseline");
      return baseline;
    },
    generateSnapshot: async (
      /** @type {object} */ _set,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      calls.push("generateSnapshot");
      generateCalls.push(options);
      return { name: "2026-01-02T0900", path: "snaps/2026-01-02T0900.tsv.zst" };
    },
  },
});
mock.module("../lib/upload.mjs", {
  exports: {
    storedHashes: async (/** @type {Record<string, unknown>} */ args) => {
      calls.push("storedHashes");
      storedCalls.push(args);
      return new Set(["already-stored"]);
    },
    uploadObjects: () => {
      calls.push("uploadObjects");
      return {
        /** @param {AsyncIterable<SnapshotRow>} rows */
        through: (rows) => rows,
        result: () => outcome,
      };
    },
    uploadSnapshotFile: async (/** @type {Record<string, unknown>} */ args) => {
      calls.push("uploadSnapshotFile");
      manifestCalls.push(args);
    },
    // The real factory's wording is unit-tested at its own seam; here what matters
    // is that `backup` delegates to it, handing over the whole drift list.
    fileChangedError: (
      /** @type {Drift[]} */ drifted,
      /** @type {string} */ set,
    ) => {
      driftErrorCalls.push({ drifted, set });
      return new FileChangedError(`drift in '${set}'`);
    },
  },
});

const { backup } = await import("./backup.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  fakeSet = { name: "photos", bucket: "b", snapshotsDir: "snaps", dirs: [] };
  calls = [];
  baseline = {
    name: "2026-01-01T0900",
    previous: new Map(),
    lookup: new Map(),
  };
  storedCalls = [];
  generateCalls = [];
  manifestCalls = [];
  outcome = { candidates: 3, uploaded: 2, drifted: [] };
  driftErrorCalls = [];
  pushCalls = [];
  pushFails = undefined;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("backup (the fused pass)", () => {
  it("settles what's stored before hashing, generates with the uploader spliced in, publishes the manifest last", async () => {
    const result = await backup("photos");

    // The order is the invariant: nothing is hashed before the store question is
    // settled, and the manifest goes up only once the pipeline has drained.
    assert.deepEqual(calls, [
      "readBaseline",
      "storedHashes",
      "uploadObjects",
      "generateSnapshot",
      "uploadSnapshotFile",
      "pushSetConfig",
    ]);
    // The uploader rides *inside* the snapshot write — that is the fusion.
    assert.ok(
      generateCalls[0]?.through,
      "expected the upload transform to be passed",
    );
    assert.equal(generateCalls[0]?.lookup, baseline.lookup);
    assert.deepEqual(manifestCalls, [
      {
        bucket: "b",
        set: "photos",
        snapshotDir: "snaps",
        name: "2026-01-02T0900",
      },
    ]);
    assert.deepEqual(result, {
      set: "photos",
      snapshot: "2026-01-02T0900",
      candidates: 3,
      uploaded: 2,
    });
  });

  it("hands the previous local snapshot to storedHashes as the baseline", async () => {
    await backup("photos");

    assert.deepEqual(storedCalls, [
      {
        bucket: "b",
        set: "photos",
        since: "2026-01-01T0900",
        baseline: baseline.previous,
      },
    ]);
  });

  it("passes no baseline on a first backup (storedHashes then LISTs the store)", async () => {
    baseline = {}; // no previous snapshot

    await backup("photos");

    assert.equal(storedCalls[0]?.since, undefined);
    assert.equal(storedCalls[0]?.baseline, undefined);
  });

  it("reports an upload failure without publishing the manifest, pointing at the cheap retry", async () => {
    // The local snapshot landed (generateSnapshot returned), so the fix is to
    // re-send the objects — not to re-hash the whole set.
    const failure = new Error("connection reset");
    outcome = { candidates: 3, uploaded: 1, drifted: [], failure };

    await assert.rejects(backup("photos"), (/** @type {Error} */ error) => {
      assert.match(error.message, /connection reset/);
      assert.match(
        error.message,
        /s3cab upload photos --snapshot 2026-01-02T0900/,
      );
      assert.equal(error.cause, failure);
      return true;
    });

    assert.deepEqual(manifestCalls, [], "no manifest for a partial upload");
    assert.ok(!calls.includes("pushSetConfig"));
  });

  it("raises the drift error, not the resume advice — a drifted file needs a fresh backup", async () => {
    // A drifted row can never be reconciled with the file as it now stands, so
    // wrapping it in the "carry on where it stopped" advice would send the user
    // at a retry that must fail. `backup` hands the whole list to the factory.
    /** @type {Drift[]} */
    const drifted = [{ path: "photo.raw", reason: "changed" }];
    outcome = { candidates: 3, uploaded: 2, drifted };

    await assert.rejects(backup("photos"), (/** @type {Error} */ error) => {
      assert.ok(error instanceof FileChangedError);
      assert.doesNotMatch(error.message, /--snapshot/, "not the resume advice");
      return true;
    });

    assert.deepEqual(driftErrorCalls, [{ drifted, set: "photos" }]);
    assert.deepEqual(manifestCalls, []);
  });

  it("blames the dropped link, not an earlier drift, when both happened", async () => {
    // The masking defect the two-field outcome exists to fix: one first-wins slot
    // let a drift on an early row speak for a dead network met on a later one, so
    // the user was sent at a fresh backup when the actual problem was the link.
    const failure = new Error("connection reset");
    outcome = {
      candidates: 3,
      uploaded: 1,
      drifted: [{ path: "photo.raw", reason: "changed" }],
      failure,
    };

    await assert.rejects(backup("photos"), (/** @type {Error} */ error) => {
      assert.match(error.message, /connection reset/);
      assert.match(error.message, /--snapshot 2026-01-02T0900/);
      return true;
    });

    assert.deepEqual(driftErrorCalls, [], "the drift error is not raised");
    assert.deepEqual(manifestCalls, []);
  });
});

describe("backup config re-sync (ADR-0052)", () => {
  it("re-publishes the set's dirs + exclude to the remote marker after uploading", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path); // empty store → no exclude.txt → exclude: undefined
    fakeSet = {
      name: "photos",
      bucket: "b",
      snapshotsDir: "snaps",
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

    assert.equal(result.snapshot, "2026-01-02T0900");
    assert.equal(pushCalls.length, 1); // it was attempted
    assert.match(
      warnings.join("\n"),
      /couldn't refresh this set's cloud config/i,
    );
  });
});
