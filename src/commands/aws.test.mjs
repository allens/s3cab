import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aws } from "./aws.mjs";

// Tests for the `aws` command: the *routing* (which recipe it returns) and
// argument validation. The recipe text itself is asserted in
// src/lib/onboarding.test.mjs; here we only check the command picks the right one
// from its flags + the AWS_ENDPOINT_URL* / AWS_REGION environment. The command
// returns the recipe as text now (ADR-0043); the dispatcher prints it.

const ENV_VARS = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
];

/** @type {Record<string, string | undefined>} */
let savedEnv;
beforeEach(() => {
  // Start from a known no-endpoint, no-region state; restore the host's after.
  savedEnv = {};
  for (const v of ENV_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of ENV_VARS) {
    if (savedEnv[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = savedEnv[v];
    }
  }
});

describe("aws routing", () => {
  it("returns the IAM-user recipe by default", () => {
    assert.match(aws("my-backups"), /aws iam create-user/);
  });

  it("returns the SSO recipe with --sso", () => {
    const out = aws("my-backups", { sso: true });
    assert.match(out, /aws sso login/);
    assert.doesNotMatch(out, /aws iam create-user/);
  });

  it("redirects to 'help provider' when a custom endpoint is set (not AWS)", () => {
    process.env.AWS_ENDPOINT_URL_S3 = "https://acct.r2.cloudflarestorage.com";
    const out = aws("my-backups");
    assert.match(out, /custom S3 endpoint is set \(https:\/\/acct\.r2/);
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /aws iam/);
  });

  it("lets the endpoint win over --sso, and needs no bucket to redirect", () => {
    process.env.AWS_ENDPOINT_URL = "https://s3.example.test";
    const out = aws(undefined, { sso: true });
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /aws sso login/);
  });
});

describe("aws region resolution", () => {
  it("uses --region for the create-bucket command", () => {
    assert.match(
      aws("my-backups", { region: "eu-west-1" }),
      /LocationConstraint=eu-west-1/,
    );
  });

  it("falls back to $AWS_REGION when --region is absent", () => {
    process.env.AWS_REGION = "ap-southeast-2";
    assert.match(aws("my-backups"), /LocationConstraint=ap-southeast-2/);
  });

  it("defaults to us-east-1 (no LocationConstraint) when nothing is set", () => {
    const out = aws("my-backups");
    assert.match(out, /--region us-east-1/);
    assert.doesNotMatch(out, /LocationConstraint/);
  });
});

describe("aws validation", () => {
  it("rejects a missing bucket name as a usage error", () => {
    assert.throws(() => aws(undefined), { code: "ERR_PARSE_ARGS" });
  });

  it("rejects a malformed bucket name (a path, not a bare name)", () => {
    assert.throws(() => aws("my/prefix"), { name: "ValidationError" });
  });
});
