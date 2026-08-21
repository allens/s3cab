import { requireArg } from "../lib/error.mjs";
import { fileProps } from "../lib/file-props.mjs";
import { readSnapshotFile } from "../lib/snapshot-file.mjs";

/** @import { Props } from "../lib/snapshot-file.mjs" */
/** @import { HashSource } from "../lib/file-props.mjs" */

/**
 * Show a file's properties (hash/size/mtime) — the CLI porcelain over `fileProps`
 * (lib/file-props.mjs). It does the two things that are the *command's* job and
 * leaves the hashing to the primitive:
 *  - validates the `<file>` argument;
 *  - resolves the `--lookup <snapshot>` *path* into that snapshot's entries, the
 *    lookup `fileProps` reuses a stored hash from for an unchanged file. Reading
 *    the snapshot file is the command's concern, so it stays here, not in `lib`.
 *
 * The snapshot pipeline does not route through here: it calls `fileProps`
 * directly with the previous snapshot's entries already in memory, so the only
 * `lookup` this command takes is the convenience *path* form (commands/snapshot.mjs).
 *
 * The source carries **no trust boundary**, so a size+mtime match is reused
 * without the ctime cross-check (ADR-0085). That is deliberate and unchanged:
 * this command is handed one arbitrary snapshot file to consult, not a set's own
 * baseline, and "when did the run that wrote this finish?" says nothing about
 * whether the answer applies to the file in front of it.
 * @param {string} [path] - The file to inspect
 * @param {object} [options]
 * @param {string} [options.lookup] - Path to a snapshot file whose stored hash is reused if the file is unchanged
 * @returns {Promise<Props>} File properties
 */
export async function prop(path, options = {}) {
  requireArg(path, "file");

  /** @type {HashSource[] | undefined} */
  let lookups;
  if (options.lookup) {
    console.warn("Reading snapshot file:", options.lookup);
    const { entries } = await readSnapshotFile(options.lookup);
    lookups = [{ entries }];
  }

  return fileProps(path, lookups);
}
