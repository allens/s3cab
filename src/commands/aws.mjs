import { requireArg } from "../lib/error.mjs";
import { awsIamPlan, awsSsoPlan } from "../lib/onboarding.mjs";
import { validateBucketName } from "../lib/sets.mjs";

// `s3cab aws` — the AWS-onboarding command. It **prints** the exact `aws`
// CLI commands + policy/lifecycle JSON to stand up an S3 bucket as a backup
// destination and a least-privilege identity for s3cab; it makes no AWS calls
// and needs no credentials to run (generative, not active — ADR-0032). Provisioning
// is a rare, one-time, per-bucket bootstrap, so it is a separate top-level command,
// not part of `setup` (a per-set operation) or `provider` (the connection-config
// door, ADR-0031/0047) — though it composes with both: its final step is
// `s3cab provider --profile <name>`, then `s3cab setup`.
//
// AWS only (ADR-0047): the identity fork is IAM-user (default) vs `--sso`
// (IAM Identity Center); a custom endpoint (AWS_ENDPOINT_URL*) means "not AWS",
// so the command points at `s3cab help provider` — the non-AWS steps live
// there — instead of printing IAM JSON that can't apply. The plan text itself
// lives in src/lib/onboarding.mjs (pure, so it is unit-testable).

/**
 * Build the steps to set up an S3 bucket as an s3cab backup destination.
 * Purely local/offline — it reads `process.env` for region/endpoint defaults
 * but calls no AWS API. The plan *is* the result (ADR-0043): it returns the
 * finished recipe as text; the dispatcher writes it to stdout (via `renderText`).
 *
 * @param {string} [name] - The bucket name to set up
 * @param {object} [options]
 * @param {string} [options.region] - The bucket's AWS region (defaults to $AWS_REGION / $AWS_DEFAULT_REGION / us-east-1)
 * @param {string} [options.profile] - An admin AWS profile to interpolate into the printed `aws` commands
 * @param {boolean} [options.sso] - Emit the AWS IAM Identity Center (SSO) recipe instead of the IAM-user one
 * @returns {string} The onboarding recipe, ready for the render layer.
 */
export function aws(name, options = {}) {
  // A custom endpoint is the single "not AWS" signal (the same SDK-native vars
  // s3.mjs's customEndpoint() reads): an S3-compatible provider has no IAM, so
  // the AWS recipes can't apply — redirect to the non-AWS steps instead of
  // guessing. Checked before the bucket arg (the redirect doesn't need one).
  const endpoint =
    process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;
  if (endpoint) {
    return `A custom S3 endpoint is set (${endpoint}), so this backup destination
isn't on AWS — and 's3cab aws' generates AWS-specific setup (IAM policy,
lifecycle JSON) that S3-compatible providers can't use.

For the provider-neutral setup steps (Cloudflare R2, Backblaze B2,
Wasabi, MinIO, …), run:
  s3cab help provider`;
  }

  requireArg(name, "bucket");
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

  return options.sso
    ? awsSsoPlan({ bucket: name, region, profile })
    : awsIamPlan({ bucket: name, region, profile });
}
