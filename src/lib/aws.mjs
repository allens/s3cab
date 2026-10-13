import { tildeify } from "./home.mjs";
import { bucketPolicy } from "./s3.mjs";

// Generates the cloud-onboarding artifacts the `aws` command uses to stand up an S3
// backup destination + a least-privilege identity for s3cab: two CloudFormation
// **templates** the command writes under `~/.s3cab/` — the bucket
// (`awsBucketTemplate`) and one identity (`awsUserTemplate`/`awsRolesAnywhereTemplate`),
// each its own stack (ADR-0105) — and the short **recipe**
// (`awsIamPlan`/`awsRolesAnywherePlan`) it prints, pointing the user at those files.
// Pure text — no AWS calls, no I/O (the command owns the file write) — which is
// what makes the command generative (ADR-0032/0056) and unit-testable without a
// client (src/lib/aws.test.mjs). The command (src/commands/aws.mjs) resolves
// region/profile/endpoint, writes the templates, and prints what these return.
//
// Why a declarative template, not an imperative `aws` command list (ADR-0056):
// CloudFormation resolves inter-resource references itself (no ARN threading), the
// deploy is one shell-agnostic command, and the stack is updatable/teardownable.
// The one thing kept OUT of the template is the access-key secret — `AWS::IAM::AccessKey`
// would materialize it in stack state, so `create-access-key` stays a single manual
// step (secret to the terminal only, never persisted). See ADR-0056 for the full
// "the delivery form tracks the secret" reasoning.

// The backup bucket's lifecycle rule, as the windows the template embeds below
// (`awsBucketTemplate`): expire *noncurrent* versions after the disaster-recovery
// window — reclaiming the space a soft delete frees — and abort stalled multipart
// uploads after a day. There is deliberately **no** current-object expiry: never
// auto-delete a live backup (the security model, docs/adr/0033), which is why the
// rule is spelled out here rather than parameterized. The exact opposite of the
// *test* bucket's 1-day *current*-object expiry (docs/integration-testing.md /
// scripts/setup-test-bucket.mjs), which is why the two are never shared.
//
// Plain constants, not an SDK `BucketLifecycleConfiguration`: nothing sends this to
// S3 — `s3cab aws` is generative (ADR-0032/0056) and only ever interpolates these
// four values into YAML, so a nested SDK shape existed purely to be taken apart
// again by its one caller. The rendered template is what ships, and what the tests
// assert on.
const LIFECYCLE_RULE_ID = "reclaim-deleted-backups";
const NONCURRENT_DAYS = 90;
const ABORT_DAYS = 1;

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
 * Strip one redundant leading `s3cab-` from the bucket before it goes into a
 * derived resource name (ADR-0056). Bucket names are global, so a user often
 * prefixes theirs with `s3cab-` for uniqueness; without this, `s3cab aws
 * s3cab-photos` would double it into `s3cab-s3cab-photos`. The bucket itself is
 * left untouched (used verbatim) — only the derived stack/user/policy/… names
 * dedupe.
 * @param {string} bucket
 */
const bare = (bucket) => bucket.replace(/^s3cab-/, "");

// Derived names share one scheme (ADR-0056/0105): every stack and resource is
// `s3cab-<bucket>-<suffix>`, the suffix saying what it is, so a name is
// predictable from the bucket and one bucket's whole footprint sorts together.
// The suffixes never collide across buckets: `bucket` and `user` are not eight hex
// digits, so no stack of one bucket can take another's name. The bucket is the
// one name the user owns, so it keeps its literal name (no prefix, no suffix).

/**
 * The bucket stack, shared by every identity on the bucket (ADR-0105).
 * @param {string} bucket
 */
const bucketStackName = (bucket) => `s3cab-${bare(bucket)}-bucket`;
/**
 * The dedicated IAM user's name, which is also its stack's (ADR-0105).
 * @param {string} bucket
 */
const userName = (bucket) => `s3cab-${bare(bucket)}-user`;
/**
 * The inline policy wrapping `bucketPolicy()` on each identity (ADR-0105).
 * @param {string} bucket
 */
