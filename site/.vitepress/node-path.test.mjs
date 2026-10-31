import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { posix, win32 } from "./node-path.mjs";

// Patterns as a reader might type them, joined onto the playground's member
// directories the way exclude.mjs joins them.
const patterns = [
  "**/node_modules/",
  "*.log",
  "/build/",
  "//a//b",
  "a/./b/",
  "a/../b",
  "../../x",
  "logs/**",
  ".",
  "..",
  "",
  "photos\\raw/",
  "\\leading\\back",
];

describe("node-path shim", () => {
  it("joins and normalizes as node:path's posix flavour does", () => {
    for (const pattern of patterns) {
      for (const base of ["/member", "/", "member", ""]) {
        assert.equal(
          posix.join(base, pattern),
          path.posix.join(base, pattern),
          `join(${base}, ${pattern})`,
        );
      }
      assert.equal(
        posix.normalize(pattern),
        path.posix.normalize(pattern),
        pattern,
      );
    }
  });

  it("joins onto a drive letter as node:path's win32 flavour does", () => {
    for (const pattern of patterns) {
      for (const base of ["C:\\member", "C:\\", "c:/member/"]) {
        assert.equal(
          win32.join(base, pattern),
          path.win32.join(base, pattern),
          `join(${base}, ${pattern})`,
        );
      }
    }
  });
});
