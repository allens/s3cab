import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awsBucketTemplate,
  awsIamPlan,
  awsRolesAnywherePlan,
  awsRolesAnywhereTemplate,
  awsSaveConfirmation,
  awsUserTemplate,
  maxBucketNameLength,
} from "./aws.mjs";
import { ARN_ENV } from "./roles-anywhere.mjs";

// A throwaway, well-formed PEM stand-in for the CA bundle these functions embed —
// they only splice the text, never parse it, so its content is irrelevant.
const FAKE_CA = `-----BEGIN CERTIFICATE-----
MIIBfake0Line1
fakeLine2==
-----END CERTIFICATE-----
`;
const FINGERPRINT = "0a1b2c3d";

/** @param {string} bucket */
const raTemplate = (bucket) =>
  awsRolesAnywhereTemplate({
    bucket,
    caPem: FAKE_CA,
    fingerprint: FINGERPRINT,
    machine: "ann@laptop",
  });

const TEMPLATE_PATHS = {
  bucket: "/tmp/s3cab-home/my-backups-bucket.yaml",
  identity: "/tmp/s3cab-home/my-backups-identity.yaml",
};

// The cloud-onboarding plan is pure text (generative — ADR-0032/0056), so the
// CloudFormation templates and the recipes wrapping them are asserted directly on
// their generated strings: the bucket protections intact (versioning, encryption,
// the Retain guard, no current-object expiry), the least-privilege policy verbs
// (no IAM wildcard), the predictable resource names, and the recipe's steps.

describe("awsBucketTemplate", () => {
  const yaml = awsBucketTemplate("my-backups");

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

  // The lifecycle windows are asserted on the *rendered* template rather than on
  // a config object, because the template is what ships: an assertion on an
  // intermediate structure passes just as happily when the YAML interpolation
  // that carries it is broken.
  it("expires noncurrent versions after 90 days and aborts stalled uploads after 1", () => {
    // Matched as nested key→value pairs, not as bare numbers: the window only
    // means anything under the right key, and a value that drifted onto the
    // wrong one would satisfy a looser match.
    assert.match(
      yaml,
      /NoncurrentVersionExpiration:\s*\n\s*NoncurrentDays: 90/,
    );
    assert.match(
      yaml,
      /AbortIncompleteMultipartUpload:\s*\n\s*DaysAfterInitiation: 1/,
    );
  });

  it("never expires CURRENT objects — the cardinal sin of auto-deleting a live backup", () => {
    assert.doesNotMatch(
      yaml,
      /\bExpiration:/,
      "lifecycle must not carry a current-object Expiration",
    );
  });

  it("holds the bucket and nothing else, so every identity can share it (ADR-0105)", () => {
    // The bucket stack is deployed again by a second machine or a switch between
    // paths; any identity in it would be replaced or deleted by that redeploy.
    assert.deepEqual(yaml.match(/^ {4}Type: \S+/gm), [
      "    Type: AWS::S3::Bucket",
    ]);
    assert.match(yaml, /BucketName: my-backups/);
  });

  it("tags the bucket with ManagedBy + the bucket, for tag-based discovery", () => {
    // Applied in the template (not the deploy `--tags`) so they travel with the
    // artifact however it is deployed (ADR-0056).
    assert.match(yaml, /- Key: ManagedBy\n\s*Value: s3cab/);
    assert.match(yaml, /- Key: "s3cab:bucket"\n\s*Value: "my-backups"/);
  });

  it("bakes no region into the bucket — it lands where the stack deploys", () => {
    assert.doesNotMatch(yaml, /LocationConstraint/);
    assert.doesNotMatch(yaml, /Region/);
  });
});

