/**
 * Parse dirs/list text into its active lines: trimmed, with `#` comments
 * (even indented) and blank lines dropped. The shape a set's `dirs.txt` and a
 * `--from-file` list are read as; also used to list the *active* patterns of
 * the in-memory `starterExclude` (setup.mjs). A set's `exclude.txt` is read by
 * `parseExclude`, which trims differently (ADR-0115) and keeps the rest.
 * @param {string} text
 */
export function parseLines(text) {
  return activeLines(text.split("\n").map((line) => line.trim()));
}

/**
 * Trimmed lines minus `#` comments and blank lines.
 * @param {string[]} lines
 */
export const activeLines = (lines) =>
  lines.filter((line) => !line.startsWith("#") && line.length > 0);