const policyName = (bucket) => `s3cab-${bare(bucket)}-policy`;
/**
 * One machine's Roles Anywhere identity stack, named by its CA's fingerprint
 * (ADR-0105); its resources suffix off this stem.
 * @param {string} bucket
 * @param {string} fingerprint - `caFingerprint` (roles-anywhere.mjs) of the machine's CA.
 */
const identityStem = (bucket, fingerprint) =>
  `s3cab-${bare(bucket)}-${fingerprint}`;

/** AWS's hard cap on an IAM user or role name. */
const IAM_NAME_MAX = 64;

/**
 * The longest a *literal* bucket name may be for the IAM name derived from it to
 * fit AWS's {@link IAM_NAME_MAX} cap: the user `s3cab-<bucket>-user`, or with
 * Roles Anywhere the longer role `s3cab-<bucket>-<fingerprint>-role`. Because a
 * leading `s3cab-` is stripped before deriving names ({@link bare}), a prefixed
 * bucket may be exactly that much longer than an unprefixed one — so the cap is
 * on the *derived* name, not the literal, or a `s3cab-`-prefixed bucket whose
 * identity name would actually fit gets wrongly rejected for length it doesn't
 * use (ADR-0056).
 * @param {string} bucket
 * @param {boolean} rolesAnywhere
 */
export const maxBucketNameLength = (bucket, rolesAnywhere) => {
  const decoration = rolesAnywhere
    ? `${identityStem("", "00000000")}-role`.length
    : userName("").length;
  return IAM_NAME_MAX - decoration + (bucket.length - bare(bucket).length);
};

/**
 * The `Tags:` block every resource in the templates carries: a `ManagedBy`
 * attribution tag plus `s3cab:bucket` tying the resource to its bucket, so the
 * whole footprint is discoverable by tag, not only by name; a Roles Anywhere
 * resource also names the `user@machine` that generated its CA. Put in the
 * template (not the deploy `--tags`) so the tags travel with the artifact however
 * the user applies it (ADR-0056: s3cab writes the file, the user deploys it).
 * Indented to sit under a resource's `Properties:` (6 spaces). Values are quoted
 * so an all-numeric bucket name is a string, not a YAML number.
 * @param {string} bucket - The literal bucket name (the association target).
 * @param {string} [machine] - `user@machine`, on a Roles Anywhere identity.
 * @returns {string}
 */
const resourceTags = (bucket, machine) =>
  `      Tags:
        - Key: ManagedBy
          Value: s3cab
        - Key: "s3cab:bucket"
          Value: "${bucket}"` +
  (machine
    ? `
        - Key: "s3cab:machine"
          Value: "${machine}"`
    : "");

/**
 * The `Policies:` block that puts `bucketPolicy()` inline on a user or role —
 * one per identity, so an identity stack needs nothing from the bucket stack and
 * works on a bucket s3cab didn't create (ADR-0105). Indented to sit under
 * `Properties:`.
 * @param {string} bucket
 */
const inlinePolicy = (bucket) => `      Policies:
        - PolicyName: ${policyName(bucket)}
          PolicyDocument:
${indentJson(bucketPolicy(bucket), 12)}`;

/**
 * The ` --profile <name>` suffix interpolated into the generated commands when
 * `--profile` was passed, or `""` otherwise. Pure text here (recipe generation
 * is offline); the printed `s3cab aws --save` step carries it forward, where it
 * authenticates the DescribeStacks read (src/lib/stack-arns.mjs).
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
 * The bucket template `s3cab aws <bucket>` emits (ADR-0105): the backup bucket
 * with every ADR-0033 protection, and nothing else. It is identical for both
 * identity paths and every machine, so deploying it again changes nothing — the
 * recipe passes `--no-fail-on-empty-changeset` so a second machine, or a switch
 * between paths, can run that step as printed.
 *
 * Region is deliberately **not** baked in: the bucket lands in whatever region the
 * stack deploys to, so the old us-east-1 `LocationConstraint` quirk disappears.
 * @param {string} bucket
 * @returns {string} The YAML template text.
 */