describe("maxBucketNameLength", () => {
  it("caps the DERIVED user name, giving a s3cab-prefixed bucket back the length the strip saves", () => {
    // `s3cab-<bucket>-user` must be <= 64; its fixed decoration is 11 chars.
    assert.equal(maxBucketNameLength("photos", false), 53); // 64 - 11
    // A leading `s3cab-` (6 chars) is stripped before deriving names, so a
    // prefixed bucket may be 6 chars longer and still fit — the over-rejection
    // this closes (a flat 53-cap on the literal would wrongly bounce it).
    assert.equal(maxBucketNameLength("s3cab-photos", false), 59); // 53 + 6
  });

  it("caps the longer Roles Anywhere role name tighter", () => {
    // `s3cab-<bucket>-<8 hex>-role` must be <= 64; its decoration is 20 chars.
    assert.equal(maxBucketNameLength("photos", true), 44);
    // The longest bucket that passes yields a role name of exactly 64.
    const role = `${raTemplate("b".repeat(44)).match(/RoleName: (\S+)/)?.[1]}`;
    assert.equal(role.length, 64);
  });
});

/** @type {[string, string][]} */
const identityTemplates = [
  ["awsUserTemplate", awsUserTemplate("my-backups")],
  ["awsRolesAnywhereTemplate", raTemplate("my-backups")],
];
for (const [label, yaml] of identityTemplates) {
  describe(`${label}: the access policy`, () => {
    it("carries bucketPolicy() inline — explicit verbs, no wildcard (ADR-0105)", () => {
      assert.match(
        yaml,
        /Policies:\n {8}- PolicyName: s3cab-my-backups-policy\n {10}PolicyDocument:/,
      );
      assert.match(yaml, /"s3:GetObject"/);
      assert.match(yaml, /"s3:PutObject"/);
      assert.match(yaml, /"s3:DeleteObject"/);
      assert.match(yaml, /"arn:aws:s3:::my-backups\/\*"/);
      assert.doesNotMatch(yaml, /s3:\*Object/);
      assert.doesNotMatch(yaml, /DeleteObjectVersion/);
    });

    it("needs nothing from the bucket stack, so it works on a bucket s3cab didn't create", () => {
      assert.doesNotMatch(yaml, /AWS::S3::Bucket/);
      assert.doesNotMatch(yaml, /ManagedPolicy/);
      assert.doesNotMatch(yaml, /!Ref|ImportValue/);
    });
  });
}

describe("awsUserTemplate", () => {
  const yaml = awsUserTemplate("my-backups");

  it("names the user predictably, as CAPABILITY_NAMED_IAM needs", () => {
    assert.match(yaml, /UserName: s3cab-my-backups-user/);
  });

  it("tags the user with ManagedBy + the bucket", () => {
    assert.equal((yaml.match(/^ {6}Tags:$/gm) ?? []).length, 1);
    assert.match(yaml, /- Key: "s3cab:bucket"\n\s*Value: "my-backups"/);
  });

  it("does not repeat the s3cab- prefix when the bucket already carries it", () => {
    // Bucket names are global, so users often prefix theirs with s3cab-; the
    // derived names must dedupe rather than become s3cab-s3cab-… . The bucket
    // itself is used verbatim (ADR-0056).
    const prefixed = awsUserTemplate("s3cab-photos");
    assert.match(prefixed, /UserName: s3cab-photos-user/);
    assert.match(prefixed, /PolicyName: s3cab-photos-policy/);
    assert.match(prefixed, /"arn:aws:s3:::s3cab-photos\/\*"/);
    assert.doesNotMatch(prefixed, /s3cab-s3cab-/);
    // The association tag still points at the real, full bucket name.
    assert.match(prefixed, /- Key: "s3cab:bucket"\n\s*Value: "s3cab-photos"/);
  });
});

