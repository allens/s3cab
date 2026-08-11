import { posix, sep } from "node:path";

/**
 * Compile one exclude glob into a matcher `RegExp`, anchored to the whole
 * string. The pattern is **absolute** — the walk joins each set root with the
 * root-relative pattern before compiling, so `*` and `**` can't escape the root.
 *
 * Glob tokens (guide/exclude.md): a `**` path segment matches zero or more whole
 * segments; a `**` *not* followed by a separator matches anything at all,
 * separators included; `*` matches one or more characters within a single
 * segment; `?` matches one character. (The first can't be written with its
 * trailing slash anywhere in this file — that sequence ends a block comment.)
 * Users may write either separator (`/` everywhere; `\` also works on
 * Windows, where `join` has already normalized it to the platform separator);
 * everything is converted to `/` before matching, because the per-segment globs
 * need one canonical separator to define a segment. Matching is case-insensitive
 * on win32, case-sensitive elsewhere.
 * @param {string} pattern - Absolute exclude glob
 * @returns {RegExp} Matcher anchored with `^…$`, tested against a `/`-separated path
 */
export function compileExclude(pattern) {
  // @ts-ignore - RegExp.escape exists in Node 24+
  const regexPattern = RegExp.escape(
    posix.normalize(pattern.split(sep).join(posix.sep)),
  )
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
    .replace(/\\\?/g, "[^/]");

  return new RegExp(
    `^${regexPattern}$`,
    process.platform === "win32" ? "i" : "",
  );
}
