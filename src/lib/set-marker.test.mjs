import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// The pure prefix builder plus the dirs.txt parse, with the s3.mjs seam mocked
// (docs/design/testing.md: "mock at s3.mjs, not the AWS SDK"). The remote
// marker's real S3 behaviour (claim, listing, config publish) is exercised
// against a real bucket in test/integration/set-marker.test.mjs. Same
// load-bearing ordering rule as objects.test.mjs: register the mock first,
// import set-marker.mjs dynamically — no static import of it.

/** @type {Record<string, string | undefined>} */
let remoteText = {};
// Only the read the parse tests need; the marker's writes are exercised against
// a real bucket, not claimed here.
mock.module("./s3.mjs", {
  exports: s3Seam({
    getText: async (/** @type {string} */ uri) => remoteText[uri],
  }),
});
const { readSetConfig, remoteSetPrefix } = await import("./set-marker.mjs");

describe("remoteSetPrefix", () => {
  it("places a set's marker under sets/<set>/", () => {
    assert.equal(remoteSetPrefix("photos"), "sets/photos/");
  });
});

describe("readSetConfig", () => {
  it("drops comment and blank lines in the remote dirs.txt", async () => {
    // The remote dirs.txt mirrors the local one, so a commented-out directory
    // pushed by `sets` must not come back as a literal `# …` path for
    // `reattach` to walk.
    remoteText = {
      "s3://b/sets/photos/dirs.txt":
        "# C:\\Retired\n\nC:\\Photos\n  # indented note\n",
    };

    assert.deepEqual(await readSetConfig("b", "photos"), {
      dirs: ["C:\\Photos"],
      exclude: undefined,
    });
  });
});