describe("awsIamPlan", () => {
  const plan = (/** @type {{region?: string, profile?: string}} */ opts = {}) =>
    awsIamPlan({
      bucket: "my-backups",
      region: "eu-west-1",
      templatePaths: TEMPLATE_PATHS,
      ...opts,
    });

  it("walks through the four steps: bucket, identity, mint one key, create the set with it", () => {
    const out = plan();
    assert.match(
      out,
      /1\. [^]*aws cloudformation deploy --template-file "\/tmp\/s3cab-home\/my-backups-bucket\.yaml" --stack-name s3cab-my-backups-bucket --no-fail-on-empty-changeset/,
    );
    assert.match(
      out,
      /2\. [^]*aws cloudformation deploy --template-file "\/tmp\/s3cab-home\/my-backups-identity\.yaml" --stack-name s3cab-my-backups-user --capabilities CAPABILITY_NAMED_IAM/,
    );
    assert.match(
      out,
      /3\. [^]*aws iam create-access-key --user-name s3cab-my-backups-user/,
    );
    // Step 4 stores the key at set creation (ADR-0055 initial-config door), not
    // via `provider` — a fresh onboarding has no set for `provider` to target.
    assert.match(out, /4\. [^]*s3cab setup .*--bucket my-backups --keys/);
    assert.doesNotMatch(out, /s3cab provider --keys/);
  });

  it("deploys the bucket stack with no IAM capability — it creates no IAM resource", () => {
    assert.doesNotMatch(
      plan(),
      /-bucket --no-fail-on-empty-changeset --capabilities/,
    );
  });

  it("points at the written template files, not inline copies (ADR-0056)", () => {
    const out = plan();
    assert.match(
      out,
      /\n {2}bucket: {3}\/tmp\/s3cab-home\/my-backups-bucket\.yaml\n/,
    );
    assert.match(
      out,
      /\n {2}identity: \/tmp\/s3cab-home\/my-backups-identity\.yaml\n/,
    );
    // The YAML body is written to disk, not embedded in the recipe.
    assert.doesNotMatch(out, /AWSTemplateFormatVersion/);
    assert.doesNotMatch(out, /Type: AWS::S3::Bucket/);
  });

  it("keeps the access-key secret out of CloudFormation — no AWS::IAM::AccessKey", () => {
    assert.doesNotMatch(plan(), /AWS::IAM::AccessKey/);
  });

  it("mentions the keyless Roles Anywhere alternative", () => {
    assert.match(plan(), /--roles-anywhere/);
  });

  it("points SSO users at the standard chain in one line, with no --sso path", () => {
    assert.match(plan(), /IAM Identity Center \(SSO\)/);
    assert.doesNotMatch(plan(), /--sso/);
  });

  it("puts the deploy region on the command", () => {
    assert.match(plan({ region: "eu-west-1" }), /--region eu-west-1/);
  });

  it("interpolates --profile into both deploys and the create-access-key command", () => {
    const out = plan({ profile: "admin" });
    assert.match(out, /--stack-name s3cab-my-backups-bucket .*--profile admin/);
    assert.match(out, /--stack-name s3cab-my-backups-user .*--profile admin/);
    assert.match(out, /create-access-key --user-name \S+ --profile admin/);
  });

  it("omits the profile flag on the aws commands when none is given", () => {
    // Only the closing `s3cab setup … --keys` mentions keys; no `aws … --profile`.
    assert.doesNotMatch(plan(), /aws [^\n]*--profile/);
  });
});

