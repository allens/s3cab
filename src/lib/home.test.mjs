import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPathSegment } from "./home.mjs";

// assertPathSegment is a pure traversal guard (no env/home dependency): a name
// interpolated into a path under s3cabDir() must be a single, ordinary path
// segment, or a hostile value could traverse out of ~/.s3cab — via a separator,
// or via the relative `.`/`..` segments that `join` resolves out of a dir
// without a separator. The error message carries the caller's `kind` noun.

describe("assertPathSegment", () => {
  it("returns a clean single-segment name unchanged", () => {
    assert.equal(assertPathSegment("my-bucket", "bucket name"), "my-bucket");
  });

  it("allows periods within a segment", () => {
    assert.equal(
      assertPathSegment("my.bucket.v2", "bucket name"),
      "my.bucket.v2",
    );
  });

  it("rejects a forward-slash separator", () => {
    assert.throws(() => assertPathSegment("a/b", "set name"), {
      message: "Invalid set name (not a single path segment): a/b",
    });
  });

  it("rejects a traversal attempt out of ~/.s3cab", () => {
    assert.throws(
      () => assertPathSegment("a/../../../etc/passwd", "bucket name"),
      { message: /^Invalid bucket name \(not a single path segment\):/ },
    );
  });

  it("rejects a leading separator", () => {
    assert.throws(
      () => assertPathSegment("/abs", "bucket name"),
      /not a single path segment/,
    );
  });

  // `..` / `.` carry no separator (basename leaves them unchanged), so they slip
  // past a separator-only check yet `join(dir, "..")` escapes dir — the gap the
  // explicit segment checks close.
  it("rejects the parent-directory segment `..`", () => {
    assert.throws(
      () => assertPathSegment("..", "set name"),
      /not a single path segment/,
    );
  });

  it("rejects the current-directory segment `.`", () => {
    assert.throws(
      () => assertPathSegment(".", "set name"),
      /not a single path segment/,
    );
  });

  it("rejects the empty string", () => {
    assert.throws(
      () => assertPathSegment("", "set name"),
      /not a single path segment/,
    );
  });
});
