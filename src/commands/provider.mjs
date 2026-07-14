import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { listProfiles } from "../lib/aws-profiles.mjs";
import { removeEnvKey, updateEnvFile } from "../lib/env-file.mjs";
import { customEndpoint, parseEnvFile } from "../lib/env.mjs";
import { tildeify } from "../lib/home.mjs";
import { ParseArgsError } from "../lib/error.mjs";
import { gatherProviderConfig, keyTail } from "../lib/provider.mjs";
import { RA_MARKER } from "../lib/roles-anywhere.mjs";
import { NO_SETS_MESSAGE, listSets, resolveSet } from "../lib/sets.mjs";

// `s3cab provider` (né `auth`, né `profile` — ADR-0047/0041) — change or inspect
// how a set signs in to its storage provider (docs/design/auth.md): an AWS
// profile, a custom S3 endpoint (any S3-compatible provider), a region, and
// access keys. The *initial* config is usually set at `s3cab setup` (which takes
// the same knobs, ADR-0055); this command changes it afterward or shows it. It
// writes a set's own env
// file (`~/.s3cab/sets/<set>/env`) — the single s3cab config layer (ADR-0055); the
// machine-wide default is your ambient AWS setup, not an s3cab file. It never
// touches `~/.aws` to *write*; profile validation only *reads* it
// (aws-profiles.mjs). Purely local — no S3, no credentials, no client.
//
// Keys are never taken via flags (they'd leak into shell history and the
// process table — the auth design's standing non-goal): `--keys` prompts at a
// terminal (secret hidden) and reads two stdin lines otherwise.
//
// There is no user-wide scope (ADR-0055): every provider setting lives on a set.
// Omitting the set name follows the sole-set default the read commands use — a
// write targets your only set (and errors, listing them, if several exist, since
// writing credentials to the wrong set would be as bad as a missing arg), while a
// bare `provider` show summarizes every set.
//
// A set is exactly one credential mode: a profile OR access keys (ADR-0055) —
// alternative ways to sign in, not layers. Setting one clears the other on that
// set (with a note in the confirmation), and passing both in one call is rejected.
// Endpoint and region are orthogonal connection knobs, untouched by the switch.

/** The knobs `--unset` accepts, and the env keys each one clears. */
const knobs = {
  profile: ["AWS_PROFILE"],
  // Clear both endpoint spellings: `--endpoint` writes the specific _S3 form,
  // but a hand-written AWS_ENDPOINT_URL would otherwise keep the endpoint live.
  endpoint: ["AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"],
  region: ["AWS_REGION"],
  keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  "roles-anywhere": [RA_MARKER],
};

/**
 * The env file a command invocation targets — always a set now (ADR-0055 removed
 * the user scope) — plus how to name that scope in messages: `phrase` fills both
 * the status nouns ("AWS endpoint for set 'photos'") and the action sentences
 * ("Cleared the access keys for set 'photos'").
 * @typedef {{ path: string, phrase: string, name: string }} Scope
 */

/**
 * Resolve a command invocation's target set into a {@link Scope}: the named set,
 * or — with no name — the sole-set default (`resolveSet`, which errors and lists
 * the sets when several exist, and rejects an unknown name). `provider` never
 * *creates* a set (that is `setup`'s job, so the remote name gets claimed).
 * @param {string} [setName]
 * @returns {Scope}
 */
function resolveScope(setName) {
  const set = resolveSet(setName);
  return { path: set.envPath, phrase: `set '${set.name}'`, name: set.name };
}

/**
 * Show what is set *at this scope* (the values written here, not the
 * post-layering effective values — the always-on notice from `client()` shows
 * that at use-time), as legible `noun: value` status lines, one per configured
 * knob. Access keys report presence only — never the secret. A set with nothing
 * of its own falls back to the ambient AWS setup, so its "none" message says so
 * and points at the set-scoped way in. When a profile *is* set, it runs the same
 * `~/.aws` cross-check the write path warns on, so *looking* also flags a broken
 * profile. Async for that lookup; best-effort (`listProfiles` → `undefined`
 * means "couldn't read", so skip the diagnostic rather than wrongly claim it's
 * absent).
 * @param {Scope} scope
 * @param {{ withShellNote?: boolean }} [opts] - Append the global shell-env note
 *   in the "nothing configured" case (true for a single-set show; false for the
 *   all-sets summary, which emits it once — see {@link describeAllSets}).
 * @returns {Promise<{ text: string, ambient: boolean }>} `ambient` is true when the
 *   set carries no settings of its own (it relies on the ambient AWS setup).
 */
