import { readFileSync } from "node:fs";

/** @param {string} path */
export function readLines(path) {
  return readFileSync(path)
    .toString() // text file
    .split("\n") // split lines
    .filter((line) => !line.startsWith("#")) // remove comments
    .map((line) => line.trim()) // trim whitespace
    .filter((line) => line.length > 0); // remove empty lines
}
