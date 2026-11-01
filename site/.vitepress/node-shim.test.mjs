import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { it } from "node:test";

import { posix as shim, win32 as shimWin32 } from "./node-shim.mjs";

// Exclude patterns as a reader might type them, joined onto the exclude
// playground's member directories the way exclude.mjs joins them.
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

it("joins as node:path's posix flavour does", () => {
  for (const pattern of patterns) {
    for (const base of ["/member", "/", "member", ""]) {
      assert.equal(
        shim.join(base, pattern),
        posix.join(base, pattern),
        `join(${base}, ${pattern})`,
      );
    }
  }
});

it("joins onto a drive letter as node:path's win32 flavour does", () => {
  for (const pattern of patterns) {
    for (const base of ["C:\\member", "C:\\", "c:/member/"]) {
      assert.equal(
        shimWin32.join(base, pattern),
        win32.join(base, pattern),
        `join(${base}, ${pattern})`,
      );
    }
  }
});

it("normalizes every short path exactly as node:path does", () => {
  // Every string of up to six of these characters: each way `.`, `..`, runs of
  // `/` and a trailing `/` can meet, and a `\`, which POSIX leaves alone.
  /** @type {string[]} */
  let layer = [""];
  const all = [""];
  for (let length = 1; length <= 6; length++) {
    layer = layer.flatMap((prefix) =>
      ["a", ".", "/", "\\"].map((c) => prefix + c),
    );
    all.push(...layer);
  }
  const differing = all.filter(
    (path) => shim.normalize(path) !== posix.normalize(path),
  );
  assert.deepEqual(differing, []);
});
