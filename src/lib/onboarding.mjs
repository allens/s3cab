import { ValidationError } from "./error.mjs";
import { tildeify } from "./home.mjs";
import { bucketPolicy } from "./s3.mjs";

// Generates the cloud-onboarding artifacts the `aws` command uses to stand up an S3
// backup destination + a least-privilege identity for s3cab: the CloudFormation
// **template** (`awsCloudFormationTemplate`/`awsRolesAnywhereTemplate`) the command
// writes to `~/.s3cab/<bucket>.yaml`, and the short **recipe**
// (`awsIamPlan`/`awsRolesAnywherePlan`) it prints, pointing the user at that file.
// Pure text — no AWS calls, no I/O (the command owns the file write) — which is
// what makes the command generative (ADR-0032/0056) and unit-testable without a
// client (src/lib/onboarding.test.mjs). The command (src/commands/aws.mjs) resolves
// region/profile/endpoint, writes the template, and prints what these return.
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
 * Indent a multi-line text block under a YAML key. Used to embed a PEM
 * certificate (the CA bundle) inside a `|` block scalar without a YAML
 * serializer — same single-source-of-truth trick as {@link indentJson}. Trailing
 * blank lines are dropped so the block scalar stays tidy.
 * @param {string} text
 * @param {number} spaces
 */
