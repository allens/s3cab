import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MissingArgError } from "../lib/error.mjs";
import { writeSet } from "../lib/sets.mjs";
import { find } from "./find.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";

// Tests for the find *command* — which sets get searched and what a bad
// invocation says. The matching and the scan itself are lib/find.test.mjs's;
// what is command-shaped here is set resolution (ADR-0011 puts validation in the
// command function) and the every-attached-set default.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const BASE = resolve("/data");

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A set holding one snapshot with one file called `secret1`.
 * @param {string} name
 * @param {string} bucket
 */
async function seedSet(name, bucket) {
  const set = writeSet(name, { dirs: [BASE], bucket });
  mkdirSync(set.snapshotsDir, { recursive: true });
  await writeSnapshot(
    set.snapshotsDir,
    "2026-06-11T0915",
    [new File([name], `${name}/secret1`, { lastModified: 1_500_000_000_000 })],
    BASE,
  );
}

describe("find", () => {
  it("searches every attached set by default", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await seedSet("photos", "photo-bucket");
    await seedSet("work", "work-bucket");

    const result = await find(["secret1"]);

    assert.deepEqual(
      result.searched.map(({ name, bucket }) => [name, bucket]),
      [
        ["photos", "photo-bucket"],
        ["work", "work-bucket"],
      ],
    );
    assert.deepEqual(
      result.files.map(({ path }) => path),
      [resolve(BASE, "photos/secret1"), resolve(BASE, "work/secret1")],
    );
  });

  it("narrows to one set with --set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await seedSet("photos", "photo-bucket");
    await seedSet("work", "work-bucket");

    const result = await find(["secret1"], { set: "work" });

    assert.deepEqual(
      result.searched.map(({ name }) => name),
      ["work"],
    );
    assert.deepEqual(
      result.files.map(({ path }) => path),
      [resolve(BASE, "work/secret1")],
    );
  });

  it("names the sets that exist when --set names one that doesn't", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await seedSet("photos", "photo-bucket");

    await assert.rejects(find(["secret1"], { set: "typo" }), {
      message: /Unknown backup set: typo[\s\S]*photos/,
    });
  });

  it("asks for a pattern when given none", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await seedSet("photos", "photo-bucket");

    await assert.rejects(find([]), MissingArgError);
  });

  it("points a user with no sets at setup", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(find(["secret1"]), {
      message: /No backup sets yet[\s\S]*s3cab setup/,
    });
  });
});
