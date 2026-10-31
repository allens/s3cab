import { join, posix, sep } from "node:path";

import { ESCAPES, danglingEscape, globSource } from "./path-match.mjs";

/**
 * Compile a set's exclude patterns for one member directory into a matcher that
 * answers, for each path the walk meets, which pattern (if any) leaves it out.
 *
 * The token grammar is `globSource`'s (guide/exclude.md); what this adds is
 * everything around it, on both sides of the match:
 *
 * - **Patterns are joined onto `baseDir` and anchored `^…$`**, so a pattern
 *   always describes a whole path beneath its root and `*`/`**` can't escape it —
 *   which is where `find` deliberately parts company (ADR-0088).
 * - **Either separator works, in patterns and paths alike**: `/` everywhere, `\`
 *   too on Windows. Both are converted to `/` before matching. Elsewhere `\`
 *   escapes (ADR-0114).
 * - **A directory is matched with a trailing `/`**, so `build/` names only the
 *   directory and `build` only a file — a `**` reaches either.
 * - **The first matching pattern wins**, and is what the walk records as the
 *   pattern on its `#excluded` row.
 *
 * Names compare the way this machine's filesystem compares them by default:
 * ignoring case on Windows and macOS, and on macOS ignoring how an accent is
 * spelled too (one character, or a letter and a combining mark: NFC/NFD). The
 * platform is the right question here, unlike in `find`, because these patterns
 * only ever meet paths from this machine's own walk. Case folds by Unicode's
 * table, which joins a few rare letters NTFS keeps apart (the Kelvin sign and
 * `k`): not the `i` flag alone, which matched NTFS on those, because only `u`
 * makes `?` match a whole emoji.
 * @param {string} baseDir - The member directory the patterns are relative to
 * @param {string[]} patterns - Root-relative exclude globs, as the user wrote them
 * @returns {(path: string, isDirectory: boolean) => string | undefined} The
 *   first pattern matching `path`, or `undefined` to keep it
 */
export function compileExcludePatterns(baseDir, patterns) {
  const matchers = patterns.map((pattern) => ({
    pattern,
    regex: compile(join(baseDir, pattern)),
  }));

  return (path, isDirectory) => {
    let subject = spell(path);
    if (isDirectory) {
      subject += posix.sep;
    }
    return matchers.find(({ regex }) => regex.test(subject))?.pattern;
  };
}

/**
 * Parse exclude.txt text into its patterns: `parseLines`' rules, but a space
 * escaped at the end of a line is part of the pattern (ADR-0114).
 * @param {string} text
 * @returns {string[]}
 */
export function parseExclude(text) {
  return text
    .split("\n")
    .map((line) => {
      // A CRLF line's CR goes first, so it is never the escaped character.
      const start = line.replace(/\r$/, "").trimStart();
      const trimmed = start.trimEnd();
      return danglingEscape(trimmed)
        ? start.slice(0, trimmed.length + 1)
        : trimmed;
    })
    .filter((line) => !line.startsWith("#") && line.length > 0);
}

/**
 * The line that names exactly `rel` when exclude.txt is read back, or
 * `undefined` when there is none (ADR-0114). A leading `#` or space is written
 * after a `\`, which escapes it on Linux and macOS and on Windows is a leading
 * separator, which changes nothing. Windows has no escape, so a name ending in
 * a space there has no line; it can't hold `*` or `?` at all.
 * @param {string} rel - A path relative to a member directory
 * @returns {string | undefined}
 */
export function exactPattern(rel) {
  let pattern = ESCAPES ? rel.replaceAll(/[\\*?]/g, "\\$&") : rel;
  if (pattern.trimEnd() !== pattern) {
    if (!ESCAPES) {
      return undefined;
    }
    pattern = `${pattern.slice(0, -1)}\\${pattern.slice(-1)}`;
  }
  return pattern.startsWith("#") || pattern.trimStart() !== pattern
    ? `\\${pattern}`
    : pattern;
}

const FOLDS_CASE =
  process.platform === "win32" || process.platform === "darwin";
const FOLDS_ACCENTS = process.platform === "darwin";

/**
 * @param {string} pattern - Absolute exclude glob
 * @returns {RegExp}
 */
function compile(pattern) {
  return new RegExp(
    `^${globSource(posix.normalize(spell(pattern)))}$`,
    FOLDS_CASE ? "iu" : "u",
  );
}

/**
 * A path or pattern with `/` separators, and on macOS in one accent spelling.
 * @param {string} path
 */
function spell(path) {
  const slashed = path.split(sep).join(posix.sep);
  return FOLDS_ACCENTS ? slashed.normalize("NFC") : slashed;
}
