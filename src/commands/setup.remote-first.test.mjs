import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// `setup` update is remote-first (push config, *then* commit local) so a creds
// failure mid-update leaves no local-ahead-of-cloud drift. Proving that needs the
// remote push to *fail*, so this file mocks the s3.mjs seam (per
// docs/design/testing.md) with `putData` throwing — it can't share
// setup.integration.test.mjs, whose gated real-bucket suite needs the real
// s3.mjs. The mock is registered
// before the dynamic import of setup.mjs (the load-bearing ordering rule from
// objects.test.mjs); the runner needs `--experimental-test-module-mocks`.
mock.module("../lib/s3.mjs", {
  exports: {
    putData: async () => {
      throw new Error("boom: remote push failed");
    },
    getData: async () => undefined,
    deleteObject: async () => {},
    listObjects: async function* () {},
    createS3ReadStream: () => {},
    downloadToFile: async () => {},
    putFile: async () => true,
  },
});
const { setup } = await import("./setup.mjs");
const { readSet, writeSet } = await import("../lib/sets.mjs");

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

describe("setup update (remote-first ordering)", () => {
  it("a failed remote push leaves the local dirs.txt unchanged", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const oldDir = realpathSync.native(dir.path);
    const newDir = join(dir.path, "added");
    mkdirSync(newDir, { recursive: true });

    // A set exists locally, backing up to a bucket.
    writeSet("photos", { dirs: [oldDir], bucket: "my-bucket" });

    // Updating its directories pushes config first; the mocked push throws, so
    // the local write never happens.
    await assert.rejects(
      () => setup("photos", [newDir], {}),
      /boom: remote push failed/,
    );

    // Local dirs.txt is untouched — no local-ahead-of-cloud drift.
    assert.deepEqual(readSet("photos").dirs, [oldDir]);
  });
});
