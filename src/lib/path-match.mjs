// Matching a path against text, tolerantly: the two primitives shared by every
// path matcher in the codebase — the glob token grammar (`globSource`) and the
// question of whether a path's case matters (`isWindowsPath`).
//
// They live together because they are two halves of one answer: `globSource`
// produces the pattern, `isWindowsPath` decides whether it folds case. `exclude`
// uses the first, `restore --output` the second, `find` both.

/**
 * Whether a path is *Windows-shaped* — a drive letter followed by a separator
 * (`C:\Users\me`, `c:/Users/me`) — and so names one file under either spelling
 * of its case.
 *
 * Asked of the **path**, never of `process.platform`, because the two disagree
 * exactly where it matters: `restore --output` puts a Windows backup on another
 * machine and `find` searches a Windows snapshot from anywhere, so `platform`
 * reads `linux` while the paths in hand are still Windows paths whose casing
 * still doesn't matter. (`compileExclude` legitimately keys on the platform
 * instead — its patterns only ever meet paths from the running machine's own
 * walk.)
 *
 * A UNC root (`\\server\share`) is deliberately *not* Windows-shaped here: the
 * remote filesystem sets its own case rules, and case-sensitive is the safe
 * answer when we can't know them.
 * @param {string} path - An absolute path, as a snapshot records it
 * @returns {boolean} True when comparisons against it should fold case
 */
export const isWindowsPath = (path) => /^[A-Za-z]:[\\/]/.test(path);

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
