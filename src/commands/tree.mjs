import { loadSet } from "../lib/env.mjs";
import { walkSet } from "../lib/walk.mjs";

/**
 * List the files a snapshot of `setName` would include — the `tree` command,
 * and the diagnostic answer to "exactly what is in this set". Resolves the set
 * (sole-set default, or an error listing the sets) and walks it, reporting just
 * the kept files (the walk's exclusion records are for the snapshot writer).
 * @param {string} [setName] - Backup set to list (default: the only set)
 * @returns {Array<string>} Array of absolute file paths
 */
export function tree(setName) {
  return walkSet(loadSet(setName)).files;
}
