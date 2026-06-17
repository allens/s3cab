import { formatSets, listSets, readSet } from "../lib/sets.mjs";

/**
 * List the backup sets: each set's name, where it backs up to, and its member
 * folders — the discoverability counterpart of "the files are the API", and
 * what the resolve-a-set error messages point at.
 *
 * Like `hashes`, this is a deliberate exception to the dispatcher's JSON
 * serialization: the formatted listing *is* the result, so it goes to stdout
 * directly (JSON.stringify would escape it into one quoted line). With no sets
 * yet, stdout stays empty and the setup hint goes to stderr.
 * @returns {undefined}
 */
export function sets() {
  const names = listSets();
  if (names.length === 0) {
    console.warn(
      "No backup sets yet. Create one with: s3cab setup <set> <folder>...",
    );
    return undefined;
  }
  process.stdout.write(formatSets(names.map(readSet)) + "\n");
  return undefined;
}
