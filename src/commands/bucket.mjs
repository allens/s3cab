import { notImplemented, requireArg } from "../lib/error.mjs";
import { awsIamPlan } from "../lib/onboarding.mjs";
import { validateBucketName } from "../lib/sets.mjs";

// `s3cab bucket` — the cloud-onboarding command. It **prints** the exact `aws`
// CLI commands + policy/lifecycle JSON to stand up an S3 bucket as a backup
// destination and a least-privilege identity for s3cab; it makes no AWS calls
// and needs no credentials to run (generative, not active — ADR-0032). Provisioning
// is a rare, one-time, per-bucket bootstrap, so it is a separate top-level command,
// not part of `setup` (a per-set operation) or `aws` (the "point at an existing
// profile" door, ADR-0031) — though it composes with both: its final step is
// `s3cab aws --profile <name>`, then `s3cab setup`.
//
// The identity step is the only fork: the default emits the IAM-user recipe;
// `--sso` emits the AWS IAM Identity Center recipe; a custom endpoint
// (AWS_ENDPOINT_URL*) auto-selects the provider-neutral non-AWS guidance. The
// plan text itself lives in src/lib/onboarding.mjs (pure, so it is unit-testable).

/**
 * Print the steps to set up an S3 bucket as an s3cab backup destination.
 * Purely local/offline — it reads `process.env` for region/endpoint defaults
 * but calls no AWS API. All output goes to stdout (ADR-0010): the plan *is* the
 * result.
 *
 * @param {string} [name] - The bucket name to set up
 * @param {object} [options]
 * @param {string} [options.region] - The bucket's AWS region (defaults to $AWS_REGION / $AWS_DEFAULT_REGION / us-east-1)
 * @param {string} [options.profile] - An admin AWS profile to interpolate into the printed `aws` commands
 * @param {boolean} [options.sso] - Emit the AWS IAM Identity Center (SSO) recipe instead of the IAM-user one
 * @returns {undefined}
 */
export function bucket(name, options = {}) {
  requireArg(name, "<bucket>");
  validateBucketName(name);

  // Region for the create-bucket command, defaulting like the test-bucket script
  // (scripts/setup-test-bucket.mjs): an explicit --region wins, then the SDK's own
  // AWS_REGION / AWS_DEFAULT_REGION, then us-east-1 as the bootstrap fallback.
  const region =
    options.region?.trim() ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const profile = options.profile?.trim() || undefined;
  // A custom endpoint is the single "not AWS" signal (the same SDK-native vars
  // s3.mjs's customEndpoint() reads): an S3-compatible provider has no IAM, so it
  // takes the provider-neutral path rather than the IAM/SSO recipes.
  const endpoint =
    process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;

  // The non-AWS and SSO recipes arrive in the next slice; the default IAM path
  // is the common case and works now.
  if (endpoint) return notImplemented("bucket for a non-AWS endpoint");
  if (options.sso) return notImplemented("bucket --sso");

  process.stdout.write(awsIamPlan({ bucket: name, region, profile }) + "\n");
  return undefined;
}
