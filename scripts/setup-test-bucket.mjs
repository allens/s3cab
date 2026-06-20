/**
 * Provision the s3cab integration-test bucket: create it (idempotently) and apply
 * the ~1-day auto-expiry lifecycle rule the testing strategy mandates.
 *
 * Portable, cross-platform alternative to the raw `aws s3api` CLI commands: it uses
 * the AWS SDK that s3cab already depends on, so it needs no AWS CLI install and the
 * same `node` invocation runs on Windows, macOS and Linux. Credentials come from the
 * ambient environment via the standard AWS credential chain (AWS_* env vars, an
 * `aws sso login` session, an instance role, etc.) — the same chain the app uses.
 *
 * Usage:
 *   node scripts/setup-test-bucket.mjs <bucket>
 *   S3CAB_TEST_BUCKET=<bucket> node scripts/setup-test-bucket.mjs
 *
 * Region is read from AWS_REGION / AWS_DEFAULT_REGION, defaulting to us-east-1 (the
 * CI reference region). See docs/specs/testing.md "Provisioning" for the why.
 *
 * Equivalent AWS CLI (the documented reference form):
 *   aws s3api create-bucket --bucket <bucket> --region us-east-1
 *   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
 *     --lifecycle-configuration file://lifecycle.json
 * where lifecycle.json is the LifecycleConfiguration object built below.
 */
import {
  CreateBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const bucket = process.argv[2] ?? process.env.S3CAB_TEST_BUCKET;
if (!bucket) {
  console.error(
    "usage: node scripts/setup-test-bucket.mjs <bucket>  (or set S3CAB_TEST_BUCKET)",
  );
  process.exit(2);
}

const region =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

const client = new S3Client({ region });

// us-east-1 is the API default and must NOT carry a LocationConstraint (S3 rejects
// it); every other region requires one. The cast keeps tsc happy with the SDK's
// region enum while letting an arbitrary configured region through.
const location =
  /** @type {import("@aws-sdk/client-s3").BucketLocationConstraint} */ (region);
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
  } else {
    throw error;
  }
}

// Auto-expiry is both the cost cap and the self-heal: a test that crashes before its
// `finally` teardown leaves orphan objects, which this sweeps within ~a day (1 is
// S3's minimum). AbortIncompleteMultipartUpload also clears crashed multipart uploads,
// which never appear in ListObjects and would otherwise accrue cost invisibly.
await client.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: "expire-test-objects",
          Status: "Enabled",
          Filter: {},
          Expiration: { Days: 1 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    },
  }),
);
console.log("applied lifecycle rule: expire objects after 1 day");

console.log(
  `\nNext: set S3CAB_TEST_BUCKET=${bucket} (plus AWS_* credentials) to run the gated S3 suites.`,
);
