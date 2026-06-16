import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPathSegment } from "./home.mjs";

// assertPathSegment is a pure traversal guard (no env/home dependency): a name
// interpolated into a path under s3cabDir() must be a single path segment, or a
// hostile value could traverse out of ~/.s3cab. The error message carries the
// caller's `kind` noun.

describe("assertPathSegment", () => {
  it("returns a clean single-segment name unchanged", () => {
    assert.equal(assertPathSegment("my-bucket", "bucket name"), "my-bucket");
  });

  it("allows dots, which are not path separators", () => {
    assert.equal(
      assertPathSegment("my.bucket.v2", "bucket name"),
      "my.bucket.v2",
    );
  });

  it("rejects a forward-slash separator", () => {
    assert.throws(() => assertPathSegment("a/b", "set name"), {
      message: "Invalid set name (contains a path separator): a/b",
    });
  });

  it("rejects a traversal attempt out of ~/.s3cab", () => {
    assert.throws(
      () => assertPathSegment("a/../../../etc/passwd", "bucket name"),
      {
        message: /^Invalid bucket name \(contains a path separator\):/,
      },
    );
  });

  it("rejects a leading separator", () => {
    assert.throws(
      () => assertPathSegment("/abs", "bucket name"),
      /path separator/,
    );
  });
});
