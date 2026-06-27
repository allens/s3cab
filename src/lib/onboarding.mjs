import { bucketPolicy } from "./s3.mjs";

// Generates the cloud-onboarding plan the `bucket` command prints: the exact
// `aws` CLI commands plus policy/lifecycle JSON a user runs to stand up an S3
// backup destination and a least-privilege identity for s3cab. Pure text — no
// AWS calls, no I/O — which is what makes the command generative (ADR-0032) and
// unit-testable without a client (src/lib/onboarding.test.mjs). The command
// (src/commands/bucket.mjs) resolves region/profile/endpoint and prints what
// these return; the JSON is `bucketPolicy()` (the same source the test docs
// reference) and `backupLifecycle()` below.

/**
 * The backup bucket's lifecycle rules: expire *noncurrent* versions after 90
 * days (the disaster-recovery window — reclaims the space a soft delete frees)
 * and abort stalled multipart uploads after 1 day. It deliberately has **no**
 * current-object expiry — never auto-delete a live backup (the security model,
 * docs/adr/0033). The exact opposite of the *test* bucket's 1-day *current*-object
 * expiry (docs/integration-testing.md / scripts/setup-test-bucket.mjs), which is
 * why the two lifecycles are never shared.
 * @returns {import("@aws-sdk/client-s3").BucketLifecycleConfiguration}
 */
export const backupLifecycle = () => ({
  Rules: [
    {
      ID: "reclaim-deleted-backups",
      Status: "Enabled",
      Filter: {},
      NoncurrentVersionExpiration: { NoncurrentDays: 90 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ],
});

/**
 * Pretty-print a policy/lifecycle object exactly as it should land in a file.
 * @param {unknown} value
 */
const json = (value) => JSON.stringify(value, null, 2);

/**
 * The ` --profile <name>` suffix interpolated into every generated `aws` command
 * when `--profile` was passed (output sugar only — never used to authenticate;
 * the command is offline), or `""` otherwise.
 * @param {string} [profile]
 */
const profileFlag = (profile) => (profile ? ` --profile ${profile}` : "");

/**
 * The `aws s3api create-bucket` line(s), handling the us-east-1
 * `LocationConstraint` quirk: us-east-1 is the API default and must **not** carry
 * a `LocationConstraint` (S3 rejects it); every other region requires one. Mirrors
 * scripts/setup-test-bucket.mjs, the test-bucket provisioner.
 * @param {string} bucket
 * @param {string} region
 * @param {string} pf - The profile-flag suffix (`profileFlag` output)
 */
const createBucketCommand = (bucket, region, pf) =>
  region === "us-east-1"
    ? `   aws s3api create-bucket --bucket ${bucket} --region ${region}${pf}`
    : `   aws s3api create-bucket --bucket ${bucket} --region ${region} \\\n` +
      `     --create-bucket-configuration LocationConstraint=${region}${pf}`;

/**
 * The default onboarding recipe: a dedicated **IAM user** scoped to this bucket
 * (the simplest path for someone without SSO). Numbered, goal-framed steps
 * (ADR-0030), each command copy-pasteable on its own line; sequential by
 * necessity — step 4 mints the key step 5 consumes — so it is human-in-the-loop,
 * not one paste-all. The policy/lifecycle JSON is printed inline for the user to
 * save as `policy.json` / `lifecycle.json`, which the `file://` references then
 * pick up (dodging cross-shell quoting of inline JSON).
 * @param {{ bucket: string, region: string, profile?: string }} params
 * @returns {string}
 */
export function awsIamPlan({ bucket, region, profile }) {
  const pf = profileFlag(profile);
  const blocks = [
    `To set up "${bucket}" as an s3cab backup destination on AWS, run these steps.`,

    `1. Create the bucket:\n` + createBucketCommand(bucket, region, pf),

    `2. Turn on versioning — your safety net, so a deleted or overwritten\n` +
      `   backup stays recoverable:\n` +
      `   aws s3api put-bucket-versioning --bucket ${bucket} \\\n` +
      `     --versioning-configuration Status=Enabled${pf}`,

    `3. Add lifecycle rules (reclaim deleted space after 90 days; clear\n` +
      `   stalled uploads after 1). Save as lifecycle.json:\n\n` +
      `${json(backupLifecycle())}\n\n` +
      `   aws s3api put-bucket-lifecycle-configuration --bucket ${bucket} \\\n` +
      `     --lifecycle-configuration file://lifecycle.json${pf}`,

    `4. Create a locked-down identity for s3cab. Save as policy.json:\n\n` +
      `${json(bucketPolicy(bucket))}\n\n` +
      `   aws iam create-user --user-name s3cab${pf}\n` +
      `   aws iam put-user-policy --user-name s3cab --policy-name s3cab-backup \\\n` +
      `     --policy-document file://policy.json${pf}\n` +
      `   aws iam create-access-key --user-name s3cab${pf}`,

    `5. Point s3cab at the new key (paste the key + secret from step 4):\n` +
      `   aws configure --profile s3cab\n` +
      `   s3cab aws --profile s3cab`,

    `Next — create a backup set in this bucket:\n` +
      `   s3cab setup <name> <folder>... --bucket ${bucket}`,

    `Using AWS IAM Identity Center / SSO instead? Re-run with --sso.`,
  ];
  return blocks.join("\n\n");
}
