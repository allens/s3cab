import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setup } from "./setup.mjs";
import { useTempHome as tempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the setup command's create/update semantics and error UX
// (docs/specs/backup.md). The set store under test keeps no module state, so each
// test just points S3CAB_HOME at a temp dir (via the shared useTempHome).

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
function useTempHome(root) {
  const home = tempHome(root);
  const photos = join(root, "photos");
  mkdirSync(photos, { recursive: true });
  return { home, photos };
}

describe("setup", () => {
  it("creates a set: absolute member folders, no bucket", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    const set = await setup("photos", [photos]);

    assert.equal(set.name, "photos");
    assert.deepEqual(set.dirs, [realpathSync.native(photos)]);
    assert.equal(set.bucket, undefined);
  });

  it("re-running with --bucket alone binds the bucket and keeps the folders", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    await setup("photos", [photos]);

    const updated = await setup("photos", [], { bucket: "my-bucket" });

    assert.equal(updated.bucket, "my-bucket");
    assert.deepEqual(updated.dirs, [realpathSync.native(photos)]);
  });

  it("requires the set name", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => setup(undefined),
      /Missing required argument: <set>/,
    );
  });

  it("requires at least one folder when creating", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => setup("photos", []),
      /Missing required argument: <folder>/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    await assert.rejects(
      () => setup("My Photos", [photos]),
      /Invalid set name: My Photos[\s\S]*lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects an s3:// URL passed as the bucket, before touching folders", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "s3://my-bucket" }),
      /Invalid bucket name[\s\S]*not a URL/,
    );
  });

  it("rejects an explicit empty --bucket rather than silently ignoring it", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    await assert.rejects(
      () => setup("photos", [photos], { bucket: "" }),
      /No bucket name given/,
    );
  });

  it("rejects a missing folder and a non-folder member", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    const file = join(dir.path, "plain.txt");
    writeFileSync(file, "x");

    await assert.rejects(
      () => setup("photos", [join(dir.path, "nope")]),
      /Folder not found: /,
    );
    await assert.rejects(
      () => setup("photos", [photos, file]),
      /Not a folder: /,
    );
  });
});
