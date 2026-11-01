import { posix } from "node:path";

// Matching a path against text, tolerantly: the two primitives shared by every
// path matcher in the codebase — the glob token grammar (`globSource`) and the
// question of how a path is *spelled* (`preparePath`, `foldsCase`).
//
// They live together because they are two halves of one answer: `globSource`
// produces the pattern, and the spelling question decides what the pattern is
// compared against and whether the comparison folds case. `exclude` uses the
// first, `restore` the second (its path filters and `--output`), `find` both,
// though `find` folds case for every path.
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
//   spelling it holds. (`compileExcludePatterns` legitimately keys on the platform
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
 * How many leading characters of a `preparePath` path are its root: a share's
 * `//`, a drive's `C:/`, and POSIX `/`. Past it, every segment is a name.
 * @param {string} path - A path with its separators already unified to `/`
 * @returns {number}
 */
export const rootLength = (path) =>
  path.startsWith("//") ? 2 : foldsCase(path) ? 3 : 1;

/**
 * Whether a `@SET DIR` can match any path (guide/format.md): absolute, with no
 * empty segment past its root, and a share's naming both server and share.
 * Trailing separators are ignored, as everywhere. Without this, `\\` would
 * hold every share path and `\\server\` every share on that server.
 * @param {string} dir
 * @returns {boolean}
 */
export function isMatchableDir(dir) {
  const { path, foldCase } = preparePath(dir);
  if (!foldCase && !path.startsWith(posix.sep)) {
    return false;
  }
  const names = path.slice(rootLength(path)).replace(/\/+$/, "");
  const segments = names === "" ? [] : names.split(posix.sep);
  return (
    !segments.includes("") && (!path.startsWith("//") || segments.length >= 2)
  );
}

/**
 * Normalize a path for containment: separators to `/` and case folded for a
 * Windows-shaped path, both left alone for a POSIX one.
 * @param {string} p
 * @returns {string}
 */
const normalize = (p) => {
  const { path, foldCase } = preparePath(p);
  return foldCase ? path.toLowerCase() : path;
};

/**
 * The form `pathMatcher` compares a folder in: normalized, any trailing
 * separator dropped. Two paths with one key name one place.
 * @param {string} folder
 * @returns {string}
 */
export const pathKey = (folder) => normalize(folder).replace(/\/+$/, "");

/**
 * Build the "does this path fall under any of these folders?" predicate — a
 * folder matches a path that equals it or lies under it (a `/`-boundary prefix),
 * separators unified and case folded for a Windows-shaped path, a trailing
 * separator ignored — so `/` is the root, and every absolute POSIX path is under
 * it. Only a path of the folder's own kind, Windows or POSIX: normalized, a share
 * path starts `//`, which `/` would otherwise claim. `restore`'s path filters,
 * and the snapshot reader's test that a row's path is under a `@SET DIR`
 * (ADR-0101).
 * @param {string[]} folders - Paths to match under
 * @returns {((path: string) => boolean) | undefined} `undefined` when no folder
 *   is given, or all are blank
 */
export function pathMatcher(folders) {
  const keys = { windows: new Set(), posix: new Set() };
  for (const folder of folders) {
    if (folder.trim() !== "") {
      keys[foldsCase(folder) ? "windows" : "posix"].add(pathKey(folder));
    }
  }
  if (keys.windows.size + keys.posix.size === 0) {
    return undefined;
  }
  // The path and each folder above it are looked up, not each folder tested
  // against the path: a `--from-file` list can name thousands.
  return (p) => {
    const { path, foldCase } = preparePath(p);
    const hay = foldCase ? path.toLowerCase() : path;
    const under = foldCase ? keys.windows : keys.posix;
    for (let end = hay.length; end !== -1; end = up(hay, end)) {
      if (under.has(hay.slice(0, end))) {
        return true;
      }
    }
    return false;
  };
}

/**
 * The end of the next folder up in a normalized path: before the `/` nearest
 * `end`, `0` for POSIX's root, `-1` past it.
 * @param {string} hay
 * @param {number} end
 */
const up = (hay, end) => (end === 0 ? -1 : hay.lastIndexOf(posix.sep, end - 1));

/**
 * The `folders` that no path in `paths` lies under, as `pathMatcher` matches
 * them: `restore`'s path filters that named nothing. Each path walks up its own
 * folders once, so a long `--from-file` list costs no more than a short one.
 * @param {string[]} folders
 * @param {Iterable<string>} paths
 * @returns {string[]} In `folders`' order, each place once, as first spelled
 */
