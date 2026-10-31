import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { ESCAPES } from "../lib/path-match.mjs";

// Offline tests for `backup`'s porcelain: the holder check up front, the fused
// pass handed to `uploadSet` (lib/upload.mjs, where its order and failures are
// tested in upload.set.test.mjs), the best-effort config re-publish to the
// remote marker (ADR-0052), the comparison over the snapshot just written, and
// the report. The set resolver, the upload lib and `set-marker` are faked at
// the module seam — what's under test is the wiring and its order. Mocks
// first, then a dynamic import (objects.test.mjs rule).

/** @type {{ name: string, bucket: string, snapshotsDir: string, excludePath: string, claimPath: string, dirs: string[] }} */
let fakeSet;
/** @type {string[]} the ordered log of lib calls a run made */
let calls = [];
/** @type {{ name?: string, previous?: Map<string, object>, previousErrors: Map<string, string>, lookup?: object }} */
let baseline;
/** @type {Record<string, unknown>[]} the options each `uploadSet` call got */
let uploadCalls = [];
/** @type {object[]} the set each `uploadSet` call got */
let uploadSets = [];
/** @type {Record<string, unknown>} what `uploadSet` reports about the pass */
let pass;
/** @type {{ candidates: number, uploaded: number, uploadedBytes: number, sendingMs: number }} */
let sending;
/** @type {Error | undefined} what `uploadSet` fails with, if it does */
let uploadFails;
/** @type {Record<string, unknown>[]} the args each `compareSnapshots` call got */
let compareCalls = [];
/** @type {object | null} what the mocked compare returns */
let comparison;
/** @type {(() => void) | undefined} let `pushSetConfig` throw, to test best-effort */
let pushFails;
/** @type {[string, string, object][]} */
let pushCalls = [];
/** @type {(() => void) | undefined} let the holder check refuse */
let notHeld;
/** @type {string[][]} the args each holder check got */
let heldCalls = [];

