// The exclude playground's whole answer, kept out of its Vue component so
// `npm test` can check it: patterns and paths in, `tree --excluded`'s verdict
// out, from s3cab's own reader and matcher.

import { compileExcludePatterns } from "../../src/lib/exclude.mjs";
import { parseLines } from "../../src/lib/read-lines.mjs";
// Not `node:path`: config.mjs shims that only within src/lib/.
import { posix } from "./node-shim.mjs";

/** @typedef {"win32" | "darwin" | "linux"} Platform */

/**
 * One path the reader typed, and whether the patterns leave it out.
 * @typedef {Object} Verdict
 * @property {string} path - As typed, trimmed
 * @property {string} [pattern] - The pattern that left it out
 * @property {string} [folder] - The left-out folder it is inside, `/`-separated,
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
  const excludedBy = compileExcludePatterns(
    member,
    parseLines(patternsText),
    platform,
  );

  return pathsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((path) => {
      // The walk only ever hands over a clean path inside the member: no `.`,
      // no doubled or leading separator. `/` is the matcher's separator too.
      const slashed = platform === "win32" ? path.replaceAll("\\", "/") : path;
      const relative = posix.normalize(slashed).replace(/^(\.?\/)+/, "");
      const subject = `${member}/${relative}`;
      for (const { index } of relative.matchAll(/\//g)) {
        const pattern = excludedBy(
          subject.slice(0, member.length + 1 + index),
          true,
        );
        if (pattern) {
          return index === relative.length - 1
            ? { path, pattern }
            : { path, pattern, folder: relative.slice(0, index + 1) };
        }
      }
      if (relative === "" || relative.endsWith("/")) {
        return { path };
      }
      const pattern = excludedBy(subject, false);
      return pattern ? { path, pattern } : { path };
    });
}