describe("awsRolesAnywhereTemplate", () => {
  const yaml = raTemplate("my-backups");

  it("holds only the keyless identity — no bucket, no IAM user", () => {
    assert.deepEqual(yaml.match(/^ {4}Type: \S+/gm), [
      "    Type: AWS::RolesAnywhere::TrustAnchor",
      "    Type: AWS::IAM::Role",
      "    Type: AWS::RolesAnywhere::Profile",
    ]);
  });

  it("names every resource by the CA's fingerprint, so each machine's identity is its own (ADR-0105)", () => {
    assert.match(yaml, /Name: s3cab-my-backups-0a1b2c3d-trust-anchor/);
    assert.match(yaml, /RoleName: s3cab-my-backups-0a1b2c3d-role/);
    assert.match(yaml, /Name: s3cab-my-backups-0a1b2c3d-profile/);
  });

  it("tags every resource with ManagedBy, the bucket and the machine", () => {
    assert.equal((yaml.match(/^ {6}Tags:$/gm) ?? []).length, 3);
    assert.equal(
      (yaml.match(/- Key: "s3cab:machine"\n\s*Value: "ann@laptop"/g) ?? [])
        .length,
      3,
    );
    assert.match(yaml, /- Key: "s3cab:bucket"\n\s*Value: "my-backups"/);
    assert.match(yaml, /Description: .*ann@laptop/);
  });

  it("uploads the CA as an external CERTIFICATE_BUNDLE, indented under the block scalar", () => {
    assert.match(yaml, /SourceType: CERTIFICATE_BUNDLE/);
    assert.match(yaml, /X509CertificateData: \|/);
    // The PEM lines are indented 12 spaces beneath the `|` block scalar.
    assert.match(yaml, /\n {12}-----BEGIN CERTIFICATE-----/);
    assert.match(yaml, /\n {12}-----END CERTIFICATE-----/);
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

  it("exports the bucket the identity serves, so --save knows where its ARNs belong", () => {
    assert.match(yaml, /\n {2}Bucket:\n {4}Value: "my-backups"\n/);
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
  const plan = (
    /** @type {{created?: boolean, region?: string, profile?: string}} */ opts = {},
  ) =>
    awsRolesAnywherePlan({
      bucket: "my-backups",
      region: "eu-west-1",
      created: true,
      fingerprint: FINGERPRINT,
      templatePaths: TEMPLATE_PATHS,
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

  it("walks through the bucket, this machine's identity, then the read-only --save capture", () => {
    const out = plan();
    assert.match(
      out,
      /1\. [^]*--template-file "\/tmp\/s3cab-home\/my-backups-bucket\.yaml" --stack-name s3cab-my-backups-bucket --no-fail-on-empty-changeset/,
    );
    assert.match(
      out,
      /2\. [^]*--template-file "\/tmp\/s3cab-home\/my-backups-identity\.yaml" --stack-name s3cab-my-backups-0a1b2c3d --capabilities CAPABILITY_NAMED_IAM/,
    );
    assert.match(
      out,
      /3\. [^]*s3cab aws --roles-anywhere --save --from-stack s3cab-my-backups-0a1b2c3d/,
    );
  });

  it("tells a second machine to run the same steps — its identity is its own", () => {
    assert.match(
      plan(),
      /Another\s+machine backing up to this bucket runs these same steps/,
    );
  });

  it("interpolates --profile into every deploy and the --save command", () => {
    const out = plan({ profile: "admin" });
    assert.match(out, /--no-fail-on-empty-changeset.*--profile admin/);
    assert.match(out, /--capabilities CAPABILITY_NAMED_IAM.*--profile admin/);
    assert.match(
      out,
      /--from-stack s3cab-my-backups-0a1b2c3d.*--profile admin/,
    );
  });

  it("omits the profile flag when none is given", () => {
    assert.doesNotMatch(plan(), /--profile/);
  });

  it("points at the written template files, not inline copies (ADR-0056)", () => {
    const out = plan();
    assert.match(
      out,
      /\n {2}identity: \/tmp\/s3cab-home\/my-backups-identity\.yaml\n/,
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

describe("awsSaveConfirmation", () => {
  const out = awsSaveConfirmation({
    stackName: "s3cab-my-backups",
    region: "eu-west-1",
    dir: "~/.s3cab/roles-anywhere",
  });

  it("names the stack, region, and the identity env file it wrote", () => {
    assert.match(
      out,
      /Saved the Roles Anywhere ARNs from stack "s3cab-my-backups" \(region eu-west-1\)/,
    );
    assert.match(out, /~\/\.s3cab\/roles-anywhere\/env/);
  });

  it("points a backup set at the now-complete identity (create and switch)", () => {
    assert.match(
      out,
      /s3cab setup --set <name> --bucket <bucket> --roles-anywhere <directory>\.\.\./,
    );
    assert.match(out, /s3cab provider --roles-anywhere <set>/);
    assert.match(out, /short-lived AWS\n?credentials for every backup/);
  });
});
