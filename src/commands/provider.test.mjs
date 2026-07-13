import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseEnvFile } from "../lib/env.mjs";
import { readSet, writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the `provider` command (né `auth`, ADR-0047). Purely local: each test
// points S3CAB_HOME at a temp dir (useTempHome), creates a set, and asserts on the
// bytes left in that set's env file — the single config scope now the user layer
// is gone (ADR-0055). Omitting the set name takes the sole-set default for a write
// and summarizes all sets for a bare show. Profile validation reads the real
// ~/.aws, so the profile tests redirect AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE
// at fixtures to stay deterministic. The `--keys` prompts are mocked at the
// prompt.mjs seam (the delete.test.mjs pattern), with process.stdin.isTTY poked to
// drive the interactive-vs-piped fork.

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

// Create a backup set (bound to a bucket, as ADR-0026 requires) so `provider` has
// a scope to target — the sole one, unless a test makes more.
/** @param {string} [name] @param {string} [bucket] */
function makeSet(name = "photos", bucket = "my-bucket") {
  writeSet(name, { dirs: ["/data/photos"], bucket });
}

/** The values a set's env file holds after `provider` writes it. @param {string} [name] */
const setEnv = (name = "photos") => parseEnvFile(readSet(name).envPath);

/** Append raw lines to a set's env file (to arrange a show-mode fixture). */
const seedSetEnv = (/** @type {string} */ name, /** @type {string} */ body) =>
  writeFileSync(readSet(name).envPath, body, { flag: "a" });

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
  it("writes AWS_PROFILE to the sole set by default", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    const warn = captureWarn(t);

    const out = await provider(undefined, { profile: "work" });

    assert.equal(setEnv().AWS_PROFILE, "work");
    assert.equal(setEnv().S3CAB_BUCKET, "my-bucket"); // untouched
    assert.match(out, /Set AWS profile 'work' for set 'photos'/);
    assert.equal(warn(), ""); // a known profile warns nothing
  });

  it("warns but still writes when the profile is unknown", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    makeSet();
    const warn = captureWarn(t);

    await provider(undefined, { profile: "bert" });

    assert.equal(setEnv().AWS_PROFILE, "bert"); // written anyway
    assert.match(warn(), /AWS profile 'bert' isn't in your AWS config/);
    assert.match(warn(), /default, work/); // available profiles, sorted
  });

  it("writes AWS_PROFILE to a named set's env, preserving its bucket", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    captureWarn(t);

    await provider("photos", { profile: "work" });

    assert.equal(setEnv().AWS_PROFILE, "work");
    assert.equal(setEnv().S3CAB_BUCKET, "my-bucket"); // untouched
  });

  it("errors, listing the sets, when several exist and none is named", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet("photos");
    makeSet("docs");

    // A write must not silently pick a set — writing credentials to the wrong one
    // would be as bad as a missing arg (ADR-0055).
    await assert.rejects(
      () => provider(undefined, { profile: "work" }),
      /Several backup sets exist — name one/,
    );
  });

  it("rejects an empty profile name, pointing at --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();

    await assert.rejects(
      () => provider(undefined, { profile: "  " }),
      /Give a profile name.*--unset profile/s,
    );
  });

  it("rejects a setter together with --unset", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => provider("photos", { profile: "work", unset: "profile" }),
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
    makeSet();

    const out = await provider(undefined, {
      endpoint: "https://accountid.r2.cloudflarestorage.com",
      region: "auto",
    });

    const env = setEnv();
    assert.equal(
      env.AWS_ENDPOINT_URL_S3,
      "https://accountid.r2.cloudflarestorage.com",
    );
    assert.equal(env.AWS_REGION, "auto");
    assert.match(
      out,
      /Set endpoint https:\/\/accountid\.r2\.cloudflarestorage\.com, region auto for set 'photos'/,
    );
  });

  it("scopes the endpoint to a set when one is named", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();

    await provider("photos", { endpoint: "https://s3.example.com" });

    const env = setEnv();
    assert.equal(env.AWS_ENDPOINT_URL_S3, "https://s3.example.com");
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // untouched
  });

  it("rejects an endpoint that isn't an http(s) URL", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();

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
    makeSet();

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
    makeSet();
    stdin.isTTY = false;
    promptLines = ["AKIAEXAMPLE", "sooper-secret"];

    const out = await provider(undefined, { keys: true });

    const env = setEnv();
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "sooper-secret");
    // The key-ID tail answers "which key?"; the secret never appears.
    assert.match(out, /Set access keys \(…MPLE\) for set 'photos'/);
    assert.doesNotMatch(out, /sooper-secret/);
  });

  it("prompts (secret hidden) at a terminal", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
    stdin.isTTY = true;
    promptLines = ["AKIAEXAMPLE"];
    hiddenLines = ["sooper-secret"];

    await provider(undefined, { keys: true });

    const env = setEnv();
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "sooper-secret");
  });

  it("rejects when either value is missing (closed stdin, empty entry)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
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
    makeSet();
    stdin.isTTY = false;
    promptLines = ["id", "secret"];

    const out = await provider(undefined, {
      endpoint: "https://s3.example.com",
      region: "auto",
      keys: true,
    });

    const env = setEnv();
    assert.equal(env.AWS_ENDPOINT_URL_S3, "https://s3.example.com");
    assert.equal(env.AWS_REGION, "auto");
    assert.equal(env.AWS_ACCESS_KEY_ID, "id");
    assert.match(out, /endpoint .*region auto.*access keys/s);
  });
});

