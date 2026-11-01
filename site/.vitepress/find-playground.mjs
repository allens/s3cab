// The pattern playground's `find` half: patterns and paths in, which pattern
// matched which path out. It runs s3cab's own matcher, so the page agrees with
// `s3cab find` on macOS and Linux; on Windows the CLI also takes `\` in a
// pattern as a separator, which the page doesn't (node-shim.mjs). The
// component, FindPlayground.vue, only draws the result.

import { ValidationError } from "../../src/lib/error.mjs";
import { compileFindPattern } from "../../src/lib/find-pattern.mjs";
import { preparePath } from "../../src/lib/path-match.mjs";

/** @import { FindMatcher } from "../../src/lib/find-pattern.mjs" */

/**
 * @typedef {Object} PatternResult
 * @property {string} pattern
 * @property {string} [error] - Why s3cab would refuse it
 */

/**
 * @typedef {Object} PathResult
 * @property {string} path
 * @property {string[]} matchedBy - Every pattern that matches it, in input order
 */

/**
 * @typedef {Object} FindReport
 * @property {PatternResult[]} patterns
 * @property {PathResult[]} paths
 */

/**
 * The non-blank lines of a text box, trimmed, as a shell would take an
 * unquoted word: a stray space must not turn a match into "no match".
 * @param {string} text
 */
const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * Match each path, one per line, against each pattern, one per line. A
 * pattern `s3cab find` would refuse is reported with its message, and the
 * rest still match.
 * @param {string} patternText
 * @param {string} pathText - Absolute paths, as a snapshot records them
 * @returns {FindReport}
 */
export function findReport(patternText, pathText) {
  /** @type {PatternResult[]} */
  const patterns = [];
  /** @type {FindMatcher[]} */
  const matchers = [];
  for (const pattern of lines(patternText)) {
    try {
      matchers.push(compileFindPattern(pattern));
      patterns.push({ pattern });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      patterns.push({ pattern, error: error.message });
    }
  }
  const paths = lines(pathText).map((path) => {
    const candidate = preparePath(path);
    return {
      path,
      matchedBy: matchers
        .filter((matcher) => matcher.test(candidate))
        .map((matcher) => matcher.pattern),
    };
  });
  return { patterns, paths };
}
