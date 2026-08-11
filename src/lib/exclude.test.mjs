import assert from "node:assert/strict";
import { sep } from "node:path";
import { describe, it } from "node:test";
import { compileExclude } from "./exclude.mjs";

// The glob → RegExp translation, tested directly on strings — no files on disk.
// Patterns are absolute, as the walk passes them (each root joined with the
// root-relative pattern). Walk integration (multi-root, .s3cab skip, directory
// recursion) lives in walk.test.mjs.

/**
 * @param {string} pattern - Absolute exclude glob
 * @param {string} path - `/`-separated path to test
 */
const matches = (pattern, path) => compileExclude(pattern).test(path);

describe("compileExclude", () => {
  it("anchors a pattern to its root, with `*` confined to one segment", () => {
    assert.equal(matches("/root/*.tmp", "/root/scratch.tmp"), true);
    // No `**/` prefix → matches at the root only, and `*` can't cross a segment.
    assert.equal(matches("/root/*.tmp", "/root/sub/nested.tmp"), false);
  });

  it("`**/` matches zero or more whole segments, never a partial one", () => {
    const p = "/root/**/log.txt";
    assert.equal(matches(p, "/root/log.txt"), true);
    assert.equal(matches(p, "/root/a/log.txt"), true);
    assert.equal(matches(p, "/root/a/b/log.txt"), true);
    // Whole segment only — `catalog.txt` must not be swept up.
    assert.equal(matches(p, "/root/catalog.txt"), false);
  });

  it("a `**` with no trailing separator spans segments", () => {
    // Regression: with only the `**/` rule, a trailing `**` fell through to the
    // single-`*` case twice and compiled to `[^/]+[^/]+` — "two or more
    // characters, in one segment", which silently matched almost nothing a user
    // writing `build/**` meant and matched short root-level names they didn't.
    const p = "/root/build/**";
    assert.equal(matches(p, "/root/build/out.js"), true);
    assert.equal(matches(p, "/root/build/sub/deep.js"), true);
    // The directory itself, which the walk tests with a trailing separator.
    assert.equal(matches(p, "/root/build/"), true);
    // Still anchored: a sibling segment is not swept up.
    assert.equal(matches(p, "/root/builder/out.js"), false);

    // A bare `**` is the whole root, which is what the walk joins it to.
    assert.equal(matches("/root/**", "/root/a/b/c.txt"), true);
    // …and the old degenerate reading is gone: a one-character name matched
    // nothing under it, while two characters matched in the root only.
    assert.equal(matches("/root/**", "/root/x"), true);
  });

  it("`?` matches exactly one character", () => {
    const p = "/root/file?.txt";
    assert.equal(matches(p, "/root/file1.txt"), true);
    assert.equal(matches(p, "/root/file.txt"), false);
    assert.equal(matches(p, "/root/file10.txt"), false);
  });

  it("matches case-insensitively on win32, case-sensitively elsewhere", () => {
    assert.equal(
      matches("/root/**/UPPER.txt", "/root/upper.txt"),
      process.platform === "win32",
    );
  });

  it(
    "treats the platform separator in a pattern as a path separator",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    () => {
      // On win32 `join` hands compileExclude a backslash-separated pattern; it
      // must normalize to `/` before the per-segment globs apply.
      const pattern = ["", "base", "sub", "*.tmp"].join(sep);
      assert.equal(matches(pattern, "/base/sub/drop.tmp"), true);
      assert.equal(matches(pattern, "/base/sub/deep/drop.tmp"), false);
    },
  );
});
