import { listProfiles } from "./aws-profiles.mjs";
import { ParseArgsError } from "./error.mjs";
import { promptHidden, promptLine, stdinLines } from "./prompt.mjs";
import { RA_MARKER } from "./roles-anywhere.mjs";
import { isInteractive } from "./style.mjs";

// Shared logic behind the provider *connection knobs* — the `--profile` /
// `--endpoint` / `--region` / `--keys` / `--roles-anywhere` options that say how a
// set signs in (docs/design/auth.md). Extracted from `commands/provider.mjs` when `setup`
// gained the same knobs (ADR-0055 onboarding; ADR-0023 "a second caller earns a
// lib primitive"): both `provider` (change/inspect an existing set) and `setup`
// (create one) turn these options into validated `AWS_*` values with
// `gatherProviderConfig`, then apply them their own way — `provider` writes the
// set's env file; `setup` populates the environment for its remote claim and
// persists them on a win. This module only *reads and validates* the options
// (prompting for the secret); it never writes a file.

/**
 * The last few characters of an access key ID — enough to answer "which key?"
 * without dumping the whole thing into a status line. Key IDs are not secret
 * (consoles list them in full); this is brevity, not masking.
 * @param {string} keyId
 */
export const keyTail = (keyId) => `…${keyId.slice(-4)}`;

/**
 * Warn (but don't block) when a profile isn't in the user's AWS config, listing
 * the ones that are — the typo-catcher. Best-effort: `listProfiles` returns
 * `undefined` if the config can't be read, in which case validation is skipped.
 * @param {string} name
 */
async function warnIfUnknownProfile(name) {
  const profiles = await listProfiles();
  if (!profiles || profiles.includes(name)) {
    return;
  }
  const available = profiles.length
    ? `Profiles found in your AWS config: ${profiles.join(", ")}.`
    : `No profiles are configured in your AWS config.`;
  console.warn(
    `AWS profile '${name}' isn't in your AWS config yet.\n` +
      `${available}\n` +
      `s3cab will use it anyway. To create the profile first:\n` +
      `  aws configure --profile ${name}\n` +
      `(for AWS IAM Identity Center, run 'aws configure sso' instead).`,
  );
}

/**
 * Validate an `--endpoint` value: an absolute http(s) URL, or a typo'd endpoint
 * becomes the classic silent R2/B2 signature-mismatch trap later.
 * @param {string} endpoint
 * @returns {string} The validated endpoint
 */
function validateEndpoint(endpoint) {
  const invalid = () =>
    new ParseArgsError(
      `Give the endpoint as a full URL, e.g. --endpoint https://<account>.r2.cloudflarestorage.com (got: ${endpoint})`,
    );
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid();
  }
  return endpoint;
}

/**
 * Obtain the access-key pair without ever touching argv: prompt when stdin is a
 * terminal (key ID echoed, secret hidden), otherwise read two lines from stdin
 * (`printf '%s\n%s\n' "$ID" "$SECRET" | s3cab provider --keys <set>` — name the
 * set, since `--keys` is set-scoped; `setup … --keys` reads it the same way).
 * @returns {Promise<{ AWS_ACCESS_KEY_ID: string, AWS_SECRET_ACCESS_KEY: string }>}
 */
async function readKeys() {
  let id, secret;
  if (isInteractive(process.stdin)) {
    id = await promptLine("Access key ID: ");
    secret = await promptHidden("Secret access key (hidden): ");
  } else {
    [id = "", secret = ""] = await stdinLines(2);
  }
  if (!id || !secret) {
    throw new ParseArgsError(
      "Both an access key ID and a secret are needed — enter them at the prompts, or pipe them as two lines to --keys.",
    );
  }
  return { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret };
}

/**
 * Turn the provider connection options into validated `AWS_*` values plus a human
 * summary of what was set (for the confirmation line). Enforces the one-mode rule
 * at the option level — a profile, access keys, and Roles Anywhere are alternative
 * sign-ins (ADR-0055/0057), so passing more than one is rejected — validates the
 * endpoint, trims the profile/region, and prompts for the key pair (never via
 * argv). Roles Anywhere is AWS-only, so it can't combine with a custom `--endpoint`
 * (ADR-0057); it contributes the set's `S3CAB_RA` marker to `updates`, no material.
 * Callers apply the returned `updates`: `provider` writes them to a set's env file
 * (and clears the modes RA/profile/keys replace); `setup` populates the environment
 * for its remote claim, then persists them on a win.
 * @param {{ profile?: string, endpoint?: string, region?: string, keys?: boolean, rolesAnywhere?: boolean }} options
 * @returns {Promise<{ updates: Record<string, string>, summary: string[] }>}
 */
export async function gatherProviderConfig({
  profile,
  endpoint,
  region,
  keys,
  rolesAnywhere,
}) {
  const modes = [
    profile !== undefined && "a profile",
    keys && "access keys",
    rolesAnywhere && "Roles Anywhere",
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new ParseArgsError(
      `Set one way to sign in, not ${modes.join(" and ")} — they are alternatives, not layers.`,
    );
  }
  if (rolesAnywhere && endpoint !== undefined) {
    throw new ParseArgsError(
      "Roles Anywhere is AWS-only, so it can't be combined with a custom --endpoint (that's for non-AWS S3 providers).",
    );
  }
  /** @type {Record<string, string>} */
  const updates = {};
  /** @type {string[]} */
  const summary = [];
  if (rolesAnywhere) {
    updates[RA_MARKER] = "1";
    summary.push("Roles Anywhere (keyless)");
  }
  if (profile !== undefined) {
    const name = profile.trim();
    if (name === "") {
      throw new ParseArgsError(
        "Give a profile name, e.g. --profile work. To remove the profile, use --unset profile.",
      );
    }
    await warnIfUnknownProfile(name);
    updates.AWS_PROFILE = name;
    summary.push(`AWS profile '${name}'`);
  }
  if (endpoint !== undefined) {
    updates.AWS_ENDPOINT_URL_S3 = validateEndpoint(endpoint.trim());
    summary.push(`endpoint ${updates.AWS_ENDPOINT_URL_S3}`);
  }
  if (region !== undefined) {
    const value = region.trim();
    if (value === "") {
      throw new ParseArgsError(
        "Give a region, e.g. --region auto. To remove the region, use --unset region.",
      );
    }
    updates.AWS_REGION = value;
    summary.push(`region ${value}`);
  }
  if (keys) {
    const pair = await readKeys();
    Object.assign(updates, pair);
    summary.push(`access keys (${keyTail(pair.AWS_ACCESS_KEY_ID)})`);
  }
  return { updates, summary };
}
