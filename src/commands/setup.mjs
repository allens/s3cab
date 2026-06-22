import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { loadEnv } from "../lib/env.mjs";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
import { downloadRemoteSnapshots } from "../lib/remote.mjs";
import {
  claimRemoteSet,
  listRemoteSets,
  pushSetConfig,
  readRemoteInfo,
  readSetConfig,
  writeRemoteInfo,
} from "../lib/set-marker.mjs";
import {
  listSets,
  readSet,
  readSetExclude,
  validateBucketName,
  validateSetName,
  writeSet,
  writeSetExclude,
} from "../lib/sets.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * Create, update, or inherit a backup set (docs/specs/backup.md). A set's name is
 * its whole identity (ADR-0024) — local handle, local folder, and remote
 * namespace — so there is nothing to pin; the three modes are:
 *
 * - **Create** (`setup <name> <folder>... --bucket <b>`): claim the name in the
 *   bucket ("first person wins") by atomically writing the remote `info` marker,
 *   then write the local set and publish its config (`dirs.txt`/`exclude.txt`) to
 *   `sets/<name>/`. A name already claimed by another machine is refused with the
 *   owner and an `--inherit` suggestion. `--bucket` is required (ADR-0026).
 * - **Inherit** (`setup <name> --inherit --bucket <b>`): the succession path for a
 *   replacement/recovery machine — pull an existing remote set's config, recreate
 *   it locally, and re-stamp ownership to this machine. Takes no folders.
 * - **Update** (`setup <name> [<folder>...]` on a set you already have): refresh
 *   the member folders and re-publish the config; the bucket is fixed at creation.
 *
 * So `setup` always touches S3 (the claim/publish/inherit), which is why it is
 * async; `snapshot`/`compare`/`tree` stay offline once a set exists.
 *
 * @param {string} [name] - The set's name
 * @param {string[]} [folders] - The member folders (required when creating)
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket to back the set up to (required on create)
 * @param {boolean} [options.inherit] - Inherit an existing remote set onto this machine
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function setup(name, folders = [], options = {}) {
  requireArg(name, "<set>");
  validateSetName(name);
  // Validate when --bucket is *given at all* (even ""), so an explicit empty
  // value fails fast rather than being treated as "not given".
  if (options.bucket !== undefined) validateBucketName(options.bucket);

  const creating = !listSets().includes(name);

  if (options.inherit) return inherit(name, folders, creating, options);
  if (creating) return create(name, folders, options);
  return update(name, folders, options);
}

/**
 * Resolve member folders to canonical absolute paths (what `dirs.txt` stores),
 * verifying each exists and is a directory. Pure-local and cheap, so `setup` runs
 * it *before* any S3 touch — a bad folder fails fast without claiming a name.
 * @param {string[]} folders
 * @returns {string[]}
 */
