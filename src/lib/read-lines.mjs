import { readFileSync } from "node:fs";

/** @param {string} path */
export function readLines(path) {
  return readFileSync(path)
    .toString() // text file
    .split("\n") // split lines
    .map((line) => line.trim()) // trim whitespace
    .filter((line) => !line.startsWith("#")) // remove comments (even indented)
    .filter((line) => line.length > 0); // remove empty lines
}
