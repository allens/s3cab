import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Tests for the layered env loading in env.mjs (see docs/specs/auth.md). loadEnv
// reads s3cabDir() and mutates process.env, and applies each file at most once
// per run — so each test (a) points S3CAB_HOME at a temp dir, (b) gets a *fresh*
// copy of the module so the once-per-run guard starts empty, and (c) has
// process.env snapshotted and restored around it.

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
    if (key.startsWith("AWS_") || key.startsWith("S3CAB_")) {
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
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
    setEnvPath,
    /** @param {string} contents */
    user: (contents) => writeEnv(join(home, ".s3cab", "env"), contents),
    /** @param {string} name @param {string} contents */
    set: (name, contents) => writeEnv(setEnvPath(name), contents),
  };
}

describe("loadEnv", () => {
  it("loads the per-user env file", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_PROFILE=userprof\n");

    t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, "userprof");
  });

  it("lets a file value win over the shell (files are authoritative)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    process.env.AWS_REGION = "us-shell";
    t.user("AWS_REGION=us-file\n");

    t.loadEnv();

    assert.equal(process.env.AWS_REGION, "us-file");
  });

  it("is a no-op when no user env file exists", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);

    t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, undefined);
  });

  it("loads a user env file created after an earlier no-op load", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);

    // First load: the user env file doesn't exist yet → nothing applied, and
    // the guard must NOT record a missing file as "applied".
    t.loadEnv();
    assert.equal(process.env.AWS_PROFILE, undefined);

    // Create it, then load again in the same process — it must now take effect.
    t.user("AWS_PROFILE=created-later\n");
    t.loadEnv();
    assert.equal(process.env.AWS_PROFILE, "created-later");
  });

  it("parses comments and quoted values (util.parseEnv)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user('# a comment\nAWS_PROFILE="quoted value"\n\nAWS_REGION=us-east-1\n');

    t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, "quoted value");
    assert.equal(process.env.AWS_REGION, "us-east-1");
  });

  // `loadEnv` no longer takes a set at all — the set layer is `loadSet`'s job,
  // and the path-separator guard lives upstream in `resolveSet`/`readSet`
  // (assertPathSegment), covered by sets.test.mjs.
});

describe("loadSet", () => {
  // `loadSet` adds the set layer *on top of* an already-loaded user layer (the
  // entry point loads the user layer first), so these arrange both and call
  // `loadEnv()` before `loadSet()` to mirror that order.

  it("resolves the cloud-ready set and surfaces it", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_PROFILE=photoprof\n");
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv();
    const set = t.loadSet("photos");

    // The resolved set, surfaced through the door:
    assert.equal(set.name, "photos");
    assert.equal(set.bucket, "photobucket");
  });

  it("applies the set layer over the user layer (and user fills the gaps)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_REGION=us-user\nAWS_PROFILE=userprof\n");
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv(); // user layer first (as the entry point does)
    t.loadSet("photos"); // then the set layer on top

    assert.equal(process.env.AWS_REGION, "us-set"); // set wins over user
    assert.equal(process.env.AWS_PROFILE, "userprof"); // user fills what set omits
  });

  it("does not let a later loadEnv() clobber the set layer already applied", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_REGION=us-user\n");
    t.set("photos", "S3CAB_BUCKET=photobucket\nAWS_REGION=us-set\n");

    t.loadEnv();
    t.loadSet("photos"); // user then set → us-set
    assert.equal(process.env.AWS_REGION, "us-set");

    t.loadEnv(); // a later user load — must not re-apply the user layer over set
    assert.equal(process.env.AWS_REGION, "us-set");
  });

  it("stops a corrupt bucket-less set before loading its env", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    // No S3CAB_BUCKET → a corrupt set (ADR-0026 removed local-only); resolveSet
    // rejects it via readSet, and it must do so *before* the env layer is applied.
    t.set("local", "AWS_REGION=us-set\n");

    assert.throws(() => t.loadSet("local"), /no bucket bound/);
    assert.equal(process.env.AWS_REGION, undefined);
  });
});
