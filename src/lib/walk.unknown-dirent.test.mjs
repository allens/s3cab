import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it, mock } from "node:test";

/** @import { Dirent } from "node:fs" */

// The walk on a filesystem that doesn't carry entry types in the directory
// listing — NFS without cached attributes, some FUSE mounts — where `readdir`
// answers "unknown" for everything and `resolveFileType`'s `lstat` fallback is
// the only thing standing between the user and a silently smaller backup.
//
// Its own file, and a dotted aspect name (ADR-0049), because simulating that
// filesystem means mocking `node:fs` before `walk.mjs` is loaded — which the
// co-located `walk.test.mjs` can't do around its static import.

/**
 * A `Dirent` as an unknown-type filesystem hands it over: the name and parent
 * are there, and every one of the seven type predicates answers `false`. That is
 * not a contrivance — it is exactly what Node produces from a `DT_UNKNOWN`
 * directory entry, and the reason such an entry used to be recorded as an
 * unsupported type.
 * @param {{ name: string, parentPath: string }} dirent
 * @returns {Dirent}
 */
const typeless = (dirent) =>
  /** @type {Dirent} */ (
    /** @type {unknown} */ ({
      name: dirent.name,
      parentPath: dirent.parentPath,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    })
  );

// A name `readdir` reports but that isn't on disk, so the fallback's `lstat`
// throws — the vanished-mid-walk / unreadable case. Injected into one named
// directory only, so the count below says which listing it came from.
const PHANTOM = "phantom.txt";

/** @type {string} */
let phantomIn = "";

// Everything `node:fs` really exports, bar `constants` — which is
// non-configurable, so the module mocker throws trying to redefine it. The rest
// has to come through because mocking a specifier replaces it for every module
// that imports it, not just the one under test.
const passthrough = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => name !== "constants"),
);

mock.module("node:fs", {
  exports: {
    ...passthrough,
    /**
     * Serves `walk.mjs`'s one call shape — `readdirSync(dir, { withFileTypes:
     * true })` — since that is the only reader this test drives.
     * @param {string} dir
     * @returns {Dirent[]}
     */
    readdirSync: (dir) => {
      const entries = realFs
        .readdirSync(dir, { withFileTypes: true })
        .map(typeless);
      return dir === phantomIn
        ? [...entries, typeless({ name: PHANTOM, parentPath: dir })]
        : entries;
    },
  },
});

const { walkDirs } = await import("./walk.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

describe("walk on a filesystem that reports no entry types", () => {
  it("classifies by lstat, so files and whole subtrees stay in the backup", async () => {
    await using dir = await mkTmpDir();
    const root = realFs.realpathSync.native(dir.path);
    phantomIn = root;
    writeFileSync(join(root, "top.txt"), "top");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "nested.txt"), "nested");

    const { files, skipped } = walkDirs([root], []);

    // Both halves of the bug at once. `top.txt` proves a file is no longer
    // written off as an unsupported type; `sub/nested.txt` proves `sub` was
    // recognised as a directory and descended into — the worse half, since an
    // unclassified directory took its entire subtree out of the backup with it.
    assert.deepEqual(
      files.map((file) => relative(root, file).split("\\").join("/")).sort(),
      ["sub/nested.txt", "top.txt"],
    );

    // The phantom is the only thing skipped: an entry the fallback couldn't
    // stat keeps its unknown type and is reported, rather than throwing and
    // taking the walk down with it.
    assert.equal(skipped.length, 1);
    const [only] = skipped;
    assert.ok(only);
    assert.equal(only.fileType, "Unknown File Type");
    assert.equal(only.reason, "Unsupported file type");
    assert.equal(only.path, join(root, PHANTOM));
  });

  // The skip notice is `walkDirs`' in general, but every other way to produce a
  // skipped entry needs a file type that can't be created portably (a symlink
  // wants Developer Mode on Windows; sockets and FIFOs aren't creatable at all),
  // so it is asserted here where the mock guarantees one on every platform.
  it("says on stderr what it left out, grouped and counted by type", async (t) => {
    await using dir = await mkTmpDir();
    const root = realFs.realpathSync.native(dir.path);
    phantomIn = root;
    writeFileSync(join(root, "kept.txt"), "kept");

    const warn = t.mock.method(console, "warn", () => {});
    walkDirs([root], []);

    const notices = warn.mock.calls
      .map(({ arguments: args }) => args.join(" "))
      .filter((line) => line.startsWith("Skipped"));

    // One line, naming the count and the type — not a silent `#SKIPPED` row in a
    // compressed file. Singular "item", because one is one.
    assert.deepEqual(notices, [
      "Skipped 1 item that can't be backed up: 1 Unknown File Type",
    ]);
  });
});
