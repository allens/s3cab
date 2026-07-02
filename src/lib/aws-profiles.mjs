import { parseKnownFiles } from "@smithy/shared-ini-file-loader";

// Reading the user's AWS shared config — strictly read-only, so the `aws`
// command can validate a profile name at config time and catch a typo then
// rather than as a surprise on the next cloud op. s3cab never *writes* ~/.aws
// (docs/design/auth.md, Design Principle 3); reading it to validate is allowed.
//
// Uses the canonical AWS-family parser, which handles the `[profile X]` (config)
// vs `[X]` (credentials) section-name asymmetry, merges both files, and honours
// the AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE overrides — so we never
// hard-code ~/.aws paths or re-implement the INI quirks ourselves.

/**
 * The names of every profile defined in the user's AWS shared config files
 * (`~/.aws/config` + `~/.aws/credentials`), sorted. An absent config yields `[]`
 * (the parser tolerates missing files); `undefined` means the files could not be
 * read at all — the signal for the caller to *skip* validation silently rather
 * than wrongly report "no profiles". Validation is advisory and must never block
 * a user from setting their own config.
 * @returns {Promise<string[] | undefined>}
 */
export async function listProfiles() {
  try {
    return Object.keys(await parseKnownFiles({})).sort();
  } catch {
    return undefined;
  }
}
