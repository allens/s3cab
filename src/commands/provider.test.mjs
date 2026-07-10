import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseEnvFile, userEnvPath } from "../lib/env.mjs";
import { readSet, writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the `provider` command (né `auth`, ADR-0047). Purely local: each
// test points S3CAB_HOME at a temp dir (useTempHome) and asserts on the bytes
// left in the scope's env file. Profile validation reads the real ~/.aws, so
// the set-profile tests redirect AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE
// at fixtures to stay deterministic. The `--keys` prompts are mocked at the
// prompt.mjs seam (the delete.test.mjs pattern), with process.stdin.isTTY poked
// to drive the interactive-vs-piped fork.

/** @type {string[]} Queued replies for the mocked promptLine, in call order. */
let promptLines = [];
/** @type {string[]} Queued replies for the mocked promptHidden. */
let hiddenLines = [];
mock.module("../lib/prompt.mjs", {
  exports: {
    promptLine: async () => promptLines.shift() ?? "",
    promptHidden: async () => hiddenLines.shift() ?? "",
    stdinLines: async (/** @type {number} */ count) =>
      promptLines.splice(0, count),
  },
});

const { provider } = await import("./provider.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// isInteractive() reads .isTTY off the stream; poke it directly to drive the gate.
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
/** @type {boolean | undefined} */
let savedTTY;

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedTTY = stdin.isTTY;
  promptLines = [];
  hiddenLines = [];
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
 * Capture console.warn for one test (t.mock auto-restores). `provider`'s
 * *result* is its return value (ADR-0043) — tests assert on that directly; only
 * the profile-typo notice still goes to stderr via `console.warn`.
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

describe("provider --profile", () => {
  it("writes AWS_PROFILE to the user env for the default scope", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    const warn = captureWarn(t);

    const out = await provider(undefined, { profile: "work" });

    assert.equal(parseEnvFile(userEnvPath()).AWS_PROFILE, "work");
    assert.match(out, /Set AWS profile 'work' for the default \(all backups\)/);
    assert.equal(warn(), ""); // a known profile warns nothing
  });

  it("warns but still writes when the profile is unknown", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    const warn = captureWarn(t);

    await provider(undefined, { profile: "bert" });

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

    await provider("photos", { profile: "work" });

    const env = parseEnv(readFileSync(readSet("photos").envPath, "utf8"));
    assert.equal(env.AWS_PROFILE, "work");
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // untouched
  });

  it("rejects an empty profile name, pointing at --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider(undefined, { profile: "  " }),
      /Give a profile name.*--unset profile/s,
    );
  });

  it("rejects a setter together with --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider(undefined, { profile: "work", unset: "profile" }),
      /--unset on its own/,
    );
  });

  it("errors on an unknown set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider("nope", { profile: "work" }),
      /Unknown backup set: nope/,
    );
  });
});

describe("provider --endpoint / --region", () => {
  it("writes the endpoint and region together, to the SDK-native vars", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const out = await provider(undefined, {
      endpoint: "https://accountid.r2.cloudflarestorage.com",
      region: "auto",
    });

    const env = parseEnvFile(userEnvPath());
    assert.equal(
      env.AWS_ENDPOINT_URL_S3,
      "https://accountid.r2.cloudflarestorage.com",
    );
    assert.equal(env.AWS_REGION, "auto");
    assert.match(
      out,
      /Set endpoint https:\/\/accountid\.r2\.cloudflarestorage\.com, region auto for the default/,
    );
  });

  it("scopes the endpoint to a set when one is named", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });

    await provider("photos", { endpoint: "https://s3.example.com" });

    const env = parseEnv(readFileSync(readSet("photos").envPath, "utf8"));
    assert.equal(env.AWS_ENDPOINT_URL_S3, "https://s3.example.com");
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // untouched
  });

  it("rejects an endpoint that isn't an http(s) URL", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    for (const endpoint of ["accountid.r2.cloudflarestorage.com", "ftp://x"]) {
      await assert.rejects(
        () => provider(undefined, { endpoint }),
        /Give the endpoint as a full URL/,
      );
    }
  });

  it("rejects an empty region, pointing at --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider(undefined, { region: " " }),
      /Give a region.*--unset region/s,
    );
  });
});

describe("provider --keys", () => {
  it("reads two stdin lines when not at a terminal and writes both keys", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    stdin.isTTY = false;
    promptLines = ["AKIAEXAMPLE", "sooper-secret"];

    const out = await provider(undefined, { keys: true });

    const env = parseEnvFile(userEnvPath());
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "sooper-secret");
    // The key-ID tail answers "which key?"; the secret never appears.
    assert.match(out, /Set access keys \(…MPLE\) for the default/);
    assert.doesNotMatch(out, /sooper-secret/);
  });

  it("prompts (secret hidden) at a terminal", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    stdin.isTTY = true;
    promptLines = ["AKIAEXAMPLE"];
    hiddenLines = ["sooper-secret"];

    await provider(undefined, { keys: true });

    const env = parseEnvFile(userEnvPath());
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "sooper-secret");
  });

  it("rejects when either value is missing (closed stdin, empty entry)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    stdin.isTTY = false;
    promptLines = ["AKIAEXAMPLE"]; // no second line — EOF yields ""

    await assert.rejects(
      () => provider(undefined, { keys: true }),
      /access key ID and a secret/,
    );
  });

  it("combines with --endpoint/--region in one call (the onboarding shape)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    stdin.isTTY = false;
    promptLines = ["id", "secret"];

    const out = await provider(undefined, {
      endpoint: "https://s3.example.com",
      region: "auto",
      keys: true,
    });

    const env = parseEnvFile(userEnvPath());
    assert.equal(env.AWS_ENDPOINT_URL_S3, "https://s3.example.com");
    assert.equal(env.AWS_REGION, "auto");
    assert.equal(env.AWS_ACCESS_KEY_ID, "id");
    assert.match(out, /endpoint .*region auto.*access keys/s);
  });
});

