import {
  closeSync,
  constants,
  fchmodSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { isENOENT } from "./error.mjs";

// Editing s3cab's `KEY=value` env files in place — the *write* side of the env
// files that `env.mjs` loads into process.env. Line-based and comment-preserving
// on purpose: an env file is the user's to read and edit (it may carry
// hand-written comments and overrides), so a mutation replaces or removes
// individual lines rather than parse-and-rewriting the whole file.
//
// A standalone leaf (depends only on builtins + error.mjs) so both `sets.mjs`
// (binding `S3CAB_BUCKET` into a set env) and the `aws` command (`AWS_PROFILE`
// into the user or a set env) can import it — `env.mjs` can't host it without a
// cycle, since env.mjs already imports `resolveSet` from sets.mjs.

// Env files can carry secrets (AWS_SECRET_ACCESS_KEY — the only auth every
// non-AWS S3 provider supports is a long-lived key+secret), so every write
// leaves them owner-only, one an editor made too. A no-op on Windows, where
// POSIX modes are ignored and a file takes its folder's ACL: owner-only in the
// user profile, not in a home moved outside it, which guide/backup.md leaves to
// the user.
const envFileMode = 0o600;

/**
 * Replace a file's text, leaving it owner-only.
 * @param {string} path
 * @param {string} text
 */
function writeOwnerOnly(path, text) {
  // Not "w", which empties the file before the chmod: a chmod that fails (a
  // file another user owns, a mount that holds no modes) would leave it empty.
  // In place, not a new file renamed over it, so a linked `env` stays linked.
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT,
    envFileMode,
  );
  try {
    fchmodSync(fd, envFileMode);
    ftruncateSync(fd);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

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
 * A value no env-file line can hold.
 * @param {string} key
 */
const unsavableValueError = (key) =>
  new Error(
    `s3cab can't save this value (${key}) in an env file: it holds a line break, or a mix of quote marks (' " \`) along with a #, a space at either end, or a quote at the start.\n\n` +
      `To keep a secret like this out of the file, hand it to s3cab through your AWS config, ` +
      `as "Keeping the secret out of plaintext" describes:\n` +
      `  https://s3cab.plantegral.com/guide/aws`,
  );

/**
 * The `KEY=value` line `parseEnv` reads back as exactly `value`: bare when it
 * can be, so a plain value reads as a person would write it, else in the first
 * quotes it survives. Unquoted, `#` starts a comment and the ends are trimmed;
 * single quotes and backticks are literal; double quotes expand `\n`; a CR is
 * dropped everywhere. The parser is the judge, so no rule here can drift from it
 * — but it judges one line, and two things only show in a whole file: a value
 * over several lines, which the line edits here can't follow, and a bare value
 * opening with a quote, which reads on to the next such quote on any later line.
 * Exported so a caller can refuse a value before it acts on it.
 * @param {string} key
 * @param {string} value
 */
export function envLine(key, value) {
  if (/[\r\n\u2028\u2029]/.test(value)) {
    throw unsavableValueError(key);
  }
  const quotes = /^['"`]/.test(value) ? ["'", "`", '"'] : ["", "'", "`", '"'];
  for (const quote of quotes) {
    const line = `${key}=${quote}${value}${quote}`;
    if (parseEnv(line)[key] === value) {
      return line;
    }
  }
  throw unsavableValueError(key);
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
    const line = envLine(key, value);
    // Global: replace EVERY occurrence — parseEnv is last-wins, so updating
    // only the first of hand-made duplicates would leave the old value live.
    const existing = new RegExp(`^${escapeRegExp(key)}=.*$`, "gm");
    if (existing.test(text)) {
      // A function, not the string: a replacement string expands `$&` and `$'`,
      // which a secret may hold.
      text = text.replaceAll(existing, () => line);
    } else {
      if (text && !text.endsWith("\n")) {
        text += "\n";
      }
      text += line + "\n";
    }
  }
  writeOwnerOnly(path, text);
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
  writeOwnerOnly(path, kept.join("\n"));
}
