import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { walkDirs } from "./walk.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// These exercise the walk core `walkDirs(dirs, patterns, …)` directly: multi-root
// accumulation, the always-skip `.s3cab`, overlap detection, and directory
// recursion. The glob → RegExp semantics are unit-tested in exclude.test.mjs.

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
 * Create the given files under `base`, walk it with the given patterns, and
 * return what survived — relative to the root, `/`-separated, sorted.
 * @param {string} base
 * @param {string[]} patterns - Exclude patterns.
 * @param {string[]} relPaths - Files to create (always `/`-separated).
 */
function walkWithExcludes(base, patterns, relPaths) {
  for (const relPath of relPaths) {
    write(base, relPath);
  }
  const root = realpathSync.native(base);
  return walkDirs([base], patterns)
    .map((path) => relative(root, path).split(sep).join(posix.sep))
    .sort();
}

describe("walkDirs", () => {
  it("drops patterned files, always skips .s3cab, keeps the rest", async () => {
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

    // The walker always skips a .s3cab/ folder, so its contents never surface
    // (defensive against stale snapshot folders left in a backed-up tree).
    write(base, ".s3cab/should-not-appear.txt");

    const root = realpathSync.native(base);
    const found = walkDirs([base], ["**/*.tmp", "**/.DS_Store", "**/Thumbs.db"])
      .map((path) => relative(root, path).split(sep).join(posix.sep))
      .sort();

    assert.deepStrictEqual(found, ["keep.txt", "sub/keep.txt"]);
  });

  it("walks several roots into one list", async () => {
    await using dir = await mkTmpDir();
    const a = join(dir.path, "a");
    const b = join(dir.path, "b");
    write(a, "1.txt");
    write(a, "sub/2.txt");
    write(b, "3.txt");

    const found = walkDirs([a, b], [])
      .map((path) =>
        relative(realpathSync.native(dir.path), path)
          .split(sep)
          .join(posix.sep),
      )
      .sort();

    assert.deepStrictEqual(found, ["a/1.txt", "a/sub/2.txt", "b/3.txt"]);
  });

  it("errors clearly when member roots overlap", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "top.txt");
    write(dir.path, "inner/deep.txt");
    const inner = join(dir.path, "inner");

    // A nested root re-walks files the outer root already yielded; the error
    // names the cause (overlapping folders) rather than a bare invariant.
    assert.throws(() => walkDirs([dir.path, inner], []), /overlap/);
  });

  it("applies patterns relative to each root", async () => {
    await using dir = await mkTmpDir();
    const a = join(dir.path, "a");
    const b = join(dir.path, "b");
    write(a, "drop.tmp");
    write(a, "keep.txt");
    write(b, "drop.tmp");
    write(b, "keep.txt");

    // `*.tmp` is anchored at each root, so both roots' drop.tmp go.
    const found = walkDirs([a, b], ["*.tmp"])
      .map((path) =>
        relative(realpathSync.native(dir.path), path)
          .split(sep)
          .join(posix.sep),
      )
      .sort();

    assert.deepStrictEqual(found, ["a/keep.txt", "b/keep.txt"]);
  });

  it("a trailing slash excludes a directory and everything inside it", async () => {
    await using dir = await mkTmpDir();

    const found = walkWithExcludes(
      dir.path,
      ["build/"],
      ["build/out.js", "build/sub/deep.js", "builder/keep.js"],
    );

    // `builder/` is a different segment and must survive; the walk must not
    // recurse into the excluded `build/`.
    assert.deepStrictEqual(found, ["builder/keep.js"]);
  });
});
