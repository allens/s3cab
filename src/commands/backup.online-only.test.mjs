import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// A backup over a folder holding a dehydrated cloud placeholder (ADR-0081) —
// the real engine, with `node:fs` and `s3.mjs` the only seams faked. What it is
// really for is the *report*: a placeholder must land in `skipped` and never in
// `errors`, because an error count would call a backup that worked exactly as
// designed a backup that failed.
//
// Its own file (ADR-0049's dotted aspect) because faking the stat means mocking
// `node:fs` before the engine loads, which the sibling `backup.fused.test.mjs`
// cannot do around its static imports.

/** The full logical size a placeholder reports, with nothing allocated behind it. */
const PLACEHOLDER_SIZE = 262_144;

/** @type {Set<string>} Paths the mocked `lstat` reports as having no bytes on disk */
const dehydrated = new Set();

const passthrough = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => name !== "constants"),
);

mock.module("node:fs", {
  exports: {
    ...passthrough,
    /** @param {string} path */
    lstatSync: (path) => {
      const stat = realFs.lstatSync(path);
      if (!dehydrated.has(path)) {
        return stat;
      }
      // Full logical size, nothing allocated — what Files On-Demand leaves
      // behind. The walk is unaffected: it classifies from the `Dirent`, and a
      // placeholder is a genuine `File` there, which is why nothing upstream of
      // the hash pass can catch this.
      return Object.create(stat, {
        size: { value: PLACEHOLDER_SIZE, enumerable: true },
        blocks: { value: 0, enumerable: true },
      });
    },
  },
});

// The upload drift guard re-stats each file through `node:fs/promises` before
// sending it, so the placeholder has to look the same to *both* stat APIs —
// otherwise the guard compares a 262,144-byte row against a real 41-byte file
// and calls it changed. A faithful fake of the filesystem, not of one function.
mock.module("node:fs/promises", {
  exports: {
    ...realFsPromises,
    /** @param {string} path */
    lstat: async (path) => {
      const stat = await realFsPromises.lstat(path);
      if (!dehydrated.has(path)) {
        return stat;
      }
      return Object.create(stat, {
        size: { value: PLACEHOLDER_SIZE, enumerable: true },
        blocks: { value: 0, enumerable: true },
      });
    },
  },
});

mock.module("../lib/s3.mjs", {
  exports: {
    putFile: async () => true,
    listObjects: async function* () {},
    putText: async () => {},
    getText: async () => undefined,
    // The baseline-identity probe (ADR-0084) finds every remote snapshot
    // absent, so no baseline is ever trusted and each backup LISTs the store.
    getStream: async () => {
      throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    },
    isObjectNotFound: (/** @type {unknown} */ error) =>
      Error.isError(error) && error.name === "NoSuchKey",
    deleteObject: async () => {},
  },
});

const { backup } = await import("./backup.mjs");
const { writeSet } = await import("../lib/sets.mjs");
const { readSnapshot } = await import("../lib/snapshot-file.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {string[]} */
let warnings = [];
/** @type {typeof console.warn} */
let realWarn;

beforeEach(() => {
  savedEnv = { ...process.env };
  warnings = [];
  realWarn = console.warn;
  console.warn = (/** @type {unknown[]} */ ...args) => {
    warnings.push(args.join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
  dehydrated.clear();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A set of two ordinary files and one cloud placeholder.
 * @param {string} root - A disposable directory to build the set and its home in
 * @returns {{ snapshotDir: string, online: string }}
 */
const setWithAPlaceholder = (root) => {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "a.txt"), "hello");
  writeFileSync(join(data, "b.txt"), "world");
  const online = join(data, "IMG_0421.jpg");
  writeFileSync(online, "the bytes OneDrive would have had to fetch");
  const home = useTempHome(root);
  writeSet("photos", { dirs: [realpathSync.native(data)], bucket: "b" });
  dehydrated.add(realpathSync.native(online));
  return {
    snapshotDir: join(home, ".s3cab", "sets", "photos", "snapshots"),
    online: realpathSync.native(online),
  };
};

describe("backup over a folder holding cloud placeholders", () => {
  it("reports it as skipped rather than failed, and says how to include it", async (t) => {
    // Windows only: this is where Files On-Demand exists and where the
    // `size && !blocks` signal was measured to belong to placeholders. On ext4
    // the identical shape is a fully sparse file — a real file that must stay in
    // the backup — so the engine reads it there and there is no skip to assert.
    if (platform !== "win32") {
      t.skip("detection is Windows-only by design (ADR-0081)");
      return;
    }
    await using dir = await mkTmpDir();
    const { snapshotDir, online } = setWithAPlaceholder(dir.path);

    const result = await backup("photos");

    // The whole point of the error/skip split: a working run, not a failing one.
    assert.equal(result.skipped, 1);
    assert.equal(result.errors, 0);
    // `files` is what the *walk* found, and the walk keeps a placeholder — it is
    // a genuine `File` to both `readdir` and `lstat`. So the run scanned three
    // and backed up two, which is exactly what the report says.
    assert.equal(result.files, 3);
    assert.equal(result.uploaded, 2);

    // And it is in the snapshot as a skip, under the name the user is shown.
    const snap = await readSnapshot(snapshotDir, result.snapshot);
    assert.equal(snap.skipped.get(online)?.fileType, "Online-Only File");
    assert.ok(!snap.entries.has(online));
    assert.ok(!snap.errors.has(online));

    // The count alone can't be acted on, so the run names the flag that changes
    // it — the only skip class that has one (ADR-0030's constructive fix).
    const hint = warnings.find((line) =>
      line.includes("--include-online-only"),
    );
    assert.ok(
      hint,
      `expected an online-only hint, got:\n${warnings.join("\n")}`,
    );
    assert.match(hint, /Left 1 file in 'photos' online/);
    assert.match(hint, / {2}s3cab backup photos --include-online-only$/);
  });

  it("downloads and stores them under --include-online-only", async (t) => {
    if (platform !== "win32") {
      t.skip("detection is Windows-only by design (ADR-0081)");
      return;
    }
    await using dir = await mkTmpDir();
    setWithAPlaceholder(dir.path);

    const result = await backup("photos", { "include-online-only": true });

    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.files, 3);
    assert.equal(result.uploaded, 3);
    assert.ok(
      !warnings.some((line) => line.includes("--include-online-only")),
      "nothing to advise when the flag is already set",
    );
  });
});
