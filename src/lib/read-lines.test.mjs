import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLines } from "./read-lines.mjs";

describe("parseLines", () => {
  it("keeps active lines, dropping blanks and comments (even indented)", () => {
    const text = "# header\n**/node_modules/\n\n  # indented\n  **/.git/  \n";
    assert.deepEqual(parseLines(text), ["**/node_modules/", "**/.git/"]);
  });

  it("returns an empty array when nothing is active", () => {
    assert.deepEqual(parseLines("# only\n\n# comments\n"), []);
  });
});
