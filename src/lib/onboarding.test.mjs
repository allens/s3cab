import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awsCloudFormationTemplate,
  awsIamPlan,
  backupLifecycle,
  validateAwsBucketName,
} from "./onboarding.mjs";

// The cloud-onboarding plan is pure text (generative — ADR-0032/0056), so both
// the CloudFormation template and the recipe wrapping it are asserted directly on
// their generated strings: the bucket protections intact (versioning, encryption,
// the Retain guard, no current-object expiry), the least-privilege policy verbs
// (no IAM wildcard), the predictable resource names, and the three-step recipe.

describe("backupLifecycle", () => {
  it("expires noncurrent versions after 90 days and aborts stalled uploads after 1", () => {
    const [rule] = backupLifecycle().Rules ?? [];
    assert.equal(rule?.NoncurrentVersionExpiration?.NoncurrentDays, 90);
    assert.equal(rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation, 1);
  });

  it("never expires CURRENT objects — the cardinal sin of auto-deleting a live backup", () => {
    for (const rule of backupLifecycle().Rules ?? []) {
      assert.equal(
        rule.Expiration,
        undefined,
        "lifecycle must not carry a current-object Expiration",
      );
    }
  });
});

describe("awsCloudFormationTemplate", () => {
  const yaml = awsCloudFormationTemplate("my-backups");

  it("turns on versioning — the safety net for a deleted or overwritten backup", () => {
    assert.match(yaml, /VersioningConfiguration:\s*\n\s*Status: Enabled/);
  });

  it("sets SSE-S3 default encryption", () => {
    assert.match(yaml, /BucketEncryption:/);
    assert.match(yaml, /SSEAlgorithm: AES256/);
  });

  it("protects the bucket from a stack delete with Retain on both policies", () => {
    // The load-bearing guard (ADR-0033/0056): deleting the stack must never be
    // able to destroy a backup bucket.
    assert.match(yaml, /DeletionPolicy: Retain/);
    assert.match(yaml, /UpdateReplacePolicy: Retain/);
  });

  it("carries the noncurrent-version lifecycle window, no current-object expiry", () => {
    assert.match(
      yaml,
      /NoncurrentVersionExpiration:\s*\n\s*NoncurrentDays: 90/,
    );
    assert.match(yaml, /AbortIncompleteMultipartUpload:/);
    assert.doesNotMatch(yaml, /\bExpiration:/); // no current-object Expiration
  });

  it("embeds bucketPolicy() verbatim as a managed policy — explicit verbs, no wildcard", () => {
    assert.match(yaml, /"s3:GetObject"/);
    assert.match(yaml, /"s3:PutObject"/);
    assert.match(yaml, /"s3:DeleteObject"/);
    assert.match(yaml, /"arn:aws:s3:::my-backups\/\*"/);
    assert.doesNotMatch(yaml, /s3:\*Object/);
    assert.doesNotMatch(yaml, /DeleteObjectVersion/);
  });

  it("uses the predictable, named resources CAPABILITY_NAMED_IAM needs", () => {
    assert.match(yaml, /BucketName: my-backups/);
    assert.match(yaml, /ManagedPolicyName: s3cab-bucket-access-my-backups/);
    assert.match(yaml, /UserName: s3cab-user-my-backups/);
  });

  it("attaches the managed policy to the user (no ARN threading)", () => {
    assert.match(yaml, /ManagedPolicyArns:\s*\n\s*- !Ref BucketAccessPolicy/);
  });

  it("bakes no region into the bucket — it lands where the stack deploys", () => {
    assert.doesNotMatch(yaml, /LocationConstraint/);
    assert.doesNotMatch(yaml, /Region/);
  });
});

describe("awsIamPlan", () => {
  const plan = (/** @type {{region?: string, profile?: string}} */ opts = {}) =>
    awsIamPlan({ bucket: "my-backups", region: "eu-west-1", ...opts });

  it("walks through the three steps: deploy, mint one key, create the set with it", () => {
    const out = plan();
    assert.match(
      out,
      /aws cloudformation deploy --template-file s3cab-my-backups\.yaml/,
    );
    assert.match(out, /--stack-name s3cab-my-backups/);
    assert.match(out, /--capabilities CAPABILITY_NAMED_IAM/);
    assert.match(
      out,
      /aws iam create-access-key --user-name s3cab-user-my-backups/,
    );
    // Step 3 stores the key at set creation (ADR-0055 initial-config door), not
    // via `provider` — a fresh onboarding has no set for `provider` to target.
    assert.match(out, /s3cab setup .*--bucket my-backups --keys/);
    assert.doesNotMatch(out, /s3cab provider --keys/);
  });

  it("embeds the CloudFormation template inline for the user to save", () => {
    assert.match(plan(), /AWSTemplateFormatVersion: "2010-09-09"/);
    assert.match(plan(), /Type: AWS::S3::Bucket/);
  });

  it("keeps the access-key secret out of CloudFormation — no AWS::IAM::AccessKey", () => {
    assert.doesNotMatch(plan(), /AWS::IAM::AccessKey/);
  });

  it("advertises the keyless Roles Anywhere path as recommended", () => {
    assert.match(plan(), /--roles-anywhere/);
    assert.match(plan(), /recommended/);
  });

  it("points SSO users at the standard chain in one line, with no --sso path", () => {
    assert.match(plan(), /IAM Identity Center \(SSO\)/);
    assert.doesNotMatch(plan(), /--sso/);
  });

  it("puts the deploy region on the command", () => {
    assert.match(plan({ region: "eu-west-1" }), /--region eu-west-1/);
  });

  it("interpolates --profile into the deploy and create-access-key commands", () => {
    const out = plan({ profile: "admin" });
    assert.match(out, /--stack-name s3cab-my-backups .*--profile admin/s);
    assert.match(out, /create-access-key --user-name \S+ --profile admin/);
  });

  it("omits the profile flag on the aws commands when none is given", () => {
    // Only the closing `s3cab setup … --keys` mentions keys; no `aws … --profile`.
    assert.doesNotMatch(plan(), /aws [^\n]*--profile/);
  });
});

describe("validateAwsBucketName", () => {
  it("accepts an ordinary lowercase-hyphen bucket name", () => {
    assert.doesNotThrow(() => validateAwsBucketName("my-backups"));
  });

  it("rejects a dotted name — CloudFormation stack names can't contain dots", () => {
    assert.throws(() => validateAwsBucketName("com.example.backups"), {
      name: "ValidationError",
      message: /stack name .* can't contain dots/,
    });
  });

  it("suggests a dot-free replacement in the error", () => {
    assert.throws(() => validateAwsBucketName("my.backups"), {
      message: /my-backups/,
    });
  });

  it("rejects a name that pushes the IAM user name past 64 characters", () => {
    // "s3cab-user-" is 11 chars, so 54+ overflows; 53 is the last that fits.
    assert.throws(() => validateAwsBucketName("a".repeat(54)), {
      name: "ValidationError",
      message: /64-character limit/,
    });
    assert.doesNotThrow(() => validateAwsBucketName("a".repeat(53)));
  });
});
