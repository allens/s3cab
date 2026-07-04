import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { listProfiles } from "../lib/aws-profiles.mjs";
import { removeEnvKey, updateEnvFile } from "../lib/env-file.mjs";
import { parseEnvFile, userEnvPath } from "../lib/env.mjs";
import { ParseArgsError } from "../lib/error.mjs";
import { readSet } from "../lib/sets.mjs";

// `s3cab auth` (né `profile`, renamed by ADR-0041) — the discoverable, safe door
// for pointing s3cab at an AWS profile (docs/design/auth.md). It writes
// `AWS_PROFILE` into one of s3cab's own env
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
 * messages. Two naming forms (the design's query-noun/action-phrase split):
 * `noun` heads a status line ("Default AWS profile: work"), `phrase` fills an
 * action sentence ("Cleared the AWS profile for the default (all backups)").
 * The user scope is "the default" — per-set profiles override it (env layering,
 * ADR-0022/0025) — not "all backups", which overclaims. A discriminated union:
 * the set scope always carries the set `name` (used to build set-scoped
 * suggestions), the user scope never does — so an `isSet: true` scope without a
 * `name` can't be constructed, and `tsc` enforces the coupling.
 * @typedef {{ path: string, noun: string, phrase: string, isSet: false }
 *   | { path: string, noun: string, phrase: string, isSet: true, name: string }} Scope
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
    return {
      path: userEnvPath(),
      noun: "Default AWS profile",
      phrase: "the default (all backups)",
      isSet: false,
    };
  }
  const set = readSet(setName);
  return {
    path: set.envPath,
    noun: `AWS profile for set '${set.name}'`,
    phrase: `set '${set.name}'`,
    isSet: true,
    name: set.name,
  };
}

/**
 * Abbreviate a leading home directory to `~` so paths read legibly. Matches on a
 * separator boundary (`~/.s3cab`, not the whole home dir alone), so a sibling
 * whose name merely starts with the home path (`/home/alex` under `/home/al`)
 * isn't mangled to `~ex/…`.
 * @param {string} path
 */
const tildeify = (path) =>
  path.startsWith(homedir() + sep) ? "~" + path.slice(homedir().length) : path;

/**
 * Show what profile/endpoint is set *at this scope* (the value written here, not
 * the post-layering effective value — the always-on notice from `client()` shows
 * that at use-time), as legible `noun: value` status lines. A set with nothing of
 * its own falls back to the user default, so its "none" message says so. When a
 * profile *is* set, it runs the same `~/.aws` cross-check `profile --profile`
 * warns on, so *looking* also flags a broken profile — closing the asymmetry
 * where the set path warned but the show path stayed silent. Async for that
 * lookup; best-effort (`listProfiles` → `undefined` means "couldn't read", so
 * skip the diagnostic rather than wrongly claim it's absent).
 * @param {Scope} scope
 * @returns {Promise<string>}
 */
async function describeScope(scope) {
  const { path, noun, phrase } = scope;
  const values = parseEnvFile(path);
  const profile = values.AWS_PROFILE;
  const endpoint = values.AWS_ENDPOINT_URL_S3 ?? values.AWS_ENDPOINT_URL;
  if (!profile && !endpoint) {
    return scope.isSet
      ? `No AWS profile set for ${phrase} — it uses the user default.\n` +
          `Give this set its own with:\n` +
          `  s3cab auth --profile <name> ${scope.name}`
      : `No default AWS profile set.\n` +
          `Point s3cab at one of your AWS profiles with:\n` +
          `  s3cab auth --profile <name>`;
  }
  const lines = [];
  if (profile) {
    lines.push(`${noun}: ${profile}   (${tildeify(path)})`);
    const known = await listProfiles();
    if (known && !known.includes(profile)) {
      lines.push(
        `Not in your AWS config — no credentials to use.`,
        `To fix it:  aws configure --profile ${profile}`,
      );
    }
  }
  if (endpoint) {
    lines.push(`AWS endpoint for ${phrase}: ${endpoint}   (${tildeify(path)})`);
  }
  return lines.join("\n");
}

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
 * Set, clear, or show the AWS profile s3cab signs in with, at the user or a
 * per-set scope.
 *
 * - `auth --profile <name> [<set>]` — write `AWS_PROFILE` (validated against
 *   `~/.aws`, warn-not-block on a miss).
 * - `auth --unset [<set>]` — remove the `AWS_PROFILE` line (distinct from
 *   writing an empty value, which would be a meaningful-empty override).
 * - `auth [<set>]` — show the current setting at that scope.
 *
 * @param {string} [setName] - A backup set to scope to; omit for the user-wide default
 * @param {object} [options]
 * @param {string} [options.profile] - The AWS profile name to set
 * @param {boolean} [options.unset] - Remove the configured profile
 * @returns {Promise<undefined>}
 */
export async function auth(setName, options = {}) {
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
    process.stdout.write(`Cleared the AWS profile for ${scope.phrase}.\n`);
    return undefined;
  }

  // Get mode: no --profile (and not --unset) → report the current setting.
  if (profile === undefined) {
    process.stdout.write((await describeScope(scope)) + "\n");
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
    `Set AWS profile '${name}' for ${scope.phrase} (${tildeify(scope.path)}).\n`,
  );
  return undefined;
}
