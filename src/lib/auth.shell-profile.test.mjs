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

// A set's credentials replace the shell's rather than merge with them: an
// exported AWS_PROFILE would otherwise win over the set's saved keys, since the
// SDK's chain takes a profile over keys in the environment, and the set would
// sign in as that profile at its own endpoint.
//
// One case per file: auth.mjs builds its chain once, and the chain keeps the
// first credentials it resolves (auth.shell-session-token.test.mjs is the other).

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

describe("a set that has saved access keys", () => {
  it("signs in with them when the shell exports AWS_PROFILE", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // The shell: a profile for other work, exported.
    const credentials = join(dir.path, "credentials");
    writeFileSync(
      credentials,
      `[work]\naws_access_key_id = ${SHELL_KEY}\naws_secret_access_key = shell-secret\n`,
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentials;
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    process.env.AWS_PROFILE = "work";
    // The set: keys for a provider that isn't AWS, as `provider --keys` saves them.
    const { envPath } = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    updateEnvFile(envPath, {
      AWS_ENDPOINT_URL_S3: "https://provider.example",
      AWS_ACCESS_KEY_ID: SET_KEY,
      AWS_SECRET_ACCESS_KEY: "set-secret",
    });

    loadSet("photos");
    const { accessKeyId } = await resolveCredentials();

    assert.equal(
      accessKeyId,
      SET_KEY,
      `signed in with another key, while s3cab reports: ${credentialsUsed()}`,
    );
  });
});
