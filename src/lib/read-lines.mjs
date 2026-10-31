/**
 * Parse dirs/list text into its active lines: trimmed, with `#` comments
 * (even indented) and blank lines dropped. The shape a set's `dirs.txt` and a
 * `--from-file` list are read as; also used to list the *active* patterns of
 * the in-memory `starterExclude` (setup.mjs). A set's `exclude.txt` is read by
 * `parseExclude`, which keeps an escaped space at a line's end (ADR-0114).
 * @param {string} text
 */
export function parseLines(text) {
  return text
    .split("\n") // split lines
    .map((line) => line.trim()) // trim whitespace
    .filter((line) => !line.startsWith("#")) // remove comments (even indented)
    .filter((line) => line.length > 0); // remove empty lines
}
