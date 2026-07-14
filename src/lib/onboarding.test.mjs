import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awsCloudFormationTemplate,
  awsIamPlan,
  awsRolesAnywherePlan,
  awsRolesAnywhereTemplate,
  backupLifecycle,
  validateAwsBucketName,
} from "./onboarding.mjs";
import { ARN_ENV } from "./roles-anywhere.mjs";

// A throwaway, well-formed PEM stand-in for the CA bundle these functions embed —
// they only splice the text, never parse it, so its content is irrelevant.
const FAKE_CA = `-----BEGIN CERTIFICATE-----
MIIBfake0Line1
fakeLine2==
-----END CERTIFICATE-----
`;

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
  const TEMPLATE_PATH = "/tmp/s3cab-home/my-backups.yaml";
  const plan = (/** @type {{region?: string, profile?: string}} */ opts = {}) =>
    awsIamPlan({
      bucket: "my-backups",
      region: "eu-west-1",
      templatePath: TEMPLATE_PATH,
      ...opts,
    });

  it("walks through the three steps: deploy, mint one key, create the set with it", () => {
    const out = plan();
    assert.match(
      out,
      /aws cloudformation deploy --template-file "\/tmp\/s3cab-home\/my-backups\.yaml"/,
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

  it("points at the written template file, not an inline copy (ADR-0056)", () => {
    const out = plan();
    assert.match(
      out,
      /Wrote the CloudFormation template to \/tmp\/s3cab-home\/my-backups\.yaml\./,
    );
    // The YAML body is written to disk, not embedded in the recipe.
    assert.doesNotMatch(out, /AWSTemplateFormatVersion/);
    assert.doesNotMatch(out, /Type: AWS::S3::Bucket/);
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

describe("awsRolesAnywhereTemplate", () => {
  const yaml = awsRolesAnywhereTemplate("my-backups", FAKE_CA);

  it("reuses the same protected bucket + managed policy as the IAM-user template", () => {
    assert.match(yaml, /Type: AWS::S3::Bucket/);
    assert.match(yaml, /DeletionPolicy: Retain/);
    assert.match(yaml, /ManagedPolicyName: s3cab-bucket-access-my-backups/);
    // No IAM user on the keyless path.
    assert.doesNotMatch(yaml, /AWS::IAM::User/);
  });

  it("stands up the keyless RA resources with predictable names", () => {
    assert.match(yaml, /Type: AWS::RolesAnywhere::TrustAnchor/);
    assert.match(yaml, /Name: s3cab-trust-anchor-my-backups/);
    assert.match(yaml, /Type: AWS::IAM::Role/);
    assert.match(yaml, /RoleName: s3cab-role-my-backups/);
    assert.match(yaml, /Type: AWS::RolesAnywhere::Profile/);
    assert.match(yaml, /Name: s3cab-profile-my-backups/);
  });

  it("uploads the CA as an external CERTIFICATE_BUNDLE, indented under the block scalar", () => {
    assert.match(yaml, /SourceType: CERTIFICATE_BUNDLE/);
    assert.match(yaml, /X509CertificateData: \|/);
    // The PEM lines are indented 12 spaces beneath the `|` block scalar.
    assert.match(yaml, /\n {12}-----BEGIN CERTIFICATE-----/);
    assert.match(yaml, /\n {12}-----END CERTIFICATE-----/);
  });

  it("attaches the same managed policy to the role (no ARN threading)", () => {
    assert.match(yaml, /ManagedPolicyArns:\s*\n\s*- !Ref BucketAccessPolicy/);
  });

  it("trusts the Roles Anywhere service, scoped to this trust anchor by GetAtt", () => {
    assert.match(yaml, /"Service": "rolesanywhere\.amazonaws\.com"/);
    assert.match(yaml, /"sts:AssumeRole"/);
    // Scoped to *this* anchor via a pure-JSON Fn::GetAtt (no YAML short-form tag
    // inside the JSON block, which CloudFormation would misparse).
    assert.match(yaml, /"aws:SourceArn"/);
    assert.match(
      yaml,
      /"Fn::GetAtt":\s*\[\s*"TrustAnchor",\s*"TrustAnchorArn"\s*\]/,
    );
    assert.doesNotMatch(yaml, /!Sub/);
  });

  it("exports the three ARNs --save reads back", () => {
    assert.match(yaml, /Outputs:/);
    assert.match(
      yaml,
      /TrustAnchorArn:\s*\n\s*Value: !GetAtt TrustAnchor\.TrustAnchorArn/,
    );
    assert.match(yaml, /ProfileArn:\s*\n\s*Value: !GetAtt Profile\.ProfileArn/);
    assert.match(yaml, /RoleArn:\s*\n\s*Value: !GetAtt Role\.Arn/);
  });

  // The contract that binds this template to the reader: `arnsFromOutputs`/`--save`
  // look each stack output up by the names in `ARN_ENV` (roles-anywhere.mjs), so
  // every one of those names MUST appear here as an Output. A rename on either side
  // that this misses would make `--save` fail silently ("missing the RA outputs",
  // blaming the user's stack). Asserted here rather than via a shared symbol so the
  // template stays readable literal YAML (ADR-0006 — a test guard, not machinery).
  it("emits an Output for every name the reader (ARN_ENV) expects", () => {
    for (const outputName of Object.keys(ARN_ENV)) {
      assert.match(
        yaml,
        new RegExp(`\\n {2}${outputName}:\\n {4}Value:`),
        `template is missing the ${outputName} Output that --save reads back`,
      );
    }
  });
});

describe("awsRolesAnywherePlan", () => {
  const TEMPLATE_PATH = "/tmp/s3cab-home/my-backups.yaml";
  const plan = (
    /** @type {{created?: boolean, region?: string, profile?: string}} */ opts = {},
  ) =>
    awsRolesAnywherePlan({
      bucket: "my-backups",
      region: "eu-west-1",
      created: true,
      templatePath: TEMPLATE_PATH,
      ...opts,
    });

  it("says a fresh identity was generated, and that the key stays local", () => {
    const out = plan({ created: true });
    assert.match(out, /Generated a new keyless Roles Anywhere identity/);
    assert.match(out, /never sent to AWS/);
  });

  it("says an existing identity is reused when one was already present", () => {
    assert.match(plan({ created: false }), /Reusing your existing/);
  });

  it("walks through deploy then the read-only --save capture", () => {
    const out = plan();
    assert.match(
      out,
      /aws cloudformation deploy --template-file "\/tmp\/s3cab-home\/my-backups\.yaml"/,
    );
    assert.match(out, /--capabilities CAPABILITY_NAMED_IAM/);
    assert.match(
      out,
      /s3cab aws --roles-anywhere --save --from-stack s3cab-my-backups/,
    );
  });

  it("points at the written template file, not an inline copy (ADR-0056)", () => {
    const out = plan();
    assert.match(
      out,
      /Wrote the CloudFormation template to \/tmp\/s3cab-home\/my-backups\.yaml\./,
    );
    // The RA template (trust anchor + embedded CA bundle) is written to disk.
    assert.doesNotMatch(out, /Type: AWS::RolesAnywhere::TrustAnchor/);
    assert.doesNotMatch(out, /-----BEGIN CERTIFICATE-----/);
  });

  it("points at wiring a set to the identity (the runtime signer is built)", () => {
    // Phase B is done: the recipe ends by pointing a set at the identity, which
    // then signs in with the certificate for every backup.
    const out = plan();
    assert.match(out, /--bucket my-backups --roles-anywhere/);
    assert.match(out, /s3cab provider --roles-anywhere <set>/);
    assert.match(out, /short-lived AWS\n?credentials for every backup/);
  });

  it("puts the deploy region on the commands", () => {
    assert.match(plan({ region: "ap-southeast-2" }), /--region ap-southeast-2/);
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