mock.module("../lib/env.mjs", {
  exports: { loadSet: () => fakeSet },
});
mock.module("../lib/set-marker.mjs", {
  exports: {
    assertHeld: async (/** @type {string[]} */ ...args) => {
      calls.push("assertHeld");
      heldCalls.push(args);
      notHeld?.();
    },
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
mock.module("../lib/compare.mjs", {
  exports: {
    compareSnapshots: async (
      /** @type {string} */ snapshotDir,
      /** @type {string[]} */ dirs,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      calls.push("compareSnapshots");
      compareCalls.push({ snapshotDir, dirs, ...options });
      return comparison;
    },
  },
});
mock.module("../lib/upload.mjs", {
  exports: {
    uploadSet: async (
      /** @type {object} */ set,
      /** @type {Record<string, unknown>} */ options,
    ) => {
      calls.push("uploadSet");
      uploadSets.push(set);
      uploadCalls.push(options);
      if (uploadFails) {
        throw uploadFails;
      }
      return { baseline, pass, ...sending };
    },
  },
});

const { backup } = await import("./backup.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number | string | null | undefined} */
let savedExitCode;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = process.exitCode;
  fakeSet = {
    name: "photos",
    bucket: "b",
    snapshotsDir: "snaps",
    excludePath: "photos/exclude.txt",
    claimPath: "photos/claim",
    dirs: [],
  };
  calls = [];
  heldCalls = [];
  notHeld = undefined;
  baseline = {
    name: "20260101T0900",
    previous: new Map(),
    previousErrors: new Map(),
    lookup: { entries: new Map() },
  };
  uploadCalls = [];
  uploadSets = [];
  uploadFails = undefined;
  pass = {
    name: "20260102T0900",
    path: "snaps/20260102T0900.tsv.gz",
    files: 400,
    bytes: 4_000_000,
    hashedFiles: 12,
    hashedBytes: 300_000,
    errors: [
      { path: "/p/a.pst", reason: "EBUSY: resource busy or locked" },
      { path: "/p/b.key", reason: "EACCES: permission denied" },
    ],
    elapsedMs: 9_000,
  };
  sending = {
    candidates: 3,
    uploaded: 2,
    uploadedBytes: 1_500_000,
    sendingMs: 2_000,
  };
  compareCalls = [];
  comparison = { since: "20260101T0900", until: "20260102T0900" };
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
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
});

describe("backup", () => {
  it("checks the holder, runs the fused pass, re-syncs the config, then compares", async () => {
    const result = await backup("photos");

    assert.deepEqual(calls, [
      // Before the pass, so a set this machine doesn't hold is refused in
      // seconds; `uploadSnapshotFile` checks again just before publishing.
      "assertHeld",
      "uploadSet",
      "pushSetConfig",
      // Last, over the snapshot that has just landed — the run's report is a
      // *reading* of the finished snapshot, never a tally kept alongside it
      // (ADR-0078 §8).
      "compareSnapshots",
    ]);
    assert.deepEqual(heldCalls, [["b", "photos", "photos/claim"]]);
    // The resolved set itself goes to the lib, which takes the lock for it.
    assert.equal(uploadSets[0], fakeSet);
    assert.deepEqual(uploadCalls, [
      { rehash: undefined, resume: undefined, debug: undefined },
    ]);
    assert.deepEqual(result, {
      set: "photos",
      bucket: "b",
      snapshot: "20260102T0900",
      files: 400,
      bytes: 4_000_000,
      hashedFiles: 12,
      hashedBytes: 300_000,
      // The pass took 9s, 2s of which were spent sending — the halves are
      // exclusive because the fused pass awaits each PUT before moving on, which
      // is what makes "is my disk slow or my link slow" answerable (ADR-0078 §9).
      scanMs: 7_000,
      candidates: 3,
      uploaded: 2,
      uploadedBytes: 1_500_000,
      uploadMs: 2_000,
      errors: pass.errors,
      excludeSuggestions: [],
      unexcludable: [],
      excludePath: "photos/exclude.txt",
      comparison,
    });
  });

  it("refuses a set this machine doesn't hold before reading anything", async () => {
    notHeld = () => {
      throw new Error("not held");
    };

    await assert.rejects(backup("photos"), /not held/);

    assert.deepEqual(calls, ["assertHeld"]);
  });

  it("passes --rehash, --resume and --debug through to the pass", async () => {
    await backup("photos", { rehash: true, resume: true, debug: true });

    assert.deepEqual(uploadCalls, [
      { rehash: true, resume: true, debug: true },
    ]);
  });

  it("a failed pass is the run's failure — no config re-sync, no comparison", async () => {
    uploadFails = new Error("connection reset");

    await assert.rejects(backup("photos"), /connection reset/);

    assert.deepEqual(calls, ["assertHeld", "uploadSet"]);
  });

  it("suggests excluding only the files that failed last time too", async () => {
    // EBUSY on both — the error code can't tell a lock file nobody wants from a
    // mailbox that only needs its program closed. Failing twice is the signal.
    const music = resolve("data", "music");
    const docs = resolve("data", "docs");
    pass.roots = [music, docs];
    const again = join(docs, "Outlook", "archive.pst");
    const once = join(docs, "draft.docx");
    pass.errors = [
      { path: again, reason: "EBUSY: resource busy or locked" },
      { path: once, reason: "EBUSY: resource busy or locked" },
    ];
    baseline.previousErrors = new Map([[again, "EBUSY"]]);

    const result = await backup("photos");

    // Relative to the member directory holding it, in the native separator the
    // starter exclude.txt is written in (ADR-0051).
    assert.deepEqual(result.excludeSuggestions, [
      join("Outlook", "archive.pst"),
    ]);
  });

  it("suggests a folder link with its separator, so the pattern matches it", async () => {
    // A link to a folder outside the backup. Its row, and so the previous
    // snapshot's key, end with a separator.
    const root = resolve("data", "docs");
    pass.roots = [root];
    const shared = join(root, "Shared") + sep;
    pass.errors = [{ path: shared, reason: "link to a folder outside …" }];
    baseline.previousErrors = new Map([[shared, "link to a folder outside …"]]);

    const result = await backup("photos");

    assert.deepEqual(result.excludeSuggestions, [`Shared${sep}`]);
  });

  it("measures a suggestion from the root the walk resolved, not dirs.txt's text", async () => {
    // A symlinked or differently-cased dirs.txt entry contains none of the
    // walk's paths; only the resolved root does.
    const root = resolve("real", "docs");
    fakeSet.dirs = [resolve("alias", "docs")];
    pass.roots = [root];
    const again = join(root, "a.pst");
    pass.errors = [{ path: again, reason: "EBUSY" }];
    baseline.previousErrors = new Map([[again, "EBUSY"]]);

    const result = await backup("photos");

    assert.deepEqual(result.excludeSuggestions, ["a.pst"]);
  });

  it("suggests the line exclude.txt reads back as the file (ADR-0115)", async () => {
    // A line is trimmed, so `notes ` as written would name `notes`. Windows
    // has no escape for the space, so there the file gets no line at all.
    const root = resolve("data", "docs");
    pass.roots = [root];
    const again = join(root, "notes ");
    pass.errors = [{ path: again, reason: "EBUSY" }];
    baseline.previousErrors = new Map([[again, "EBUSY"]]);

    const result = await backup("photos");

    if (ESCAPES) {
      assert.deepEqual(result.excludeSuggestions, ["notes\\ "]);
      assert.deepEqual(result.unexcludable, []);
    } else {
      assert.deepEqual(result.excludeSuggestions, []);
      assert.deepEqual(result.unexcludable, [again]);
    }
  });

  it("exits 1 when files couldn't be read — the machine-readable signal must not lie", async () => {
    // The fixture pass carries two errors (`#error` rows). The snapshot still
    // publishes — everything it lists is stored — but a scheduled backup runs
    // on the exit code alone (guide/output.md), so it must go nonzero. Set via
    // process.exitCode, not a throw, so the run report still prints.
    process.exitCode = 0;
    await backup("photos");
    assert.equal(process.exitCode, 1);
  });

  it("leaves the exit code alone when every file was read", async () => {
    pass.errors = [];
    process.exitCode = 0;
    await backup("photos");
    assert.equal(process.exitCode, 0);
  });

  it("reports errored files from the pass, not from the diff", async () => {
    // Two sources for one number is the divergence ADR-0078 §8 refuses. These
    // are facts about the snapshot just written, and a first backup — which runs
    // no diff at all — still has to report them.
    comparison = { since: "x", until: "y", errors: [] };

    const result = await backup("photos");

    assert.deepEqual(result.errors, pass.errors);
  });

  it("diffs against the baseline the pass already parsed, never a second read of it", async () => {
    const result = await backup("photos");

    assert.deepEqual(compareCalls, [
      {
        snapshotDir: "snaps",
        dirs: [],
        // The parse handed straight through, not the baseline's *name*: the run
        // is holding it already (`readBaseline`), and `compare` accepts it in
        // this form precisely so it isn't decompressed twice. Both halves go —
        // the entries and the paths that snapshot couldn't hash, without which a
        // file that was merely locked last time reads as new (ADR-0079).
        since: {
          name: "20260101T0900",
          entries: baseline.previous,
          errors: baseline.previousErrors,
        },
        until: "20260102T0900",
        setName: "photos",
      },
    ]);
    assert.equal(result.comparison, comparison);
  });

  it("runs no comparison at all on a first backup", async () => {
    // Every file is an addition against an empty baseline: the diff is both the
    // most expensive one there is and the least informative (ADR-0078 §7). The
    // couldn't-be-backed-up list still comes through.
    baseline = { previousErrors: new Map() }; // no previous snapshot

    const result = await backup("photos");

    assert.ok(!calls.includes("compareSnapshots"));
    assert.equal(result.comparison, null);
    assert.deepEqual(result.errors, pass.errors);
  });
});

describe("backup config re-sync (ADR-0052)", () => {
  it("re-publishes the set's dirs + exclude to the remote marker after uploading", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path); // empty store → no exclude.txt → exclude: undefined
    fakeSet = { ...fakeSet, dirs: ["/home/me/Photos"] };

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

    assert.equal(result.snapshot, "20260102T0900");
    assert.equal(pushCalls.length, 1); // it was attempted
    assert.match(
      warnings.join("\n"),
      /couldn't refresh this set's cloud config/i,
    );
  });
});
