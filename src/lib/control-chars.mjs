// Its own module, importing nothing, because exclude.mjs needs it and the docs
// site's exclude playground bundles exclude.mjs for a browser: format.mjs would
// bring `node:assert` and `Intl.DurationFormat` along.

/**
 * A path with its tab and line-ending characters spelled out as the Unicode
 * Control Pictures `␉` `␍` `␊` (ADR-0100), so one path stays on one line: one
 * entry of an error's list, or one `#excluded` row of a snapshot. Not for any
 * path s3cab reads back as a real one (a `-` row):
 * there a real `␉` in a name is only a character of it.
 * @param {string} path
 * @returns {string}
 */
export const showControlChars = (path) =>
  path.replaceAll("\t", "␉").replaceAll("\r", "␍").replaceAll("\n", "␊");
