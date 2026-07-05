import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import { auth } from "./auth.mjs";
import { parseEnvFile, userEnvPath } from "../lib/env.mjs";
import { readSet, writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the `auth` command (né `profile`, ADR-0041). Purely local: each test points S3CAB_HOME at a
// temp dir (useTempHome) and asserts on the bytes left in the scope's env file.
// Profile validation reads the real ~/.aws, so the set-profile tests redirect
// AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE at fixtures to stay deterministic.

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
 * Point the SDK's config readers at a fixture so validation is deterministic.
 * Sections need at least one key — the INI parser drops empty ones.
 * @param {string} root
 * @param {string} [body]
 */
function useAwsConfig(
  root,
  body = "[profile work]\nregion = eu-west-1\n[default]\nregion = us-east-1\n",
) {
  const cfg = join(root, "aws-config");
  writeFileSync(cfg, body);
  process.env.AWS_CONFIG_FILE = cfg;
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(root, "no-credentials");
}

/**
 * Capture console.warn for one test (t.mock auto-restores). `auth`'s *result* is
 * its return value now (ADR-0043) — tests assert on that directly; only the
 * profile-typo notice still goes to stderr via `console.warn`.
 * @param {import("node:test").TestContext} t
 */
function captureWarn(t) {
  /** @type {string[]} */
  const warn = [];
  t.mock.method(console, "warn", (/** @type {unknown[]} */ ...args) => {
    warn.push(args.join(" "));
  });
  return () => warn.join("\n");
}

describe("auth --profile", () => {
  it("writes AWS_PROFILE to the user env for the default scope", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    const warn = captureWarn(t);

    const out = await auth(undefined, { profile: "work" });

    assert.equal(parseEnvFile(userEnvPath()).AWS_PROFILE, "work");
    assert.match(out, /Set AWS profile 'work' for the default \(all backups\)/);
    assert.equal(warn(), ""); // a known profile warns nothing
  });

  it("warns but still writes when the profile is unknown", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    const warn = captureWarn(t);

    await auth(undefined, { profile: "bert" });

    assert.equal(parseEnvFile(userEnvPath()).AWS_PROFILE, "bert"); // written anyway
    assert.match(warn(), /AWS profile 'bert' isn't in your AWS config/);
    assert.match(warn(), /default, work/); // available profiles, sorted
  });

  it("writes AWS_PROFILE to a named set's env, preserving its bucket", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
    captureWarn(t);

    await auth("photos", { profile: "work" });

    const env = parseEnv(readFileSync(readSet("photos").envPath, "utf8"));
    assert.equal(env.AWS_PROFILE, "work");
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // untouched
  });

  it("rejects an empty profile name, pointing at --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => auth(undefined, { profile: "  " }),
      /Give a profile name.*--unset/s,
    );
  });

  it("rejects --profile together with --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => auth(undefined, { profile: "work", unset: true }),
      /not both/,
    );
  });

  it("errors on an unknown set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => auth("nope", { profile: "work" }),
      /Unknown backup set: nope/,
    );
  });
});

describe("auth --unset", () => {
  it("removes the AWS_PROFILE line, preserving the bucket", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
    captureWarn(t);
    await auth("photos", { profile: "work" });

    const out = await auth("photos", { unset: true });

    assert.match(out, /Cleared the AWS profile for set 'photos'\./);
    const env = parseEnv(readFileSync(readSet("photos").envPath, "utf8"));
    assert.equal(env.AWS_PROFILE, undefined); // gone
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // preserved
  });
});

describe("auth (show)", () => {
  it("reports nothing set for the default scope", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const out = await auth(undefined, {});

    assert.match(out, /No default AWS profile set/);
    assert.match(out, /s3cab auth --profile <name>/); // constructive fix
  });

  it("reports the profile (name:value) and endpoint set at the default scope", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // 'work' exists → healthy, no diagnostic line
    mkdirSync(dirname(userEnvPath()), { recursive: true });
    writeFileSync(
      userEnvPath(),
      "AWS_PROFILE=work\nAWS_ENDPOINT_URL=https://example.r2\n",
    );

    const out = await auth(undefined, {});

    // The legible query-noun form, and no broken-profile diagnostic.
    assert.match(out, /Default AWS profile: work/);
    assert.match(
      out,
      /AWS endpoint for the default \(all backups\): https:\/\/example\.r2/,
    );
    assert.doesNotMatch(out, /Not in your AWS config/);
  });

  it("shows a set's own profile with the set-named query noun", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // 'work' exists → healthy
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
    writeFileSync(readSet("photos").envPath, "AWS_PROFILE=work\n", {
      flag: "a",
    });

    const out = await auth("photos", {});

    assert.match(out, /AWS profile for set 'photos': work/);
    assert.doesNotMatch(out, /Not in your AWS config/);
  });

  it("flags a profile that isn't in the AWS config when looking (default scope)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    mkdirSync(dirname(userEnvPath()), { recursive: true });
    writeFileSync(userEnvPath(), "AWS_PROFILE=s3cab-test\n");

    const out = await auth(undefined, {});

    assert.match(out, /Default AWS profile: s3cab-test/);
    assert.match(out, /Not in your AWS config — no credentials to use/);
    assert.match(out, /aws configure --profile s3cab-test/);
  });

  it("flags a broken profile at a set scope too", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
    writeFileSync(readSet("photos").envPath, "AWS_PROFILE=s3cab-test\n", {
      flag: "a",
    });

    const out = await auth("photos", {});

    assert.match(out, /AWS profile for set 'photos': s3cab-test/);
    assert.match(out, /Not in your AWS config — no credentials to use/);
    assert.match(out, /aws configure --profile s3cab-test/);
  });

  it("reports a set with no override falls back to the user default", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });

    const out = await auth("photos", {});

    assert.match(out, /uses the user default/);
    assert.match(out, /s3cab auth --profile <name> photos/); // set-scoped fix
  });
});
