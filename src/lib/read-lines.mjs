import { readFileSync } from "node:fs";

/**
 * Parse dirs/exclude text into its active lines: trimmed, with `#` comments
 * (even indented) and blank lines dropped. The shape a set's `exclude.txt` and
 * `dirs.txt` are read as at runtime; also used to list the *active* patterns of
 * the in-memory `starterExclude` (setup.mjs), so a single rule decides what
 * counts as active everywhere.
 * @param {string} text
 */
export function parseLines(text) {
  return text
    .split("\n") // split lines
    .map((line) => line.trim()) // trim whitespace
    .filter((line) => !line.startsWith("#")) // remove comments (even indented)
    .filter((line) => line.length > 0); // remove empty lines
}

/** @param {string} path */
export function readLines(path) {
  return parseLines(readFileSync(path).toString());
}
