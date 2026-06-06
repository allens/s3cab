import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { utimes } from "node:fs/promises";
import { describe, it } from "node:test";
import { prop } from "./prop.mjs";

describe("prop", () => {
  it("gets file properties", async () => {
    const filePath = "./test/fixtures/dir1/hello-world.txt";
    const expectedMtime = new Date("2025-01-15T10:30:00.000Z");
    await utimes(filePath, expectedMtime, expectedMtime);

    const { hashDuration, ...props } = await prop(filePath);

    assert.deepEqual(props, {
      size: 12,
      mtime: "2025-01-15T10:30:00.000Z",
      hash: "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a",
    });
    assert.ok(
      hashDuration !== undefined && hashDuration >= 0 && hashDuration <= 100,
    );
  });

  it("gets large file properties", async () => {
    const filePath = "./test/fixtures/dir1/10MB.txt";
    const expectedMtime = new Date("2025-01-15T10:30:00.000Z");
    await utimes(filePath, expectedMtime, expectedMtime);

    const { hashDuration, ...props } = await prop(filePath);

    assert.deepEqual(props, {
      size: 10 * 1024 * 1024,
      mtime: "2025-01-15T10:30:00.000Z",
      hash: "eb6183addde05c2196ce25e6fa34a4baf20f9bf30d33892f452a9a1e88c9a472",
    });
    assert.ok(hashDuration !== undefined && hashDuration > 0);
  });

  it("gets empty file properties", async () => {
    const filePath = "./test/fixtures/dir1/zero-size";
    const expectedMtime = new Date("2025-01-15T10:30:00.000Z");
    const SHA256_EMPTY_STRING = hash("sha256", "", {
      outputEncoding: "hex",
    });
    await utimes(filePath, expectedMtime, expectedMtime);

    const { hashDuration, ...props } = await prop(filePath);

    assert.deepEqual(props, {
      size: 0,
      mtime: "2025-01-15T10:30:00.000Z",
      hash: SHA256_EMPTY_STRING,
    });
    assert.ok(hashDuration !== undefined && hashDuration <= 0.1);
  });

  it("throws for empty file path", async () => {
    await assert.rejects(prop(""), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: <file>",
    });
  });

  it("thows for non-existing file", async () => {
    await assert.rejects(prop("./test/fixtures/dir1/non-existing-file.txt"), {
      code: "ENOENT",
    });
  });

  it("throws for non-regular file", async () => {
    const path = "./test/fixtures/dir1"; // a directory

    await assert.rejects(prop(path), {
      message: `Not a regular file: ${path}`,
    });
  });
});
