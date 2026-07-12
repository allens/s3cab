import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Tests for env.mjs's env loading (see docs/design/auth.md). The one s3cab layer
// is a set's env file, applied by loadSet over the ambient shell (ADR-0055 dropped
// the user layer); loadEnv just marks the environment initialized. applyEnvLayer
// mutates process.env and applies each file at most once per run — so each test
// (a) points S3CAB_HOME at a temp dir, (b) gets a *fresh* copy of the module so the
// once-per-run guard starts empty, and (c) has process.env snapshotted and restored
// around it.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// A query string makes each import a distinct module key, so the module's
// `appliedEnvFiles` guard is reset between tests.
let moduleCounter = 0;
const freshEnv = async () => import(`./env.mjs?case=${moduleCounter++}`);

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  // Start each test from a clean shell so an inherited AWS_PROFILE / region on
  // the dev's machine can't skew an assertion; afterEach puts them back.
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("AWS_") ||
      key.startsWith("S3CAB_") ||
      key.startsWith("__S3CAB")
    ) {
      delete process.env[key];
    }
  }
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
 * Write an env file, creating its parent dirs.
 * @param {string} path
 * @param {string} contents
 */
function writeEnv(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Wire up a temp home, point S3CAB_HOME at it, and return a fresh
 * `loadEnv`/`loadSet` plus helpers to populate each layer's file.
 * @param {string} root - The disposable temp directory.
 */
async function setup(root) {
  const home = join(root, "home");
  // Point s3cab's home at the temp dir via S3CAB_HOME (not the OS HOME), so the
  // loader reads these env files and nothing leaks from the real ~/.s3cab. Set
  // before importing env.mjs, which derives its paths from s3cabDir().
  process.env.S3CAB_HOME = join(home, ".s3cab");
  const env = await freshEnv();
  // The set's env-file path — writing it (with an `S3CAB_BUCKET`) is what makes
  // a set resolvable, so `loadSet` can pick it up. sets.mjs owns this layout.
  /** @param {string} name */
  const setEnvPath = (name) => join(home, ".s3cab", "sets", name, "env");
  return {
    loadEnv: env.loadEnv,
    loadSet: env.loadSet,
    profileSource: env.profileSource,
    setEnvPath,
    /** @param {string} contents */
    user: (contents) => writeEnv(join(home, ".s3cab", "env"), contents),
    /** @param {string} name @param {string} contents */
    set: (name, contents) => writeEnv(setEnvPath(name), contents),
  };
}

describe("loadEnv", () => {
  it("marks the environment initialized (the client() tripwire breadcrumb)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);

    t.loadEnv();

    assert.equal(process.env.__S3CAB_ENV_LOADED, "1");
  });

  it("no longer loads a user env file (ADR-0055 dropped the user layer)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    // A ~/.s3cab/env file must be ignored now — only a set's env layer carries
    // s3cab config, applied by loadSet.
    t.user("AWS_PROFILE=userprof\n");

    t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, undefined);
  });

  // The set layer's parsing (comments/quotes via util.parseEnv) and its
  // set-over-shell precedence are exercised through `loadSet` below; `loadEnv`
  // itself now only drops the breadcrumb.
});

describe("loadSet", () => {
  // `loadSet` applies the set layer over the ambient shell (set > shell — the one
  // s3cab layer, ADR-0055). `loadEnv()` is called first only to mirror the entry
  // point's order; it loads nothing itself.

  it("resolves the cloud-ready set and surfaces it", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv();
    const set = t.loadSet("photos");

    // The resolved set, surfaced through the door:
    assert.equal(set.name, "photos");
    assert.equal(set.bucket, "photobucket");
  });

  it("applies the set layer over the shell (and the shell fills the gaps)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    process.env.AWS_REGION = "us-shell";
    process.env.AWS_PROFILE = "shellprof";
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv();
    t.loadSet("photos");

    assert.equal(process.env.AWS_REGION, "us-set"); // set wins over shell
    assert.equal(process.env.AWS_PROFILE, "shellprof"); // shell fills what set omits
  });

  it("parses comments and quoted values in a set env file (util.parseEnv)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.set(
      "photos",
      '# a comment\nS3CAB_BUCKET=photobucket\nAWS_PROFILE="quoted value"\n',
    );

    t.loadEnv();
    t.loadSet("photos");

    assert.equal(process.env.AWS_PROFILE, "quoted value");
  });

  it("a later loadEnv() leaves an applied set layer intact", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv();
    t.loadSet("photos");
    assert.equal(process.env.AWS_REGION, "us-set");

    t.loadEnv(); // inert now — must not disturb the applied set layer
    assert.equal(process.env.AWS_REGION, "us-set");
  });

  it("stops a corrupt bucket-less set before loading its env", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    // No S3CAB_BUCKET → a corrupt set (ADR-0026 removed local-only); resolveSet
    // rejects it via readSet, and it must do so *before* the env layer is applied.
    t.set("local", "AWS_REGION=us-set\n");

    assert.throws(() => t.loadSet("local"), /no S3CAB_BUCKET/);
    assert.equal(process.env.AWS_REGION, undefined);
  });
});

describe("profileSource", () => {
  it("is undefined when no profile is set", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);

    t.loadEnv();

    assert.equal(t.profileSource(), undefined);
  });

  it("reports 'your environment' for a shell/ambient profile s3cab didn't set", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    // Set directly on process.env — a shell export or a Node --env-file both land
    // here before s3cab's layering runs, indistinguishable from each other.
    process.env.AWS_PROFILE = "shellprof";

    t.loadEnv();

    assert.equal(t.profileSource(), "your environment");
  });

  it("names the set config when the set layer supplies the profile", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_PROFILE=setprof\n");

    t.loadEnv();
    t.loadSet("photos");

    assert.equal(process.env.AWS_PROFILE, "setprof");
    assert.equal(t.profileSource(), "set 'photos' config");
  });

  it("attributes the winning layer: a set profile overriding an ambient one", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    process.env.AWS_PROFILE = "shellprof";
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_PROFILE=setprof\n");

    t.loadEnv();
    t.loadSet("photos");

    // The set value wins the merge, so the reported source follows it — not the
    // shadowed shell export.
    assert.equal(process.env.AWS_PROFILE, "setprof");
    assert.equal(t.profileSource(), "set 'photos' config");
  });
});
