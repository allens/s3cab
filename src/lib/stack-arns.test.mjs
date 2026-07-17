import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseEnv } from "node:util";
import {
  ensureMachineIdentity,
  machineIdentityDir,
} from "./roles-anywhere.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { Output } from "@aws-sdk/client-cloudformation" */

// stack-arns.mjs is the aws-only CloudFormation boundary (ADR-0059), so it STATICALLY
// imports @aws-sdk/client-cloudformation — the seam mocked here. Per the house rule
// (docs/design/testing.md, and objects.test.mjs): register the mock at module scope
// FIRST, then import the subject dynamically below, so its static CFN binding resolves
// to the mock (a static import of the subject would bind the real client first). One
// mock per file — the per-test DescribeStacks result varies through `stackOutputs`,
// the mutable the fake `send()` reads, not a re-registered mock.

/** @type {Output[]} */
let stackOutputs = [];
/** @type {{ region?: string, profile?: string } | undefined} */
let clientConfig;
mock.module("@aws-sdk/client-cloudformation", {
  exports: {
    CloudFormationClient: class {
      constructor(/** @type {object} */ config) {
        clientConfig = config;
      }
      async send() {
        return { Stacks: [{ Outputs: stackOutputs }] };
      }
    },
    DescribeStacksCommand: class {
      constructor(/** @type {object} */ input) {
        this.input = input;
      }
    },
  },
});
const { saveArnsFromStack } = await import("./stack-arns.mjs");

const mkTmpDir = () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  stackOutputs = [];
  clientConfig = undefined;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("saveArnsFromStack", () => {
  it("refuses when no identity has been generated yet", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await assert.rejects(
      saveArnsFromStack({ stackName: "s3cab-foo", region: "eu-west-1" }),
      { name: "ValidationError", message: /No Roles Anywhere identity/ },
    );
  });

  // The output→env-key mapping is unit-tested mock-free in `arnsFromOutputs`
  // (roles-anywhere.test.mjs); this covers only the wrapper's own I/O — that it
  // persists what the mapping produced (plus the region) into the identity env file.
  it("persists the mapped ARNs + region into the identity env file", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();
    stackOutputs = [
      { OutputKey: "TrustAnchorArn", OutputValue: "arn:aws:ta/1" },
      { OutputKey: "ProfileArn", OutputValue: "arn:aws:profile/2" },
      { OutputKey: "RoleArn", OutputValue: "arn:aws:role/3" },
    ];

    await saveArnsFromStack({ stackName: "s3cab-foo", region: "eu-west-1" });

    const env = parseEnv(
      readFileSync(join(machineIdentityDir(), "env"), "utf8"),
    );
    assert.equal(env.S3CAB_RA_TRUST_ANCHOR_ARN, "arn:aws:ta/1");
    assert.equal(env.S3CAB_RA_PROFILE_ARN, "arn:aws:profile/2");
    assert.equal(env.S3CAB_RA_ROLE_ARN, "arn:aws:role/3");
    assert.equal(env.AWS_REGION, "eu-west-1");
    // No --profile → the client runs on ambient credentials, not a stale profile.
    assert.deepEqual(clientConfig, { region: "eu-west-1", profile: undefined });
  });

  // The bug this guards against: `--save --from-stack … --profile <p>` used to
  // build the client with `{ region }` only, so the DescribeStacks read silently
  // ignored the admin profile the recipe's step 1 told the user to deploy with.
  it("authenticates the stack read with the given profile", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();
    stackOutputs = [
      { OutputKey: "TrustAnchorArn", OutputValue: "arn:aws:ta/1" },
      { OutputKey: "ProfileArn", OutputValue: "arn:aws:profile/2" },
      { OutputKey: "RoleArn", OutputValue: "arn:aws:role/3" },
    ];

    await saveArnsFromStack({
      stackName: "s3cab-foo",
      region: "eu-west-1",
      profile: "admin",
    });

    assert.deepEqual(clientConfig, { region: "eu-west-1", profile: "admin" });
  });

  it("errors constructively when the stack is missing the RA outputs", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();
    stackOutputs = []; // e.g. the IAM-user stack

    await assert.rejects(
      saveArnsFromStack({ stackName: "s3cab-foo", region: "eu-west-1" }),
      {
        name: "ValidationError",
        message: /missing the Roles Anywhere outputs/,
      },
    );
  });
});
