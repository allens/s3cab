import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aws } from "./aws.mjs";

// Tests for the `aws` command: the *routing* (which recipe it returns, or the
// not-yet-built refusal) and argument validation. The recipe text itself is
// asserted in src/lib/onboarding.test.mjs; here we only check the command reacts
// to its flags + the AWS_ENDPOINT_URL* / AWS_REGION environment. The command
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
  it("returns the IAM-user CloudFormation recipe by default", () => {
    const out = aws("my-backups");
    assert.match(out, /aws cloudformation deploy/);
    assert.match(out, /create-access-key --user-name s3cab-user-my-backups/);
  });

  it("refuses --roles-anywhere as not yet available", () => {
    assert.throws(() => aws("my-backups", { "roles-anywhere": true }), {
      message: /Roles Anywhere.*isn't available yet/s,
    });
  });

  it("redirects to 'help provider' when a custom endpoint is set (not AWS)", () => {
    process.env.AWS_ENDPOINT_URL_S3 = "https://acct.r2.cloudflarestorage.com";
    const out = aws("my-backups");
    assert.match(out, /custom S3 endpoint is set \(https:\/\/acct\.r2/);
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /cloudformation/);
  });

  it("lets the endpoint win, and needs no bucket to redirect", () => {
    process.env.AWS_ENDPOINT_URL = "https://s3.example.test";
    const out = aws(undefined);
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /cloudformation/);
  });
});

describe("aws region resolution", () => {
  it("uses --region for the deploy command", () => {
    assert.match(
      aws("my-backups", { region: "eu-west-1" }),
      /--region eu-west-1/,
    );
  });

  it("falls back to $AWS_REGION when --region is absent", () => {
    process.env.AWS_REGION = "ap-southeast-2";
    assert.match(aws("my-backups"), /--region ap-southeast-2/);
  });

  it("defaults to us-east-1 when nothing is set", () => {
    assert.match(aws("my-backups"), /--region us-east-1/);
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
