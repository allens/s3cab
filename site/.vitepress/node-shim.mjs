// What s3cab's browser-safe lib modules (src/lib/find-pattern.mjs,
// src/lib/exclude.mjs, src/lib/read-lines.mjs and what they import) take from
// Node, for the docs site's pattern playgrounds. The config hands this module
// to them in place of `node:path`, `node:util` and `node:fs`, so it exports
// exactly the names they import; one they start importing that isn't here
// fails `npm run docs:build`. The playgrounds' tests run through this module
// too, so a `posix` member they start using that isn't here fails `npm test`.
//
// `sep` is `/`: a `find` pattern typed here is read the way s3cab on macOS or
// Linux reads one, where `\` is an ordinary character. The exclude playground
// names its platform, and exclude.mjs picks `posix` or `win32` from it.

/**
 * `path.posix.normalize`: `.` and `..` resolved, runs of `/` collapsed, a
 * trailing `/` kept. node-shim.test.mjs holds it to Node's own.
 * @param {string} path
 * @returns {string}
 */
function normalize(path) {
  if (path === "") {
    return ".";
  }
  const absolute = path.startsWith("/");
  /** @type {string[]} */
  const segments = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      segments.push(segment);
    } else if (segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
    } else if (!absolute) {
      segments.push("..");
    }
  }
  let joined = segments.join("/");
  if (joined === "" && !absolute) {
    joined = ".";
  }
  if (joined !== "" && path.endsWith("/")) {
    joined += "/";
  }
  return absolute ? `/${joined}` : joined;
}

/** `path.posix.join`. @param {string[]} parts */
const join = (...parts) => normalize(parts.filter(Boolean).join("/") || ".");

export const sep = "/";
export const posix = { sep, normalize, join };

const DRIVE_ROOT = /^[A-Za-z]:\//;

/**
 * `path.win32`, joining onto a drive-letter base: the only kind the exclude
 * playground passes.
 */
export const win32 = {
  sep: "\\",
  /** @param {string[]} parts */
  join: (...parts) => {
    const path = parts.filter(Boolean).join("/").replaceAll("\\", "/");
    const root = DRIVE_ROOT.test(path) ? path.slice(0, 2) : "";
    return (root + normalize(path.slice(root.length))).replaceAll("/", "\\");
  },
};

/**
 * `util.styleText`, styling nothing: a web page has no terminal to colour.
 * @param {unknown} _format
 * @param {string} text
 */
export const styleText = (_format, text) => text;

/**
 * `fs.readFileSync`, for read-lines.mjs's import: the playground calls only its
 * `parseLines`, and a page has no files to read.
 * @returns {never}
 */
export const readFileSync = () => {
  throw new Error("A web page has no files to read.");
};
