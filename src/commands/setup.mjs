import { realpathSync, statSync } from "node:fs";
import { loadEnv } from "../lib/env.mjs";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
import { listRemoteNamespaces, listRemoteSnapshots } from "../lib/remote.mjs";
import {
  listSets,
  validateBucketName,
  validateNamespace,
  validateSetName,
  writeSet,
} from "../lib/sets.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

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
 * Adoption (`--from <namespace>`) is the fresh-machine recovery path: instead of
 * deriving a new identity, it pins an *existing* remote `user@machine/set`
 * namespace and binds the bucket, so `restore` can pull a backup made elsewhere.
 * It verifies the namespace really has a backup first (so a typo fails loudly,
 * listing what is in the bucket) — the one path here that touches S3, which is
 * why `setup` is async (a single return type, like its sibling commands).
 *
 * @param {string} [name] - The set's name
 * @param {string[]} [folders] - The member folders (required when creating)
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket to back the set up to
 * @param {string} [options.from] - Adopt this remote `user@machine/set` namespace
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function setup(name, folders = [], options = {}) {
  requireArg(name, "<set>");
  validateSetName(name);
  // Validate when --bucket is *given at all* (even ""), so an explicit empty
  // value fails fast rather than silently leaving the set bucket-less.
  if (options.bucket !== undefined) validateBucketName(options.bucket);

  const creating = !listSets().includes(name);

  if (options.from !== undefined) {
    return adopt(name, folders, creating, options);
  }

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

/**
 * Adopt an existing remote backup into a new local set (`setup --from`): pin the
 * given remote namespace and bind the bucket, so `restore` can recover a backup
 * made on another machine (specs/backup.md). `dirs.txt` is left empty — restore
 * reads file paths from the snapshot, and re-snapshotting from here (which needs
 * member dirs) is a separate concern — so adoption takes no folders.
 * @param {string} name - The (new) local set name
 * @param {string[]} folders - Positional folders (must be empty for adoption)
 * @param {boolean} creating - Whether the set is new
 * @param {{ from?: string, bucket?: string }} options
 * @returns {Promise<BackupSet>}
 */
async function adopt(name, folders, creating, options) {
  const namespace = options.from ?? "";
  validateNamespace(namespace);
  if (folders.length) {
    throw new ParseArgsError(
      "setup --from takes no folders (it adopts an existing remote backup)",
    );
  }
  if (!creating) {
    throw new Error(
      `Set '${name}' already exists. Adopt into a new set name — a set's ` +
        `namespace is pinned at creation and cannot be changed.`,
    );
  }
  if (!options.bucket) {
    // A missing required argument (like requireArg / the missing-folder check),
    // so ParseArgsError — the CLI prints usage. Value-validation and state
    // errors below/above stay plain Error (matching validateBucketName et al.).
    throw new ParseArgsError(
      `Adoption needs the bucket holding the backup:\n` +
        `  s3cab setup ${name} --from ${namespace} --bucket <bucket>`,
    );
  }
  const bucket = options.bucket;

  // First (and only) S3 touch in setup: load the bucket's auth layer, then
  // confirm the namespace really has a backup before writing anything locally —
  // a typo'd identity fails loudly, listing what the bucket actually holds.
  loadEnv({ bucket });
  const snapshots = await listRemoteSnapshots(bucket, namespace);
  if (snapshots.length === 0) {
    const available = await listRemoteNamespaces(bucket);
    throw new Error(
      `No backups found for '${namespace}' in bucket '${bucket}'.\n` +
        (available.length
          ? `Backups exist under these namespaces — adopt one with --from:\n  ${available.join("\n  ")}`
          : `This bucket holds no backups under snapshots/ yet.`),
    );
  }

  return writeSet(name, { bucket, namespace });
}
