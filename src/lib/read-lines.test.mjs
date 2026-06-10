import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readLines } from "./read-lines.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

describe("readLines", () => {
  it("returns non-empty, non-comment lines with whitespace trimmed", async () => {
    await using dir = await mkTmpDir();
    const file = join(dir.path, "test.txt");
    writeFileSync(file, "# comment\nline1\n\n  line2  \n# another comment\nline3\n");

    assert.deepEqual(readLines(file), ["line1", "line2", "line3"]);
  });

  it("returns empty array for a file with only comments and blank lines", async () => {
    await using dir = await mkTmpDir();
    const file = join(dir.path, "empty.txt");
    writeFileSync(file, "# comment\n\n# another\n");

    assert.deepEqual(readLines(file), []);
  });

  it("returns empty array for an empty file", async () => {
    await using dir = await mkTmpDir();
    const file = join(dir.path, "zero.txt");
    writeFileSync(file, "");

    assert.deepEqual(readLines(file), []);
  });
});
