import { posix } from "node:path";

// Matching a path against text, tolerantly: the two primitives shared by every
// path matcher in the codebase — the glob token grammar (`globSource`) and the
// question of how a path is *spelled* (`preparePath`, `foldsCase`).
//
// They live together because they are two halves of one answer: `globSource`
// produces the pattern, and the spelling question decides what the pattern is
// compared against and whether the comparison folds case. `exclude` uses the
// first, `restore --output` the second, `find` both.
//
// The spelling question is really two — **which characters separate segments**,
// and **whether case matters** — and both are answered from the path's own
// **shape**, never from `process.platform`, because the two disagree exactly
// where it matters: `restore --output` puts a Windows backup on another machine
// and `find` searches a Windows snapshot from anywhere, so `platform` reads
// `linux` while the paths in hand are still Windows paths. Three shapes:
//
// - **Drive letter** (`C:\Users\me`, `c:/Users/me`) — Windows. Both separators,
//   case folds.
// - **UNC** (`\\server\share\…`, `//server/share/…`) — also Windows, and what a
//   mapped network drive resolves to, so it is every backup of a NAS. Both
//   separators, case folds: a UNC path only ever originates from a Windows
//   client, whose name lookup is case-insensitive against every Windows server
//   and against the usual NAS defaults, and the share never told the user which
//   spelling it holds. (`compileExclude` legitimately keys on the platform
//   instead — its patterns only ever meet paths from the running machine's own
//   walk.)
// - **POSIX** (`/home/me`) — `/` is the only separator, a backslash is an
//   ordinary character in a filename, and case is significant.
//
// Answering both questions from one read is the point of `preparePath`: a caller
// that derived one answer from the other's predicate is how a UNC path once
// became unfindable — its separators were judged by the drive-letter test.

/**
 * One path, prepared once for matching against every pattern.
 * @typedef {Object} PreparedPath
 * @property {string} path - Separators normalized to `/` (Windows shapes only)
 * @property {string} base - Its last segment
 * @property {boolean} foldCase - Windows-shaped, so matching folds case
 */

/** A drive letter followed by a separator. */
const DRIVE = /^[A-Za-z]:[\\/]/;
/** Two leading separators: a UNC root (`\\server\share`), under either spelling. */
const UNC = /^[\\/]{2}/;

/**
 * Whether `path` is Windows-shaped — a drive-letter or UNC root — and so
 * names one file under either spelling of its case.
 * @param {string} path - An absolute path, as a snapshot records it
 * @returns {boolean} True when comparisons against it should fold case
 */
export const foldsCase = (path) => DRIVE.test(path) || UNC.test(path);

/**
 * Derive the forms a snapshot path is matched in. Called once per row of every
 * snapshot in history, so it does the least it can: the basename is cut from the
 * original string (no allocation), and the `/`-separated form is built only for
 * a Windows shape, since a POSIX path already is one.
 *
 * Which separators count is the path's own shape (see the module header) — on
 * POSIX a backslash is an ordinary character in a filename, and cutting the
 * basename at one would name a file that doesn't exist. A UNC path keeps its
 * two leading separators, as `//server/share/…`.
 * @param {string} path - An absolute path, as a snapshot records it
 * @returns {PreparedPath}
 */
export function preparePath(path) {
  const foldCase = foldsCase(path);
  const cut = foldCase
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/");
  return {
    path: foldCase ? path.replaceAll("\\", posix.sep) : path,
    base: path.slice(cut + 1),
    foldCase,
  };
}

/**
 * Compile a glob's *tokens* into regular-expression source, **unanchored** — the
 * shared half of s3cab's two path matchers, whose whole difference is the
 * anchoring each wraps around this
 * ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)):
 * `compileExclude` anchors whole and absolute, `find` follows POSIX `find` and
 * anchors to the basename or floats over the path.
 *
 * Tokens (guide/exclude.md, guide/find.md): a `**` path segment matches zero or
 * more whole segments; a `**` *not* followed by a separator matches anything at
 * all, separators included; `*` matches one or more characters within a single
 * segment; `?` matches one character. (The first can't be written with its
 * trailing slash anywhere in this file — that sequence ends a block comment.)
 * @param {string} pattern - A `/`-separated glob; converting the platform's own
 *   separator is the caller's job, because the per-segment tokens need one
 *   canonical separator to define a segment by
 * @returns {string} Regex source carrying no `^`/`$` of its own
 */
export function globSource(pattern) {
  // @ts-ignore - RegExp.escape exists in Node 24+
  return (
    RegExp.escape(pattern)
      // **/ matches zero or more segments
      .replace(/\\\*\\\*\\\//g, "(.*\\/)?")
      // Any ** left over is one not followed by a separator — `build/**`, or a
      // bare `**`. It spans segments like its `**/` sibling: without this rule it
      // fell through to the single-`*` case *twice*, quietly compiling to two
      // [^/]+ runs — "two or more characters, in one segment" — which is nobody's
      // reading of `**`. Must run before that rule, which would otherwise consume
      // the halves.
      .replace(/\\\*\\\*/g, ".*")
      // * matches one or more chars in one segment
      .replace(/\\\*/g, "[^/]+")
      // ? matches one char
      .replace(/\\\?/g, "[^/]")
  );
}
