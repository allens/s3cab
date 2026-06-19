import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { list } from "./list.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// The `list` command's --remote path lists S3, so its real coverage is the
// gated remote.test.mjs (listRemoteSnapshots) + the e2e suite. Without S3, the
// testable bit is that --remote routes through the cloud-set front door:
// bucket-less sets stop with the bind-bucket command. Temp-home pattern as in
// sets.test.mjs. (The local listing core, listSnapshotNames, is unit-tested in
// snapshot-file.test.mjs.)
/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("list --remote", () => {
  it("stops with the bind-bucket command for a bucket-less set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: [join(dir.path, "photos")] });

    await assert.rejects(
      () => list("photos", { remote: true }),
      /no bucket bound[\s\S]*s3cab setup photos --bucket/,
    );
  });
});
