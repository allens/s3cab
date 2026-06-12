import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setup } from "./setup.mjs";

// Tests for the setup command's create/update semantics and error UX
// (specs/backup.md). The set store under test keeps no module state, so each
// test just points homedir() at a temp dir (USERPROFILE/HOME — set both).

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
 * Wire up a temp home plus a member folder to enrol, and point homedir() at
 * the home.
 * @param {string} root - The disposable temp directory.
 */
function useTempHome(root) {
  const home = join(root, "home");
  const photos = join(root, "photos");
  mkdirSync(home, { recursive: true });
  mkdirSync(photos, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, photos };
}

describe("setup", () => {
  it("creates a set: absolute member folders, pinned namespace, no bucket", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    const set = setup("photos", [photos]);

    assert.equal(set.name, "photos");
    assert.deepEqual(set.dirs, [realpathSync.native(photos)]);
    assert.equal(set.bucket, undefined);
    assert.match(String(set.namespace), /^[a-z0-9-]+@[a-z0-9-]+\/photos$/);
  });

  it("re-running with --bucket alone binds the bucket and keeps the folders", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    setup("photos", [photos]);

    const updated = setup("photos", [], { bucket: "my-bucket" });

    assert.equal(updated.bucket, "my-bucket");
    assert.deepEqual(updated.dirs, [realpathSync.native(photos)]);
  });

  it("requires the set name", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => setup(undefined), /Missing required argument: <set>/);
  });

  it("requires at least one folder when creating", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(
      () => setup("photos", []),
      /Missing required argument: <folder>/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);

    assert.throws(
      () => setup("My Photos", [photos]),
      /Invalid set name: My Photos[\s\S]*lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects a missing folder and a non-folder member", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    const file = join(dir.path, "plain.txt");
    writeFileSync(file, "x");

    assert.throws(
      () => setup("photos", [join(dir.path, "nope")]),
      /Folder not found: /,
    );
    assert.throws(() => setup("photos", [photos, file]), /Not a folder: /);
  });
});
