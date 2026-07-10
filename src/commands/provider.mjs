import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";
import { listProfiles } from "../lib/aws-profiles.mjs";
import { removeEnvKey, updateEnvFile } from "../lib/env-file.mjs";
import { customEndpoint, parseEnvFile, userEnvPath } from "../lib/env.mjs";
import { ParseArgsError } from "../lib/error.mjs";
import { promptHidden, promptLine, stdinLines } from "../lib/prompt.mjs";
import { readSet } from "../lib/sets.mjs";
import { isInteractive } from "../lib/style.mjs";

// `s3cab provider` (né `auth`, né `profile` — ADR-0047/0041) — the one door for
// configuring which storage provider s3cab talks to and how it signs in
// (docs/design/auth.md): an AWS profile, a custom S3 endpoint (any
// S3-compatible provider), a region, and access keys. It writes s3cab's own env
// files: the user-wide `~/.s3cab/env` (the default for every backup) or a named
// set's `env` (a per-set override). It never touches `~/.aws` to *write*;
// profile validation only *reads* it (aws-profiles.mjs). Purely local — no S3,
// no credentials, no client.
//
// Keys are never taken via flags (they'd leak into shell history and the
// process table — the auth design's standing non-goal): `--keys` prompts at a
// terminal (secret hidden) and reads two stdin lines otherwise.
//
// The positional set is deliberately *explicit*: omitting it means the **user**
// scope, NOT "the only set" (the sole-set default the read commands use). Setting
// where your credentials point is exactly where a silent default would be wrong.

/** The knobs `--unset` accepts, and the env keys each one clears. */
const knobs = {
  profile: ["AWS_PROFILE"],
  // Clear both endpoint spellings: `--endpoint` writes the specific _S3 form,
  // but a hand-written AWS_ENDPOINT_URL would otherwise keep the endpoint live.
  endpoint: ["AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"],
  region: ["AWS_REGION"],
  keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
};

/**
 * The env file a command invocation targets, plus how to name that scope in
 * messages: `phrase` fills both the status nouns ("AWS endpoint for the
 * default (all backups)") and the action sentences ("Cleared the access keys
 * for set 'photos'"). The user scope is "the default" — per-set settings
 * override it (env layering, ADR-0022/0025) — not "all backups", which
 * overclaims. A discriminated union: the set scope always carries the set
 * `name` (used to build set-scoped suggestions), the user scope never does —
 * so an `isSet: true` scope without a `name` can't be constructed, and `tsc`
 * enforces the coupling.
 * @typedef {{ path: string, phrase: string, isSet: false }
 *   | { path: string, phrase: string, isSet: true, name: string }} Scope
 */

/**
 * Resolve a command invocation's scope. A named set must already exist —
 * `readSet` rejects an unknown name with the usual listing; `provider` never
 * *creates* a set (that is `setup`'s job, so the remote name gets claimed).
 * @param {string} [setName]
 * @returns {Scope}
 */
