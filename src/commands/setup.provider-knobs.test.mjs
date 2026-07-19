import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseEnvFile } from "../lib/env.mjs";
import { listSets, readSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// setup's provider-knob flow (ADR-0055): the knobs populate the environment for
// the remote claim (a set's credentials can't be configured before it exists) and
// are persisted to the new set's env on a win. set-marker is mocked so the claim
// outcome is controllable without a real bucket, and it snapshots the environment
// it saw so we can assert the populate; prompt is mocked for `--keys`.

let claimWins = true;
/** @type {NodeJS.ProcessEnv | undefined} the environment the claim saw. */
let envAtClaim;
mock.module("../lib/set-marker.mjs", {
  exports: {
    claimRemoteSet: async () => {
      envAtClaim = { ...process.env };
      return claimWins;
    },
    readRemoteInfo: async () => ({
      owner: "someone-else",
      created: "2026-01-01T0000",
    }),
    pushSetConfig: async () => {},
  },
});

/** @type {string[]} Queued replies for the mocked key prompts. */
let promptLines = [];
mock.module("../lib/prompt.mjs", {
  exports: {
    promptLine: async () => promptLines.shift() ?? "",
    promptHidden: async () => promptLines.shift() ?? "",
    stdinLines: async (/** @type {number} */ n) => promptLines.splice(0, n),
  },
});

const { setup } = await import("./setup.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
/** @type {boolean | undefined} */
let savedTTY;
/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedTTY = stdin.isTTY;
  claimWins = true;
  envAtClaim = undefined;
  promptLines = [];
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  stdin.isTTY = savedTTY;
});

/** @param {string} root */
function withMemberDir(root) {
  const home = useTempHome(root);
  const photos = join(root, "photos");
  mkdirSync(photos, { recursive: true });
  return { home, photos };
}

describe("setup provider knobs", () => {
  it("populates the environment for the claim and persists non-AWS keys on a win", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);
    stdin.isTTY = false; // --keys reads two piped lines
    promptLines = ["AKIAEXAMPLE", "sooper-secret"];

    await setup([photos], {
      set: "photos",
      bucket: "my-bucket",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      keys: true,
    });

    // The claim saw the endpoint + keys, so it could authenticate the first touch.
    assert.equal(
      envAtClaim?.AWS_ENDPOINT_URL_S3,
      "https://acct.r2.cloudflarestorage.com",
    );
    assert.equal(envAtClaim?.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    // And they're persisted to the new set's env for later commands.
    const env = parseEnvFile(readSet("photos").envPath);
    assert.equal(
      env.AWS_ENDPOINT_URL_S3,
      "https://acct.r2.cloudflarestorage.com",
    );
    assert.equal(env.AWS_REGION, "auto");
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "sooper-secret");
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // the bucket too
  });

  it("populates and persists an AWS profile on a win", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);
    // Redirect the AWS config so the profile is known (no typo warning).
    const cfg = join(dir.path, "aws-config");
    writeFileSync(cfg, "[profile work]\nregion = eu-west-1\n");
    process.env.AWS_CONFIG_FILE = cfg;
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir.path, "none");

    await setup([photos], {
      set: "photos",
      bucket: "my-bucket",
      profile: "work",
    });

    assert.equal(envAtClaim?.AWS_PROFILE, "work");
    assert.equal(parseEnvFile(readSet("photos").envPath).AWS_PROFILE, "work");
  });

  it("persists nothing on a lost claim — no set is created locally", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);
    claimWins = false;
    stdin.isTTY = false;
    promptLines = ["AKIAEXAMPLE", "sooper-secret"];

    await assert.rejects(
      () =>
        setup([photos], {
          set: "photos",
          bucket: "my-bucket",
          endpoint: "https://acct.r2.cloudflarestorage.com",
          keys: true,
        }),
      /already set up in bucket/,
    );
    // The claim ran with the gathered creds, but nothing was written locally.
    assert.equal(envAtClaim?.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(listSets().includes("photos"), false);
  });
});
