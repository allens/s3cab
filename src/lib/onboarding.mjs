import { bucketPolicy } from "./s3.mjs";

// Generates the cloud-onboarding plan the `aws` command prints: a CloudFormation
// template plus the short recipe a user runs to stand up an S3 backup destination
// and a least-privilege identity for s3cab. Pure text — no AWS calls, no I/O —
// which is what makes the command generative (ADR-0032/0056) and unit-testable
// without a client (src/lib/onboarding.test.mjs). The command (src/commands/aws.mjs)
// resolves region/profile/endpoint and prints what these return.
//
// Why a declarative template, not an imperative `aws` command list (ADR-0056):
// CloudFormation resolves inter-resource references itself (no ARN threading), the
// deploy is one shell-agnostic command, and the stack is updatable/teardownable.
// The one thing kept OUT of the template is the access-key secret — `AWS::IAM::AccessKey`
// would materialize it in stack state, so `create-access-key` stays a single manual
// step (secret to the terminal only, never persisted). See ADR-0056 for the full
// "the delivery form tracks the secret" reasoning.

/**
 * The backup bucket's lifecycle rules: expire *noncurrent* versions after 90
 * days (the disaster-recovery window — reclaims the space a soft delete frees)
 * and abort stalled multipart uploads after 1 day. It deliberately has **no**
 * current-object expiry — never auto-delete a live backup (the security model,
 * docs/adr/0033). The exact opposite of the *test* bucket's 1-day *current*-object
 * expiry (docs/integration-testing.md / scripts/setup-test-bucket.mjs), which is
 * why the two lifecycles are never shared. The single source of the window values
 * the CloudFormation template embeds below (`awsCloudFormationTemplate`).
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
 * Indent a JSON-serialized object under a YAML key. JSON is valid YAML (a flow
 * mapping), so embedding `bucketPolicy()` verbatim keeps it the single source of
 * truth (ADR-0056) without a bespoke YAML serializer. Each line is padded so the
 * block nests under its `PolicyDocument:` key.
 * @param {unknown} value
 * @param {number} spaces - Indentation depth for the nested block.
 */
const indentJson = (value, spaces) => {
  const pad = " ".repeat(spaces);
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
};

/**
 * The CloudFormation stack name for a bucket's onboarding (ADR-0056).
 * @param {string} bucket
 */
const stackName = (bucket) => `s3cab-${bucket}`;
/**
 * The dedicated IAM user's name (default identity path, ADR-0056).
 * @param {string} bucket
 */
const userName = (bucket) => `s3cab-user-${bucket}`;
/**
 * The managed policy wrapping `bucketPolicy()` (ADR-0056).
 * @param {string} bucket
 */
const policyName = (bucket) => `s3cab-bucket-access-${bucket}`;

/**
 * The ` --profile <name>` suffix interpolated into the generated `aws` commands
 * when `--profile` was passed (output sugar only — never used to authenticate;
 * the command is offline), or `""` otherwise.
 * @param {string} [profile]
 */
const profileFlag = (profile) => (profile ? ` --profile ${profile}` : "");

/**
 * The goal-framed opening line shared by every recipe (ADR-0030).
 * @param {string} bucket
 * @param {string} target - Where the bucket lives, e.g. "AWS"
 */
const header = (bucket, target) =>
  `To set up "${bucket}" as an s3cab backup destination on ${target}, run these steps.`;

/**
 * The CloudFormation template `s3cab aws <bucket>` emits (ADR-0056): one stack
 * standing up the backup bucket plus a least-privilege IAM user for s3cab. Every
 * ADR-0033 bucket protection is baked in — versioning ON, SSE-S3 default
 * encryption, the noncurrent-version lifecycle window, and **`DeletionPolicy` /
 * `UpdateReplacePolicy` `Retain`** so deleting the stack can never destroy backups
 * (the load-bearing guard). `bucketPolicy()` is embedded verbatim as a managed
 * policy (`policyName`) attached to the user — the single source of truth (ADR-0056).
 *
 * Region is deliberately **not** baked in: the bucket lands in whatever region the
 * stack deploys to, so the old us-east-1 `LocationConstraint` quirk disappears.
 * @param {string} bucket
 * @returns {string} The YAML template text.
 */
