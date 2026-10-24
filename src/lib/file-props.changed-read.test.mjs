import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it, mock } from "node:test";

// `fileProps` refuses a file whose read returns another number of bytes than
// its `lstat` reported, so the hash pass gives it an `#error` row. A file
// changing between the two can't be timed in a test, so `lstatSync` is faked to
// report the size; the other two functions `file-props.mjs` imports are the real
// ones, for the read. Mocks first, then a dynamic import.

/** @type {bigint | undefined} */
let size;

mock.module("node:fs", {
  exports: {
    createReadStream: fs.createReadStream,
    readFileSync: fs.readFileSync,
    lstatSync: (/** @type {string} */ path, /** @type {object} */ options) => {
      const stat = fs.lstatSync(path, options);
      return size === undefined ? stat : Object.assign(stat, { size });
    },
  },
});

const { fileProps } = await import("./file-props.mjs");

const FILE = "./test/fixtures/dir1/hello-world.txt";

describe("fileProps and a file that changed while it was read", () => {
  it("reads a file whose bytes match its size", async () => {
    size = undefined;
    const props = await fileProps(FILE);
    assert.equal(props.size, fs.statSync(FILE).size);
  });

  it("refuses one read whole, and one streamed, naming the file", async () => {
    const real = fs.statSync(FILE).size;
    // Only the streamed read reports its start, so each case proves its branch.
    for (const [reported, streamed] of [
      [1n, false],
      [5_000_000n, true],
    ]) {
      size = /** @type {bigint} */ (reported);
      let started = false;
      await assert.rejects(
        () =>
          fileProps(FILE, undefined, { onHashStart: () => (started = true) }),
        new RegExp(
          `^ChangedWhileReadError: File changed while it was read \\(read ${real} bytes; its size was ${reported}\\): .*hello-world\\.txt$`,
        ),
      );
      assert.equal(started, streamed);
    }
  });
});
