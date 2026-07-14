import { customEndpoint } from "../lib/env.mjs";
import { ParseArgsError, requireArg } from "../lib/error.mjs";
import {
  awsIamPlan,
  awsRolesAnywherePlan,
  awsSaveConfirmation,
  validateAwsBucketName,
} from "../lib/onboarding.mjs";
import {
  ensureMachineIdentity,
  saveArnsFromStack,
} from "../lib/roles-anywhere.mjs";
import { tildeify } from "../lib/home.mjs";
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
// vs `--roles-anywhere` (keyless, certificate-based — ADR-0057/0058). The RA path
// generates a machine-level CA + client certificate locally (src/lib/roles-anywhere.mjs),
// emits a CloudFormation template embedding the public CA, and — with `--save
// --from-stack` — reads the deployed stack's ARNs back into the local identity
// (read-only DescribeStacks). `--sso` is retired (ADR-0056): SSO works through the
// standard credential chain, so it needs no onboarding path of its own — the
// recipe points there in a line. A custom endpoint (AWS_ENDPOINT_URL*) means "not
// AWS", so the command points at `s3cab help provider` — the non-AWS steps live
// there — instead of printing IAM JSON that can't apply. The recipe text lives in
// src/lib/onboarding.mjs (pure, unit-testable); cert gen + ARN capture live in
// src/lib/roles-anywhere.mjs.

/**
 * Build the steps to set up an S3 bucket as an s3cab backup destination.
 * Purely local/offline — it reads `process.env` for region/endpoint defaults
 * but calls no AWS API. The plan *is* the result (ADR-0043): it returns the
 * finished recipe as text; the dispatcher writes it to stdout (via `renderText`).
 *
 * @param {string} [name] - The bucket name to set up (not needed with `--save`)
 * @param {{ region?: string, profile?: string, "roles-anywhere"?: boolean, save?: boolean, "from-stack"?: string }} [options]
 *   - `region`: the bucket's AWS region (defaults to $AWS_REGION /
 *     $AWS_DEFAULT_REGION / us-east-1); `profile`: an admin AWS profile to
 *     interpolate into the printed `aws` commands; `roles-anywhere`: the keyless
 *     Roles Anywhere path (generate certs + emit the RA template); `save` +
 *     `from-stack`: read a deployed stack's ARNs back into the local RA identity.
 * @returns {Promise<string>} The onboarding recipe or a confirmation, for the
 *   render layer. Async because `--save` makes a read-only DescribeStacks call;
 *   the offline paths just resolve immediately.
 */
export async function aws(name, options = {}) {
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

  // Region for the deploy command's --region flag, defaulting like the test-bucket
  // script (scripts/setup-test-bucket.mjs): an explicit --region wins, then the
  // SDK's own AWS_REGION / AWS_DEFAULT_REGION, then us-east-1 as the fallback.
  const region =
    options.region?.trim() ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "us-east-1";
  const profile = options.profile?.trim() || undefined;

  // `--save` captures a deployed stack's ARNs into the local Roles Anywhere
  // identity — the one online, AWS-touching path (read-only). It reads the stack
  // named by --from-stack, not a bucket, so no bucket positional is required. It
  // only makes sense for the RA identity, so it implies --roles-anywhere.
  if (options.save) {
    const stackName = options["from-stack"]?.trim();
    if (!stackName) {
      throw new ParseArgsError(
        "--save needs --from-stack <stack> (the deployed onboarding stack, e.g. s3cab-<bucket>)",
        { argName: "from-stack" },
      );
    }
    return await saveRolesAnywhere(stackName, region);
  }

  requireArg(name, "bucket");
  validateBucketName(name);
  // AWS onboarding derives named CloudFormation/IAM resources from the bucket, so
  // it has stricter name rules than the permissive global validator (ADR-0056).
  validateAwsBucketName(name);

  // The keyless Roles Anywhere path (ADR-0057/0058): generate the machine identity
  // locally (once — reused on re-run so the CA never silently changes) and emit
  // the RA CloudFormation template embedding its public CA.
  if (options["roles-anywhere"]) {
    const { caPem, created } = ensureMachineIdentity();
    return awsRolesAnywherePlan({
      bucket: name,
      region,
      caPem,
      created,
      profile,
    });
  }

  return awsIamPlan({ bucket: name, region, profile });
}

/**
 * The `--save --from-stack` body: capture the stack's RA ARNs into the local
 * identity, then confirm. The confirmation prose lives with the other recipe text
 * in onboarding.mjs (`awsSaveConfirmation`, pure + unit-testable — this file's
 * header invariant); here we only do the I/O and hand it the display path.
 * @param {string} stackName
 * @param {string} region
 * @returns {Promise<string>}
 */
async function saveRolesAnywhere(stackName, region) {
  const { dir } = await saveArnsFromStack({ stackName, region });
  return awsSaveConfirmation({ stackName, region, dir: tildeify(dir) });
}