export function unmatchedFolders(folders, paths) {
  const kindOf = (/** @type {string} */ p) =>
    foldsCase(p) ? "windows" : "posix";
  const left = { windows: new Set(), posix: new Set() };
  for (const folder of folders) {
    left[kindOf(folder)].add(pathKey(folder));
  }
  for (const p of paths) {
    if (left.windows.size + left.posix.size === 0) {
      break;
    }
    const hay = normalize(p);
    const under = left[kindOf(p)];
    for (let end = hay.length; end !== -1; end = up(hay, end)) {
      under.delete(hay.slice(0, end));
    }
  }
  // `delete`, not `has`: a place named twice, in any spelling, is listed once.
  return folders.filter((folder) =>
    left[kindOf(folder)].delete(pathKey(folder)),
  );
}

/**
 * Whether `\` escapes the next character in a pattern
 * ([ADR-0115](../../docs/adr/0115-backslash-escapes-on-linux-and-macos.md)):
 * on Linux and macOS, where it isn't a separator. On Windows it is one, and no
 * name there holds `*` or `?`. The platform, not the path's shape, because a
 * pattern is typed on this machine.
 */
export const ESCAPES = process.platform !== "win32";

/**
 * A `\` that escapes nothing: at the end, or before anything but `\`, `*`, `?`,
 * `#` or a whitespace character that isn't a control character. Group 1 holds
 * the escaped `\\` pairs before it. Refused, not read, because it is how a
 * Windows path reads here: `**\Thumbs.db` would also match `myThumbs.db`.
 */
export const STRAY_ESCAPE =
  /(?<!\\)((?:\\\\)*)\\(?![\\*?#]|(?![\t\n\v\f\r])\s)/g;

/**
 * Whether `pattern` holds a `STRAY_ESCAPE`.
 * @param {string} pattern
 * @returns {boolean} Always false where `\` doesn't escape
 */
export const strayEscape = (pattern) =>
  ESCAPES && pattern.search(STRAY_ESCAPE) !== -1;

/** What a `\` means here, for a refusal of a `STRAY_ESCAPE` to explain. */
export const ESCAPE_RULE =
  "Here / separates folders, and a \\ makes a \\, *, ?, # or space after it " +
  "match only itself.";

/**
 * A refused pattern as it reads if each `\` separates folders: one `/` per run
 * of separators, none leading. `undefined` when that leaves nothing.
 * @param {string} pattern
 * @returns {string | undefined}
 */
export function asFolders(pattern) {
  const slashed = pattern.replaceAll(/[\\/]+/g, "/").replace(/^\//, "");
  return slashed === "" || slashed === "/" ? undefined : slashed;
}

/**
 * `text` matching only itself as a pattern: on Linux and macOS each `\`, `*`
 * and `?` escaped. Windows has no escape, and no name there holds `*` or `?`
 * through Win32.
 * @param {string} text
 * @returns {string}
 */
export const literalPattern = (text) =>
  ESCAPES ? text.replaceAll(/[\\*?]/g, "\\$&") : text;

/**
 * Compile a glob's *tokens* into regular-expression source, **unanchored** — the
 * shared half of s3cab's two path matchers, which each wrap their own anchoring
 * around it ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)):
 * an exclude pattern is anchored whole and absolute, a `find` pattern follows
 * POSIX `find` and anchors to the basename or floats over the path.
 *
 * Tokens (guide/exclude.md, guide/find.md): a `**` path segment matches zero or
 * more whole segments; a `**` *not* followed by a separator matches anything at
 * all, separators included; `*` matches one or more characters within a single
 * segment; `?` matches one character; where `ESCAPES`, `\` makes the character
 * after it match only itself. (The first can't be written with its trailing
 * slash anywhere in this file — that sequence ends a block comment.)
 * @param {string} pattern - A `/`-separated glob; converting the platform's own
 *   separator is the caller's job, because the per-segment tokens need one
 *   canonical separator to define a segment by. Never `strayEscape`: the
 *   callers refuse that with their own wording
 * @returns {string} Regex source carrying no `^`/`$` of its own, for compiling
 *   with the `u` flag: without it `?` matches half of an emoji
 */
export function globSource(pattern) {
  let source = "";
  let literal = "";
  const token = (/** @type {string} */ regex) => {
    // @ts-ignore - RegExp.escape exists in Node 24+
    source += RegExp.escape(literal) + regex;
    literal = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (ESCAPES && char === "\\") {
      literal += pattern[++i];
    } else if (char === "*" && pattern[i + 1] === "*") {
      // **/ matches zero or more segments, where it starts one. Stuck to a name
      // (`photos**/raw`) it is a plain `**`, so it can't join `photos` to `raw`
      // as `photosraw`. Any other ** (`build/**`, a bare `**`, `**.log`) spans
      // segments too: read as two `*`s it was "two or more characters, in one
      // segment", which is nobody's reading of `**`.
      const startsSegment = i === 0 || pattern[i - 1] === "/";
      if (startsSegment && pattern[i + 2] === "/") {
        token("(.*\\/)?");
        i += 2;
      } else {
        token(".*");
        i += 1;
      }
    } else if (char === "*") {
      token("[^/]+");
    } else if (char === "?") {
      token("[^/]");
    } else {
      literal += char;
    }
  }
  token("");
  return source;
}
