import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it, mock } from "node:test";

// `fileProps` refuses a modification time the 24-character form can't hold, so
// the hash pass gives the file an `#error` row. No filesystem the suite runs on
// holds such a time, so `lstatSync` is faked to report one; the other two
// functions `file-props.mjs` imports are the real ones, for the hash. Mocks
// first, then a dynamic import.

/** @type {bigint} */
let mtimeNs = 0n;

mock.module("node:fs", {
  exports: {
    createReadStream: fs.createReadStream,
    readFileSync: fs.readFileSync,
    lstatSync: (/** @type {string} */ path, /** @type {object} */ options) =>
      Object.assign(fs.lstatSync(path, options), { mtimeNs }),
  },
});

const { fileProps } = await import("./file-props.mjs");

const FILE = "./test/fixtures/dir1/hello-world.txt";
const ns = (/** @type {string} */ iso) => BigInt(Date.parse(iso)) * 1_000_000n;

describe("fileProps refuses a time outside the years 0000 to 9999", () => {
  it("keeps both edges", async () => {
    for (const [at, mtime] of [
      [ns("0000-01-01T00:00:00.000Z") - 500_000n, "0000-01-01T00:00:00.000Z"],
      [ns("9999-12-31T23:59:59.999Z") + 499_999n, "9999-12-31T23:59:59.999Z"],
    ]) {
      mtimeNs = /** @type {bigint} */ (at);
      const props = await fileProps(FILE);
      assert.equal(props.mtime, mtime);
    }
  });

  it("refuses past them, naming the file, even where no Date can be built", async () => {
    for (const at of [
      ns("0000-01-01T00:00:00.000Z") - 500_001n,
      ns("9999-12-31T23:59:59.999Z") + 500_000n, // rounds into year 10000
      10n ** 25n, // about year 316 million
    ]) {
      mtimeNs = at;
      await assert.rejects(
        () => fileProps(FILE),
        /^Error: Modification time outside the years 0000 to 9999, which a snapshot can't hold: .*hello-world\.txt$/,
      );
    }
  });
});