function resolveFolders(folders) {
  return folders.map((folder) => {
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
}

/** A minute-precision ISO 8601 stamp for the `info` marker's `CREATED` field. */
const nowStamp = () =>
  Temporal.Now.plainDateTimeISO().toString({ smallestUnit: "minutes" });

/**
 * The collision error a losing claim raises: name the owner and point at
 * `--inherit` as the way to take over.
 * @param {string} name
 * @param {string} bucket
 * @param {import("../lib/set-marker.mjs").SetInfo} [info]
 */
const collisionError = (name, bucket, info) => {
  // Only the fields actually present — a corrupted/partial marker (empty OWNER
  // or CREATED) must not print "(owner: , created )".
  const parts = [];
  if (info?.owner) parts.push(`owner: ${info.owner}`);
  if (info?.created) parts.push(`created ${info.created}`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return new Error(
    `Backup set '${name}' is already set up in bucket '${bucket}'${detail}.\n` +
      `To take it over on this machine:\n` +
      `  s3cab setup ${name} --inherit --bucket ${bucket}`,
  );
};

/**
 * Create a new set: claim the name in the bucket, then write it locally and
 * publish its config. Folders and `--bucket` are both required here.
 * @param {string} name
 * @param {string[]} folders
 * @param {{ bucket?: string }} options
 * @returns {Promise<BackupSet>}
 */
async function create(name, folders, options) {
  if (folders.length === 0) {
    throw new ParseArgsError(
      "Missing required argument: <folder> (a new set needs at least one folder)",
    );
  }
  // Resolve folders (local, cheap) before the --bucket check so a bad folder
  // reports "Folder not found" regardless of whether a bucket was given.
  const dirs = resolveFolders(folders);
  if (!options.bucket) {
    // A missing required argument (like requireArg / the missing-folder check),
    // so ParseArgsError — the CLI prints usage.
    throw new ParseArgsError(
      "Missing required argument: --bucket (a backup set is bound to a bucket at creation)",
    );
  }
  const bucket = options.bucket;

  // Claim the name before writing anything locally ("first person wins"). The
  // set env doesn't exist yet, so loadEnv() (user layer) supplies the S3 client's
  // credentials/region.
  loadEnv();
  const won = await claimRemoteSet(bucket, name, {
    owner: hostname(),
    created: nowStamp(),
  });
  if (!won) {
    const info = await readRemoteInfo(bucket, name);
    throw collisionError(name, bucket, info);
  }

  const set = writeSet(name, { dirs, bucket });
  await pushSetConfig(bucket, name, { dirs, exclude: readSetExclude(name) });
  return set;
}

/**
 * Update a set you already own: refresh its folders (if any are given) and
 * re-publish its config to the remote marker. The bucket is fixed at creation —
 * a different `--bucket` is rejected (bucket migration isn't supported yet).
 * @param {string} name
 * @param {string[]} folders
 * @param {{ bucket?: string }} options
 * @returns {Promise<BackupSet>}
 */
async function update(name, folders, options) {
  // `readSet` guarantees a bucket (ADR-0026), so `existing.bucket` is always
  // bound — a corrupt, bucket-less folder is rejected there, not here.
  const existing = readSet(name);
  if (options.bucket && options.bucket !== existing.bucket) {
    throw new Error(
      `Set '${name}' is bound to bucket '${existing.bucket}'. Re-binding to a ` +
        `different bucket (migration) isn't supported yet.`,
    );
  }
  const bucket = existing.bucket;

  const dirs = folders.length ? resolveFolders(folders) : existing.dirs;
  const set = folders.length ? writeSet(name, { dirs }) : existing;

  loadEnv(set);
  await pushSetConfig(bucket, name, { dirs, exclude: readSetExclude(name) });
  return set;
}

/**
 * Inherit an existing remote set onto this machine (`setup --inherit`): the
 * succession path for retiring/replacing a machine or recovering on a fresh one.
 * Pulls the remote set's published config, recreates it locally, and re-stamps
 * `OWNER` to this machine while preserving the original `CREATED`. Takes no
 * folders — they come from the remote. Inherit never disables the prior machine
 * (re-stamping `OWNER` is the only remote change), so two live machines on one
 * set stays possible (the tolerated power-user case).
 * @param {string} name
 * @param {string[]} folders
 * @param {boolean} creating - Whether the set is new locally
 * @param {{ bucket?: string }} options
 * @returns {Promise<BackupSet>}
 */
async function inherit(name, folders, creating, options) {
  if (folders.length) {
    throw new ParseArgsError(
      "setup --inherit takes no folders (it adopts an existing remote set)",
    );
  }
  if (!options.bucket) {
    throw new ParseArgsError(
      `Inheriting needs the bucket holding the set:\n` +
        `  s3cab setup ${name} --inherit --bucket <bucket>`,
    );
  }
  const bucket = options.bucket;
  if (!creating) {
    throw new Error(
      `Set '${name}' already exists locally. Delete it first to re-inherit it ` +
        `from the bucket.`,
    );
  }

  // First S3 touch: user env for credentials (the set env doesn't exist yet).
  loadEnv();
  const info = await readRemoteInfo(bucket, name);
  if (!info) {
    const available = await listRemoteSets(bucket);
    throw new Error(
      `No backup set '${name}' in bucket '${bucket}' to inherit.\n` +
        (available.length
          ? `Sets in this bucket:\n  ${available.join("\n  ")}`
          : `This bucket holds no backup sets yet.`),
    );
  }

  const { dirs, exclude } = await readSetConfig(bucket, name);
  const set = writeSet(name, { dirs, bucket });
  if (exclude !== undefined) writeSetExclude(name, exclude);

  // Pull the set's snapshot manifests down so the new machine lands with full
  // local history — this is what lets `compare`/`list` stay local-only (ADR-0027).
  console.warn(`Inheriting '${name}' from bucket '${bucket}'…`);
  const pulled = await downloadRemoteSnapshots(bucket, name, set.snapshotsDir);
  console.warn(
    pulled > 0
      ? `Pulled ${pulled} snapshot${pulled === 1 ? "" : "s"} from the cloud — ` +
          `local history is ready (try: s3cab list ${name}).`
      : `No snapshots in the cloud for '${name}' yet — nothing to pull.`,
  );

  // A normal set always has member dirs (create requires ≥1 folder), so an empty
  // `dirs` here means a partial/legacy remote marker. Not fatal — restore reads
  // paths from the snapshot, not dirs.txt, so the set can still recover files —
  // but warn, since it can't snapshot/backup until folders are added.
  if (dirs.length === 0) {
    console.warn(
      `Inherited '${name}' with no member directories from the remote config. ` +
        `It can restore, but can't snapshot or back up until you add folders:\n` +
        `  s3cab setup ${name} <folder>...`,
    );
  }

  // Re-stamp ownership to this machine; preserve the original CREATED.
  await writeRemoteInfo(bucket, name, {
    owner: hostname(),
    created: info.created,
  });
  return set;
}
