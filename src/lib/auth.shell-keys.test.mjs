import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { credentialsUsed, resolveCredentials } from "./auth.mjs";
import { updateEnvFile } from "./env-file.mjs";
import { loadSet } from "./env.mjs";
import { writeSet } from "./sets.mjs";

// `applyEnv` leaves the shell's keys beside a set's profile, so this pins the
// SDK order that relies on: under a profile, keys in the environment are
// ignored. The SDK warns that a future version may flip it; if one does, this
// fails.
//
// One case per file: auth.mjs builds its chain once, and the chain keeps the
// first credentials it resolves (auth.shell-profile.test.mjs and
// auth.shell-session-token.test.mjs are the others).

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const SET_KEY = "AKIASETSETSETSETSET0";
const SHELL_KEY = "AKIASHELLSHELLSHELL0";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("AWS_")) {
      delete process.env[name];
    }
  }
  mock.method(console, "warn", () => {});
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

describe("a set that names a profile", () => {
  it("signs in as the profile when the shell exports keys", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // The set's profile, in a credentials file of its own.
    const credentials = join(dir.path, "credentials");
    writeFileSync(
      credentials,
      `[work]\naws_access_key_id = ${SET_KEY}\naws_secret_access_key = set-secret\n`,
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentials;
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    // The shell: keys for something else, exported.
    process.env.AWS_ACCESS_KEY_ID = SHELL_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "shell-secret";
    const { envPath } = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    updateEnvFile(envPath, { AWS_PROFILE: "work" });

    loadSet("photos");
    const { accessKeyId } = await resolveCredentials();

    assert.equal(
      accessKeyId,
      SET_KEY,
      `signed in with the shell's key, while s3cab reports: ${credentialsUsed()}`,
    );
  });
});
