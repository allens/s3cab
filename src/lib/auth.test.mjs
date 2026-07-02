import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessDeniedError,
  badSignatureError,
  clockSkewError,
  expiredCredentialsError,
  invalidCredentialsError,
  isAccessDenied,
  isBadSignature,
  isClockSkew,
  isExpiredCredentials,
  isInvalidCredentials,
  noCredentialsError,
} from "./auth.mjs";

/** An error carrying the AWS-style `name` the SDK sets from the service code. */
const named = (
  /** @type {string} */ name,
  message = "The provided token has expired.",
) => Object.assign(new Error(message), { name });

describe("isExpiredCredentials", () => {
  it("recognizes ExpiredToken, ExpiredTokenException, and TokenRefreshRequired", () => {
    assert.equal(isExpiredCredentials(named("ExpiredToken")), true);
    assert.equal(isExpiredCredentials(named("ExpiredTokenException")), true);
    assert.equal(isExpiredCredentials(named("TokenRefreshRequired")), true);
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

describe("isAccessDenied / isInvalidCredentials / isBadSignature / isClockSkew", () => {
  it("each recognizes only its own code, and ignores non-errors", () => {
    assert.equal(isAccessDenied(named("AccessDenied")), true);
    assert.equal(isAccessDenied(named("InvalidToken")), false);

    assert.equal(isInvalidCredentials(named("InvalidToken")), true);
    assert.equal(isInvalidCredentials(named("InvalidAccessKeyId")), true);
    assert.equal(isInvalidCredentials(named("InvalidSecurity")), true);
    assert.equal(isInvalidCredentials(named("ExpiredToken")), false);

    assert.equal(isBadSignature(named("SignatureDoesNotMatch")), true);
    assert.equal(isBadSignature(named("AccessDenied")), false);

    assert.equal(isClockSkew(named("RequestTimeTooSkewed")), true);
    assert.equal(isClockSkew(named("AccessDenied")), false);

    for (const predicate of [
      isAccessDenied,
      isInvalidCredentials,
      isBadSignature,
      isClockSkew,
    ]) {
      assert.equal(predicate("AccessDenied"), false);
      assert.equal(predicate(undefined), false);
    }
  });
});

describe("accessDeniedError", () => {
  const cause = named("AccessDenied", "Access Denied");

  it("names the bucket and points at 's3cab aws <bucket>' on AWS", () => {
    const error = accessDeniedError(cause, { bucket: "my-backups" });
    assert.equal(error.cause, cause);
    // Goal-framed: a permissions problem, not a credentials one.
    assert.match(
      error.message,
      /don't have permission to use the bucket "my-backups"/,
    );
    assert.match(error.message, /permissions problem, not a credentials one/);
    // The exact, copy-pasteable AWS remedy, naming the bucket.
    assert.match(error.message, /s3cab aws my-backups/);
  });

  it("points at the provider's permissions (not 's3cab aws') off AWS", () => {
    const error = accessDeniedError(cause, {
      bucket: "my-backups",
      endpoint: "https://example.r2.cloudflarestorage.com",
    });
    assert.doesNotMatch(error.message, /s3cab aws/);
    assert.match(error.message, /provider's bucket and token permissions/);
    assert.match(error.message, /my-backups/);
  });
});

describe("invalidCredentialsError / badSignatureError / clockSkewError", () => {
  it("each leads with its plain-language headline and embeds the raw code-first error", () => {
    const cases = [
      {
        make: invalidCredentialsError,
        cause: named(
          "InvalidToken",
          "The provided token is malformed or otherwise invalid.",
        ),
        headline: /^Your credentials were rejected as invalid\./,
        raw: /InvalidToken: The provided token is malformed/,
      },
      {
        make: badSignatureError,
        cause: named(
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match.",
        ),
        headline: /signature mismatch/,
        raw: /SignatureDoesNotMatch: The request signature/,
      },
      {
        make: clockSkewError,
        cause: named(
          "RequestTimeTooSkewed",
          "The difference between the request time and the current time is too large.",
        ),
        headline: /clock is too far out of sync/,
        raw: /RequestTimeTooSkewed: The difference between/,
      },
    ];
    for (const { make, cause, headline, raw } of cases) {
      const error = make(cause);
      assert.equal(error.cause, cause); // original kept for the debug path
      assert.match(error.message, headline);
      // The raw AWS error, code-first for googling, under a label.
      assert.match(error.message, /The server reported:/);
      assert.match(error.message, raw);
      // Defers the per-source depth to the help topic.
      assert.match(error.message, /s3cab help auth/);
    }
  });
});

describe("noCredentialsError (configuration-aware guidance)", () => {
  const cause = new Error("Could not load credentials from any providers");

  it("advises pointing s3cab at a profile when none is set", () => {
    const error = noCredentialsError(cause);
    assert.equal(error.cause, cause); // kept for the debug path
    assert.match(error.message, /^No AWS credentials found\./);
    // The chain's own reason is embedded.
    assert.match(
      error.message,
      /Could not load credentials from any providers/,
    );
    // The original "point s3cab at a profile" advice.
    assert.match(error.message, /s3cab profile --profile <name>/);
    // It does NOT wrongly tell a user a profile is missing when none was set.
    assert.doesNotMatch(error.message, /isn't in your AWS config/);
  });

  it("names the missing profile and how to create it when it isn't in ~/.aws", () => {
    // AWS_PROFILE=s3cab-test, but ~/.aws only has other profiles — the "aha".
    const error = noCredentialsError(cause, {
      profile: "s3cab-test",
      knownProfiles: ["default", "work"],
    });
    assert.match(
      error.message,
      /profile 's3cab-test', but it isn't in your AWS\s+config/,
    );
    // The exact, copy-pasteable fix, naming the profile.
    assert.match(error.message, /aws configure --profile s3cab-test/);
    // And the escape hatch to point elsewhere.
    assert.match(error.message, /s3cab profile --profile <name>/);
    // Not the "set a profile" advice (that would send them in a circle).
    assert.doesNotMatch(error.message, /or set AWS_\* variables directly/);
  });

  it("advises SSO sign-in / key check when the profile exists but yields nothing", () => {
    const error = noCredentialsError(cause, {
      profile: "s3cab-test",
      knownProfiles: ["default", "s3cab-test"],
    });
    assert.match(error.message, /profile 's3cab-test', but it produced no/);
    assert.match(error.message, /aws sso login --profile s3cab-test/);
    assert.match(error.message, /check the profile's access keys/);
  });

  it("treats an unreadable ~/.aws (undefined) as present, not missing", () => {
    // listProfiles() returns undefined when it can't read the config — don't
    // claim the profile is absent; fall to the "produced no credentials" branch.
    const error = noCredentialsError(cause, { profile: "s3cab-test" });
    assert.match(error.message, /produced no credentials/);
    assert.doesNotMatch(error.message, /isn't in your AWS config/);
  });
});
