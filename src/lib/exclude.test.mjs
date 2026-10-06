import assert from "node:assert/strict";
import { sep } from "node:path";
import { describe, it } from "node:test";
import { compileExcludePatterns } from "./exclude.mjs";

// The whole match — patterns joined to a root, the glob → RegExp translation and
// the path's side of it — tested directly on strings, no files on disk. Walk
// integration (multi-root, .s3cab skip, not descending into an excluded
// directory) lives in walk.test.mjs.

/**
 * @param {string[]} patterns - Root-relative exclude globs, rooted at `/root`
 * @param {string} path - Path to test
 * @param {boolean} [isDirectory]
 */
const excludedBy = (patterns, path, isDirectory = false) =>
  compileExcludePatterns("/root", patterns)(path, isDirectory);

describe("compileExcludePatterns", () => {
  it("anchors a pattern to its root, with `*` confined to one segment", () => {
    assert.equal(excludedBy(["*.tmp"], "/root/scratch.tmp"), "*.tmp");
    // No `**/` prefix → matches at the root only, and `*` can't cross a segment.
    assert.equal(excludedBy(["*.tmp"], "/root/sub/nested.tmp"), undefined);
  });

  it("`**/` matches zero or more whole segments, never a partial one", () => {
    const p = ["**/log.txt"];
    assert.equal(excludedBy(p, "/root/log.txt"), "**/log.txt");
    assert.equal(excludedBy(p, "/root/a/log.txt"), "**/log.txt");
    assert.equal(excludedBy(p, "/root/a/b/log.txt"), "**/log.txt");
    // Whole segment only — `catalog.txt` must not be swept up.
    assert.equal(excludedBy(p, "/root/catalog.txt"), undefined);
  });

  it("a `**` with no trailing separator spans segments", () => {
    // Regression: with only the `**/` rule, a trailing `**` fell through to the
    // single-`*` case twice and compiled to `[^/]+[^/]+` — "two or more
    // characters, in one segment", which silently matched almost nothing a user
    // writing `build/**` meant and matched short root-level names they didn't.
    const p = ["build/**"];
    assert.equal(excludedBy(p, "/root/build/out.js"), "build/**");
    assert.equal(excludedBy(p, "/root/build/sub/deep.js"), "build/**");
    assert.equal(excludedBy(p, "/root/build", true), "build/**");
    // Still anchored: a sibling segment is not swept up.
    assert.equal(excludedBy(p, "/root/builder/out.js"), undefined);

    // A bare `**` is the whole root.
    assert.equal(excludedBy(["**"], "/root/a/b/c.txt"), "**");
    // …and the old degenerate reading is gone: a one-character name matched
    // nothing under it, while two characters matched in the root only.
    assert.equal(excludedBy(["**"], "/root/x"), "**");
  });

  it("a trailing `/` names a directory, and only a directory", () => {
    assert.equal(excludedBy(["build/"], "/root/build", true), "build/");
    assert.equal(excludedBy(["build/"], "/root/build"), undefined);
    // …and its absence names only a file.
    assert.equal(excludedBy(["build"], "/root/build"), "build");
    assert.equal(excludedBy(["build"], "/root/build", true), undefined);
  });

  it("`?` matches exactly one character", () => {
    const p = ["file?.txt"];
    assert.equal(excludedBy(p, "/root/file1.txt"), "file?.txt");
    assert.equal(excludedBy(p, "/root/file.txt"), undefined);
    assert.equal(excludedBy(p, "/root/file10.txt"), undefined);
  });

  it("answers with the first matching pattern, in the order given", () => {
    assert.equal(excludedBy(["*.log", "**/*"], "/root/a.log"), "*.log");
    assert.equal(excludedBy(["**/*", "*.log"], "/root/a.log"), "**/*");
    assert.equal(excludedBy([], "/root/a.log"), undefined);
  });

  it("matches case-insensitively on win32, case-sensitively elsewhere", () => {
    assert.equal(
      excludedBy(["**/UPPER.txt"], "/root/upper.txt"),
      process.platform === "win32" ? "**/UPPER.txt" : undefined,
    );
  });

  it(
    "treats the platform separator as a path separator, in patterns and paths",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    () => {
      // On win32 the walk hands over backslash-separated paths, and a user may
      // write a pattern either way; both must reach `/` before the per-segment
      // globs apply.
      const path = (/** @type {string[]} */ ...parts) =>
        ["", ...parts].join(sep);
      const matcher = compileExcludePatterns(path("base"), ["sub\\*.tmp"]);
      assert.equal(
        matcher(path("base", "sub", "drop.tmp"), false),
        "sub\\*.tmp",
      );
      assert.equal(
        matcher(path("base", "sub", "deep", "drop.tmp"), false),
        undefined,
      );
    },
  );
});
