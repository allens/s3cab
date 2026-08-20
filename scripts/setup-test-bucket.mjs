/**
 * Provision an s3cab test bucket: create it (idempotently), then apply the
 * auto-expiry lifecycle the testing strategy mandates — and, for a conformance
 * bucket, enable versioning first.
 *
 * Test buckets are named `test-s3cab-<owner>-<testType>` (see
 * docs/integration-testing.md "Create a bucket"). The `test-s3cab-` prefix is the
 * safety boundary — test IAM identities are scoped to it — so this script refuses
 * to apply its expire-everything lifecycle to a bucket outside the prefix unless
 * --force says the name is deliberate.
 *
 * Portable, cross-platform alternative to the raw `aws s3api` CLI commands: it uses
 * the AWS SDK that s3cab already depends on, so it needs no AWS CLI install and the
 * same `node` invocation runs on Windows, macOS and Linux. Credentials come from the
 * ambient environment via the standard AWS credential chain (AWS_* env vars, an
 * `aws sso login` session, an instance role, etc.) — the same chain the app uses.
 *
 * Usage:
 *   node scripts/setup-test-bucket.mjs [--conformance] [--force] [--days <n>] <bucket>
 *   S3CAB_TEST_BUCKET=<bucket> node scripts/setup-test-bucket.mjs
 *
 * The default is an integration bucket: unversioned, flat 1-day expiry, shareable
 * between concurrent runs. --conformance instead provisions for the model-based
 * conformance harness, whose assertions cover whole-bucket state: versioning
 * enabled, plus a versioned-aware expiry baseline (noncurrent versions and
 * orphaned delete markers are reclaimed too).
 *
 * --days raises the expiry clock for a bucket holding data meant to outlive a run.
 * Re-running this script restores the default, which is a feature for a test bucket
 * and a trap for one holding staged fixtures — pass --days again when you do.
 *
 * Region is read from AWS_REGION / AWS_DEFAULT_REGION, defaulting to us-east-1 (the
 * CI reference region). See docs/design/testing.md "Provisioning" for the why.
 *
 * Equivalent AWS CLI (the documented reference form):
 *   aws s3api create-bucket --bucket <bucket> --region us-east-1
 *   aws s3api put-bucket-versioning --bucket <bucket> \
 *     --versioning-configuration Status=Enabled          # --conformance only
 *   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
 *     --lifecycle-configuration file://lifecycle.json
 * where lifecycle.json is the LifecycleConfiguration object built below.
 */
import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** @import { BucketLocationConstraint, LifecycleRule } from "@aws-sdk/client-s3" */

const args = process.argv.slice(2);
const conformance = args.includes("--conformance");
const force = args.includes("--force");
const daysIndex = args.indexOf("--days");
/** @param {number} index */
const isDaysValue = (index) => index === daysIndex + 1;
const unknown = args.find(
  (arg, index) =>
    arg.startsWith("-") &&
    arg !== "--conformance" &&
    arg !== "--force" &&
    arg !== "--days" &&
    !isDaysValue(index),
);
const positionals = args.filter(
  (arg, index) => !arg.startsWith("-") && !isDaysValue(index),
);
const bucket = positionals[0] ?? process.env.S3CAB_TEST_BUCKET;

// A day by default: long enough for any suite, short enough that a crashed run's
// residue is swept before the next one starts. For the tiers that assert whole-bucket
// state that sweep is correctness, not housekeeping — test/crash asserts exact object
// counts and test/model/conformance resets the whole bucket, so both want the short
// clock and neither holds anything worth keeping. Raise it only for a bucket holding
// data meant to outlive a run, which today means fixtures staged for a clean-room
// restorer (see cleanroom/stage.mjs).
const days = daysIndex === -1 ? 1 : Number(args[daysIndex + 1]);
if (
  unknown !== undefined ||
  positionals.length > 1 ||
  !bucket ||
  !Number.isInteger(days) ||
  days < 1
) {
  console.error(
    "usage: node scripts/setup-test-bucket.mjs [--conformance] [--force] [--days <n>] <bucket>  (or set S3CAB_TEST_BUCKET)",
  );
  process.exit(2);
}

