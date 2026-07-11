import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setup } from "./setup.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Offline setup tests (docs/design/backup.md, ADR-0036): the pre-S3
// create/update/inherit validation, which fires before any network touch. The
// create / collision / inherit behaviour touches the bucket, so it lives in the
// gated test/integration/set-lifecycle.test.mjs. The set store keeps no module state, so each
// test points S3CAB_HOME at a temp dir.

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
 * Wire up a temp home (via the shared helper) plus a member directory to enrol.
 * @param {string} root - The disposable temp directory.
 */
function withMemberDir(root) {
  const home = useTempHome(root);
  const photos = join(root, "photos");
  mkdirSync(photos, { recursive: true });
  return { home, photos };
}

describe("setup (offline validation)", () => {
  it("requires a set name, since setup only mutates a named set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => setup(undefined, [], { bucket: "b" }),
      /Missing required argument: <set>/,
    );
  });

  it("requires at least one directory when creating", async () => {
    await using dir = await mkTmpDir();
    withMemberDir(dir.path);

    await assert.rejects(
      () => setup("photos", []),
      /Missing required argument: <directory>/,
    );
  });

  it("requires --bucket when creating (a set always backs up to a bucket)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup("photos", [photos]),
      /Missing required argument: --bucket/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup("My Photos", [photos], { bucket: "b" }),
      /Invalid set name: My Photos[\s\S]*lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects an s3:// URL passed as the bucket, before touching directories", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "s3://my-bucket" }),
      /Invalid bucket name[\s\S]*not a URL/,
    );
  });

  it("rejects an explicit empty --bucket rather than silently ignoring it", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "" }),
      /No bucket name given/,
    );
  });

  it("rejects a missing directory and a non-directory member (before --bucket)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);
    const file = join(dir.path, "plain.txt");
    writeFileSync(file, "x");

    // Directory resolution runs before the --bucket check, so a bad directory
    // reports itself regardless of whether a bucket was given.
    await assert.rejects(
      () => setup("photos", [join(dir.path, "nope")]),
      /Directory not found: /,
    );
    await assert.rejects(
      () => setup("photos", [photos, file]),
      /Not a directory: /,
    );
  });

  it("inherit takes no directories and needs a bucket", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { inherit: true, bucket: "b" }),
      /takes no directories/,
    );
    await assert.rejects(
      () => setup("photos", [], { inherit: true }),
      /Inheriting needs the bucket/,
    );
  });
});
