import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

/** @import { StatSyncOptions } from "node:fs" */

// `realPath` on a mount whose folders share one inode number: a share
// reporting 0 for every file, or one whose top-level folders are separate
// filesystems on the server. Its own file, and a dotted aspect name (ADR-0049),
// because the shared numbers are made by mocking `node:fs` before `walk.mjs`
// is loaded.

/** Every entry below this folder reports inode 0. */
let sharing = "";

// Everything `node:fs` really exports, bar the non-configurable `constants`
// (see walk.unknown-dirent.test.mjs).
const passthrough = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => name !== "constants"),
);

mock.module("node:fs", {
  exports: {
    ...passthrough,
    /**
     * @param {string} path
     * @param {StatSyncOptions} [options]
     */
    lstatSync: (path, options) => {
      const stats = realFs.lstatSync(path, options);
      return sharing && path.startsWith(sharing) && stats
        ? Object.assign(stats, { ino: options?.bigint ? 0n : 0 })
        : stats;
    },
  },
});

const { realPath } = await import("./walk.mjs");

describe("realPath where folders share an inode number", () => {
  it("keeps the name as typed rather than take another folder's", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const base = realpathSync.native(dir.path);
    mkdirSync(join(base, "Archive"));
    mkdirSync(join(base, "Photos"));
    if (!existsSync(join(base, "PHOTOS"))) {
      t.skip("filesystem is case-sensitive");
      return;
    }
    sharing = join(base, "");
    // As glibc's does, in a Linux directory that ignores case.
    t.mock.method(realpathSync, "native", (/** @type {string} */ path) => path);

    assert.equal(realPath(join(base, "PHOTOS")), join(base, "PHOTOS"));
  });
});
