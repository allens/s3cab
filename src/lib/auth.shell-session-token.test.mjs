import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { resolveCredentials } from "./auth.mjs";
import { updateEnvFile } from "./env-file.mjs";
import { loadSet } from "./env.mjs";
import { writeSet } from "./sets.mjs";

// `applyEnv`'s rule that a set's keys replace the shell's credentials, here an
// exported AWS_SESSION_TOKEN.
//
// One case per file: auth.mjs builds its chain once, and the chain keeps the
// first credentials it resolves (auth.shell-profile.test.mjs and
// auth.shell-keys.test.mjs are the others).

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const SHELL_TOKEN = "IQoJb3JpZ2luX2VjSHELLSESSIONTOKEN";

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
  it("sends no session token the shell exported for another sign-in", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir.path, "no-credentials");
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    // The shell: temporary AWS credentials, exported.
    process.env.AWS_ACCESS_KEY_ID = "ASIASHELLSHELLSHELL0";
    process.env.AWS_SECRET_ACCESS_KEY = "shell-secret";
    process.env.AWS_SESSION_TOKEN = SHELL_TOKEN;
    // The set: keys for a provider that isn't AWS, as `provider --keys` saves them.
    const { envPath } = writeSet("photos", { dirs: [dir.path], bucket: "b" });
    updateEnvFile(envPath, {
      AWS_ENDPOINT_URL_S3: "https://provider.example",
      AWS_ACCESS_KEY_ID: "AKIASETSETSETSETSET0",
      AWS_SECRET_ACCESS_KEY: "set-secret",
    });

    loadSet("photos");
    const credentials = await resolveCredentials();

    assert.equal(credentials.accessKeyId, "AKIASETSETSETSETSET0");
    assert.equal(
      credentials.sessionToken,
      undefined,
      "the shell's session token goes to the set's endpoint",
    );
  });
});
