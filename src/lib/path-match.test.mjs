import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldsCase, preparePath } from "./path-match.mjs";

// The path-spelling question, tested on literal paths of every shape from one
// run — a Windows path must be read as Windows on Linux and a POSIX one as
// POSIX on Windows, and only literal strings can assert both at once. The glob
// grammar (`globSource`) is covered through its two consumers, exclude.test.mjs
// and find.test.mjs, whose anchoring is the part that differs.

describe("foldsCase", () => {
  it("folds a drive-letter path under either separator", () => {
    assert.equal(foldsCase("C:\\Users\\me\\a.txt"), true);
    assert.equal(foldsCase("c:/Users/me/a.txt"), true);
  });

  it("folds a UNC path under either separator", () => {
    assert.equal(foldsCase("\\\\nas\\photos\\a.jpg"), true);
    assert.equal(foldsCase("//nas/photos/a.jpg"), true);
  });

  it("does not fold a POSIX path", () => {
    assert.equal(foldsCase("/home/me/a.txt"), false);
    // A single leading backslash is an ordinary POSIX filename, not a root.
    assert.equal(foldsCase("\\home"), false);
    assert.equal(foldsCase("C\\Users"), false);
  });
});

describe("preparePath", () => {
  it("normalizes a drive-letter path's separators and folds its case", () => {
    assert.deepEqual(preparePath("C:\\Users\\me\\a.txt"), {
      path: "C:/Users/me/a.txt",
      base: "a.txt",
      foldCase: true,
    });
  });

  it("reads a UNC path as Windows-shaped for both questions", () => {
    // The one that was silently wrong: a UNC root is not a drive letter, and
    // deciding the separator rule from the drive-letter test left its
    // backslashes in place and its basename as the whole path.
    assert.deepEqual(preparePath("\\\\nas\\photos\\2019\\beach.jpg"), {
      path: "//nas/photos/2019/beach.jpg",
      base: "beach.jpg",
      foldCase: true,
    });
  });

  it("cuts the basename at either separator in a Windows path", () => {
    assert.equal(preparePath("C:\\a/b\\c.txt").base, "c.txt");
    assert.equal(preparePath("C:\\a\\b/c.txt").base, "c.txt");
  });

  it("treats a backslash in a POSIX path as an ordinary character", () => {
    assert.deepEqual(preparePath("/home/me/we\\ird"), {
      path: "/home/me/we\\ird",
      base: "we\\ird",
      foldCase: false,
    });
  });
});
