import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ParseArgsError,
  ValidationError,
  isInputError,
  isUsageError,
  notImplemented,
  requireArg,
} from "./error.mjs";

describe("ParseArgsError", () => {
  it("sets ERR_PARSE_ARGS code and message", () => {
    const err = new ParseArgsError("bad arg");
    assert.equal(err.code, "ERR_PARSE_ARGS");
    assert.equal(err.message, "bad arg");
    assert.ok(err instanceof Error);
  });
});

describe("requireArg", () => {
  it("throws ParseArgsError when value is absent, wrapping the plain name", () => {
    assert.throws(() => requireArg(undefined, "bucket"), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: <bucket>",
    });
  });

  it("tags the error with the plain argName for the description lookup", () => {
    assert.throws(
      () => requireArg(undefined, "bucket"),
      (err) => err instanceof ParseArgsError && err.argName === "bucket",
    );
  });

  it("throws ParseArgsError when value is empty string", () => {
    assert.throws(() => requireArg("", "file"), { code: "ERR_PARSE_ARGS" });
  });

  it("does not throw when value is present", () => {
    assert.doesNotThrow(() => requireArg("something", "bucket"));
  });
});

describe("isUsageError", () => {
  it("returns true for ParseArgsError", () => {
    assert.ok(isUsageError(new ParseArgsError("test")));
  });

  it("returns true for any ERR_PARSE_ARGS* failure, not just unknown option", () => {
    for (const code of [
      "ERR_PARSE_ARGS_UNKNOWN_OPTION",
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", // e.g. `--bucket` given no value
      "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
    ]) {
      assert.ok(isUsageError(Object.assign(new Error(code), { code })), code);
    }
  });

  it("returns false for a generic Error", () => {
    assert.equal(isUsageError(new Error("generic")), false);
  });

  it("returns false for non-error values", () => {
    assert.equal(isUsageError(null), false);
    assert.equal(isUsageError("string"), false);
  });

  it("does not treat a ValidationError as a usage (print-usage) error", () => {
    // A bad value exits 2 but carries its own fix, so usage is NOT printed.
    assert.equal(isUsageError(new ValidationError("bad value")), false);
  });
});

describe("isInputError", () => {
  it("is true for every usage error (the structural subset)", () => {
    assert.ok(isInputError(new ParseArgsError("test")));
    assert.ok(
      isInputError(
        Object.assign(new Error("x"), {
          code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
        }),
      ),
    );
  });

  it("is true for a value ValidationError (exit 2, no usage dump)", () => {
    assert.ok(isInputError(new ValidationError("bad value")));
  });

  it("is false for a runtime error and non-errors", () => {
    assert.equal(isInputError(new Error("network down")), false);
    assert.equal(isInputError(null), false);
  });
});

describe("notImplemented", () => {
  it("throws with the feature name in the message", () => {
    assert.throws(() => notImplemented("backup"), {
      message: /Not yet implemented: backup/,
    });
  });
});
