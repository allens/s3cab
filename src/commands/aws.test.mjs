import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aws } from "./aws.mjs";
import { s3cabDir } from "../lib/home.mjs";
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

/** @type {Record<string, string | undefined>} */
let savedEnv;
/** @type {string} */
let tmpHomeRoot;
beforeEach(() => {
  // Start from a known no-endpoint, no-region state; restore the host's after.
  savedEnv = {};
  for (const v of ENV_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  // Every path now writes the template under s3cab's home, so isolate it — no test
  // should touch the real ~/.s3cab. (useTempHome sets S3CAB_HOME, restored above.)
  tmpHomeRoot = mkdtempSync(join(tmpdir(), "s3cab-aws-"));
  useTempHome(tmpHomeRoot);
});
afterEach(() => {
  rmSync(tmpHomeRoot, { recursive: true, force: true });
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

  it("writes the template to ~/.s3cab/<bucket>.yaml and points the recipe at it", async () => {
    const out = await aws("my-backups");
    const path = join(s3cabDir(), "my-backups.yaml");
    const template = readFileSync(path, "utf8");
    // The YAML body is on disk (not in the recipe), and the deploy command names it.
    assert.match(template, /AWSTemplateFormatVersion/);
    assert.match(template, /Type: AWS::S3::Bucket/);
    assert.match(out, /Wrote the CloudFormation template to/);
    // Plain substring, not a RegExp — a Windows path has backslashes that would be
    // read as regex escapes.
    assert.ok(out.includes(`--template-file "${path}"`));
    assert.doesNotMatch(out, /AWSTemplateFormatVersion/);
  });

  it("generates the identity and writes the RA template with --roles-anywhere", async () => {
    const out = await aws("my-backups", { "roles-anywhere": true });
    const template = readFileSync(join(s3cabDir(), "my-backups.yaml"), "utf8");
    assert.match(template, /Type: AWS::RolesAnywhere::TrustAnchor/);
    assert.match(template, /-----BEGIN CERTIFICATE-----/);
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
