import { posix, win32 } from "node:path";

import {
  asFolders,
  ESCAPE_RULE,
  ESCAPES,
  globSource,
  literalPattern,
  strayEscape,
} from "./path-match.mjs";
import { showControlChars } from "./format.mjs";
import { activeLines } from "./read-lines.mjs";

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
 *   escapes (ADR-0115).
 * - **A directory is matched with a trailing `/`**, so `build/` names only the
 *   directory and `build` only a file — a `**` reaches either.
 * - **The first matching pattern wins**, and is what the walk records as the
 *   pattern on its `#excluded` row.
 *
 * Names compare the way the platform's filesystem compares them by default:
 * ignoring case on Windows and macOS, and on macOS ignoring how an accent is
 * spelled too (one character, or a letter and a combining mark: NFC/NFD). The
 * platform is the right question here, unlike in `find`, because these patterns
 * only ever meet paths from one machine's own walk, and `platform` names that
 * machine. Case folds by Unicode's table, which joins a few rare letters NTFS
 * keeps apart (the Kelvin sign and `k`): not the `i` flag alone, which matched
 * NTFS on those, because only `u` makes `?` match a whole emoji.
 * @param {string} baseDir - The member directory the patterns are relative to
 * @param {string[]} patterns - Root-relative exclude globs, as the user wrote them
 * @param {NodeJS.Platform} [platform] - The machine whose walk the paths come
 *   from: this one, unless a caller is showing another's
 * @returns {(path: string, isDirectory: boolean) => string | undefined} The
 *   first pattern matching `path`, or `undefined` to keep it
 */
export function compileExcludePatterns(
  baseDir,
  patterns,
  platform = process.platform,
) {
  // Node's own choice of `node:path` flavour, made from `platform`.
  const { join, sep } = platform === "win32" ? win32 : posix;
  const escapes = sep === posix.sep;
  const foldsAccents = platform === "darwin";
  const flags = platform === "win32" || foldsAccents ? "iu" : "u";

  /**
   * A path or pattern with `/` separators, and on macOS in one accent spelling.
   * @param {string} path
   */
  const spell = (path) => {
    const slashed = path.split(sep).join(posix.sep);
    return foldsAccents ? slashed.normalize("NFC") : slashed;
  };

  // The member directory is a path, not a pattern: a `\`, `*` or `?` in its
  // name must match only itself.
  const root = literalPattern(baseDir, escapes);
  const matchers = patterns.map((pattern) => ({
    pattern,
    regex: new RegExp(
      `^${globSource(posix.normalize(spell(join(root, pattern))), escapes)}$`,
      flags,
    ),
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
 * Parse exclude.txt text into its patterns: `parseLines`' rules, but a
 * whitespace character a `\` at the end of a line escapes is part of the
 * pattern (ADR-0115).
 * @param {string} text
 * @param {boolean} [escapes] - As for `literalPattern`
 * @returns {string[]}
 */
export function parseExclude(text, escapes = ESCAPES) {
  return activeLines(
    text.split("\n").map((line) => {
      // A CRLF line's CR goes first, so it is never the escaped character.
      const start = line.replace(/\r$/, "").trimStart();
      const trimmed = start.trimEnd();
      const kept = start.slice(0, trimmed.length + 1);
      return strayEscape(trimmed, escapes) && !strayEscape(kept, escapes)
        ? kept
        : trimmed;
    }),
  );
}

/**
 * The error that stops the walk using these exclude.txt patterns, or
 * `undefined` when it can use them: first a tab or carriage return in a
 * pattern (ADR-0100), then a `\` that escapes nothing (ADR-0115). Here, not in
 * the walk, so the docs site's playground refuses the same patterns.
 * @param {string[]} patterns - As `parseExclude` read them
 * @param {string} file - The exclude file, as the message names it
 * @param {boolean} [escapes] - As for `literalPattern`
 * @returns {Error | undefined}
 */
export function unusableExcludeError(patterns, file, escapes = ESCAPES) {
  // After the trim, so a CRLF file's line endings never get here.
  const controls = patterns.filter((pattern) => /[\t\r]/.test(pattern));
  if (controls.length) {
    const these =
      controls.length === 1
        ? "this pattern contains"
        : "these patterns contain";
    return new Error(
      `Can't use the set's exclude file, because ${these} a tab or a carriage ` +
        `return (${file}):\n` +
        controls.map((pattern) => `  ${showControlChars(pattern)}`).join("\n") +
        `\nWrite * in place of the character, which still matches it:\n` +
        controls
          .map((pattern) => `  ${pattern.replaceAll(/[\t\r]+/g, "*")}`)
          .join("\n"),
    );
  }
  // The likeliest cause is a file written on Windows, where `\` separates
  // folders, so that is the fix offered first.
  const stray = patterns.filter((pattern) => strayEscape(pattern, escapes));
  if (stray.length) {
    const folders = stray.map(asFolders).filter((line) => line !== undefined);
    const these =
      stray.length === 1 ? "this pattern has" : "these patterns have";
    return new Error(
      `Can't use the set's exclude file, because ${these} a \\ that escapes ` +
        `nothing (${file}):\n` +
        stray.map((pattern) => `  ${pattern}`).join("\n") +
        `\n${ESCAPE_RULE}` +
        (folders.length
          ? ` If the \\ separates folders, write:\n` +
            folders.map((pattern) => `  ${pattern}`).join("\n")
          : "") +
        `\nFor a backslash in a name, write \\\\.`,
    );
  }
  return undefined;
}

/**
 * The line that names exactly `rel` when exclude.txt is read back, or
 * `undefined` when there is none (ADR-0115). A leading `#` or space is written
 * after a `\`, which escapes it on Linux and macOS and on Windows is a leading
 * separator, which changes nothing. Windows has no escape, so a name there
 * ending in a space, or holding a `*` or `?` (a share can), has no line; nor
 * does a name with a control character, which no line holds and no terminal
 * shows as written.
 * @param {string} rel - A path relative to a member directory
 * @returns {string | undefined}
 */
export function exactPattern(rel) {
  if (/\p{Cc}/u.test(rel) || (!ESCAPES && /[*?]/.test(rel))) {
    return undefined;
  }
  let pattern = literalPattern(rel);
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
