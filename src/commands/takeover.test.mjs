import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// `takeover` over an in-memory bucket (ADR-0108): set-marker.mjs is real, its
// small text objects held in a map at the s3.mjs seam, and the snapshot pull is
// faked at remote.mjs — what `takeover` adds to it is the config pull and the
// claim, so that is what these assert. Mocks first, then a dynamic import.

/** @type {Map<string, string>} the bucket's text objects, by URI */
const texts = new Map();
/** @type {string[]} every text object written, by URI */
let puts = [];

mock.module("../lib/s3.mjs", {
  exports: s3Seam({
    getText: async (/** @type {string} */ uri) => texts.get(uri),
    putText: async (
      /** @type {string} */ uri,
      /** @type {string} */ content,
      { noClobber = false } = {},
    ) => {
      if (noClobber && texts.has(uri)) {
        return false;
      }
      puts.push(uri);
      texts.set(uri, content);
      return true;
    },
  }),
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["2026-08-01T0900"],
    downloadRemoteSnapshots: async () => 0,
  },
});

const { takeover } = await import("./takeover.mjs");
const { writeSet } = await import("../lib/sets.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const INFO = "s3://b/snapshots/photos.info";
const DIRS = "s3://b/.s3cab/sets/photos/dirs.txt";
const EXCLUDE = "s3://b/.s3cab/sets/photos/exclude.txt";
const BOBS =
  "OWNER=bob@laptop\nCLAIMED=2026-01-01T00:00:00.000Z\nCREATED=2025-06-01T00:00:00.000Z\n";
/** This user on this machine, built here rather than by the helper under test. */
const me = `${userInfo().username}@${hostname()}`;

/**
 * The marker's fields, read naively.
 * @param {string | undefined} text
 */
const fields = (text = "") =>
  Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {string[]} */
let warnings = [];
beforeEach(() => {
  savedEnv = { ...process.env };
  texts.clear();
  puts = [];
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

describe("takeover", () => {
  it("takes a set from its holder: rewrites OWNER and CLAIMED, keeps CREATED, pulls the config", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    texts.set(INFO, BOBS);
    texts.set(DIRS, "D:\\Photos\n");
    texts.set(EXCLUDE, "*.tmp\n");

    const set = await takeover("photos", [], { bucket: "b" });

    const info = fields(texts.get(INFO));
    assert.equal(info.OWNER, me);
    assert.equal(info.CREATED, "2025-06-01T00:00:00.000Z");
    assert.match(info.CLAIMED ?? "", /^\d{4}-\d\d-\d\dT[\d:.]{12}Z$/);
    assert.notEqual(info.CLAIMED, "2026-01-01T00:00:00.000Z");
    // The pair kept here is exactly the text written to the bucket.
    assert.equal(readFileSync(set.claimPath, "utf8"), texts.get(INFO));
    assert.deepEqual(set.dirs, ["D:\\Photos"]);
    assert.equal(readFileSync(set.excludePath, "utf8"), "*.tmp\n");
    assert.match(warnings.join("\n"), /from bob@laptop/);
  });

  it("gives a marker with no CREATED, or an empty one, the new CLAIMED", async () => {
    for (const marker of [
      "OWNER=bob@laptop\nCLAIMED=2026-01-01T00:00:00.000Z\n",
      "OWNER=bob@laptop\nCLAIMED=2026-01-01T00:00:00.000Z\nCREATED=\n",
    ]) {
      await using dir = await mkTmpDir();
      useTempHome(dir.path);
      texts.clear();
      texts.set(INFO, marker);

      await takeover("photos", [], { bucket: "b" });

      const info = fields(texts.get(INFO));
      assert.match(info.CREATED ?? "", /^\d{4}-/);
      assert.equal(info.CREATED, info.CLAIMED);
    }
  });

  it("claims a set with no marker, CREATED being the moment it claimed", async () => {
    // A set another client wrote: snapshots, and neither a marker nor s3cab's
    // config. The conditional create stands in for the rewrite.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const set = await takeover("photos", [], { bucket: "b" });

    const info = fields(texts.get(INFO));
    assert.equal(info.OWNER, me);
    assert.equal(info.CREATED, info.CLAIMED);
    assert.deepEqual(set.dirs, []);
    assert.match(warnings.join("\n"), /had no holder/);
    assert.match(warnings.join("\n"), /no member directories/);
  });

  it("keeps the dirs.txt and exclude.txt this machine already has", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const here = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    writeFileSync(here.excludePath, "mine\n");
    texts.set(INFO, BOBS);
    texts.set(DIRS, "D:\\Photos\n");
    texts.set(EXCLUDE, "*.tmp\n");

    const set = await takeover("photos", [], {});

    assert.deepEqual(set.dirs, [dir.path]);
    assert.equal(readFileSync(set.excludePath, "utf8"), "mine\n");
  });

  it("does nothing on a set this machine already holds", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const here = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    const mine = `OWNER=${me}\nCLAIMED=2026-01-01T00:00:00.000Z\nCREATED=2025-06-01T00:00:00.000Z\n`;
    texts.set(INFO, mine);
    writeFileSync(here.claimPath, mine);

    await takeover("photos", [], {});

    assert.deepEqual(puts, []);
    assert.equal(texts.get(INFO), mine);
    assert.match(warnings.join("\n"), /already holds 'photos'/);
  });
});
