import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadEnv } from "../lib/env.mjs";
import { deleteObject } from "../lib/s3.mjs";
import {
  readRemoteInfo,
  readSetConfig,
  remoteSetPrefix,
} from "../lib/set-marker.mjs";
import { readSet } from "../lib/sets.mjs";
import { setup } from "./setup.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the setup command (docs/specs/backup.md). The offline block covers the
// pre-S3 validation/UX (which fires before any network touch); the create /
// collision / inherit behaviour touches the bucket, so it lives in the gated
// real-bucket block below (mirroring remote.test.mjs / restore.test.mjs). The set
// store keeps no module state, so each test points S3CAB_HOME at a temp dir.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Wire up a temp home (via the shared helper) plus a member folder to enrol.
 * @param {string} root - The disposable temp directory.
 */
function withMemberFolder(root) {
  const home = useTempHome(root);
  const photos = join(root, "photos");
  mkdirSync(photos, { recursive: true });
  return { home, photos };
}

describe("setup (offline validation)", () => {
  it("requires the set name", async () => {
    await using dir = await mkTmpDir();
    withMemberFolder(dir.path);

    await assert.rejects(
      () => setup(undefined),
      /Missing required argument: <set>/,
    );
  });

  it("requires at least one folder when creating", async () => {
    await using dir = await mkTmpDir();
    withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("photos", []),
      /Missing required argument: <folder>/,
    );
  });

  it("requires --bucket when creating (a set is bound to a bucket at creation)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("photos", [photos]),
      /Missing required argument: --bucket/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("My Photos", [photos], { bucket: "b" }),
      /Invalid set name: My Photos[\s\S]*lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects an s3:// URL passed as the bucket, before touching folders", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "s3://my-bucket" }),
      /Invalid bucket name[\s\S]*not a URL/,
    );
  });

  it("rejects an explicit empty --bucket rather than silently ignoring it", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "" }),
      /No bucket name given/,
    );
  });

  it("rejects a missing folder and a non-folder member (before --bucket)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);
    const file = join(dir.path, "plain.txt");
    writeFileSync(file, "x");

    // Folder resolution runs before the --bucket check, so a bad folder reports
    // itself regardless of whether a bucket was given.
    await assert.rejects(
      () => setup("photos", [join(dir.path, "nope")]),
      /Folder not found: /,
    );
    await assert.rejects(
      () => setup("photos", [photos, file]),
      /Not a folder: /,
    );
  });

  it("inherit takes no folders and needs a bucket", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberFolder(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { inherit: true, bucket: "b" }),
      /takes no folders/,
    );
    await assert.rejects(
      () => setup("photos", [], { inherit: true }),
      /Inheriting needs the bucket/,
    );
  });
});

// Create / collision / inherit touch the bucket, so they're gated on
// S3CAB_TEST_BUCKET (+ ambient AWS credentials) like the other S3 suites, and
// skipped with a message otherwise. Each uses a unique set name so the shared
// bucket stays isolated, and deletes its `sets/<name>/` marker on teardown.
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

// These gated suites call the S3 ops directly (no CLI entry point), so they must
// trip the env-loaded flag client() asserts (ADR-0022) — ambient AWS credentials
// supply the real creds; this just sets the flag. At module scope so it runs
// before the file-level beforeEach snapshots process.env (afterEach then keeps it).
if (TEST_BUCKET) loadEnv();

/**
 * Delete a set's remote marker files (best-effort) — teardown for the gated
 * tests so the shared bucket doesn't accumulate `sets/<name>/` markers.
 * @param {string} bucket
 * @param {string} name
 */
async function cleanupSet(bucket, name) {
  for (const file of ["info", "dirs.txt", "exclude.txt"]) {
    await deleteObject(`s3://${bucket}/${remoteSetPrefix(name)}${file}`).catch(
      () => {},
    );
  }
}

describe("setup (real bucket)", { skip }, () => {
  it("create claims the name and publishes its config", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `st-create-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      const set = await setup(name, [content], { bucket });
      assert.equal(set.name, name);
      assert.equal(set.bucket, bucket);
      assert.deepEqual(set.dirs, [realpathSync.native(content)]);

      // The remote marker is claimed (owner = this machine) and the config is
      // published.
      const info = await readRemoteInfo(bucket, name);
      assert.equal(info?.owner, hostname());
      assert.match(String(info?.created), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      const config = await readSetConfig(bucket, name);
      assert.deepEqual(config.dirs, [realpathSync.native(content)]);
    } finally {
      await cleanupSet(bucket, name);
    }
  });

  it("refuses a name already claimed (by another machine), pointing at --inherit", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `st-collide-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A claims the name.
      useTempHome(join(dir.path, "a"));
      await setup(name, [content], { bucket });

      // Machine B (a fresh local home, same bucket) is refused.
      useTempHome(join(dir.path, "b"));
      await assert.rejects(
        () => setup(name, [content], { bucket }),
        /already set up[\s\S]*--inherit/,
      );
    } finally {
      await cleanupSet(bucket, name);
    }
  });

  it("inherit recreates the set locally from the remote, preserving CREATED", async () => {
    await using dir = await mkTmpDir();
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `st-inherit-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A creates it.
      useTempHome(join(dir.path, "a"));
      await setup(name, [content], { bucket });
      const before = await readRemoteInfo(bucket, name);

      // Machine B inherits — no folders, recreated from the remote config.
      useTempHome(join(dir.path, "b"));
      const inherited = await setup(name, [], { bucket, inherit: true });
      assert.equal(inherited.bucket, bucket);
      assert.deepEqual(inherited.dirs, [realpathSync.native(content)]);
      // The local set really exists on machine B.
      assert.deepEqual(readSet(name).dirs, [realpathSync.native(content)]);

      // CREATED is preserved across the inherit (only OWNER is re-stamped).
      const after = await readRemoteInfo(bucket, name);
      assert.equal(after?.created, before?.created);
    } finally {
      await cleanupSet(bucket, name);
    }
  });

  it("update re-publishes changed folders to the remote", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `st-update-${Date.now()}`;
    const c1 = resolve(dir.path, "one");
    const c2 = resolve(dir.path, "two");
    mkdirSync(c1, { recursive: true });
    mkdirSync(c2, { recursive: true });

    try {
      await setup(name, [c1], { bucket });
      await setup(name, [c1, c2], { bucket }); // update: add a folder

      const config = await readSetConfig(bucket, name);
      assert.deepEqual(config.dirs, [
        realpathSync.native(c1),
        realpathSync.native(c2),
      ]);
    } finally {
      await cleanupSet(bucket, name);
    }
  });
});
