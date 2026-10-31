// The exclude playground's whole answer, kept out of its Vue component so
// `npm test` can check it: patterns and paths in, `tree --excluded`'s verdict
// out, from s3cab's own reader and matcher.

import { compileExcludePatterns } from "../../src/lib/exclude.mjs";
import { parseLines } from "../../src/lib/read-lines.mjs";

/** @typedef {"win32" | "darwin" | "linux"} Platform */

/**
 * One path the reader typed, and whether the patterns leave it out.
 * @typedef {Object} Verdict
 * @property {string} path - As typed
 * @property {string} [pattern] - The pattern that left it out
 * @property {string} [folder] - The left-out folder it is inside, as typed,
 *   when that folder's pattern is what left it out
 */

/** The member directory the typed paths are taken to be inside. */
const MEMBER = { win32: "C:\\member", darwin: "/member", linux: "/member" };

/**
 * Judge each path as a backup's walk would: every folder above it first,
 * outermost first, because the walk never looks inside a left-out folder; then
 * the path itself. A trailing separator makes a path a folder.
 * @param {string} patternsText - An `exclude.txt`, comments and all
 * @param {string} pathsText - Paths inside a member directory, one per line
 * @param {Platform} platform - Whose filesystem to match like
 * @returns {Verdict[]} One per non-blank line of `pathsText`, in order
 */
export function excludeReport(patternsText, pathsText, platform) {
  const member = MEMBER[platform];
  const sep = platform === "win32" ? "\\" : "/";
  const separators = platform === "win32" ? /[\\/]/g : /\//g;
  const excludedBy = compileExcludePatterns(
    member,
    parseLines(patternsText),
    platform,
  );

  return pathsText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((path) => {
      for (const { index } of path.matchAll(separators)) {
        const pattern = excludedBy(
          `${member}${sep}${path.slice(0, index)}`,
          true,
        );
        if (pattern) {
          return index === path.length - 1
            ? { path, pattern }
            : { path, pattern, folder: path.slice(0, index + 1) };
        }
      }
      if (path.endsWith("/") || path.endsWith(sep)) {
        return { path };
      }
      const pattern = excludedBy(`${member}${sep}${path}`, false);
      return pattern ? { path, pattern } : { path };
    });
}