describe("provider --unset", () => {
  it("removes the AWS_PROFILE line, preserving the bucket", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
    captureWarn(t);
    await provider("photos", { profile: "work" });

    const out = await provider("photos", { unset: "profile" });

    assert.match(out, /Cleared the AWS profile for set 'photos'\./);
    const env = parseEnv(readFileSync(readSet("photos").envPath, "utf8"));
    assert.equal(env.AWS_PROFILE, undefined); // gone
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // preserved
  });

  it("unsets both endpoint spellings and both key halves", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    mkdirSync(dirname(userEnvPath()), { recursive: true });
    writeFileSync(
      userEnvPath(),
      "AWS_ENDPOINT_URL_S3=https://a\nAWS_ENDPOINT_URL=https://b\n" +
        "AWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=secret\n",
    );

    await provider(undefined, { unset: "endpoint" });
    const out = await provider(undefined, { unset: "keys" });

    assert.match(out, /Cleared the access keys for the default/);
    assert.equal(readFileSync(userEnvPath(), "utf8").trim(), "");
  });

  it("rejects an unknown setting name, listing the real ones", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider(undefined, { unset: "bucket" }),
      /Unknown setting to unset: bucket.*profile, endpoint, region, keys/s,
    );
  });
});

describe("provider (show)", () => {
  /** The knobs the shell-env note reads; cleared for hermetic empty-scope tests. */
  const SHELL_VARS = [
    "AWS_PROFILE",
    "AWS_ENDPOINT_URL_S3",
    "AWS_ENDPOINT_URL",
    "AWS_ACCESS_KEY_ID",
  ];

  it("reports nothing configured for the default scope, pointing both ways in", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    for (const name of SHELL_VARS) {
      delete process.env[name]; // restored by afterEach
    }

    const out = await provider(undefined, {});

    assert.match(out, /No default provider configured/);
    assert.match(out, /s3cab provider --profile <name>/); // the AWS way in
    assert.match(out, /s3cab help provider/); // the non-AWS way in
    assert.doesNotMatch(out, /shell environment/); // nothing ambient to report
  });

  it("notes shell-environment auth so an empty file doesn't read as broken", async () => {
    // Backups can work entirely off shell AWS_* vars; "no provider configured"
    // alone would then be a false alarm.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    for (const name of SHELL_VARS) {
      delete process.env[name];
    }
    process.env.AWS_PROFILE = "work";
    process.env.AWS_ENDPOINT_URL = "https://s3.example";

    const out = await provider(undefined, {});

    assert.match(out, /No default provider configured/);
    assert.match(
      out,
      /shell environment sets AWS_PROFILE=work, an endpoint \(https:\/\/s3\.example\)/,
    );
    assert.match(out, /unless a file overrides it/);
  });

  it("reports profile, endpoint, region, and key presence at the default scope", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // 'work' exists → healthy, no diagnostic line
    mkdirSync(dirname(userEnvPath()), { recursive: true });
    writeFileSync(
      userEnvPath(),
      "AWS_PROFILE=work\nAWS_ENDPOINT_URL=https://example.r2\n" +
        "AWS_REGION=auto\nAWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=hunter2\n",
    );

    const out = await provider(undefined, {});

    // The legible query-noun form, and no broken-profile diagnostic.
    assert.match(out, /Default AWS profile: work/);
    assert.match(
      out,
      /AWS endpoint for the default \(all backups\): https:\/\/example\.r2/,
    );
    assert.match(out, /AWS region for the default \(all backups\): auto/);
    // Key presence + the ID tail ("which key?"), never the secret.
    assert.match(
      out,
      /Access keys for the default \(all backups\): set \(…id\)/,
    );
    assert.doesNotMatch(out, /hunter2/);
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

    const out = await provider("photos", {});

    assert.match(out, /AWS profile for set 'photos': work/);
    assert.doesNotMatch(out, /Not in your AWS config/);
  });

  it("flags a profile that isn't in the AWS config when looking (default scope)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    mkdirSync(dirname(userEnvPath()), { recursive: true });
    writeFileSync(userEnvPath(), "AWS_PROFILE=s3cab-test\n");

    const out = await provider(undefined, {});

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

    const out = await provider("photos", {});

    assert.match(out, /AWS profile for set 'photos': s3cab-test/);
    assert.match(out, /Not in your AWS config — no credentials to use/);
    assert.match(out, /aws configure --profile s3cab-test/);
  });

  it("reports a set with no override falls back to the user default", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });

    const out = await provider("photos", {});

    assert.match(out, /uses the user default/);
    assert.match(out, /s3cab provider --profile <name> photos/); // set-scoped fix
  });
});
