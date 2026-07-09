import { readFileSync, writeFileSync } from "node:fs";
import { isENOENT } from "./error.mjs";

// Editing s3cab's `KEY=value` env files in place — the *write* side of the env
// files that `env.mjs` loads into process.env. Line-based and comment-preserving
// on purpose: an env file is the user's to read and edit (it may carry
// hand-written comments and overrides), so a mutation replaces or removes
// individual lines rather than parse-and-rewriting the whole file.
//
// A standalone leaf (depends only on node:fs + error.mjs) so both `sets.mjs`
// (binding `S3CAB_BUCKET` into a set env) and the `aws` command (`AWS_PROFILE`
// into the user or a set env) can import it — `env.mjs` can't host it without a
// cycle, since env.mjs already imports `resolveSet` from sets.mjs.

// Env files can carry secrets (AWS_SECRET_ACCESS_KEY — the only auth every
// non-AWS S3 provider supports is a long-lived key+secret), so create them
// owner-only. Applies at creation only; a no-op on Windows, where POSIX modes
// are ignored and the profile dir's ACLs already restrict access.
const envFileMode = 0o600;

/**
 * Escape a string for literal use inside a `RegExp`. The keys we build line
 * matchers from are internal constants (`AWS_PROFILE`, `S3CAB_BUCKET`) with no
 * regex metacharacters, so this changes nothing today — but it keeps this shared
 * primitive correct if a future key ever carries one (`.`/`[`/`$`/…), rather
 * than silently mis-matching or throwing.
 * @param {string} text
 */
const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Read a file's text, or `""` if it doesn't exist.
 * @param {string} path
 */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isENOENT(error)) {
      return "";
    }
    throw error;
  }
}

/**
 * Set `KEY=value` lines in an env file, replacing each key's existing line or
 * appending a new one. Line-based on purpose: the file is the API and may carry
 * hand-written comments and overrides, which an update must preserve — never a
 * parse-and-rewrite.
 * @param {string} path
 * @param {Record<string, string>} updates
 */
export function updateEnvFile(path, updates) {
  let text = readText(path);
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    // Global: replace EVERY occurrence — parseEnv is last-wins, so updating
    // only the first of hand-made duplicates would leave the old value live.
    const existing = new RegExp(`^${escapeRegExp(key)}=.*$`, "gm");
    if (existing.test(text)) {
      text = text.replaceAll(existing, line);
    } else {
      if (text && !text.endsWith("\n")) {
        text += "\n";
      }
      text += line + "\n";
    }
  }
  writeFileSync(path, text, { mode: envFileMode });
}

/**
 * Remove a key's line(s) from an env file — the `--unset` path. Distinct from
 * writing an empty value (`KEY=`), which would be a *meaningful empty* override
 * (files win over the shell, so it would blank the variable rather than defer to
 * it). Removes EVERY `KEY=...` line (parseEnv is last-wins; a hand-made
 * duplicate left behind would keep the value live) and preserves every other
 * line and comment. A no-op when the file or key is absent.
 * @param {string} path
 * @param {string} key
 */
export function removeEnvKey(path, key) {
  const text = readText(path);
  if (text === "") {
    return;
  }
  const matches = new RegExp(`^${escapeRegExp(key)}=`);
  const lines = text.split("\n");
  const kept = lines.filter((line) => !matches.test(line));
  if (kept.length === lines.length) {
    return;
  } // key absent — nothing to write
  writeFileSync(path, kept.join("\n"), { mode: envFileMode });
}