export function awsBucketTemplate(bucket) {
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: s3cab backup bucket "${bucket}"
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
          - Id: ${LIFECYCLE_RULE_ID}
            Status: Enabled
            NoncurrentVersionExpiration:
              NoncurrentDays: ${NONCURRENT_DAYS}
            AbortIncompleteMultipartUpload:
              DaysAfterInitiation: ${ABORT_DAYS}
${resourceTags(bucket)}
`;
}

/**
 * The access-key identity template (ADR-0056/0105): a dedicated **IAM user** for
 * s3cab carrying `bucketPolicy()` inline. Its own stack, so it never touches the
 * bucket stack or another identity. The access key itself stays out of it (see
 * the module header).
 * @param {string} bucket
 * @returns {string} The YAML template text.
 */
export function awsUserTemplate(bucket) {
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: s3cab's least-privilege access-key identity for bucket "${bucket}"
Resources:
  User:
    Type: AWS::IAM::User
    Properties:
      UserName: ${userName(bucket)}
${inlinePolicy(bucket)}
${resourceTags(bucket)}
`;
}

/**
 * One machine's Roles Anywhere identity template (ADR-0057/0105): a **keyless**
 * certificate-based identity — a trust anchor over the machine's self-signed CA,
 * an IAM role the trust anchor's principal assumes (carrying `bucketPolicy()`
 * inline), and a profile. No AWS secret ever exists (the client private key stays
 * local — ADR-0058), so the whole identity goes into CloudFormation, unlike the
 * IAM-user path's out-of-band access key ("the delivery form tracks the secret",
 * ADR-0056). Named by the CA's fingerprint, so a second machine's identity is a
 * second stack and never replaces this one's CA.
 *
 * The CA certificate is embedded inline as the trust anchor's `CERTIFICATE_BUNDLE`
 * — it is public (a cert, never the key), so this is safe. The role's trust policy
 * is scoped to *this* trust anchor by `aws:SourceArn` (the external-CA best
 * practice). The `Outputs` are what `s3cab aws --roles-anywhere --save
 * --from-stack` reads back: the three ARNs, and the bucket they serve.
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.caPem - The self-signed CA certificate (PEM), from the local identity.
 * @param {string} params.fingerprint - `caFingerprint(caPem)`.
 * @param {string} params.machine - `user@machine`, for the tags and description.
 * @returns {string} The YAML template text.
 */
export function awsRolesAnywhereTemplate({
  bucket,
  caPem,
  fingerprint,
  machine,
}) {
  const stem = identityStem(bucket, fingerprint);
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
Description: s3cab keyless Roles Anywhere identity for ${machine} on bucket "${bucket}"
Resources:
  TrustAnchor:
    Type: AWS::RolesAnywhere::TrustAnchor
    Properties:
      Name: ${stem}-trust-anchor
      Enabled: true
${resourceTags(bucket, machine)}
      Source:
        SourceType: CERTIFICATE_BUNDLE
        SourceData:
          X509CertificateData: |
${indentText(caPem, 12)}
  Role:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${stem}-role
${inlinePolicy(bucket)}
${resourceTags(bucket, machine)}
      AssumeRolePolicyDocument:
${indentJson(raTrustPolicy, 8)}
  Profile:
    Type: AWS::RolesAnywhere::Profile
    Properties:
      Name: ${stem}-profile
      Enabled: true
      RoleArns:
        - !GetAtt Role.Arn
${resourceTags(bucket, machine)}
Outputs:
  TrustAnchorArn:
    Value: !GetAtt TrustAnchor.TrustAnchorArn
  ProfileArn:
    Value: !GetAtt Profile.ProfileArn
  RoleArn:
    Value: !GetAtt Role.Arn
  Bucket:
    Value: "${bucket}"
`;
}

/**
 * The paths the command wrote the two templates to (ADR-0105), referenced by the
 * deploy commands' `--template-file`.
 * @typedef {{ bucket: string, identity: string }} TemplatePaths
 */

/**
 * The lines both recipes open with: which files were written, and step 1 —
 * deploying the bucket stack, which every identity on the bucket shares. Its
 * deploy passes `--no-fail-on-empty-changeset` because a second machine, or a
 * switch between identity paths, deploys it again unchanged (ADR-0105).
 * @param {string} bucket
 * @param {TemplatePaths} templatePaths
 * @param {string} rf - The ` --region …` suffix, or "".
 * @param {string} pf - The ` --profile …` suffix, or "".
 * @returns {string[]}
 */
const bucketStep = (bucket, templatePaths, rf, pf) => [
  `Wrote the CloudFormation templates:\n` +
    `  bucket:   ${tildeify(templatePaths.bucket)}\n` +
    `  identity: ${tildeify(templatePaths.identity)}\n` +
    `Each command below is one line, so it pastes the same into PowerShell,\n` +
    `cmd, and bash.`,

  `1. Create the bucket, with versioning and a guard that keeps it if the stack\n` +
    `   is ever deleted. Running this again is harmless; if the bucket already\n` +
    `   exists and s3cab didn't create it, skip this step:\n` +
    `   aws cloudformation deploy --template-file "${templatePaths.bucket}" --stack-name ${bucketStackName(bucket)} --no-fail-on-empty-changeset${rf}${pf}`,
];

