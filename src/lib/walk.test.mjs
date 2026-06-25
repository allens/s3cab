import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { walkDirs } from "./walk.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// These exercise the walk core `walkDirs(dirs, patterns)` directly: multi-root
// accumulation into `{ files, excluded }`, the always-skip `.s3cab`, overlap
// detection, directory recursion, and the exclusion records the walk hands back
// as data. The glob → RegExp semantics are unit-tested in exclude.test.mjs.

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
 * Make absolute paths relative to `root`, `/`-separated and sorted.
 * @param {string} root
 * @param {string[]} paths
 */
const relPaths = (root, paths) =>
  paths.map((path) => relative(root, path).split(sep).join(posix.sep)).sort();

/**
 * Create the given files under `base`, walk it with the given patterns, and
 * return what survived — relative to the root, `/`-separated, sorted.
 * @param {string} base
 * @param {string[]} patterns - Exclude patterns.
 * @param {string[]} paths - Files to create (always `/`-separated).
 */
function walkWithExcludes(base, patterns, paths) {
  for (const path of paths) {
    write(base, path);
  }
  const root = realpathSync.native(base);
  return relPaths(root, walkDirs([base], patterns).files);
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
    const found = relPaths(
      root,
      walkDirs([base], ["**/*.tmp", "**/.DS_Store", "**/Thumbs.db"]).files,
    );

    assert.deepStrictEqual(found, ["keep.txt", "sub/keep.txt"]);
  });

  it("walks several roots into one list", async () => {
    await using dir = await mkTmpDir();
    const a = join(dir.path, "a");
    const b = join(dir.path, "b");
    write(a, "1.txt");
    write(a, "sub/2.txt");
    write(b, "3.txt");

    const found = relPaths(
      realpathSync.native(dir.path),
      walkDirs([a, b], []).files,
    );

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
    const found = relPaths(
      realpathSync.native(dir.path),
      walkDirs([a, b], ["*.tmp"]).files,
    );

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

  it("hands back exclusion records (the matched pattern and dirent type) as data", async () => {
    await using dir = await mkTmpDir();
    const base = dir.path;
    write(base, "keep.txt");
    write(base, "scratch.tmp");
    // An excluded directory yields ONE record (the walk doesn't recurse into
    // it), not one per file inside — so its contents never reach `excluded`.
    write(base, "build/out.js");
    write(base, "build/sub/deep.js");

    const root = realpathSync.native(base);
    const { files, excluded } = walkDirs([base], ["**/*.tmp", "build/"]);

    assert.deepStrictEqual(relPaths(root, files), ["keep.txt"]);

    const records = excluded
      .map(({ fileType, reason, path }) => ({
        fileType,
        reason,
        path: relative(root, path).split(sep).join(posix.sep),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(records, [
      { fileType: "Directory", reason: "build/", path: "build" },
      { fileType: "File", reason: "**/*.tmp", path: "scratch.tmp" },
    ]);
  });

  it("returns no exclusion records when no patterns are given", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "a.txt");
    write(dir.path, "b.tmp");

    // With an empty pattern list the walk does no matching at all, so nothing
    // is recorded as excluded (everything is kept).
    const { files, excluded } = walkDirs([dir.path], []);
    assert.equal(files.length, 2);
    assert.deepStrictEqual(excluded, []);
  });

  it(
    "records unsupported file types in skipped (not excluded), never in files",
    {
      skip:
        process.platform === "win32"
          ? "symlink creation requires Developer Mode on Windows"
          : false,
    },
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "regular.txt");
      // Symlinks are an unsupported type: they can't be content-addressed without
      // deciding whether to follow them (and may create cycles). They belong in
      // `skipped` (by-design, not backupable), not `excluded` (user-pattern match)
      // and not `files` — regardless of whether patterns exist.
      symlinkSync(join(base, "regular.txt"), join(base, "link.txt"));

      const root = realpathSync.native(base);

      // With patterns: symlink lands in skipped, not excluded
      const withPatterns = walkDirs([base], ["*.tmp"]);
      assert.deepStrictEqual(relPaths(root, withPatterns.files), [
        "regular.txt",
      ]);
      assert.deepStrictEqual(withPatterns.excluded, []);
      assert.equal(withPatterns.skipped.length, 1);
      const [wp0] = withPatterns.skipped;
      assert.ok(wp0);
      assert.equal(wp0.reason, "Unsupported file type");
      assert.equal(wp0.fileType, "SymbolicLink");

      // Without patterns: same — still goes to skipped, not silently passed through
      const noPatterns = walkDirs([base], []);
      assert.deepStrictEqual(relPaths(root, noPatterns.files), ["regular.txt"]);
      assert.deepStrictEqual(noPatterns.excluded, []);
      assert.equal(noPatterns.skipped.length, 1);
      const [np0] = noPatterns.skipped;
      assert.ok(np0);
      assert.equal(np0.reason, "Unsupported file type");
    },
  );
});
