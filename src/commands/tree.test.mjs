import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { tree } from "./tree.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * Write a file under `base`, creating parent directories. `relPath` always
 * uses `/` as the separator.
 * @param {string} base
 * @param {string} relPath
 * @param {string} [contents]
 */
function write(base, relPath, contents = "x") {
  const full = join(base, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Write the exclude file and the given files under `base`, run tree(), and
 * return what survived — relative to the root, `/`-separated, sorted.
 * @param {string} base
 * @param {string[]} patterns - Exclude patterns, one per line.
 * @param {string[]} relPaths - Files to create (always `/`-separated).
 */
function treeWithExcludes(base, patterns, relPaths) {
  for (const relPath of relPaths) {
    write(base, relPath);
  }
  write(base, ".s3cab/exclude.txt", patterns.join("\n"));

  const root = realpathSync.native(base);
  return tree(base)
    .map((path) => relative(root, path).split(sep).join(posix.sep))
    .sort();
}

describe("tree", () => {
  it("drops OS-junk and patterned files, always skips .s3cab, keeps the rest", async () => {
    await using dir = await mkTmpDir();
    const base = dir.path;

    // Kept
    write(base, "keep.txt");
    write(base, "sub/keep.txt");

    // Dropped by exclude patterns (in root and in a subdirectory)
    write(base, ".DS_Store");
    write(base, "Thumbs.db");
    write(base, "scratch.tmp");
    write(base, "sub/.DS_Store");
    write(base, "sub/Thumbs.db");
    write(base, "sub/scratch.tmp");

    // The walker always skips .s3cab/, so its contents never surface
    write(base, ".s3cab/should-not-appear.txt");
    write(
      base,
      ".s3cab/exclude.txt",
      ["**/*.tmp", "**/.DS_Store", "**/Thumbs.db"].join("\n"),
    );

    const root = realpathSync.native(base);
    const found = tree(base)
      .map((path) => relative(root, path).split(sep).join(posix.sep))
      .sort();

    assert.deepStrictEqual(found, ["keep.txt", "sub/keep.txt"]);
  });

  it(
    "accepts Windows backslash separators in patterns",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    async () => {
      await using dir = await mkTmpDir();

      const found = treeWithExcludes(
        dir.path,
        ["sub\\*.tmp"],
        ["keep.txt", "sub/drop.tmp", "sub/keep.txt"],
      );

      assert.deepStrictEqual(found, ["keep.txt", "sub/keep.txt"]);
    },
  );

  it("anchors patterns to the snapshot root", async () => {
    await using dir = await mkTmpDir();

    // Without a `**/` prefix, a pattern matches at the root only.
    const found = treeWithExcludes(
      dir.path,
      ["*.tmp"],
      ["root.tmp", "sub/nested.tmp"],
    );

    assert.deepStrictEqual(found, ["sub/nested.tmp"]);
  });

  it("**/ matches zero or more whole segments", async () => {
    await using dir = await mkTmpDir();

    const found = treeWithExcludes(
      dir.path,
      ["**/log.txt"],
      ["log.txt", "a/log.txt", "a/b/log.txt", "catalog.txt"],
    );

    // Matches at any depth including the root, but only as a whole segment —
    // `catalog.txt` must not be swept up.
    assert.deepStrictEqual(found, ["catalog.txt"]);
  });

  it("? matches exactly one character", async () => {
    await using dir = await mkTmpDir();

    const found = treeWithExcludes(
      dir.path,
      ["file?.txt"],
      ["file1.txt", "file.txt", "file10.txt"],
    );

    assert.deepStrictEqual(found, ["file.txt", "file10.txt"]);
  });

  it("a trailing slash excludes a directory and everything inside it", async () => {
    await using dir = await mkTmpDir();

    const found = treeWithExcludes(
      dir.path,
      ["build/"],
      ["build/out.js", "build/sub/deep.js", "builder/keep.js"],
    );

    // `builder/` is a different segment and must survive.
    assert.deepStrictEqual(found, ["builder/keep.js"]);
  });

  it("matches case-insensitively on Windows, case-sensitively elsewhere", async () => {
    await using dir = await mkTmpDir();

    const found = treeWithExcludes(
      dir.path,
      ["**/UPPER.txt"],
      ["upper.txt", "keep.txt"],
    );

    assert.deepStrictEqual(
      found,
      process.platform === "win32" ? ["keep.txt"] : ["keep.txt", "upper.txt"],
    );
  });
});
