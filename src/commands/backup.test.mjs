import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { backup } from "./backup.mjs";

// `backup`'s upload path needs a real bucket, so it is exercised end-to-end by
// the gated round-trip in lib/remote.test.mjs (uploadSnapshot) and the e2e
// suite. What is testable without S3 is the front-door guard: a bucket-less set
// can't be backed up. Same temp-home pattern as sets.test.mjs.
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

/** @param {string} root */
function useTempHome(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

describe("backup", () => {
  it("stops with the bind-bucket command when the set has no bucket", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: [join(dir.path, "photos")] });

    await assert.rejects(
      () => backup("photos"),
      /no bucket bound[\s\S]*s3cab setup photos --bucket/,
    );
  });
});
