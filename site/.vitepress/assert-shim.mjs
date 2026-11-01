// `node:assert` for the pattern playgrounds, as node-shim.mjs is for `node:path`
// and `node:util`: format.mjs, which exclude.mjs imports, takes its default
// export. Not in node-shim.mjs: the playgrounds' tests mock `node:path` with
// that module's whole namespace, which can't carry a default export.

/**
 * @param {unknown} value
 * @param {string} [message]
 * @returns {asserts value}
 */
export default function assert(value, message) {
  if (!value) {
    throw new Error(message ?? "Assertion failed");
  }
}
