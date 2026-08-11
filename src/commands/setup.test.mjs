import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setup } from "./setup.mjs";
import { writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { PathLike } from "node:fs" */

// Offline setup tests (docs/design/backup.md, ADR-0036, ADR-0052, ADR-0053): the
// pre-S3 create validation, which fires before any network touch, and the refusal
// to re-run on a set that already exists here (there is no update mode —
// directories are edited in the public dirs.txt). Adopting an existing *remote*
// set is `reattach` now, tested in reattach.test.mjs. The create/collision
// behaviour touches the bucket, so it lives in the gated
// test/integration/set-lifecycle.test.mjs. The set store keeps no module state,
// so each test points S3CAB_HOME at a temp dir.

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
  it("requires a set name, since setup creates a named set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      // Named by --set, not a positional: the directories are the bulk operand
      // (ADR-0062), so the set moved to a flag.
      () => setup([], { bucket: "b" }),
      /Missing required argument: set/,
    );
  });

  it("requires at least one directory when creating", async () => {
    await using dir = await mkTmpDir();
    withMemberDir(dir.path);

    await assert.rejects(
      () => setup([], { set: "photos" }),
      /Missing required argument: directory/,
    );
  });

  it("requires --bucket when creating (a set always backs up to a bucket)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup([photos], { set: "photos" }),
      /Missing required argument: bucket/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup([photos], { set: "My Photos", bucket: "b" }),
      /Invalid set name: My Photos[\s\S]*lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects an s3:// URL passed as the bucket, before touching directories", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup([photos], { set: "photos", bucket: "s3://my-bucket" }),
      /Invalid bucket name[\s\S]*not a URL/,
    );
  });

  it("rejects an explicit empty --bucket rather than silently ignoring it", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () => setup([photos], { set: "photos", bucket: "" }),
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
      () => setup([join(dir.path, "nope")], { set: "photos" }),
      /Directory not found: /,
    );
    await assert.rejects(
      () => setup([photos, file], { set: "photos" }),
      /Not a directory: /,
    );
  });

  it("won't call a folder it can't resolve missing, and says what it can't do", async (t) => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    // Constructed, not reproduced. The measured case is an unlocked OneDrive
    // Personal Vault — a junction onto a volume GUID with no mount point, which
    // `lstat`/`stat` call a directory and `readdir` lists, while
    // `GetFinalPathNameByHandle` answers ENOENT (proposals/filesystem-edge-cases.md).
    // A *locked* vault has no such path at all, so the misleading message was
    // reachable only with it open; nothing portable creates one, so the OS's
    // answer for this one path is faked and the folder underneath is real.
    const native = realpathSync.native;
    t.mock.method(
      realpathSync,
      "native",
      /** @param {PathLike} path */ (path) => {
        if (path === photos) {
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, realpath '${path}'`),
            { code: "ENOENT" },
          );
        }
        return native(path);
      },
    );

    await assert.rejects(
      () => setup([photos], { set: "photos", bucket: "b" }),
      (error) =>
        error instanceof Error &&
        // The bug: a folder that plainly exists and lists was reported missing.
        !/Directory not found/.test(error.message) &&
        error.message.startsWith(
          `Can't add '${photos}' to backup set 'photos'`,
        ) &&
        /the folder is there and lists/.test(error.message) &&
        // The fix carries the values we already know, placeholder only for the
        // one the user has to choose (ADR-0030).
        error.message.includes(
          "  s3cab setup --set photos --bucket b <directory>...",
        ),
    );
  });

  it("rejects --profile and --keys together before any network touch (one mode)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    // The one-mode rule (ADR-0055) is enforced while gathering the knobs, which
    // runs before the remote claim — so this fails offline, no name is claimed.
    await assert.rejects(
      () =>
        setup([photos], {
          set: "photos",
          bucket: "b",
          profile: "work",
          keys: true,
        }),
      /Set one way to sign in, not a profile and access keys/,
    );
  });

  it("refuses --roles-anywhere before any network touch when no identity exists", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    // RA is a machine identity stood up by `s3cab aws --roles-anywhere` first;
    // creating a set against it without one fails fast (offline), pointing at that
    // recipe, so no name is claimed on a half-built identity (ADR-0057).
    await assert.rejects(
      () =>
        setup([photos], {
          set: "photos",
          bucket: "my-backups",
          "roles-anywhere": true,
        }),
      /no complete Roles Anywhere identity yet.*s3cab aws my-backups --roles-anywhere/s,
    );
  });

  it("rejects a malformed --endpoint before any network touch", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);

    await assert.rejects(
      () =>
        setup([photos], { set: "photos", bucket: "b", endpoint: "not-a-url" }),
      /Give the endpoint as a full URL/,
    );
  });

  it("refuses to re-run on a set that already exists here (no update mode)", async () => {
    await using dir = await mkTmpDir();
    const { photos } = withMemberDir(dir.path);
    // A set already exists locally (written straight to the store, no S3).
    writeSet("photos", { dirs: [photos], bucket: "my-bucket" });

    // Re-running setup on it is refused — pointing at the public dirs.txt and at
    // creating a new set, not silently re-pointing the existing one.
    await assert.rejects(
      () => setup([photos], { set: "photos", bucket: "my-bucket" }),
      /already exists on this machine[\s\S]*dirs\.txt[\s\S]*create a new set/,
    );
  });
});
