import { posix, win32 } from "node:path";

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
 *
 * `platform` is this machine's everywhere but the docs site's playground
 * (site/.vitepress/exclude-playground.mjs), which matches like any of them.
 * @param {string} baseDir - The member directory the patterns are relative to
 * @param {string[]} patterns - Root-relative exclude globs, as the user wrote them
 * @param {NodeJS.Platform} [platform] - Whose filesystem to compare names like
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

  const matchers = patterns.map((pattern) => ({
    pattern,
    regex: new RegExp(
      `^${globSource(posix.normalize(spell(join(baseDir, pattern))))}$`,
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