export function awsCloudFormationTemplate(bucket) {
  const [rule] = backupLifecycle().Rules ?? [];
  const noncurrentDays = rule?.NoncurrentVersionExpiration?.NoncurrentDays;
  const abortDays = rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation;
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: s3cab backup bucket "${bucket}" and its least-privilege identity
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    # Retain so deleting this stack can NEVER destroy the backup bucket (ADR-0033/0056).
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      BucketName: ${bucket}
      VersioningConfiguration:
        Status: Enabled
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
      LifecycleConfiguration:
        Rules:
          - Id: ${rule?.ID}
            Status: ${rule?.Status}
            NoncurrentVersionExpiration:
              NoncurrentDays: ${noncurrentDays}
            AbortIncompleteMultipartUpload:
              DaysAfterInitiation: ${abortDays}
  BucketAccessPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: ${policyName(bucket)}
      PolicyDocument:
${indentJson(bucketPolicy(bucket), 8)}
  User:
    Type: AWS::IAM::User
    Properties:
      UserName: ${userName(bucket)}
      ManagedPolicyArns:
        - !Ref BucketAccessPolicy
`;
}

/**
 * The default onboarding recipe: a CloudFormation template that stands up the
 * bucket + a dedicated **IAM user** scoped to it, then the three short steps to
 * deploy it and wire s3cab up (ADR-0056). Goal-framed (ADR-0030). The steps are
 * sequential by necessity — step 2 mints the access-key secret step 3 consumes —
 * so it is human-in-the-loop, not one paste-all. The secret is the one thing kept
 * out of the template (ADR-0056): `create-access-key` prints it once to the
 * terminal and it is never stored in the stack.
 *
 * Step 3 stores the key at set *creation* via `setup --keys` — the initial-config
 * door (ADR-0055), which is why it, not `provider` (the *change-it-afterward*
 * door), completes the recipe: a fresh onboarding has no set yet for `provider` to
 * target, and `setup --keys` creates the set and stores the key in one atomic step.
 * @param {{ bucket: string, region: string, profile?: string }} params
 * @returns {string}
 */
export function awsIamPlan({ bucket, region, profile }) {
  const pf = profileFlag(profile);
  const rf = region ? ` --region ${region}` : "";
  const stack = stackName(bucket);
  const blocks = [
    header(bucket, "AWS"),

    `1. Save this CloudFormation template as ${stack}.yaml:\n\n` +
      `${awsCloudFormationTemplate(bucket)}\n` +
      `   Deploy it — one command creates the bucket and a locked-down s3cab\n` +
      `   identity, resolving every reference for you:\n` +
      `   aws cloudformation deploy --template-file ${stack}.yaml \\\n` +
      `     --stack-name ${stack} --capabilities CAPABILITY_NAMED_IAM${rf}${pf}`,

    `2. Mint an access key for the new identity. This is the one secret step —\n` +
      `   it is shown once here and never stored in the stack:\n` +
      `   aws iam create-access-key --user-name ${userName(bucket)}${pf}`,

    `3. Create your backup set and store the key on it in one step (paste the\n` +
      `   key + secret from step 2 when prompted):\n` +
      `   s3cab setup <name> <directory>... --bucket ${bucket} --keys`,

    `Prefer no long-lived key? Re-run with --roles-anywhere for keyless,\n` +
      `certificate-based access (recommended).`,

    `Signing in with AWS IAM Identity Center (SSO)? It works through the\n` +
      `standard credential chain — run 's3cab help provider'.`,
  ];
  return blocks.join("\n\n");
}
