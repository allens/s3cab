// What s3cab's browser-safe lib modules (src/lib/find-pattern.mjs and what it
// imports) take from Node, for the docs site's pattern playground. The config
// hands this module to them in place of `node:path` and `node:util`, so it
// exports exactly the names they import; one they start importing that isn't
// here fails `npm run docs:build`. find-playground.test.mjs runs through this
// module too, so a `posix` member they start using that isn't here fails
// `npm test`.
//
// `sep` is `/`: a pattern typed here is read the way s3cab on macOS or Linux
// reads one, where `\` is an ordinary character.

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

export const sep = "/";
export const posix = { sep, normalize };

/**
 * `util.styleText`, styling nothing: a web page has no terminal to colour.
 * @param {unknown} _format
 * @param {string} text
 */
export const styleText = (_format, text) => text;
