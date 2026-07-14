import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aws } from "./aws.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the `aws` command: the *routing* (which recipe it returns, or the
// usage refusals) and argument validation. The recipe/template text itself is
// asserted in src/lib/onboarding.test.mjs, and cert gen + ARN capture in
// src/lib/roles-anywhere.test.mjs; here we only check the command reacts to its
// flags + the AWS_ENDPOINT_URL* / AWS_REGION environment. The command is async
// (--save makes a read-only AWS call) and returns its text; the dispatcher prints
// it (ADR-0043).

const ENV_VARS = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "S3CAB_HOME",
];

const mkTmpDir = () => mkdtempDisposable(join("test", ".tmp"));

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
  it("returns the IAM-user CloudFormation recipe by default", async () => {
    const out = await aws("my-backups");
    assert.match(out, /aws cloudformation deploy/);
    assert.match(out, /create-access-key --user-name s3cab-user-my-backups/);
  });

  it("generates the identity and RA template with --roles-anywhere", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const out = await aws("my-backups", { "roles-anywhere": true });
    assert.match(out, /Type: AWS::RolesAnywhere::TrustAnchor/);
    assert.match(out, /-----BEGIN CERTIFICATE-----/);
    assert.match(out, /s3cab aws --roles-anywhere --save --from-stack/);
  });

  it("redirects to 'help provider' when a custom endpoint is set (not AWS)", async () => {
    process.env.AWS_ENDPOINT_URL_S3 = "https://acct.r2.cloudflarestorage.com";
    const out = await aws("my-backups");
    assert.match(out, /custom S3 endpoint is set \(https:\/\/acct\.r2/);
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /cloudformation/);
  });

  it("lets the endpoint win, and needs no bucket to redirect", async () => {
    process.env.AWS_ENDPOINT_URL = "https://s3.example.test";
    const out = await aws(undefined);
    assert.match(out, /s3cab help provider/);
    assert.doesNotMatch(out, /cloudformation/);
  });
});

describe("aws --save routing", () => {
  it("requires --from-stack, as a usage error", async () => {
    await assert.rejects(
      aws(undefined, { "roles-anywhere": true, save: true }),
      {
        code: "ERR_PARSE_ARGS",
      },
    );
  });

  it("refuses when no local identity exists yet (needs generating first)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await assert.rejects(
      aws(undefined, {
        "roles-anywhere": true,
        save: true,
        "from-stack": "s3cab-my-backups",
      }),
      { name: "ValidationError", message: /No Roles Anywhere identity/ },
    );
  });
});

describe("aws region resolution", () => {
  it("uses --region for the deploy command", async () => {
    assert.match(
      await aws("my-backups", { region: "eu-west-1" }),
      /--region eu-west-1/,
    );
  });

  it("falls back to $AWS_REGION when --region is absent", async () => {
    process.env.AWS_REGION = "ap-southeast-2";
    assert.match(await aws("my-backups"), /--region ap-southeast-2/);
  });

  it("defaults to us-east-1 when nothing is set", async () => {
    assert.match(await aws("my-backups"), /--region us-east-1/);
  });
});

describe("aws validation", () => {
  it("rejects a missing bucket name as a usage error", async () => {
    await assert.rejects(aws(undefined), { code: "ERR_PARSE_ARGS" });
  });

  it("rejects a malformed bucket name (a path, not a bare name)", async () => {
    await assert.rejects(aws("my/prefix"), { name: "ValidationError" });
  });

  it("rejects an AWS-incompatible bucket name (dots break the stack name)", async () => {
    await assert.rejects(aws("com.example.backups"), {
      name: "ValidationError",
      message: /can't contain dots/,
    });
  });
});
