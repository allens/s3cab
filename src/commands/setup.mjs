import { realpathSync, statSync } from "node:fs";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
import {
  listSets,
  validateBucketName,
  validateSetName,
  writeSet,
} from "../lib/sets.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * Create or update a backup set (docs/specs/backup.md): `~/.s3cab/sets/<set>/` with
 * its member folders in `dirs.txt` and the bucket bound when given. A set's name
 * is its whole identity (ADR-0024), so there is nothing to pin — creating and
 * updating run the same path; folders are *required* only when creating (e.g.
 * `setup photos --bucket b` later just binds the bucket).
 *
 * A bucket-less set is a fully working local snapshot engine on purpose — the
 * try-it-first path; `backup` on such a set will point here to bind one. (This
 * survives only until ADR-0026 makes `--bucket` mandatory at setup.)
 *
 * `setup` is **async** even though the create/update path below is synchronous:
 * the succession flow (`--inherit`, ADR-0024) and the setup-time collision check
 * (ADR-0024/0026) both touch S3 once implemented, so the command returns a
 * promise now to keep its signature stable across those slices. (The old
 * `--from` adoption that made it genuinely async was removed with the namespace
 * model; `--inherit` replaces it.)
 *
 * @param {string} [name] - The set's name
 * @param {string[]} [folders] - The member folders (required when creating)
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket to back the set up to
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function setup(name, folders = [], options = {}) {
  requireArg(name, "<set>");
  validateSetName(name);
  // Validate when --bucket is *given at all* (even ""), so an explicit empty
  // value fails fast rather than silently leaving the set bucket-less.
  if (options.bucket !== undefined) validateBucketName(options.bucket);

  const creating = !listSets().includes(name);

  if (creating && folders.length === 0) {
    throw new ParseArgsError(
      "Missing required argument: <folder> (a new set needs at least one folder)",
    );
  }

  // Pin member folders as canonical absolute paths (dirs.txt stores absolute
  // paths), verifying each exists and is a folder while we're at it.
  const dirs = folders.map((folder) => {
    let real;
    try {
      real = realpathSync.native(folder);
    } catch (error) {
      if (isENOENT(error)) {
        throw new Error(`Folder not found: ${folder}`, { cause: error });
      }
      throw error;
    }
    if (!statSync(real).isDirectory()) {
      throw new Error(`Not a folder: ${folder}`);
    }
    return real;
  });

  return writeSet(name, { dirs, bucket: options.bucket });
}
