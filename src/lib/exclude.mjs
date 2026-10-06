import { join, posix, sep } from "node:path";

import { globSource } from "./path-match.mjs";

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
 *   too on Windows. Both are converted to `/` before matching.
 * - **A directory is matched with a trailing `/`**, so `build/` names only the
 *   directory and `build` only a file — a `**` reaches either.
 * - **The first matching pattern wins**, and is what the walk records as the
 *   entry's `#EXCLUDED` reason.
 *
 * Matching is case-insensitive on win32, case-sensitive elsewhere — the platform
 * is the right question here, unlike in `find`, because these patterns only ever
 * meet paths from this machine's own walk.
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
    let subject = toSlashes(path);
    if (isDirectory) {
      subject += posix.sep;
    }
    return matchers.find(({ regex }) => regex.test(subject))?.pattern;
  };
}

/**
 * @param {string} pattern - Absolute exclude glob
 * @returns {RegExp}
 */
function compile(pattern) {
  return new RegExp(
    `^${globSource(posix.normalize(toSlashes(pattern)))}$`,
    process.platform === "win32" ? "i" : "",
  );
}

/** @param {string} path */
const toSlashes = (path) => path.split(sep).join(posix.sep);
