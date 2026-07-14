import { customEndpoint } from "../lib/env.mjs";
import { requireArg } from "../lib/error.mjs";
import { awsIamPlan, validateAwsBucketName } from "../lib/onboarding.mjs";
import { validateBucketName } from "../lib/sets.mjs";

// `s3cab aws` — the AWS-onboarding command. It **prints** a CloudFormation
// template + the short recipe to stand up an S3 bucket as a backup destination
// and a least-privilege identity for s3cab; it makes no AWS calls and needs no
// credentials to run (generative, not active — ADR-0032/0056). Provisioning is a
// rare, one-time, per-bucket bootstrap, so it is a separate top-level command,
// not part of `setup` (a per-set operation) or `provider` (the connection-config
// door, ADR-0031/0047) — though it composes with them: its final step is
// `s3cab setup ... --keys`, which creates the first set in the new bucket.
//
// AWS only (ADR-0047): the identity fork is the default IAM-user (access keys)
// vs `--roles-anywhere` (keyless, certificate-based — ADR-0057; not built yet).
// `--sso` is retired (ADR-0056): SSO works through the standard credential chain,
// so it needs no onboarding path of its own — the recipe points there in a line.
// A custom endpoint (AWS_ENDPOINT_URL*) means "not AWS", so the command points at
// `s3cab help provider` — the non-AWS steps live there — instead of printing IAM
// JSON that can't apply. The plan text itself lives in src/lib/onboarding.mjs
// (pure, so it is unit-testable).

/**
 * Build the steps to set up an S3 bucket as an s3cab backup destination.
 * Purely local/offline — it reads `process.env` for region/endpoint defaults
 * but calls no AWS API. The plan *is* the result (ADR-0043): it returns the
 * finished recipe as text; the dispatcher writes it to stdout (via `renderText`).
 *
 * @param {string} [name] - The bucket name to set up
 * @param {{ region?: string, profile?: string, "roles-anywhere"?: boolean }} [options]
 *   - `region`: the bucket's AWS region (defaults to $AWS_REGION /
 *     $AWS_DEFAULT_REGION / us-east-1); `profile`: an admin AWS profile to
 *     interpolate into the printed `aws` commands; `roles-anywhere`: emit the
 *     keyless Roles Anywhere recipe instead of the IAM-user one (not built yet).
 * @returns {string} The onboarding recipe, ready for the render layer.
 */
export function aws(name, options = {}) {
  // A custom endpoint is the single "not AWS" signal: an S3-compatible provider
  // has no IAM, so the AWS recipes can't apply — redirect to the non-AWS steps
  // instead of guessing. Checked before the bucket arg (the redirect doesn't
  // need one).
  const endpoint = customEndpoint();
  if (endpoint) {
    return `A custom S3 endpoint is set (${endpoint}), so this backup destination
isn't on AWS — and 's3cab aws' generates an AWS CloudFormation template
(bucket, IAM policy, IAM user) that S3-compatible providers can't use.

For the provider-neutral setup steps (Cloudflare R2, Backblaze B2,
Wasabi, MinIO, …), run:
  s3cab help provider`;
  }

  requireArg(name, "bucket");
  validateBucketName(name);
  // AWS onboarding derives named CloudFormation/IAM resources from the bucket, so
  // it has stricter name rules than the permissive global validator (ADR-0056).
  validateAwsBucketName(name);

  // The keyless Roles Anywhere path (ADR-0057) has a recognized flag so the
  // surface exists, but its cert generation + template fragment aren't built yet;
  // error clearly and point back at the working default meanwhile (ADR-0030).
  if (options["roles-anywhere"]) {
    throw new Error(
      `Keyless Roles Anywhere onboarding (--roles-anywhere) isn't available yet.\n` +
        `For now, set up "${name}" with the default IAM-user path:\n` +
        `   s3cab aws ${name}`,
    );
  }

  // Region for the deploy command's --region flag, defaulting like the test-bucket
  // script (scripts/setup-test-bucket.mjs): an explicit --region wins, then the
  // SDK's own AWS_REGION / AWS_DEFAULT_REGION, then us-east-1 as the fallback.
  const region =
    options.region?.trim() ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const profile = options.profile?.trim() || undefined;

  return awsIamPlan({ bucket: name, region, profile });
}
