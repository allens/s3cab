import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awsIamPlan,
  awsSsoPlan,
  backupLifecycle,
  nonAwsPlan,
} from "./onboarding.mjs";

// The cloud-onboarding plan is pure text (generative — ADR-0032), so each recipe
// is asserted directly on its generated string: the right commands present, the
// security-critical bits intact (no current-object expiry, no IAM wildcard), and
// the us-east-1 / profile-flag / endpoint variations rendered correctly.

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

describe("awsIamPlan", () => {
  const plan = (/** @type {{region?: string, profile?: string}} */ opts = {}) =>
    awsIamPlan({ bucket: "my-backups", region: "eu-west-1", ...opts });

  it("walks through creating the dedicated IAM user, policy, and access key", () => {
    const out = plan();
    assert.match(out, /aws iam create-user --user-name s3cab/);
    assert.match(out, /aws iam put-user-policy --user-name s3cab/);
    assert.match(out, /aws iam create-access-key --user-name s3cab/);
    assert.match(out, /s3cab auth --profile s3cab/);
  });

  it("emits the explicit-verb policy, never the s3:*Object wildcard", () => {
    const out = plan();
    assert.match(out, /"s3:GetObject"/);
    assert.match(out, /"s3:DeleteObject"/);
    assert.doesNotMatch(out, /s3:\*Object/);
    assert.doesNotMatch(out, /DeleteObjectVersion/);
  });

  it("adds a LocationConstraint for a non-us-east-1 region", () => {
    assert.match(plan({ region: "eu-west-1" }), /LocationConstraint=eu-west-1/);
  });

  it("omits the LocationConstraint for us-east-1 (the API default rejects it)", () => {
    const out = plan({ region: "us-east-1" });
    assert.match(out, /create-bucket --bucket my-backups --region us-east-1/);
    assert.doesNotMatch(out, /LocationConstraint/);
  });

  it("interpolates --profile into every aws command when given", () => {
    // us-east-1 keeps create-bucket on one line, so the flag is visible inline;
    // every other generated command carries it too (e.g. create-user).
    const out = plan({ region: "us-east-1", profile: "admin" });
    assert.match(
      out,
      /create-bucket --bucket my-backups --region us-east-1 --profile admin/,
    );
    assert.match(out, /create-user --user-name s3cab --profile admin/);
  });

  it("omits the profile flag entirely when none is given", () => {
    assert.doesNotMatch(plan(), / --profile (?!s3cab)/); // only the final `s3cab auth --profile s3cab` mentions a profile
  });

  it("points SSO users at --sso", () => {
    assert.match(plan(), /Re-run with --sso\./);
  });
});

describe("awsSsoPlan", () => {
  const out = awsSsoPlan({
    bucket: "my-backups",
    region: "eu-west-1",
    profile: "admin",
  });

  it("uses the existing SSO sign-in (B-light) — no IAM user is created", () => {
    assert.match(out, /aws sso login/);
    assert.match(out, /permission set you sign in with/);
    assert.doesNotMatch(out, /aws iam create-user/);
  });

  it("includes the advanced dedicated-permission-set block with placeholder ARNs", () => {
    assert.match(out, /Advanced: a dedicated s3cab-only identity/);
    assert.match(out, /<sso-instance-arn>/);
    assert.match(out, /<permission-set-arn>/);
  });

  it("shares the identity-agnostic bucket steps (versioning, lifecycle)", () => {
    assert.match(out, /put-bucket-versioning/);
    assert.match(out, /put-bucket-lifecycle-configuration/);
  });
});

describe("nonAwsPlan", () => {
  const out = nonAwsPlan({
    bucket: "my-backups",
    endpoint: "https://acct.r2.cloudflarestorage.com",
  });

  it("emits an env template with the detected endpoint pre-filled", () => {
    assert.match(
      out,
      /AWS_ENDPOINT_URL_S3=https:\/\/acct\.r2\.cloudflarestorage\.com/,
    );
    assert.match(out, /AWS_ACCESS_KEY_ID=<your-access-key>/);
    assert.match(out, /AWS_SECRET_ACCESS_KEY=<your-secret>/);
  });

  it("has no IAM or policy JSON — S3-compatible providers have no IAM", () => {
    assert.doesNotMatch(out, /aws iam/);
    assert.doesNotMatch(out, /arn:aws:s3/);
    assert.match(out, /Cloudflare R2, Backblaze\n?\s*B2 and Wasabi/);
  });
});
