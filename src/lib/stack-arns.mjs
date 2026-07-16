import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { updateEnvFile } from "./env-file.mjs";
import { ValidationError } from "./error.mjs";
import { tildeify } from "./home.mjs";
import {
  arnsFromOutputs,
  identityEnvPath,
  machineIdentityDir,
  machineIdentityExists,
} from "./roles-anywhere.mjs";

// The `--save --from-stack` ARN capture (ADR-0056/0057/0059) — the ONE place s3cab
// talks to a non-S3 AWS control-plane API (`@aws-sdk/client-cloudformation`). It
// lives here, in a module imported by nothing but the aws command, on purpose:
//
//   - `@aws-sdk/client-cloudformation` is a *provisioning-plane* dependency, and
//     ADR-0059 quarantines provisioning to the aws-onboarding command. A STATIC
//     import here loads CloudFormation only when aws.mjs loads — never on the hot
//     backup/restore path — so the boundary is enforced by *structure*, not by a
//     lazy `import()` inside a hot-path module. It is also s3cab's only heavy dep
//     that clears the "lazy-load it" bar (heavy + rare + one call site), but the
//     right lever is placement, not a dynamic import (ADR-0059).
//
// The pure output→env-key mapping (`arnsFromOutputs`) and the RA identity paths
// stay in roles-anywhere.mjs (the hot-path module the signer needs); this module
// only adds the CloudFormation read + the env-file write around them.

/**
 * Read a deployed onboarding stack's three RA ARNs and persist them (plus the
 * region) into the machine identity's `env` file — the `--save --from-stack` step
 * (ADR-0056/0057). Read-only: a single `DescribeStacks` via
 * `@aws-sdk/client-cloudformation`, authenticated by `profile` when given (the
 * same admin profile the recipe's step 1 deployed the stack with), else the
 * deployer's ambient credentials; it creates nothing.
 *
 * The identity must already have been generated (its dir holds the env file), so a
 * missing identity is a constructive error (ADR-0030) rather than an opaque write
 * failure. Likewise a stack whose outputs are absent (wrong stack, or the IAM-user
 * template) points the user at the right command.
 * @param {{ stackName: string, region: string, profile?: string }} params
 * @returns {Promise<{ dir: string, arns: Record<string, string>, region: string }>}
 */
export async function saveArnsFromStack({ stackName, region, profile }) {
  if (!machineIdentityExists()) {
    throw new ValidationError(
      `No Roles Anywhere identity found at ${tildeify(machineIdentityDir())}.\n` +
        `Generate it first (it also prints the template to deploy):\n` +
        `   s3cab aws <bucket> --roles-anywhere`,
    );
  }

  const client = new CloudFormationClient({ region, profile });
  const response = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const { arns, missing } = arnsFromOutputs(
    response.Stacks?.[0]?.Outputs ?? [],
  );
  if (missing.length > 0) {
    throw new ValidationError(
      `Stack "${stackName}" is missing the Roles Anywhere outputs (${missing.join(", ")}).\n` +
        `Check the stack name, its region (--region ${region}), and that it was\n` +
        `deployed from the --roles-anywhere template (not the IAM-user one).`,
    );
  }

  updateEnvFile(identityEnvPath(), { ...arns, AWS_REGION: region });
  return { dir: machineIdentityDir(), arns, region };
}