describe("provider one mode per set", () => {
  it("writing a profile clears existing access keys, and says so", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    seedSetEnv("photos", "AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=shh\n");
    captureWarn(t);

    const out = await provider("photos", { profile: "work" });

    const env = setEnv();
    assert.equal(env.AWS_PROFILE, "work");
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined); // the other mode is gone
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.match(out, /replacing its access keys/);
  });

  it("writing keys clears an existing profile, naming it", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
    seedSetEnv("photos", "AWS_PROFILE=work\n");
    stdin.isTTY = false;
    promptLines = ["AKIAEXAMPLE", "secret"];

    const out = await provider("photos", { keys: true });

    const env = setEnv();
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAEXAMPLE");
    assert.equal(env.AWS_PROFILE, undefined); // the profile is gone
    assert.match(out, /replacing its profile 'work'/);
  });

  it("keeps endpoint and region when switching to a profile", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    seedSetEnv(
      "photos",
      "AWS_ENDPOINT_URL_S3=https://s3.example\nAWS_REGION=auto\n" +
        "AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=shh\n",
    );
    captureWarn(t);

    await provider("photos", { profile: "work" });

    const env = setEnv();
    assert.equal(env.AWS_PROFILE, "work");
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined); // keys cleared
    assert.equal(env.AWS_ENDPOINT_URL_S3, "https://s3.example"); // knob kept
    assert.equal(env.AWS_REGION, "auto"); // knob kept
  });

  it("says nothing about replacing when the other mode was absent", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    captureWarn(t);

    const out = await provider("photos", { profile: "work" });

    assert.doesNotMatch(out, /replacing/);
  });

  it("rejects --profile and --keys in one call", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();

    await assert.rejects(
      () => provider("photos", { profile: "work", keys: true }),
      /either a profile or access keys/,
    );
  });
});