const indentText = (text, spaces) => {
  const pad = " ".repeat(spaces);
  return text
    .replace(/\n+$/, "")
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
 * The IAM role assumed via Roles Anywhere (RA identity path, ADR-0056/0057).
 * @param {string} bucket
 */
const roleName = (bucket) => `s3cab-role-${bucket}`;
/**
 * The Roles Anywhere trust anchor (external self-signed CA, ADR-0056/0057).
 * @param {string} bucket
 */
const trustAnchorName = (bucket) => `s3cab-trust-anchor-${bucket}`;
/**
 * The Roles Anywhere profile pointing at the role (ADR-0056/0057).
 * @param {string} bucket
 */
const profileName = (bucket) => `s3cab-profile-${bucket}`;

/** IAM's hard cap on a user name — the binding length limit here (below). */
const IAM_NAME_MAX = 64;

/**
 * The AWS-onboarding-specific bucket-name checks, on top of the permissive global
 * `validateBucketName` (sets.mjs, provider-neutral by design). The CloudFormation
 * template derives named resources from the bucket (ADR-0056), and two AWS
 * *control-plane* limits — which bite only here, never on non-AWS providers like
 * R2/B2/Wasabi — would otherwise surface as an opaque `aws cloudformation deploy`
 * failure well after the recipe was printed:
 *
 *   - **Dots** — CloudFormation stack names (`s3cab-<bucket>`) must match
 *     `[A-Za-z][-A-Za-z0-9]*`, so no dots. (Dots are fine for the S3 bucket, the
 *     IAM user, and the policy — only the *stack* name rejects them.)
 *   - **Length** — IAM user names (`s3cab-user-<bucket>`) cap at 64 characters.
 *
 * Fail fast with the real reason (ADR-0030) instead of emitting a template that
 * can't deploy. Kept AWS-scoped on purpose: a dotted or long bucket name is
 * perfectly valid on the non-AWS providers s3cab also targets, so the global
 * validator stays permissive (its rationale) and only `aws` applies these.
 * @param {string} bucket
 */
export function validateAwsBucketName(bucket) {
  if (bucket.includes(".")) {
    throw new ValidationError(
      `That bucket name can't be used for AWS onboarding — the CloudFormation\n` +
        `stack name "${stackName(bucket)}" can't contain dots.\n` +
        `Use a bucket name without dots, e.g.\n` +
        `   ${bucket.replaceAll(".", "-")}`,
    );
  }
  const user = userName(bucket);
  if (user.length > IAM_NAME_MAX) {
    const max = IAM_NAME_MAX - userName("").length;
    throw new ValidationError(
      `That bucket name can't be used for AWS onboarding — the IAM user name\n` +
        `"${user}" would exceed AWS's ${IAM_NAME_MAX}-character limit (it is ${user.length}).\n` +
        `Use a bucket name of ${max} characters or fewer.`,
    );
  }
}

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
 * The shared `Resources:` block both onboarding templates carry — the protected
 * backup bucket + the managed `bucketPolicy()`, indented for nesting under
 * `Resources:`. Factored out so the IAM-user and Roles Anywhere templates keep an
 * identical bucket (every ADR-0033 protection) with one definition.
 * @param {string} bucket
 * @returns {string}
 */
function bucketResources(bucket) {
  const [rule] = backupLifecycle().Rules ?? [];
  const noncurrentDays = rule?.NoncurrentVersionExpiration?.NoncurrentDays;
  const abortDays = rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation;
  return `  Bucket:
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
${indentJson(bucketPolicy(bucket), 8)}`;
}

/**
 * The CloudFormation template `s3cab aws <bucket>` emits (ADR-0056): one stack
 * standing up the backup bucket plus a least-privilege IAM user for s3cab. Every
 * ADR-0033 bucket protection is baked in via {@link bucketResources}; the identity
 * is a dedicated **IAM user** carrying the managed `bucketPolicy()`.
 *
 * Region is deliberately **not** baked in: the bucket lands in whatever region the
 * stack deploys to, so the old us-east-1 `LocationConstraint` quirk disappears.
 * @param {string} bucket
 * @returns {string} The YAML template text.
 */
export function awsCloudFormationTemplate(bucket) {
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: s3cab backup bucket "${bucket}" and its least-privilege identity
Resources:
${bucketResources(bucket)}
  User:
    Type: AWS::IAM::User
    Properties:
      UserName: ${userName(bucket)}
      ManagedPolicyArns:
        - !Ref BucketAccessPolicy
`;
}

/**
 * The Roles Anywhere onboarding template (ADR-0056/0057): the same bucket +
 * managed policy as the IAM-user template, but the identity is a **keyless**
 * certificate-based one — a trust anchor over the self-signed CA, an IAM role the
 * trust anchor's principal assumes (carrying the same managed `bucketPolicy()`),
 * and a profile. No AWS secret ever exists (the client private key stays local —
 * ADR-0058), so the whole identity goes into CloudFormation, unlike the IAM-user
 * path's out-of-band access key ("the delivery form tracks the secret", ADR-0056).
 *
 * The CA certificate is embedded inline as the trust anchor's `CERTIFICATE_BUNDLE`
 * — it is public (a cert, never the key), so this is safe. The role's trust policy
 * is scoped to *this* trust anchor by `aws:SourceArn` (the external-CA best
 * practice). Three `Outputs` (the trust anchor / profile / role ARNs) are what
 * `s3cab aws --roles-anywhere --save --from-stack` reads back.
 * @param {string} bucket
 * @param {string} caPem - The self-signed CA certificate (PEM), from the local identity.
 * @returns {string} The YAML template text.
 */
export function awsRolesAnywhereTemplate(bucket, caPem) {
  const raTrustPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "rolesanywhere.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
        // Scope the trust to *this* trust anchor (the external-CA best practice).
        // `Fn::GetAtt` in its pure-JSON form resolves to the anchor's ARN — no
        // YAML short-form tag inside the JSON-in-YAML block, which CloudFormation
        // parses unambiguously.
        Condition: {
          ArnEquals: {
            "aws:SourceArn": {
              "Fn::GetAtt": ["TrustAnchor", "TrustAnchorArn"],
            },
          },
        },
      },
    ],
  };
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: s3cab backup bucket "${bucket}" and its keyless Roles Anywhere identity
Resources:
${bucketResources(bucket)}
  TrustAnchor:
    Type: AWS::RolesAnywhere::TrustAnchor
    Properties:
      Name: ${trustAnchorName(bucket)}
      Enabled: true
      Source:
        SourceType: CERTIFICATE_BUNDLE
        SourceData:
          X509CertificateData: |
${indentText(caPem, 12)}
  Role:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${roleName(bucket)}
      ManagedPolicyArns:
        - !Ref BucketAccessPolicy
      AssumeRolePolicyDocument:
${indentJson(raTrustPolicy, 8)}
  Profile:
    Type: AWS::RolesAnywhere::Profile
    Properties:
      Name: ${profileName(bucket)}
      Enabled: true
      RoleArns:
        - !GetAtt Role.Arn
Outputs:
  TrustAnchorArn:
    Value: !GetAtt TrustAnchor.TrustAnchorArn
  ProfileArn:
    Value: !GetAtt Profile.ProfileArn
  RoleArn:
    Value: !GetAtt Role.Arn
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
 * @param {{ bucket: string, region: string, profile?: string, templatePath: string }} params
 *   - `templatePath`: where the command wrote the template (ADR-0056), referenced
 *     by the deploy command's `--template-file`.
 * @returns {string}
 */
export function awsIamPlan({ bucket, region, profile, templatePath }) {
  const pf = profileFlag(profile);
  const rf = region ? ` --region ${region}` : "";
  const stack = stackName(bucket);
  const blocks = [
    header(bucket, "AWS"),

    `Wrote the CloudFormation template to ${tildeify(templatePath)}.`,

    `1. Deploy it — one command creates the bucket and a locked-down s3cab\n` +
      `   identity, resolving every reference for you (one line so it pastes\n` +
      `   identically into PowerShell, cmd, and bash):\n` +
      `   aws cloudformation deploy --template-file "${templatePath}" --stack-name ${stack} --capabilities CAPABILITY_NAMED_IAM${rf}${pf}`,

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

/**
 * The keyless Roles Anywhere onboarding recipe (ADR-0056/0057). Unlike the
 * IAM-user path, the identity is already generated **locally** by the time this
 * text is shown — a CA + client certificate under `~/.s3cab/roles-anywhere/`, no
 * AWS secret anywhere — so this recipe covers standing up the AWS side and wiring
 * the ARNs back:
 *
 *   1. deploy the template (bucket + trust anchor + role + profile, all keyless);
 *   2. capture the three ARNs into the local identity with a read-only
 *      `--save --from-stack` (ADR-0056 — CloudFormation resolves the inter-resource
 *      references, so there is nothing to copy-paste);
 *   3. point a backup set at the identity (`setup`/`provider --roles-anywhere`).
 *
 * The runtime signer that *uses* this identity for backups is built (Phase B,
 * ADR-0057): step 3's set then authenticates with the certificate for every backup.
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.region
 * @param {boolean} params.created - Whether this run generated a fresh identity.
 * @param {string} params.templatePath - Where the command wrote the template
 *   (ADR-0056), referenced by the deploy command's `--template-file`.
 * @param {string} [params.profile] - An admin profile to interpolate into `aws` commands.
 * @returns {string}
 */
export function awsRolesAnywherePlan({
  bucket,
  region,
  created,
  profile,
  templatePath,
}) {
  const pf = profileFlag(profile);
  const rf = region ? ` --region ${region}` : "";
  const stack = stackName(bucket);
  const identityLine = created
    ? `Generated a new keyless Roles Anywhere identity (CA + client certificate)`
    : `Reusing your existing Roles Anywhere identity (CA + client certificate)`;
  const blocks = [
    header(bucket, "AWS (keyless, Roles Anywhere)"),

    `${identityLine} under ~/.s3cab/roles-anywhere/. The client private key\n` +
      `stays on this machine and is never sent to AWS; only the public CA\n` +
      `(embedded in the template) is uploaded, as the trust anchor.`,

    `Wrote the CloudFormation template to ${tildeify(templatePath)}.`,

    `1. Deploy it — one command creates the bucket and the keyless identity\n` +
      `   (trust anchor, role, profile), resolving every reference for you (one\n` +
      `   line so it pastes identically into PowerShell, cmd, and bash):\n` +
      `   aws cloudformation deploy --template-file "${templatePath}" --stack-name ${stack} --capabilities CAPABILITY_NAMED_IAM${rf}${pf}`,

    `2. Capture the stack's ARNs into your local identity (read-only — it only\n` +
      `   reads the stack you just deployed, creates nothing):\n` +
      `   s3cab aws --roles-anywhere --save --from-stack ${stack}${rf}`,

    `3. Point a backup set at this identity — at creation:\n` +
      `   s3cab setup <name> <directory>... --bucket ${bucket} --roles-anywhere\n` +
      `   or switch an existing set:\n` +
      `   s3cab provider --roles-anywhere <set>`,

    `s3cab then authenticates with the certificate and receives short-lived AWS\n` +
      `credentials for every backup — no long-lived key ever on disk.`,
  ];
  return blocks.join("\n\n");
}
