import { loadSet } from "../lib/env.mjs";
import { walkSet } from "../lib/walk.mjs";

/**
 * @import { Writable } from "node:stream"
 */

/**
 * List the files a snapshot of `setName` would include — the `tree` command,
 * and the diagnostic answer to "exactly what is in this set". Resolves the set
 * (sole-set default, or an error listing the sets) and walks it.
 * @param {string} [setName] - Backup set to list (default: the only set)
 * @param {Writable} [writeStream]
 * @returns {Array<string>} Array of absolute file paths
 */
export function tree(setName, writeStream) {
  return walkSet(loadSet(setName), writeStream);
}
