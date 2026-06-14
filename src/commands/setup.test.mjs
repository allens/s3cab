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

    const set = await setup("photos", [photos]);

    assert.equal(set.name, "photos");
    assert.deepEqual(set.dirs, [realpathSync.native(photos)]);
    assert.equal(set.bucket, undefined);
    assert.match(String(set.namespace), /^[a-z0-9-]+@[a-z0-9-]+\/photos$/);
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

// Adoption's offline error paths — everything that fails before the S3
// verification (which is gated, covered by the round-trip e2e). The from-path
// is async, so these reject rather than throw.
describe("setup --from (adoption)", () => {
  it("rejects a malformed namespace, teaching the shape", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await assert.rejects(
      () => setup("recovery", [], { from: "Not A Namespace", bucket: "b" }),
      /Invalid namespace[\s\S]*user@machine\/set/,
    );
  });

  it("rejects folders passed alongside --from", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    await assert.rejects(
      () =>
        setup("recovery", [photos], {
          from: "allen@allen-pc/photos",
          bucket: "b",
        }),
      /takes no folders/,
    );
  });

  it("refuses to adopt into an existing set (namespace is pinned at creation)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = useTempHome(dir.path);
    await setup("photos", [photos]);
    await assert.rejects(
      () => setup("photos", [], { from: "allen@allen-pc/photos", bucket: "b" }),
      /already exists/,
    );
  });

  it("requires a bucket to adopt from", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await assert.rejects(
      () => setup("recovery", [], { from: "allen@allen-pc/photos" }),
      /needs the bucket/,
    );
  });
});