async function describeScope(scope, { withShellNote = true } = {}) {
  const { path, phrase } = scope;
  const values = parseEnvFile(path);
  const profile = values.AWS_PROFILE;
  const endpoint = customEndpoint(values);
  const region = values.AWS_REGION;
  const keyId = values.AWS_ACCESS_KEY_ID;
  const rolesAnywhere = values[RA_MARKER] === "1";
  if (!profile && !endpoint && !region && !keyId && !rolesAnywhere) {
    return {
      ambient: true,
      text:
        `No provider settings for ${phrase} — it uses your ambient AWS setup.\n` +
        `Give this set its own with:\n` +
        `  s3cab provider --profile <name> ${scope.name}${withShellNote ? shellNote() : ""}`,
    };
  }
  const where = `   (${tildeify(path)})`;
  const lines = [];
  if (rolesAnywhere) {
    lines.push(`Sign-in for ${phrase}: Roles Anywhere (keyless)${where}`);
  }
  if (profile) {
    lines.push(`AWS profile for ${phrase}: ${profile}${where}`);
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
  return { text: lines.join("\n"), ambient: false };
}

/**
 * Summarize every set's provider config — the answer to a bare `provider` with no
 * set named. Read-only, so an all-sets view is safe and useful; a *write* with no
 * set takes the sole-set default instead (`resolveScope`). Each block is what
 * `provider <set>` alone would print; a first-timer with no sets gets the
 * create-a-set hint rather than an empty answer.
 * @returns {Promise<string>}
 */
async function describeAllSets() {
  const names = listSets();
  if (names.length === 0) {
    return NO_SETS_MESSAGE;
  }
  const results = await Promise.all(
    names.map((name) =>
      describeScope(resolveScope(name), { withShellNote: false }),
    ),
  );
  // The shell-env note is global, not per-set, so emit it once (not once per
  // ambient set) — and only when some set actually relies on the ambient setup.
  const note = results.some((r) => r.ambient) ? shellNote() : "";
  return results.map((r) => r.text).join("\n\n") + note;
}

/**
 * A trailing note for a set's "nothing configured" answer when the *shell
 * environment* nonetheless carries auth — without it, a user whose backups work
 * fine off shell `AWS_*` vars reads "no provider settings" as broken. Only
 * shell-origin values can appear here: `describeScope` reads the set file's own
 * values (`parseEnvFile`), and this command never applies the set layer. An empty
 * `AWS_PROFILE` counts as none (as `authNotice` treats it).
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
unless the set overrides it.)`;
}

/**
 * Set, clear, or show how s3cab connects to your storage provider, per set.
 *
 * - `provider --profile <name> [<set>]` — write `AWS_PROFILE` (validated against
 *   `~/.aws`, warn-not-block on a miss).
 * - `provider --endpoint <url> [<set>]` — write `AWS_ENDPOINT_URL_S3` (any
 *   S3-compatible provider).
 * - `provider --region <region> [<set>]` — write `AWS_REGION`.
 * - `provider --keys [<set>]` — write `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`,
 *   prompted or piped, never flags. Setters combine in one call.
 * - `provider --roles-anywhere [<set>]` — switch the set to the keyless Roles
 *   Anywhere identity (writes the `S3CAB_RA` marker; AWS-only, ADR-0057).
 * - `provider --unset <knob> [<set>]` — remove a knob's line(s) (distinct from
 *   writing an empty value, which would be a meaningful-empty override).
 * - `provider <set>` — show that set's settings; bare `provider` summarizes all sets.
 *
 * Omitting the set name takes the sole-set default for a write/`--unset` (erroring
 * if several sets exist), and summarizes every set for a bare show (ADR-0055).
 *
 * A set holds one credential mode: `--profile`, `--keys`, and `--roles-anywhere`
 * are mutually exclusive — setting one clears the others on that set (endpoint and
 * region are untouched; Roles Anywhere is AWS-only, so it refuses a set with a
 * custom endpoint).
 *
 * @param {string} [setName] - A backup set to scope to; omit to target your only
 *   set (write/unset) or summarize all sets (show)
 * @param {{ profile?: string, endpoint?: string, region?: string, keys?: boolean,
 *   "roles-anywhere"?: boolean, unset?: string }} [options] - `profile`/`endpoint`/
 *   `region`/`keys` set a connection knob; `roles-anywhere` switches to the keyless
 *   identity; `unset` removes one setting (profile, endpoint, region, keys, or
 *   roles-anywhere).
 * @returns {Promise<string>} The status/confirmation text, for the render layer.
 */
export async function provider(setName, options = {}) {
  const { profile, endpoint, region, keys, unset } = options;
  const rolesAnywhere = options["roles-anywhere"];
  const setting =
    profile !== undefined ||
    endpoint !== undefined ||
    region !== undefined ||
    keys ||
    rolesAnywhere;

  if (unset !== undefined && setting) {
    throw new ParseArgsError(
      "Pass --unset on its own, without other settings.",
    );
  }

  // Bare `provider` (no set named, nothing to set or unset) summarizes every set —
  // read-only, so an all-sets view is safe. A write or `--unset` with no set falls
  // through to the sole-set default in `resolveScope`.
  if (setName === undefined && !setting && unset === undefined) {
    return describeAllSets();
  }

  const scope = resolveScope(setName);

  if (unset !== undefined) {
    const envKeys = knobs[/** @type {keyof typeof knobs} */ (unset)];
    if (!envKeys) {
      throw new ParseArgsError(
        `Unknown setting to unset: ${unset}. Use one of: ${Object.keys(knobs).join(", ")}.`,
      );
    }
    // The set's directory already exists (resolveScope resolved it), and clearing
    // a never-set knob is a harmless no-op regardless.
    for (const key of envKeys) {
      removeEnvKey(scope.path, key);
    }
    const what =
      unset === "keys"
        ? "access keys"
        : unset === "roles-anywhere"
          ? "Roles Anywhere setting"
          : `AWS ${unset}`;
    return `Cleared the ${what} for ${scope.phrase}.`;
  }

  // Get mode: nothing to set → report the current settings.
  if (!setting) {
    const { text } = await describeScope(scope);
    return text;
  }

  // Roles Anywhere is AWS-only (ADR-0057), so it can't apply to a set already
  // pointed at a custom S3 endpoint. Fail fast with the exact fix (ADR-0030),
  // before prompting or writing anything.
  const current = parseEnvFile(scope.path);
  const setEndpoint = customEndpoint(current);
  if (rolesAnywhere && setEndpoint) {
    throw new ParseArgsError(
      `Set '${scope.name}' points at a custom S3 endpoint (${setEndpoint}), and\n` +
        `Roles Anywhere is AWS-only. Clear the endpoint first:\n` +
        `  s3cab provider --unset endpoint ${scope.name}`,
    );
  }

  // The knob-gathering (validate, prompt for keys, reject two credential modes at
  // once) is shared with `setup` — see lib/provider.mjs. `provider` then applies
  // the one-mode clearing below, which `setup` doesn't need (its set is brand new).
  const { updates, summary } = await gatherProviderConfig({
    profile,
    endpoint,
    region,
    keys,
    rolesAnywhere,
  });

  // Enforce the one-mode rule against what's already on disk: a set holds exactly
  // one credential mode (profile / keys / Roles Anywhere, ADR-0055/0057), so
  // setting one clears the other two (endpoint and region are orthogonal
  // connection knobs — left alone). Name what was replaced, for the confirmation.
  const newMode = rolesAnywhere
    ? "ra"
    : profile !== undefined
      ? "profile"
      : keys
        ? "keys"
        : undefined;
  /** @type {string[]} */
  const clear = [];
  /** @type {string[]} */
  const replacedParts = [];
  if (newMode) {
    if (
      newMode !== "keys" &&
      (current.AWS_ACCESS_KEY_ID || current.AWS_SECRET_ACCESS_KEY)
    ) {
      clear.push("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY");
      replacedParts.push("its access keys");
    }
    if (newMode !== "profile" && current.AWS_PROFILE) {
      clear.push("AWS_PROFILE");
      replacedParts.push(`its profile '${current.AWS_PROFILE}'`);
    }
    if (newMode !== "ra" && current[RA_MARKER]) {
      clear.push(RA_MARKER);
      replacedParts.push("its Roles Anywhere setting");
    }
  }
  const replaced = replacedParts.length
    ? `, replacing ${replacedParts.join(" and ")}`
    : "";

  // The set's directory already exists (resolveScope resolved it); mkdir is a
  // harmless owner-only guard. The env file may carry secrets (see lib/env-file.mjs).
  mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
  updateEnvFile(scope.path, updates);
  for (const key of clear) {
    removeEnvKey(scope.path, key);
  }
  return `Set ${summary.join(", ")} for ${scope.phrase}${replaced} (${tildeify(scope.path)}).`;
}
