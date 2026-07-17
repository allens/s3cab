import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSet, writeSet } from "../lib/sets.mjs";
import { list } from "./list.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the list command (docs/design/backup.md, ADR-0036, ADR-0043). All
// offline: the local-snapshot paths (every set, a named set, --latest) need no
// network. list returns *data* now (the render layer turns it into text —
// render.test.mjs pins that), so these assert the returned shape. The --remote
// path lists S3 and is covered by the gated suites. The set store keeps no module
// state, so each test points S3CAB_HOME at a temp dir.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

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
 * Create a set on disk with the given snapshot names — drops empty `.tsv.zst`
 * files into the set's snapshot dir, which is all `list` reads to name them.
 * @param {string} name
 * @param {string[]} dirs
 * @param {string} bucket
 * @param {string[]} snapshots - snapshot names, e.g. `2026-06-12T0915`
 */
function seedSet(name, dirs, bucket, snapshots) {
  const set = writeSet(name, { dirs, bucket });
  mkdirSync(set.snapshotsDir, { recursive: true });
  for (const snap of snapshots) {
    writeFileSync(join(set.snapshotsDir, `${snap}.tsv.zst`), "");
  }
}

describe("list", () => {
  it("returns an empty summary when there are no sets yet", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const result = await list();

    assert.deepEqual(result, { mode: "summary", sets: [] });
  });

  it("returns every set with its snapshot times, newest first", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", [
      "2026-06-11T0915",
      "2026-06-12T0915",
    ]);
    seedSet("docs", ["/data/docs"], "my-bucket", ["2026-05-12T0946"]);

    const result = await list();

    assert.equal(result.mode, "summary");
    assert(result.mode === "summary");
    // Sorted by set name (listSets order); snapshots newest first.
    assert.deepEqual(result.sets, [
      { name: "docs", snapshots: ["2026-05-12T0946"] },
      { name: "photos", snapshots: ["2026-06-12T0915", "2026-06-11T0915"] },
    ]);
  });

  it("returns an empty snapshot list for a set with no snapshots", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("empty", ["/data/empty"], "my-bucket", []);

    const result = await list();

    assert(result.mode === "summary");
    assert.deepEqual(result.sets, [{ name: "empty", snapshots: [] }]);
  });

  it("with --latest narrows each set to its most recent snapshot", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", [
      "2026-06-11T0915",
      "2026-06-12T0915",
    ]);

    const result = await list(undefined, { latest: true });

    assert(result.mode === "summary");
    assert.deepEqual(result.sets, [
      { name: "photos", snapshots: ["2026-06-12T0915"] },
    ]);
  });

  it("returns a named set in detail — its config and snapshots", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("docs", ["/data/docs"], "my-bucket", ["2026-05-12T0946"]);
    seedSet("photos", ["/data/photos"], "other-bucket", ["2026-06-12T0915"]);

    const result = await list("docs");

    assert(result.mode === "detail");
    assert.equal(result.remote, false);
    assert.equal(result.set.name, "docs");
    assert.equal(result.set.bucket, "my-bucket");
    assert.deepEqual(result.set.dirs, ["/data/docs"]);
    // The config paths the detail view surfaces are the named set's own.
    assert.match(result.set.dirsPath, /docs.dirs\.txt$/);
    assert.match(result.set.excludePath, /docs.exclude\.txt$/);
    assert.deepEqual(result.snapshots, ["2026-05-12T0946"]);
    // The set env carries only its bucket → no provider overrides.
    assert.deepEqual(result.overrides, {
      profile: undefined,
      endpoint: undefined,
      region: undefined,
      keyId: undefined,
      rolesAnywhere: false,
    });
  });

  it("surfaces the set's provider overrides, never the secret", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("docs", ["/data/docs"], "my-bucket", []);
    writeFileSync(
      readSet("docs").envPath,
      "AWS_PROFILE=work\nAWS_ENDPOINT_URL=https://s3.example\n" +
        "AWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=hunter2\n",
      { flag: "a" },
    );

    const result = await list("docs");

    assert(result.mode === "detail");
    assert.deepEqual(result.overrides, {
      profile: "work",
      endpoint: "https://s3.example", // the _S3 ?? plain fallback, one spelling
      region: undefined,
      keyId: "id", // the ID names the key —
      rolesAnywhere: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /hunter2/); // — never the secret
  });

  it("reports Roles Anywhere as the set's sign-in mode", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("docs", ["/data/docs"], "my-bucket", []);
    writeFileSync(readSet("docs").envPath, "S3CAB_RA=1\n", { flag: "a" });

    const result = await list("docs");

    assert(result.mode === "detail");
    assert.equal(result.overrides.rolesAnywhere, true);
  });

  it("rejects an unknown named set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", []);

    await assert.rejects(() => list("nope"), /Unknown backup set: nope/);
  });
});
