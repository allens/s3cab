import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ParseArgsError, isUsageError, notImplemented, requireArg } from "./error.mjs";

describe("ParseArgsError", () => {
  it("sets ERR_PARSE_ARGS code and message", () => {
    const err = new ParseArgsError("bad arg");
    assert.equal(err.code, "ERR_PARSE_ARGS");
    assert.equal(err.message, "bad arg");
    assert.ok(err instanceof Error);
  });
});

describe("requireArg", () => {
  it("throws ParseArgsError when value is absent", () => {
    assert.throws(() => requireArg(undefined, "<bucket>"), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: <bucket>",
    });
  });

  it("throws ParseArgsError when value is empty string", () => {
    assert.throws(() => requireArg("", "<file>"), { code: "ERR_PARSE_ARGS" });
  });

  it("does not throw when value is present", () => {
    assert.doesNotThrow(() => requireArg("something", "<bucket>"));
  });
});

describe("isUsageError", () => {
  it("returns true for ParseArgsError", () => {
    assert.ok(isUsageError(new ParseArgsError("test")));
  });

  it("returns true for ERR_PARSE_ARGS_UNKNOWN_OPTION errors", () => {
    const err = Object.assign(new Error("unknown option"), {
      code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    });
    assert.ok(isUsageError(err));
  });

  it("returns false for a generic Error", () => {
    assert.equal(isUsageError(new Error("generic")), false);
  });

  it("returns false for non-error values", () => {
    assert.equal(isUsageError(null), false);
    assert.equal(isUsageError("string"), false);
  });
});

describe("notImplemented", () => {
  it("throws with the feature name in the message", () => {
    assert.throws(() => notImplemented("backup"), {
      message: /Not yet implemented: backup/,
    });
  });
});
