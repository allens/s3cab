import { realpathSync, statSync } from "node:fs";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
import {
  listSets,
  validateBucketName,
  validateSetName,
  writeSet,
} from "../lib/sets.mjs";

/**
 * Create or update a backup set (specs/backup.md): `~/.s3cab/sets/<set>/` with
 * its member folders in `dirs.txt`, the identity namespace pinned into its
 * `env` at creation, and the bucket bound when given. Re-running updates
 * whatever pieces are passed — folders are therefore only *required* when
 * creating (e.g. `setup photos --bucket b` later just binds the bucket).
 *
 * A bucket-less set is a fully working local snapshot engine on purpose — the
 * try-it-first path; `backup` on such a set will point here to bind one.
 *
 * @param {string} [name] - The set's name
 * @param {string[]} [folders] - The member folders (required when creating)
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket to back the set up to
 * @returns {import("../lib/sets.mjs").BackupSet} The set as stored
 */
export function setup(name, folders = [], options = {}) {
  requireArg(name, "<set>");
  validateSetName(name);
  if (options.bucket) validateBucketName(options.bucket);

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