function resolveScope(setName) {
  if (setName === undefined) {
    return {
      path: userEnvPath(),
      phrase: "the default (all backups)",
      isSet: false,
    };
  }
  const set = readSet(setName);
  return {
    path: set.envPath,
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
 * Show what is set *at this scope* (the values written here, not the
 * post-layering effective values — the always-on notice from `client()` shows
 * that at use-time), as legible `noun: value` status lines, one per configured
 * knob. Access keys report presence only — never the secret. A set with nothing
 * of its own falls back to the user default, so its "none" message says so; a
 * bare default scope points at the two ways in (an AWS profile, or the non-AWS
 * setup steps in `help provider`). When a profile *is* set, it runs the same
 * `~/.aws` cross-check the set path warns on, so *looking* also flags a broken
 * profile. Async for that lookup; best-effort (`listProfiles` → `undefined`
 * means "couldn't read", so skip the diagnostic rather than wrongly claim it's
 * absent).
 * @param {Scope} scope
 * @returns {Promise<string>}
 */
async function describeScope(scope) {
  const { path, phrase } = scope;
  const values = parseEnvFile(path);
  const profile = values.AWS_PROFILE;
  const endpoint = customEndpoint(values);
  const region = values.AWS_REGION;
  const keyId = values.AWS_ACCESS_KEY_ID;
  if (!profile && !endpoint && !region && !keyId) {
    return scope.isSet
      ? `No provider settings for ${phrase} — it uses the user default.\n` +
          `Give this set its own with:\n` +
          `  s3cab provider --profile <name> ${scope.name}`
      : `No default provider configured.\n` +
          `Point s3cab at one of your AWS profiles with:\n` +
          `  s3cab provider --profile <name>\n` +
          `Or set up an S3-compatible provider (Cloudflare R2, Backblaze B2, …):\n` +
          `  s3cab help provider${shellNote()}`;
  }
  const where = `   (${tildeify(path)})`;
  const lines = [];
  if (profile) {
    const noun = scope.isSet
      ? `AWS profile for ${phrase}`
      : "Default AWS profile";
    lines.push(`${noun}: ${profile}${where}`);
    const known = await listProfiles();
    if (known && !known.includes(profile)) {
      lines.push(
        `Not in your AWS config — no credentials to use.`,
        `To fix it:  aws configure --profile ${profile}`,
      );
    }
  }
  if (endpoint) {
    lines.push(`AWS endpoint for ${phrase}: ${endpoint}${where}`);
  }
  if (region) {
    lines.push(`AWS region for ${phrase}: ${region}${where}`);
  }
  if (keyId) {
    lines.push(`Access keys for ${phrase}: set (${keyTail(keyId)})${where}`);
  }
  return lines.join("\n");
}

/**
 * The last few characters of an access key ID — enough to answer "which key?"
 * without dumping the whole thing into every status line. Key IDs are not
 * secret (consoles list them in full); this is brevity, not masking.
 * @param {string} keyId
 */
const keyTail = (keyId) => `…${keyId.slice(-4)}`;

/**
 * A trailing note for the user-scope "nothing configured" answer when the
 * *shell environment* nonetheless carries auth — without it, a user whose
 * backups work fine off shell `AWS_*` vars reads "no provider configured" as
 * broken. Only shell-origin values can appear here: this branch means the user
 * env file set nothing, and the set layer is never loaded by this command.
 * An empty `AWS_PROFILE` counts as none (as `authNotice` treats it).
 */
function shellNote() {
  const vars = [];
  if (process.env.AWS_PROFILE) {
    vars.push(`AWS_PROFILE=${process.env.AWS_PROFILE}`);
  }
  const endpoint = customEndpoint();
  if (endpoint) {
    vars.push(`an endpoint (${endpoint})`);
  }
  if (process.env.AWS_ACCESS_KEY_ID) {
    vars.push("access keys");
  }
  if (vars.length === 0) {
    return "";
  }
  return `\n(Your shell environment sets ${vars.join(", ")} — s3cab uses that
unless a file overrides it.)`;
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
 * (`printf '%s\n%s\n' "$ID" "$SECRET" | s3cab provider --keys`).
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
 * Set, clear, or show how s3cab connects to your storage provider, at the user
 * or a per-set scope.
 *
 * - `provider --profile <name> [<set>]` — write `AWS_PROFILE` (validated against
 *   `~/.aws`, warn-not-block on a miss).
 * - `provider --endpoint <url> [<set>]` — write `AWS_ENDPOINT_URL_S3` (any
 *   S3-compatible provider).
 * - `provider --region <region> [<set>]` — write `AWS_REGION`.
 * - `provider --keys [<set>]` — write `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
 *   prompted or piped, never flags. Setters combine in one call.
 * - `provider --unset <knob> [<set>]` — remove a knob's line(s) (distinct from
 *   writing an empty value, which would be a meaningful-empty override).
 * - `provider [<set>]` — show the current settings at that scope.
 *
 * @param {string} [setName] - A backup set to scope to; omit for the user-wide default
 * @param {object} [options]
 * @param {string} [options.profile] - The AWS profile name to set
 * @param {string} [options.endpoint] - The provider's S3 endpoint URL to set
 * @param {string} [options.region] - The region to set
 * @param {boolean} [options.keys] - Save an access key + secret (prompt/stdin)
 * @param {string} [options.unset] - Remove a setting: profile, endpoint, region, or keys
 * @returns {Promise<string>} The status/confirmation text, for the render layer.
 */
export async function provider(setName, options = {}) {
  const { profile, endpoint, region, keys, unset } = options;
  const setting =
    profile !== undefined ||
    endpoint !== undefined ||
    region !== undefined ||
    keys;

  if (unset !== undefined && setting) {
    throw new ParseArgsError(
      "Pass --unset on its own, without other settings.",
    );
  }

  const scope = resolveScope(setName);

  if (unset !== undefined) {
    const envKeys = knobs[/** @type {keyof typeof knobs} */ (unset)];
    if (!envKeys) {
      throw new ParseArgsError(
        `Unknown setting to unset: ${unset}. Use one of: ${Object.keys(knobs).join(", ")}.`,
      );
    }
    // A set's directory already exists; the user's ~/.s3cab may not on a fresh
    // machine — but unsetting a never-set knob is a harmless no-op, so only
    // the write path below needs the directory.
    for (const key of envKeys) {
      removeEnvKey(scope.path, key);
    }
    const what = unset === "keys" ? "access keys" : `AWS ${unset}`;
    return `Cleared the ${what} for ${scope.phrase}.`;
  }

  // Get mode: nothing to set → report the current settings.
  if (!setting) {
    return describeScope(scope);
  }

  /** @type {Record<string, string>} */
  const updates = {};
  /** @type {string[]} */
  const set = [];
  if (profile !== undefined) {
    const name = profile.trim();
    if (name === "") {
      throw new ParseArgsError(
        "Give a profile name, e.g. --profile work. To remove the profile, use --unset profile.",
      );
    }
    await warnIfUnknownProfile(name);
    updates.AWS_PROFILE = name;
    set.push(`AWS profile '${name}'`);
  }
  if (endpoint !== undefined) {
    updates.AWS_ENDPOINT_URL_S3 = validateEndpoint(endpoint.trim());
    set.push(`endpoint ${updates.AWS_ENDPOINT_URL_S3}`);
  }
  if (region !== undefined) {
    const value = region.trim();
    if (value === "") {
      throw new ParseArgsError(
        "Give a region, e.g. --region auto. To remove the region, use --unset region.",
      );
    }
    updates.AWS_REGION = value;
    set.push(`region ${value}`);
  }
  if (keys) {
    const pair = await readKeys();
    Object.assign(updates, pair);
    set.push(`access keys (${keyTail(pair.AWS_ACCESS_KEY_ID)})`);
  }

  // The user's ~/.s3cab may not exist yet on a fresh machine; a set's does.
  // Owner-only: the env files inside may carry secrets (see lib/env-file.mjs).
  mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
  updateEnvFile(scope.path, updates);
  return `Set ${set.join(", ")} for ${scope.phrase} (${tildeify(scope.path)}).`;
}
