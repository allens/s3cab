import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aws } from "./aws.mjs";
import { s3cabDir } from "../lib/home.mjs";
import { caFingerprint, machineIdentityDir } from "../lib/roles-anywhere.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the `aws` command: the *routing* (which recipe it returns, or the
// usage refusals) and argument validation. The recipe/template text itself is
// asserted in src/lib/aws.test.mjs, and cert gen + ARN capture in
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
    assert.match(out, /create-access-key --user-name s3cab-my-backups-user/);
  });

  it("writes the bucket and user templates under ~/.s3cab/ and points the recipe at them", async () => {
    const out = await aws("my-backups");
    const bucketPath = join(s3cabDir(), "my-backups-bucket.yaml");
    const userPath = join(s3cabDir(), "my-backups-user.yaml");
    // The YAML bodies are on disk (not in the recipe), and the deploy commands name them.
    assert.match(readFileSync(bucketPath, "utf8"), /Type: AWS::S3::Bucket/);
    assert.match(readFileSync(userPath, "utf8"), /Type: AWS::IAM::User/);
    // Plain substring, not a RegExp — a Windows path has backslashes that would be
    // read as regex escapes.
    assert.ok(out.includes(`--template-file "${bucketPath}"`));
    assert.ok(out.includes(`--template-file "${userPath}"`));
    assert.doesNotMatch(out, /AWSTemplateFormatVersion/);
  });

  it("generates the identity and writes this machine's RA template, named by its CA", async () => {
    const out = await aws("my-backups", { "roles-anywhere": true });
    const caPem = readFileSync(join(machineIdentityDir(), "ca.pem"), "utf8");
    const fingerprint = caFingerprint(caPem);
    const template = readFileSync(
      join(s3cabDir(), `my-backups-${fingerprint}.yaml`),
      "utf8",
    );
    assert.match(template, /Type: AWS::RolesAnywhere::TrustAnchor/);
    assert.ok(template.includes(caPem.trim().split("\n")[1] ?? "?"));
    assert.ok(
      out.includes(`--save --from-stack s3cab-my-backups-${fingerprint}`),
    );
  });

  it("gives a second machine's CA a second identity stack, never the first one's", async () => {
    const first = await aws("my-backups", { "roles-anywhere": true });
    // Another machine: a fresh s3cab home, so a fresh CA.
    useTempHome(mkdtempSync(join(tmpHomeRoot, "other-")));
    const second = await aws("my-backups", { "roles-anywhere": true });
    const stack = (/** @type {string} */ out) =>
      /--save --from-stack (\S+)/.exec(out)?.[1];
    assert.ok(stack(first));
    assert.notEqual(stack(second), stack(first));
    // Both share the one bucket stack.
    const bucketStack = (/** @type {string} */ out) =>
      /--stack-name (\S+-bucket) /.exec(out)?.[1];
    assert.equal(bucketStack(second), bucketStack(first));
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

  it("caps a Roles Anywhere bucket name tighter than an access-key one (the role name is longer)", async () => {
    const name = "b".repeat(50);
    assert.match(await aws(name), /create-access-key/);
    await assert.rejects(aws(name, { "roles-anywhere": true }), {
      name: "ValidationError",
    });
  });

  it("rejects an AWS-incompatible bucket name (dots break the stack name)", async () => {
    await assert.rejects(aws("com.example.backups"), {
      name: "ValidationError",
      message: /without dots/,
    });
  });
});