// The lifecycle below auto-deletes EVERY object on that clock, and is applied even to
// a bucket that already exists — so refuse a name outside the test-bucket naming
// convention, where a slip could point it at a bucket holding real backups.
const flags = `${conformance ? "--conformance " : ""}${daysIndex === -1 ? "" : `--days ${days} `}`;
if (!bucket.startsWith("test-s3cab-") && !force) {
  console.error(
    `'${bucket}' doesn't look like a test bucket (they're named\n` +
      "test-s3cab-<owner>-<testType>), so refusing to give it the test lifecycle,\n" +
      `which auto-deletes every object after ${days} day${days === 1 ? "" : "s"}. If the name is deliberate:\n` +
      "\n" +
      `    node scripts/setup-test-bucket.mjs --force ${flags}${bucket}\n`,
  );
  process.exit(2);
}

const region =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

const client = new S3Client({ region });

// us-east-1 is the API default and must NOT carry a LocationConstraint (S3 rejects
// it); every other region requires one. The cast keeps tsc happy with the SDK's
// region enum while letting an arbitrary configured region through.
const location = /** @type {BucketLocationConstraint} */ (region);
const createInput =
  region === "us-east-1"
    ? { Bucket: bucket }
    : {
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: location },
      };

try {
  await client.send(new CreateBucketCommand(createInput));
  console.log(`created bucket ${bucket} (${region})`);
} catch (error) {
  // Re-running setup is fine: a bucket you already own is success, not failure.
  if (error instanceof Error && error.name === "BucketAlreadyOwnedByYou") {
    console.log(`bucket ${bucket} already exists and is yours — continuing`);
  } else if (error instanceof Error && error.name === "AccessDenied") {
    // A scoped test identity is typically granted the data plane and the bucket's
    // own settings, but not s3:CreateBucket — which made re-running this script to
    // adjust an existing bucket (the whole point of --days) impossible. Assume the
    // bucket is there and carry on: if it isn't, the calls below fail by name, and
    // that error describes the real problem better than this one does.
    console.log(
      `no permission to create ${bucket} — assuming it already exists and continuing`,
    );
  } else {
    throw error;
  }
}

// Conformance buckets are versioned because the harness asserts whole-bucket
// invariants, version state included. Integration buckets stay unversioned: their
// suites assert only per-run state and share the bucket, and an unversioned bucket
// keeps the unversioned code path exercised.
if (conformance) {
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  console.log("enabled versioning (conformance bucket)");
}

// Auto-expiry is both the cost cap and the self-heal: a test that crashes before its
// `finally` teardown leaves orphan objects, which this sweeps on the --days clock (1
// is S3's minimum, and the default). AbortIncompleteMultipartUpload also clears
// crashed multipart uploads, which never appear in ListObjects and would otherwise
// accrue cost invisibly — it stays at a day whatever --days says, because nothing
// worth keeping is ever a half-finished upload, and that is the one form of residue
// you cannot see to clean up by hand.
//
// On a versioned (conformance) bucket the flat Days rule only lays delete markers,
// so noncurrent versions need their own expiry — and the markers theirs, in a
// second rule, because S3 forbids ExpiredObjectDeleteMarker in a rule that also
// carries Expiration.Days.
/** @type {LifecycleRule[]} */
const rules = conformance
  ? [
      {
        ID: "expire-test-objects",
        Status: "Enabled",
        Filter: {},
        Expiration: { Days: days },
        NoncurrentVersionExpiration: { NoncurrentDays: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
      {
        ID: "expire-delete-markers",
        Status: "Enabled",
        Filter: {},
        Expiration: { ExpiredObjectDeleteMarker: true },
      },
    ]
  : [
      {
        ID: "expire-test-objects",
        Status: "Enabled",
        Filter: {},
        Expiration: { Days: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ];

await client.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: { Rules: rules },
  }),
);
const clock = `${days} day${days === 1 ? "" : "s"}`;
console.log(
  conformance
    ? `applied lifecycle rules: expire objects, noncurrent versions and delete markers after ${clock}`
    : `applied lifecycle rule: expire objects after ${clock}`,
);

console.log(
  `\nNext: set S3CAB_TEST_BUCKET=${bucket} (plus AWS_* credentials) to run the gated S3 suites.`,
);
