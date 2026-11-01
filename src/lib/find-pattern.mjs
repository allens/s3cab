import { posix, sep } from "node:path";

import { ValidationError } from "./error.mjs";
import { globSource } from "./path-match.mjs";
import { shellCommand } from "./style.mjs";

/** @import { PreparedPath } from "./path-match.mjs" */

// The `find` pattern matcher, apart from the snapshot reading in find.mjs so the
// docs site's pattern playground can bundle it for a browser. Nothing here, or
// in what it imports, may touch the filesystem: the site maps `node:path` and
// `node:util` to small stand-ins (site/.vitepress/node-shim.mjs), and any other
// Node builtin fails `npm run docs:build`.

/**
 * One compiled pattern: the text the user typed (kept for the report) and the
 * test it compiled to.
 * @typedef {Object} FindMatcher
 * @property {string} pattern
 * @property {(candidate: PreparedPath) => boolean} test
 */

/**
 * Compile one find pattern into a matcher.
 *
 * The anchoring, which is where this parts company with `compileExcludePatterns`
 * over the same token grammar ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)):
 *
 * - **No separator** → match the **basename**. `junkfile.dat` finds that file
 *   wherever it lived; `*.jpg` finds every JPEG.
 * - **A separator** → match the **full path, floating**: an implicit `**` on the
 *   front, so `secretsdir/secret1` finds `C:\Users\me\secretsdir\secret1` without
 *   the user typing the part of the path they don't remember.
 * - **A trailing separator** → everything *beneath* that directory. Snapshots
 *   have no directory rows, so this is the only way to name a subtree, and it
 *   matches paths — never the directory itself.
 *
 * **Separators in the *pattern* key on `process.platform`; separators in the
 * *path* key on the path's shape.** They are different questions with
 * different right answers: the pattern was typed at this machine's shell, so a
 * Windows user typing `secretsdir\secret1` means a separator; the path came out
 * of a snapshot that may have been taken on another OS entirely, so only its own
 * shape can say how it is spelled (`preparePath`). The consequence is a POSIX
 * filename containing a literal backslash can't be named by a pattern — a wart
 * worth the two rules being independently correct.
 * @param {string} pattern - As the user typed it
 * @returns {FindMatcher}
 * @throws {ValidationError} On a pattern with nothing in it to match
 */
export function compileFindPattern(pattern) {
  const slashed = pattern.split(sep).join(posix.sep);
  const directory = slashed.endsWith(posix.sep);
  const body = directory ? slashed.slice(0, -1) : slashed;

  if (body === "") {
    throw new ValidationError(
      `There's nothing to search for in the pattern '${pattern}'. Give a file ` +
        `name, a path fragment, or a directory to search beneath:\n\n` +
        `  ${shellCommand("s3cab find secrets/")}`,
    );
  }

  // A separator anywhere — including the trailing one just stripped — switches
  // from basename matching to a floating whole-path match.
  const normalized = oneSpelling(posix.normalize(body));
  const wholePath = directory || normalized.includes(posix.sep);
  const source = globSource(normalized);
  const anchored = wholePath
    ? `^(?:.*/)?${source}${directory ? "/.*" : ""}$`
    : `^${source}$`;

  // Neither case nor how an accent is spelled matters to a search. A miss here
  // leaves the file in every backup, while an extra match only shows in the
  // report the user picks hashes from. Nor can a snapshot say whether they
  // mattered where it was taken: a macOS path looks just like a Linux one.
  const regex = new RegExp(anchored, "iu");

  return {
    pattern,
    test: (candidate) =>
      regex.test(oneSpelling(wholePath ? candidate.path : candidate.base)),
  };
}

/** Anything past ASCII, the only text an accent can be spelled two ways in. */
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Text with every accent in one spelling (NFC: `é` as one character, never `e`
 * and a combining mark), leaving alone the plain-ASCII paths that are most of
 * a history, since it runs on every row searched.
 * @param {string} text
 */
const oneSpelling = (text) =>
  NON_ASCII.test(text) ? text.normalize("NFC") : text;
