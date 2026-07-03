import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listProfiles } from "./aws-profiles.mjs";

// Tests for reading AWS shared-config profile names. No mocking: we point the
// SDK's AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE overrides at fixture files
// in a temp dir, so the real parser runs against real bytes.

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

describe("listProfiles", () => {
  it("merges config + credentials and strips the '[profile X]' prefix, sorted", async () => {
    await using dir = await mkTmpDir();
    const cfg = join(dir.path, "config");
    const creds = join(dir.path, "credentials");
    writeFileSync(
      cfg,
      "[profile work]\nregion = eu-west-1\n[default]\nregion = us-east-1\n",
    );
    writeFileSync(creds, "[personal]\naws_access_key_id = AKIA...\n");
    process.env.AWS_CONFIG_FILE = cfg;
    process.env.AWS_SHARED_CREDENTIALS_FILE = creds;

    assert.deepEqual(await listProfiles(), ["default", "personal", "work"]);
  });

  it("returns [] when the config files don't exist", async () => {
    await using dir = await mkTmpDir();
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir.path, "no-creds");

    assert.deepEqual(await listProfiles(), []);
  });
});
