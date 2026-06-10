import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Tests for the layered env loading in auth.mjs (see specs/auth.md). loadEnv
// reads homedir() and mutates process.env, and applies each file at most once
// per run — so each test (a) points homedir() at a temp dir, (b) gets a *fresh*
// copy of the module so the once-per-run guard starts empty, and (c) has
// process.env snapshotted and restored around it.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// A query string makes each import a distinct module key, so the module's
// `appliedEnvFiles` guard is reset between tests.
let moduleCounter = 0;
const freshLoadEnv = async () =>
  (await import(`./auth.mjs?case=${moduleCounter++}`)).loadEnv;

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
 * Wire up a temp home + project dir, point homedir() at the home, and return a
 * fresh `loadEnv` plus helpers to populate each layer's file.
 * @param {string} root - The disposable temp directory.
 */
async function setup(root) {
  const home = join(root, "home");
  const proj = join(root, "proj");
  // homedir() reads USERPROFILE on Windows, HOME on POSIX — set both. Must be in
  // place before importing auth.mjs (it derives ~/.s3cab paths from homedir()).
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const loadEnv = await freshLoadEnv();
  return {
    loadEnv,
    proj,
    /** @param {string} contents */
    user: (contents) => writeEnv(join(home, ".s3cab", "env"), contents),
    /** @param {string} name @param {string} contents */
    bucket: (name, contents) =>
      writeEnv(join(home, ".s3cab", `env.${name}`), contents),
    /** @param {string} contents */
    folder: (contents) => writeEnv(join(proj, ".s3cab", "env"), contents),
  };
}

describe("loadEnv", () => {
  it("loads the per-user env file", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_PROFILE=userprof\n");

    const { bucket } = t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, "userprof");
    assert.equal(bucket, undefined);
  });

  it("lets a file value win over the shell (files are authoritative)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    process.env.AWS_REGION = "us-shell";
    t.user("AWS_REGION=us-file\n");

    t.loadEnv();

    assert.equal(process.env.AWS_REGION, "us-file");
  });

  it("loads the per-bucket env file for an explicit bucket name", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.bucket("mybucket", "AWS_PROFILE=bucketprof\n");

    const { bucket } = t.loadEnv({ bucket: "mybucket" });

    assert.equal(bucket, "mybucket");
    assert.equal(process.env.AWS_PROFILE, "bucketprof");
  });

  it("applies the per-bucket layer over the per-user layer", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_REGION=us-user\n");
    t.bucket("b", "AWS_REGION=us-bucket\n");

    t.loadEnv({ bucket: "b" });

    assert.equal(process.env.AWS_REGION, "us-bucket");
  });

  it("resolves the bucket from the folder env and applies dir > bucket > user", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_REGION=us-user\nAWS_PROFILE=userprof\n");
    t.bucket("projbucket", "AWS_REGION=us-bucket\nAWS_PROFILE=bucketprof\n");
    t.folder("S3CAB_BUCKET=projbucket\nAWS_REGION=us-dir\n");

    const { bucket } = t.loadEnv({ dir: t.proj });

    assert.equal(bucket, "projbucket");
    assert.equal(process.env.S3CAB_BUCKET, "projbucket");
    assert.equal(process.env.AWS_REGION, "us-dir"); // dir wins over bucket + user
    assert.equal(process.env.AWS_PROFILE, "bucketprof"); // bucket fills what dir omits
  });

  it("prefers an explicit bucket arg over the folder env's S3CAB_BUCKET", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.folder("S3CAB_BUCKET=folderbucket\n");
    t.bucket("explicitbucket", "AWS_PROFILE=fromexplicit\n");
    t.bucket("folderbucket", "AWS_PROFILE=fromfolder\n");

    const { bucket } = t.loadEnv({ dir: t.proj, bucket: "explicitbucket" });

    assert.equal(bucket, "explicitbucket");
    assert.equal(process.env.AWS_PROFILE, "fromexplicit");
  });

  it("falls back to the user-level S3CAB_BUCKET when the folder env has none", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("S3CAB_BUCKET=userbucket\n");
    t.bucket("userbucket", "AWS_PROFILE=fromuserbucket\n");
    t.folder("AWS_REGION=us-dir\n"); // no S3CAB_BUCKET of its own

    const { bucket } = t.loadEnv({ dir: t.proj });

    assert.equal(bucket, "userbucket");
    assert.equal(process.env.AWS_PROFILE, "fromuserbucket");
  });

  it("does not infer or load a per-bucket file from a no-scope call", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    process.env.S3CAB_BUCKET = "shellbucket"; // a bare default, not authoritative
    t.bucket("shellbucket", "AWS_SECRET_ACCESS_KEY=should-not-load\n");

    const { bucket } = t.loadEnv();

    assert.equal(bucket, undefined);
    assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);
  });

  it("is a no-op when no env files exist", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);

    const { bucket } = t.loadEnv({ dir: t.proj, bucket: "absent" });

    assert.equal(bucket, "absent"); // an explicit name is still returned
    assert.equal(process.env.AWS_PROFILE, undefined);
  });

  it("does not let a later no-scope call clobber a higher layer already applied", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user("AWS_REGION=us-user\n");
    t.bucket("b", "AWS_REGION=us-bucket\n");

    t.loadEnv({ bucket: "b" }); // user then bucket → us-bucket
    assert.equal(process.env.AWS_REGION, "us-bucket");

    t.loadEnv(); // the client() safety net — must not re-apply the user layer
    assert.equal(process.env.AWS_REGION, "us-bucket");
  });

  it("parses comments and quoted values (util.parseEnv)", async () => {
    await using dir = await mkTmpDir();
    const t = await setup(dir.path);
    t.user('# a comment\nAWS_PROFILE="quoted value"\n\nAWS_REGION=us-east-1\n');

    t.loadEnv();

    assert.equal(process.env.AWS_PROFILE, "quoted value");
    assert.equal(process.env.AWS_REGION, "us-east-1");
  });
});
