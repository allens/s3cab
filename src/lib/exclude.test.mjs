import assert from "node:assert/strict";
import { sep } from "node:path";
import { describe, it } from "node:test";
import {
  compileExcludePatterns,
  exactPattern,
  parseExclude,
} from "./exclude.mjs";
import { ESCAPES } from "./path-match.mjs";

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

  it("`**/` stuck to a name is a plain `**`, which can't join the two", () => {
    const p = ["photos**/raw"];
    assert.equal(excludedBy(p, "/root/photos/raw"), "photos**/raw");
    assert.equal(excludedBy(p, "/root/photos2024/raw"), "photos**/raw");
    assert.equal(excludedBy(p, "/root/photos2024/a/raw"), "photos**/raw");
    assert.equal(excludedBy(p, "/root/photosraw"), undefined);
    // Two in a row each start a segment, so both may match nothing.
    assert.equal(excludedBy(["a/**/**/b"], "/root/a/b"), "a/**/**/b");
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
    // An emoji is one character, though JavaScript stores it as two.
    const emoji = String.fromCodePoint(0x1f389);
    assert.equal(excludedBy(p, `/root/file${emoji}.txt`), "file?.txt");
  });

  it("answers with the first matching pattern, in the order given", () => {
    assert.equal(excludedBy(["*.log", "**/*"], "/root/a.log"), "*.log");
    assert.equal(excludedBy(["**/*", "*.log"], "/root/a.log"), "**/*");
    assert.equal(excludedBy([], "/root/a.log"), undefined);
  });

  it("ignores case on Windows and macOS, as their filesystems do, and not on Linux", () => {
    const expected = (/** @type {string} */ pattern) =>
      process.platform === "linux" ? undefined : pattern;
    assert.equal(
      excludedBy(["**/UPPER.txt"], "/root/upper.txt"),
      expected("**/UPPER.txt"),
    );
    // A letter JavaScript stores as two units (Deseret capital and small I).
    const upper = String.fromCodePoint(0x10400);
    const lower = String.fromCodePoint(0x10428);
    assert.equal(excludedBy([upper], `/root/${lower}`), expected(upper));
  });

  it("ignores how an accent is spelled on macOS, as APFS does, and nowhere else", () => {
    // Built with normalize(): typed out, the two spellings look identical.
    const oneChar = "caf\u00e9.txt".normalize("NFC");
    const withMark = "caf\u00e9.txt".normalize("NFD");
    assert.notEqual(oneChar, withMark);
    const expected = (/** @type {string} */ pattern) =>
      process.platform === "darwin" ? pattern : undefined;
    assert.equal(excludedBy([oneChar], `/root/${withMark}`), expected(oneChar));
    assert.equal(
      excludedBy([withMark], `/root/${oneChar}`),
      expected(withMark),
    );
  });

  it("matches like the platform it is given, whatever machine runs it", () => {
    /**
     * @param {NodeJS.Platform} platform
     * @param {string} base
     * @param {string} pattern
     * @param {string} path
     */
    const on = (platform, base, pattern, path) =>
      compileExcludePatterns(base, [pattern], platform)(path, false);
    // Windows: `\` separates, case folds.
    assert.equal(
      on("win32", "C:\\root", "sub\\*.TMP", "C:\\root\\sub\\a.tmp"),
      "sub\\*.TMP",
    );
    // macOS: case and accent spelling fold.
    assert.equal(
      on("darwin", "/root", "UPPER.txt", "/root/upper.txt"),
      "UPPER.txt",
    );
    const oneChar = "caf\u00e9".normalize("NFC");
    const withMark = "caf\u00e9".normalize("NFD");
    assert.equal(on("darwin", "/root", oneChar, `/root/${withMark}`), oneChar);
    // Linux: neither folds, and `\` is a filename character.
    assert.equal(
      on("linux", "/root", "UPPER.txt", "/root/upper.txt"),
      undefined,
    );
    assert.equal(on("linux", "/root", oneChar, `/root/${withMark}`), undefined);
    assert.equal(
      on("linux", "/root", "sub\\*.tmp", "/root/sub/a.tmp"),
      undefined,
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

describe("compileExcludePatterns escapes (ADR-0115)", () => {
  it(
    "makes the character after a \\ match only itself",
    { skip: !ESCAPES && "\\ is a separator on Windows" },
    () => {
      assert.equal(excludedBy(["a\\*b"], "/root/a*b"), "a\\*b");
      assert.equal(excludedBy(["a\\*b"], "/root/axyb"), undefined);
      assert.equal(excludedBy(["a\\?b"], "/root/a?b"), "a\\?b");
      assert.equal(excludedBy(["a\\?b"], "/root/axb"), undefined);
      assert.equal(
        excludedBy(["back\\\\slash"], "/root/back\\slash"),
        "back\\\\slash",
      );
      // An escaped `*` is a name, so it can't start a `**/`.
      assert.equal(excludedBy(["\\**/x"], "/root/a/x"), undefined);
      assert.equal(excludedBy(["\\**/x"], "/root/*a/x"), "\\**/x");
    },
  );

  it(
    "reads the member directory as a path, not a pattern",
    { skip: !ESCAPES && "no name holds \\, * or ? through Win32" },
    () => {
      for (const root of [
        "/home/me/odd\\dir",
        "/home/me/a*b",
        "/home/me/a?b",
      ]) {
        const match = compileExcludePatterns(root, ["*.tmp"]);
        assert.equal(match(`${root}/x.tmp`, false), "*.tmp", root);
      }
      const star = compileExcludePatterns("/home/me/a*b", ["*.tmp"]);
      assert.equal(star("/home/me/axyb/x.tmp", false), undefined);
    },
  );

  it(
    "takes \\ as a separator on Windows",
    { skip: ESCAPES && "\\ escapes off Windows" },
    () => {
      assert.equal(excludedBy(["sub\\a.txt"], "/root/sub/a.txt"), "sub\\a.txt");
      assert.equal(excludedBy(["\\#notes"], "/root/#notes"), "\\#notes");
    },
  );
});

describe("parseExclude", () => {
  it("reads lines as parseLines does", () => {
    const text =
      "# header\n**/node_modules/\r\n\n  # indented\n\t# tabbed\n  **/.git/  \n";
    assert.deepEqual(parseExclude(text), ["**/node_modules/", "**/.git/"]);
  });

  it(
    "keeps a space escaped at the end of a line",
    { skip: !ESCAPES && "\\ is a separator on Windows" },
    () => {
      assert.deepEqual(parseExclude("notes\\ \nold\\  \r\n"), [
        "notes\\ ",
        "old\\ ",
      ]);
      // A tab is a control character, which a \ doesn't escape.
      assert.deepEqual(parseExclude("notes\\\t\nfine\\\\ \n"), [
        "notes\\",
        "fine\\\\",
      ]);
    },
  );
});

describe("exactPattern", () => {
  // Each name, and one its line must not match.
  const names = /** @type {[string, string][]} */ ([
    ["a b.txt", "ab.txt"],
    ["[draft] {v2}!.txt", "d"],
    ["notes#1.txt", "notes"],
    ["#notes", "notes"],
    [" lead", "lead"],
    ["  two", " two"],
    ["sub/#notes", "sub/notes"],
    ...(ESCAPES
      ? [
          ["a*b", "axyb"],
          ["a?b", "axb"],
          ["**", "a"],
          ["back\\slash", "back/slash"],
          ["trail ", "trail"],
          [" both ", "both"],
          ["two  ", "two "],
        ]
      : []),
  ]);

  it("spells a path so exclude.txt reads it back as a line naming only it", () => {
    for (const [rel, other] of names) {
      const pattern = /** @type {string} */ (exactPattern(rel));
      const lines = parseExclude(`${pattern}\n`);
      assert.deepEqual(lines, [pattern], JSON.stringify(rel));
      assert.equal(excludedBy(lines, `/root/${rel}`), pattern, rel);
      assert.equal(excludedBy(lines, `/root/${other}`), undefined, rel);
    }
  });

  it("writes a leading # or space after a \\ on every system", () => {
    assert.equal(exactPattern("#notes"), "\\#notes");
    assert.equal(exactPattern(" lead"), "\\ lead");
  });

  it("has no line for a name holding a control character", () => {
    for (const rel of ["a\tb", "a\rb", "a\nb", "a\x1bb", "a\x7fb", "a\x9bb"]) {
      assert.equal(exactPattern(rel), undefined, JSON.stringify(rel));
    }
  });

  it(
    "has no line on Windows for a name ending in a space, or holding * or ?",
    { skip: ESCAPES && "\\ escapes off Windows" },
    () => {
      // Win32 refuses `*` and `?`, but a share or WSL can make such a name.
      for (const rel of ["trail ", "a*b", "a?b"]) {
        assert.equal(exactPattern(rel), undefined, JSON.stringify(rel));
      }
    },
  );
});
