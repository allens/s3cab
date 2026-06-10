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
});
