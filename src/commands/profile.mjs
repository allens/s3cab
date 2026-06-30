import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { listProfiles } from "../lib/aws-profiles.mjs";
import { removeEnvKey, updateEnvFile } from "../lib/env-file.mjs";
import { parseEnvFile, userEnvPath } from "../lib/env.mjs";
import { ParseArgsError } from "../lib/error.mjs";
import { readSet } from "../lib/sets.mjs";

// `s3cab profile` — the discoverable, safe door for pointing s3cab at an AWS
// profile (docs/specs/auth.md). It writes `AWS_PROFILE` into one of s3cab's own env
// files: the user-wide `~/.s3cab/env` (the default for every backup) or a named
// set's `env` (a per-set override, e.g. a set that backs up to a different AWS
// account). It never touches `~/.aws` to *write*; profile validation only *reads*
// it (aws-profiles.mjs). Purely local — no S3, no credentials, no client.
//
// The positional set is deliberately *explicit*: omitting it means the **user**
// scope, NOT "the only set" (the sole-set default the read commands use). Setting
// where your credentials point is exactly where a silent default would be wrong.

/**
 * The env file a command invocation targets, plus how to name that scope in
 * messages. A discriminated union: the set scope always carries the set `name`
 * (used to build set-scoped suggestions), the user scope never does — so an
 * `isSet: true` scope without a `name` can't be constructed, and `tsc` enforces
 * the coupling rather than a runtime guard.
 * @typedef {{ path: string, label: string, isSet: false }
 *   | { path: string, label: string, isSet: true, name: string }} Scope
 */

/**
 * Resolve a command invocation's scope. A named set must already exist —
 * `readSet` rejects an unknown name with the usual listing; `profile` never
 * *creates* a set (that is `sets`' job, so the remote name gets claimed).
 * @param {string} [setName]
 * @returns {Scope}
 */
function resolveScope(setName) {
  if (setName === undefined) {
    return { path: userEnvPath(), label: "all backups", isSet: false };
  }
  const set = readSet(setName);
  return {
    path: set.envPath,
    label: `set '${set.name}'`,
    isSet: true,
    name: set.name,
  };
}

/**
 * Show what profile/endpoint is set *at this scope* (the value written here, not
 * the post-layering effective value — the always-on notice from `client()` shows
 * that at use-time). A set with nothing of its own falls back to the user
 * default, so its "none" message says so.
 * @param {Scope} scope
 * @returns {string}
 */
function describeScope(scope) {
  const { path, label } = scope;
  const values = parseEnvFile(path);
  const profile = values.AWS_PROFILE;
  const endpoint = values.AWS_ENDPOINT_URL_S3 ?? values.AWS_ENDPOINT_URL;
  if (!profile && !endpoint) {
    return scope.isSet
      ? `No AWS profile set for ${label} — it uses the user default.\n` +
          `Give this set its own with:\n` +
          `  s3cab profile --profile <name> ${scope.name}`
      : `No AWS profile set for ${label}.\n` +
          `Point s3cab at one of your AWS profiles with:\n` +
          `  s3cab profile --profile <name>`;
  }
  const parts = [];
  if (profile) parts.push(`profile: ${profile}`);
  if (endpoint) parts.push(`endpoint: ${endpoint}`);
  return `AWS for ${label} — ${parts.join(", ")} (${path})`;
}

/**
 * Warn (but don't block) when a profile isn't in the user's AWS config, listing
 * the ones that are — the typo-catcher. Best-effort: `listProfiles` returns
 * `undefined` if the config can't be read, in which case validation is skipped.
 * @param {string} name
 */
async function warnIfUnknownProfile(name) {
  const profiles = await listProfiles();
  if (!profiles || profiles.includes(name)) return;
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
 * Set, clear, or show the AWS profile s3cab uses, at the user or a per-set scope.
 *
 * - `profile --profile <name> [<set>]` — write `AWS_PROFILE` (validated against
 *   `~/.aws`, warn-not-block on a miss).
 * - `profile --unset [<set>]` — remove the `AWS_PROFILE` line (distinct from
 *   writing an empty value, which would be a meaningful-empty override).
 * - `profile [<set>]` — show the current setting at that scope.
 *
 * @param {string} [setName] - A backup set to scope to; omit for the user-wide default
 * @param {object} [options]
 * @param {string} [options.profile] - The AWS profile name to set
 * @param {boolean} [options.unset] - Remove the configured profile
 * @returns {Promise<undefined>}
 */
export async function profile(setName, options = {}) {
  const { profile, unset } = options;

  if (profile !== undefined && unset) {
    throw new ParseArgsError("Pass either --profile or --unset, not both.");
  }

  const scope = resolveScope(setName);

  if (unset) {
    // A set's directory already exists; the user's ~/.s3cab may not on a fresh
    // machine — but unsetting a never-set profile is a harmless no-op, so only
    // the write paths below need the directory.
    removeEnvKey(scope.path, "AWS_PROFILE");
    process.stdout.write(`Cleared the AWS profile for ${scope.label}.\n`);
    return undefined;
  }

  // Get mode: no --profile (and not --unset) → report the current setting.
  if (profile === undefined) {
    process.stdout.write(describeScope(scope) + "\n");
    return undefined;
  }

  const name = profile.trim();
  if (name === "") {
    throw new ParseArgsError(
      "Give a profile name, e.g. --profile work. To remove the profile, use --unset.",
    );
  }
  await warnIfUnknownProfile(name);
  // The user's ~/.s3cab may not exist yet on a fresh machine; a set's does.
  mkdirSync(dirname(scope.path), { recursive: true });
  updateEnvFile(scope.path, { AWS_PROFILE: name });
  process.stdout.write(
    `Set AWS profile '${name}' for ${scope.label} (${scope.path}).\n`,
  );
  return undefined;
}