/**
 * The default onboarding recipe: the bucket stack, then a dedicated **IAM user**
 * scoped to it in its own stack, then the steps that wire s3cab up
 * (ADR-0056/0105). Goal-framed (ADR-0030). The steps are sequential by
 * necessity — step 3 mints the access-key secret step 4 consumes — so it is
 * human-in-the-loop, not one paste-all. The secret is the one thing kept out of
 * the template (ADR-0056): `create-access-key` prints it once to the terminal and
 * it is never stored in the stack.
 *
 * Step 4 stores the key at set *creation* via `setup --keys` — the initial-config
 * door (ADR-0055), which is why it, not `provider` (the *change-it-afterward*
 * door), completes the recipe: a fresh onboarding has no set yet for `provider` to
 * target, and `setup --keys` creates the set and stores the key in one atomic step.
 * @param {{ bucket: string, region: string, profile?: string, templatePaths: TemplatePaths }} params
 * @returns {string}
 */
export function awsIamPlan({ bucket, region, profile, templatePaths }) {
  const pf = profileFlag(profile);
  const rf = region ? ` --region ${region}` : "";
  const blocks = [
    header(bucket, "AWS"),

    ...bucketStep(bucket, templatePaths, rf, pf),

    `2. Create a locked-down s3cab identity that can use only this bucket:\n` +
      `   aws cloudformation deploy --template-file "${templatePaths.identity}" --stack-name ${userName(bucket)} --capabilities CAPABILITY_NAMED_IAM${rf}${pf}`,

    `3. Mint an access key for the new identity. This is the one secret step —\n` +
      `   it is shown once here and never stored in the stack:\n` +
      `   aws iam create-access-key --user-name ${userName(bucket)}${pf}`,

    `4. Create your backup set and store the key on it in one step (paste the\n` +
      `   key + secret from step 3 when prompted):\n` +
      `   s3cab setup --set <name> --bucket ${bucket} --keys <directory>...`,

    `Rather not hold a long-lived key? Re-run with --roles-anywhere for keyless,\n` +
      `certificate-based access (more setup steps).`,

    `Signing in with AWS IAM Identity Center (SSO)? It works through the\n` +
      `standard credential chain — run 's3cab help provider'.`,
  ];
  return blocks.join("\n\n");
}

