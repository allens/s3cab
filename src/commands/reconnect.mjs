import { hostname } from "node:os";
import { ParseArgsError } from "../lib/error.mjs";
import { downloadRemoteSnapshots } from "../lib/remote.mjs";
import {
  listRemoteSets,
  readRemoteInfo,
  readSetConfig,
  writeRemoteInfo,
} from "../lib/set-marker.mjs";
import {
  listSets,
  validateBucketName,
  validateSetName,
  writeSet,
  writeSetExclude,
} from "../lib/sets.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * Reconnect this machine to a backup set that already lives in the cloud
 * (docs/design/backup.md, ADR-0053) — the succession path for a replacement or
 * recovery machine, or a second machine joining a set. Pulls the set's published
 * config (`dirs.txt`/`exclude.txt`) *and* its snapshot history down, recreates
 * the set locally, and re-stamps `OWNER` to this machine while preserving the
 * original `CREATED`.
 *
 * It does **not** download the backed-up file *contents* — those stay in
 * `objects/<sha256>` until `restore`; only the config and the snapshot manifests
 * come down, which is what lets `list`/`compare` run offline afterwards
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 * Takes no directories — they come from the remote.
 *
 * Split out of `setup` by [ADR-0053](../../docs/adr/0053-reconnect-command.md)
 * (was `setup --inherit`): `setup` now only *creates* a new set and `reconnect`
 * adopts an existing one — near-opposite acts (the name must be *free* vs. must
 * *exist*) no longer multiplexed behind one flag. Reconnect never disables the
 * prior machine (re-stamping `OWNER` is its only remote change), so two live
 * machines on one set stays possible (the tolerated power-user case).
 *
 * @param {string} [name] - The existing set's name (required)
 * @param {string[]} [directories] - Rejected: reconnect adopts the remote's dirs
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket holding the set (required)
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function reconnect(name, directories = [], options = {}) {
  if (name === undefined) {
    // A distinct undefined-check (not requireArg) so an *empty* string still
    // routes to validateSetName below as invalid, not "missing".
    throw new ParseArgsError("Missing required argument: <set>", {
      argName: "set",
    });
  }
  validateSetName(name);
  if (options.bucket !== undefined) {
    validateBucketName(options.bucket);
  }
  if (directories.length) {
    throw new ParseArgsError(
      "reconnect takes no directories (it adopts an existing remote set)",
    );
  }
  if (!options.bucket) {
    throw new ParseArgsError(
      `Reconnecting needs the bucket holding the set:\n` +
        `  s3cab reconnect ${name} --bucket <bucket>`,
    );
  }
  const bucket = options.bucket;
  if (listSets().includes(name)) {
    throw new Error(
      `Set '${name}' already exists on this machine. Delete it first to ` +
        `reconnect it fresh from the bucket.`,
    );
  }

  // First S3 touch: the set env doesn't exist yet, so the user env loaded at the
  // entry point supplies the credentials.
  const info = await readRemoteInfo(bucket, name);
  if (!info) {
    const available = await listRemoteSets(bucket);
    throw new Error(
      `No backup set '${name}' in bucket '${bucket}' to reconnect to.\n` +
        (available.length
          ? `Sets in this bucket:\n  ${available.join("\n  ")}`
          : `This bucket holds no backup sets yet.`),
    );
  }

  const { dirs, exclude } = await readSetConfig(bucket, name);
  const set = writeSet(name, { dirs, bucket });
  // The remote config is reproduced exactly — including *no* exclude file for a
  // legacy set that never had one. No starter file here: silently activating
  // excludes would narrow what an established set backs up.
  if (exclude !== undefined) {
    writeSetExclude(name, exclude);
  }

  // Pull the set's snapshot files down so this machine lands with full local
  // history — this is what lets `compare`/`list` stay local-only (ADR-0027).
  console.warn(`Reconnecting to '${name}' in bucket '${bucket}'…`);
  const pulled = await downloadRemoteSnapshots(bucket, name, set.snapshotsDir);
  console.warn(
    pulled > 0
      ? `Pulled ${pulled} snapshot${pulled === 1 ? "" : "s"} from the cloud — ` +
          `local history is ready (try: s3cab list ${name}).`
      : `No snapshots in the cloud for '${name}' yet — nothing to pull.`,
  );

  // A normal set always has member dirs (create requires ≥1 directory), so an
  // empty `dirs` here means a partial/legacy remote marker. Not fatal — restore
  // reads paths from the snapshot, not dirs.txt, so the set can still recover
  // files — but warn, since it can't snapshot/back up until directories are added.
  if (dirs.length === 0) {
    console.warn(
      `Reconnected to '${name}' with no member directories from the remote config. ` +
        `It can restore, but can't snapshot or back up until you add directories ` +
        `(one absolute path per line) to:\n` +
        `  ${set.dirsPath}`,
    );
  }

  // Re-stamp ownership to this machine; preserve the original CREATED.
  await writeRemoteInfo(bucket, name, {
    owner: hostname(),
    created: info.created,
  });
  return set;
}
