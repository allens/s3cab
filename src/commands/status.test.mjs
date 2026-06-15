import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { status } from "./status.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// `status`'s remote diff needs a real bucket, so it is exercised end-to-end by
// the e2e suite. Testable without S3 is the read-only guard reached before any
// S3 call: a set with a bucket but no local snapshot yet. Same temp-home
// pattern as sets.test.mjs.
const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

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

describe("status", () => {
  it("tells you to snapshot first when the set has no local snapshot", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: [join(dir.path, "photos")], bucket: "b" });

    await assert.rejects(
      () => status("photos"),
      /No snapshot yet[\s\S]*s3cab snapshot photos/,
    );
  });
});
