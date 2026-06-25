import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expiredCredentialsError, isExpiredCredentials } from "./auth.mjs";

/** An error carrying the AWS-style `name` the SDK sets from the service code. */
const named = (/** @type {string} */ name) =>
  Object.assign(new Error("The provided token has expired."), { name });

describe("isExpiredCredentials", () => {
  it("recognizes S3's ExpiredToken and STS's ExpiredTokenException", () => {
    assert.equal(isExpiredCredentials(named("ExpiredToken")), true);
    assert.equal(isExpiredCredentials(named("ExpiredTokenException")), true);
  });

  it("ignores unrelated errors and non-errors", () => {
    assert.equal(isExpiredCredentials(named("AccessDenied")), false);
    assert.equal(isExpiredCredentials(new Error("plain")), false);
    assert.equal(isExpiredCredentials("ExpiredToken"), false);
    assert.equal(isExpiredCredentials(undefined), false);
  });
});

describe("expiredCredentialsError", () => {
  it("carries an actionable, goal-framed message and keeps the cause", () => {
    const cause = named("ExpiredToken");
    const error = expiredCredentialsError(cause);
    assert.equal(error.cause, cause); // original kept for the debug path
    // Goal-framed headline, no AWS code/jargon up front (ADR-0030).
    assert.match(error.message, /^Your AWS credentials have expired\./);
    // The exact, copy-pasteable refresh command.
    assert.match(error.message, /aws sso login/);
  });
});
