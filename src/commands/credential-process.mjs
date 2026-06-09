import { resolveAppManagedAwsCredentials } from "../lib/auth.mjs";

/**
 * Emit AWS credentials in the standard `credential_process` JSON format, sourced
 * from s3cab's app-managed login (`s3cab login`). This is the advanced/manual
 * integration surface from specs/auth.md: a user who wants to wire s3cab into
 * their own AWS shared config can point a profile at it —
 *
 *   [profile s3cab]
 *   credential_process = s3cab credential-process
 *
 * — and the AWS SDK/CLI will invoke this to obtain credentials. It deliberately
 * uses *only* the app-managed resolver (not the full chain in `resolveCredentials`),
 * since the chain is what would be invoking this in the first place.
 *
 * The returned object is serialized to **stdout** as JSON by the dispatcher; the
 * short-lived secrets never touch stderr (the security contract for process
 * credential helpers — tools may capture a helper's stderr). `Expiration` is
 * included so the SDK can cache and refresh on schedule.
 *
 * @returns {Promise<{ Version: number, AccessKeyId: string, SecretAccessKey: string, SessionToken?: string, Expiration?: string }>}
 */
export async function credentialProcess() {
  const { accessKeyId, secretAccessKey, sessionToken, expiration } =
    await resolveAppManagedAwsCredentials();

  return {
    Version: 1,
    AccessKeyId: accessKeyId,
    SecretAccessKey: secretAccessKey,
    ...(sessionToken ? { SessionToken: sessionToken } : {}),
    ...(expiration ? { Expiration: expiration.toISOString() } : {}),
  };
}