describe("provider --unset", () => {
  it("removes the AWS_PROFILE line, preserving the bucket", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path);
    makeSet();
    captureWarn(t);
    await provider("photos", { profile: "work" });

    const out = await provider("photos", { unset: "profile" });

    assert.match(out, /Cleared the AWS profile for set 'photos'\./);
    const env = setEnv();
    assert.equal(env.AWS_PROFILE, undefined); // gone
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // preserved
  });

  it("unsets both endpoint spellings and both key halves", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
    seedSetEnv(
      "photos",
      "AWS_ENDPOINT_URL_S3=https://a\nAWS_ENDPOINT_URL=https://b\n" +
        "AWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=secret\n",
    );

    await provider("photos", { unset: "endpoint" });
    const out = await provider("photos", { unset: "keys" });

    assert.match(out, /Cleared the access keys for set 'photos'/);
    const env = setEnv();
    assert.equal(env.AWS_ENDPOINT_URL_S3, undefined);
    assert.equal(env.AWS_ENDPOINT_URL, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.S3CAB_BUCKET, "my-bucket"); // the set's own line survives
  });

  it("rejects an unknown setting name, listing the real ones", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();

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

  it("reports nothing configured for a set, pointing at the set-scoped fix", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
    for (const name of SHELL_VARS) {
      delete process.env[name]; // restored by afterEach
    }

    const out = await provider("photos", {});

    assert.match(
      out,
      /No provider settings for set 'photos' — it uses your ambient AWS setup/,
    );
    assert.match(out, /s3cab provider --profile <name> photos/); // set-scoped fix
    assert.doesNotMatch(out, /shell environment/); // nothing ambient to report
  });

  it("notes shell-environment auth so an empty set doesn't read as broken", async () => {
    // Backups can work entirely off shell AWS_* vars; "no provider settings"
    // alone would then be a false alarm.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet();
    for (const name of SHELL_VARS) {
      delete process.env[name];
    }
    process.env.AWS_PROFILE = "work";
    process.env.AWS_ENDPOINT_URL = "https://s3.example";

    const out = await provider("photos", {});

    assert.match(out, /No provider settings for set 'photos'/);
    assert.match(
      out,
      /shell environment sets AWS_PROFILE=work, an endpoint \(https:\/\/s3\.example\)/,
    );
    assert.match(out, /unless the set overrides it/);
  });

  it("reports profile, endpoint, region, and key presence at a set scope", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // 'work' exists → healthy, no diagnostic line
    makeSet();
    seedSetEnv(
      "photos",
      "AWS_PROFILE=work\nAWS_ENDPOINT_URL=https://example.r2\n" +
        "AWS_REGION=auto\nAWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=hunter2\n",
    );

    const out = await provider("photos", {});

    // The legible query-noun form, and no broken-profile diagnostic.
    assert.match(out, /AWS profile for set 'photos': work/);
    assert.match(out, /AWS endpoint for set 'photos': https:\/\/example\.r2/);
    assert.match(out, /AWS region for set 'photos': auto/);
    // Key presence + the ID tail ("which key?"), never the secret.
    assert.match(out, /Access keys for set 'photos': set \(…id\)/);
    assert.doesNotMatch(out, /hunter2/);
    assert.doesNotMatch(out, /Not in your AWS config/);
  });

  it("flags a profile that isn't in the AWS config when looking", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    useAwsConfig(dir.path); // only 'work' and 'default' exist
    makeSet();
    seedSetEnv("photos", "AWS_PROFILE=s3cab-test\n");

    const out = await provider("photos", {});

    assert.match(out, /AWS profile for set 'photos': s3cab-test/);
    assert.match(out, /Not in your AWS config — no credentials to use/);
    assert.match(out, /aws configure --profile s3cab-test/);
  });

  it("summarizes every set on a bare `provider`", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet("photos");
    makeSet("docs");
    seedSetEnv("photos", "AWS_ENDPOINT_URL_S3=https://photos.example\n");
    seedSetEnv("docs", "AWS_REGION=eu-west-1\n");
    for (const name of SHELL_VARS) {
      delete process.env[name];
    }

    const out = await provider(undefined, {});

    assert.match(
      out,
      /AWS endpoint for set 'photos': https:\/\/photos\.example/,
    );
    assert.match(out, /AWS region for set 'docs': eu-west-1/);
  });

  it("emits the shell-environment note once for the summary, not per ambient set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    makeSet("photos");
    makeSet("docs");
    // Both sets are empty (ambient), and the shell carries auth.
    for (const name of SHELL_VARS) {
      delete process.env[name];
    }
    process.env.AWS_PROFILE = "work";

    const out = await provider(undefined, {});

    // The global note appears exactly once, though two sets rely on ambient.
    assert.equal((out.match(/shell environment sets/g) ?? []).length, 1);
  });

  it("gives the create-a-set hint when there are no sets", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const out = await provider(undefined, {});

    assert.match(out, /No backup sets yet/);
    assert.match(out, /s3cab setup <set>/);
  });
});
