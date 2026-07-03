import { bucketPolicy } from "./s3.mjs";

// Generates the cloud-onboarding plan the `aws` command prints: the exact
// `aws` CLI commands plus policy/lifecycle JSON a user runs to stand up an S3
// backup destination and a least-privilege identity for s3cab. Pure text — no
// AWS calls, no I/O — which is what makes the command generative (ADR-0032) and
// unit-testable without a client (src/lib/onboarding.test.mjs). The command
// (src/commands/aws.mjs) resolves region/profile/endpoint and prints what
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
 * The goal-framed opening line shared by every recipe (ADR-0030).
 * @param {string} bucket
 * @param {string} target - Where the bucket lives, e.g. "AWS"
 */
const header = (bucket, target) =>
  `To set up "${bucket}" as an s3cab backup destination on ${target}, run these steps.`;

/**
 * Steps 1–3 — create the bucket, versioning, lifecycle. *Identity-agnostic*: the
 * AWS IAM and SSO recipes share these verbatim (only the identity step forks),
 * which is what keeps the SSO variant small.
 * @param {string} bucket
 * @param {string} region
 * @param {string} pf - The profile-flag suffix
 * @returns {string[]}
 */
const bucketSteps = (bucket, region, pf) => [
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
];

/**
 * The closing "now make a set" pointer shared by every recipe.
 * @param {string} bucket
 */
const nextStep = (bucket) =>
  `Next — create a backup set in this bucket:\n` +
  `   s3cab setup <name> <directory>... --bucket ${bucket}`;

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
    header(bucket, "AWS"),

    ...bucketSteps(bucket, region, pf),

    `4. Create a locked-down identity for s3cab. Save as policy.json:\n\n` +
      `${json(bucketPolicy(bucket))}\n\n` +
      `   aws iam create-user --user-name s3cab${pf}\n` +
      `   aws iam put-user-policy --user-name s3cab --policy-name s3cab-backup \\\n` +
      `     --policy-document file://policy.json${pf}\n` +
      `   aws iam create-access-key --user-name s3cab${pf}`,

    `5. Point s3cab at the new key (paste the key + secret from step 4):\n` +
      `   aws configure --profile s3cab\n` +
      `   s3cab auth --profile s3cab`,

    nextStep(bucket),

    `Using AWS IAM Identity Center / SSO instead? Re-run with --sso.`,
  ];
  return blocks.join("\n\n");
}

/**
 * The `--sso` recipe for users who sign in with **AWS IAM Identity Center**
 * (where there is no long-lived access key to mint). Same bucket steps 1–3, then
 * the identity fork in two tiers:
 *
 * - **B-light** (steps 4–5, the common case): attach the bucket policy to the
 *   permission set you *already* sign in with, refresh the session, point s3cab
 *   at the profile. No new identity to create.
 * - **B-dedicated** (the trailing "Advanced" block, optional): a permission set
 *   used *only* by s3cab, for tighter scope — more setup, most people skip it.
 *   Console-first, since attaching an inline policy by CLI needs the SSO
 *   instance + permission-set ARNs, which can't be pre-filled (a `<placeholder>`
 *   CLI appendix is given for those who manage Identity Center from the shell).
 *
 * We do **not** teach standing up Identity Center from scratch (heavy, tiny
 * audience, re-treads the removed `login` ground — ADR-0015).
 * @param {{ bucket: string, region: string, profile?: string }} params
 * @returns {string}
 */
export function awsSsoPlan({ bucket, region, profile }) {
  const pf = profileFlag(profile);
  const blocks = [
    header(bucket, "AWS"),

    ...bucketSteps(bucket, region, pf),

    `4. Grant s3cab access through the identity you already sign in with.\n` +
      `   Save as policy.json:\n\n` +
      `${json(bucketPolicy(bucket))}\n\n` +
      `   In the AWS console → IAM Identity Center → Permission sets → the\n` +
      `   permission set you sign in with → Inline policy, paste policy.json.`,

    `5. Refresh your session and point s3cab at your profile:\n` +
      `   aws sso login --profile <your-sso-profile>\n` +
      `   s3cab auth --profile <your-sso-profile>`,

    `--- Advanced: a dedicated s3cab-only identity ---\n\n` +
      `For tighter scope, give s3cab its own permission set instead of reusing\n` +
      `your everyday one. More setup; most people don't need it.\n\n` +
      `In the AWS console → IAM Identity Center:\n` +
      `  1. Permission sets → Create permission set → custom → attach policy.json\n` +
      `     (above) as an inline policy; name it e.g. s3cab-backup.\n` +
      `  2. Assign that permission set to your user on the account holding the bucket.\n` +
      `  3. Add an SSO profile for it, then sign in:\n` +
      `     aws configure sso          # pick the s3cab-backup permission set\n` +
      `     aws sso login --profile s3cab\n` +
      `     s3cab auth --profile s3cab\n\n` +
      `CLI appendix (if you manage Identity Center from the command line —\n` +
      `substitute the <placeholder> ARNs from your account; they can't be\n` +
      `pre-filled):\n` +
      `   aws sso-admin put-inline-policy-to-permission-set \\\n` +
      `     --instance-arn <sso-instance-arn> \\\n` +
      `     --permission-set-arn <permission-set-arn> \\\n` +
      `     --inline-policy file://policy.json`,

    nextStep(bucket),
  ];
  return blocks.join("\n\n");
}

/**
 * The non-AWS recipe, auto-selected when a custom endpoint is set (any
 * S3-compatible provider — Cloudflare R2, Backblaze B2, Wasabi, MinIO, …). These
 * have **no IAM**, so onboarding degrades to best-effort console steps plus a
 * ready-to-paste `~/.s3cab/env` template (endpoint + key/secret) — there is no
 * policy JSON to attach. Versioning is offered conditionally since not every
 * provider supports it. The detected `endpoint` is pre-filled into the template.
 * @param {{ bucket: string, endpoint: string }} params
 * @returns {string}
 */
export function nonAwsPlan({ bucket, endpoint }) {
  const blocks = [
    `To set up "${bucket}" as an s3cab backup destination on ${endpoint},\n` +
      `run these steps. (A custom S3 endpoint is set, so these are\n` +
      `provider-neutral — S3-compatible providers like Cloudflare R2, Backblaze\n` +
      `B2 and Wasabi have no AWS IAM, so there is no policy to attach.)`,

    `1. Create the bucket "${bucket}" in your provider's console (or its CLI).`,

    `2. Turn on object versioning if the provider supports it — your safety net,\n` +
      `   so a deleted or overwritten backup stays recoverable. Not every\n` +
      `   S3-compatible provider offers it; skip this if yours doesn't.`,

    `3. Create an access key / token scoped to this bucket, with read, write,\n` +
      `   delete, and list on its objects. Where to do this differs by provider\n` +
      `   (R2: API Tokens; B2: Application Keys; Wasabi: sub-users).`,

    `4. Point s3cab at it — save these to ~/.s3cab/env (or set them in your shell):\n\n` +
      `   AWS_ENDPOINT_URL_S3=${endpoint}\n` +
      `   AWS_ACCESS_KEY_ID=<your-access-key>\n` +
      `   AWS_SECRET_ACCESS_KEY=<your-secret>\n` +
      `   AWS_REGION=auto          # some providers need a real region, e.g. us-east-1\n\n` +
      `   s3cab drops AWS-only request features automatically off a custom endpoint.`,

    nextStep(bucket),
  ];
  return blocks.join("\n\n");
}
