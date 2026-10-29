import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// What `reattach` does with the bucket (ADR-0108): it attaches read-only, or
// refreshes, and changes nothing there. set-marker.mjs is real, its text objects
// held in a map at the s3.mjs seam that refuses every write; the snapshot pull
// is faked at remote.mjs. reattach.test.mjs is the offline validation. Mocks
// first, then a dynamic import.

/** @type {Map<string, string>} the bucket's text objects, by URI */
const texts = new Map();
/** @type {string[]} the snapshots `snapshots/photos/` holds */
let remoteSnapshots = [];

mock.module("../lib/s3.mjs", {
  exports: s3Seam({
    getText: async (/** @type {string} */ uri) => texts.get(uri),
    listObjects: async function* (/** @type {string} */ uri) {
      for (const key of texts.keys()) {
        if (key.startsWith(uri)) {
          yield { Key: key.slice("s3://b/".length) };
        }
      }
    },
  }),
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => remoteSnapshots,
    downloadRemoteSnapshots: async () => remoteSnapshots.length,
  },
});

const { reattach } = await import("./reattach.mjs");
const { writeSet } = await import("../lib/sets.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const INFO = "s3://b/snapshots/photos.info";
const BOBS =
  "OWNER=bob@laptop\nCLAIMED=2026-01-01T00:00:00.000Z\nCREATED=2025-06-01T00:00:00.000Z\n";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {string[]} */
let warnings = [];
beforeEach(() => {
  savedEnv = { ...process.env };
  texts.clear();
  remoteSnapshots = ["20260801T0900", "20260802T0900"];
  warnings = [];
  mock.method(console, "warn", (/** @type {unknown[]} */ ...args) =>
    warnings.push(args.join(" ")),
  );
});
afterEach(() => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("reattach", () => {
  it("attaches read-only: snapshots only, no config, no claim, and the holder named", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    texts.set(INFO, BOBS);
    texts.set("s3://b/.s3cab/sets/photos/dirs.txt", "D:\\Photos\n");

    const result = await reattach("photos", [], { bucket: "b" });

    assert.deepEqual(result, {
      set: "photos",
      bucket: "b",
      snapshots: 0, // the pull is faked, so none landed
      pulled: 2,
      holder: "bob@laptop",
      held: false,
    });
    const setDir = join(home, ".s3cab", "sets", "photos");
    for (const file of ["dirs.txt", "exclude.txt", "claim"]) {
      assert.equal(existsSync(join(setDir, file)), false, file);
    }
    assert.match(
      warnings.join("\n"),
      /instead of bob@laptop[\s\S]*s3cab takeover photos/,
    );
  });

  it("refreshes a set already here without --bucket, and the holder isn't nudged", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    texts.set(INFO, BOBS);
    writeFileSync(set.claimPath, BOBS);

    const result = await reattach("photos", [], {});

    assert.equal(result.held, true);
    assert.doesNotMatch(warnings.join("\n"), /takeover/);
  });

  it("attaches a set another client wrote, with no marker and no config", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const result = await reattach("photos", [], { bucket: "b" });

    assert.equal(result.holder, undefined);
    assert.equal(result.held, false);
  });

  it("names the sets the bucket does hold when it has no such set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    remoteSnapshots = [];
    texts.set("s3://b/snapshots/docs.info", BOBS);

    await assert.rejects(
      () => reattach("photos", [], { bucket: "b" }),
      /No backup set 'photos' in bucket 'b'[\s\S]*docs/,
    );
  });
});