/**
 * The keyless Roles Anywhere onboarding recipe (ADR-0057/0105). Unlike the
 * IAM-user path, the identity is already generated **locally** by the time this
 * text is shown — a CA + client certificate under `~/.s3cab/roles-anywhere/`, no
 * AWS secret anywhere — so this recipe covers standing up the AWS side and wiring
 * the ARNs back:
 *
 *   1. deploy the bucket stack (shared, harmless to repeat);
 *   2. deploy this machine's identity stack (trust anchor + role + profile);
 *   3. capture its ARNs into the local identity with a read-only
 *      `--save --from-stack` (ADR-0056 — CloudFormation resolves the inter-resource
 *      references, so there is nothing to copy-paste);
 *   4. point a backup set at the identity (`setup`/`provider --roles-anywhere`).
 * @param {object} params
 * @param {string} params.bucket
 * @param {string} params.region
 * @param {boolean} params.created - Whether this run generated a fresh identity.
 * @param {string} params.fingerprint - `caFingerprint` of this machine's CA.
 * @param {TemplatePaths} params.templatePaths
 * @param {string} [params.profile] - An admin profile to interpolate into `aws` commands.
 * @returns {string}
 */
export function awsRolesAnywherePlan({
  bucket,
  region,
  created,
  fingerprint,
  profile,
  templatePaths,
}) {
  const pf = profileFlag(profile);
  const rf = region ? ` --region ${region}` : "";
  const stack = identityStem(bucket, fingerprint);
  const identityLine = created
    ? `Generated a new keyless Roles Anywhere identity (CA + client certificate)`
    : `Reusing your existing Roles Anywhere identity (CA + client certificate)`;
  const blocks = [
    header(bucket, "AWS (keyless, Roles Anywhere)"),

    `${identityLine} under ~/.s3cab/roles-anywhere/. The client private key\n` +
      `stays on this machine and is never sent to AWS; only the public CA\n` +
      `(embedded in the template) is uploaded, as the trust anchor.`,

    ...bucketStep(bucket, templatePaths, rf, pf),

    `2. Create this machine's keyless identity (trust anchor, role, profile).\n` +
      `   It is this machine's alone, so it never affects another machine's:\n` +
      `   aws cloudformation deploy --template-file "${templatePaths.identity}" --stack-name ${stack} --capabilities CAPABILITY_NAMED_IAM${rf}${pf}`,

    `3. Capture the stack's ARNs into your local identity (read-only — it only\n` +
      `   reads the stack you just deployed, creates nothing):\n` +
      `   s3cab aws --roles-anywhere --save --from-stack ${stack}${rf}${pf}`,

    `4. Point a backup set at this identity — at creation:\n` +
      `   s3cab setup --set <name> --bucket ${bucket} --roles-anywhere <directory>...\n` +
      `   or switch an existing set:\n` +
      `   s3cab provider --roles-anywhere <set>`,

    `s3cab then authenticates with the certificate and receives short-lived AWS\n` +
      `credentials for every backup — no long-lived key ever on disk. Another\n` +
      `machine backing up to this bucket runs these same steps there.`,
  ];
  return blocks.join("\n\n");
}

/**
 * The confirmation shown after `s3cab aws --roles-anywhere --save --from-stack`
 * captures a deployed stack's ARNs into the local identity (src/commands/aws.mjs):
 * it names the file it wrote and the next step — pointing a backup set at the
 * now-complete identity (ADR-0030, goal-framed). Pure text, so it lives here with
 * the other recipe prose (aws.mjs's "recipe text lives in src/lib/aws.mjs"
 * invariant) and is unit-testable without the `--save` I/O.
 * @param {{ stackName: string, region: string, bucket: string, envPath: string }} params -
 *   `envPath` is the bucket's env file as a display path (the caller passes
 *   `tildeify(path)`).
 * @returns {string}
 */
export function awsSaveConfirmation({ stackName, region, bucket, envPath }) {
  return `Saved the Roles Anywhere ARNs from stack "${stackName}" (region ${region})
for bucket "${bucket}", to ${envPath}.

Your keyless identity is now fully configured for that bucket. Point a backup
set at it — at creation:
  s3cab setup --set <name> --bucket ${bucket} --roles-anywhere <directory>...
or switch an existing set:
  s3cab provider --roles-anywhere <set>
s3cab then authenticates with the certificate and receives short-lived AWS
credentials for every backup — no long-lived key.`;
}
