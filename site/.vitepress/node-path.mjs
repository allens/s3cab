// What the exclude playground's bundle gets for `node:path` (config.mjs aliases
// it here): the browser has none, and the matcher needs only these few calls.
// `win32.join` handles a drive-letter base, the only kind the playground passes.
// node-path.test.mjs holds each one to Node's own answers.

/**
 * `path.posix.normalize`: repeated `/` count as one, `.` and `..` resolved, a
 * trailing `/` kept.
 * @param {string} path
 * @returns {string}
 */
function normalize(path) {
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  /** @type {string[]} */
  const out = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      out.push(segment);
    } else if (out.length && out.at(-1) !== "..") {
      out.pop();
    } else if (!absolute) {
      out.push("..");
    }
  }
  const joined = out.join("/");
  if (joined === "") {
    return absolute ? "/" : trailing ? "./" : ".";
  }
  return `${absolute ? "/" : ""}${joined}${trailing ? "/" : ""}`;
}

/** @param {string[]} parts */
const join = (...parts) => normalize(parts.filter(Boolean).join("/") || ".");

export const posix = { sep: "/", normalize, join };

const DRIVE_ROOT = /^[A-Za-z]:\//;

export const win32 = {
  sep: "\\",
  /** @param {string[]} parts */
  join: (...parts) => {
    const path = parts.filter(Boolean).join("/").replaceAll("\\", "/");
    const root = DRIVE_ROOT.test(path) ? path.slice(0, 2) : "";
    return (root + normalize(path.slice(root.length))).replaceAll("/", "\\");
  },
};
