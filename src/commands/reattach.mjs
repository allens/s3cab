import { hostname } from "node:os";
import { MissingArgError, ParseArgsError } from "../lib/error.mjs";
import { plural } from "../lib/format.mjs";
import { downloadRemoteSnapshots } from "../lib/remote.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
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
 * Reattach this machine to a backup set that already lives in the cloud
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
 * Split out of `setup` by [ADR-0053](../../docs/adr/0053-reattach-command.md)
 * (was `setup --inherit`): `setup` now only *creates* a new set and `reattach`
 * adopts an existing one — near-opposite acts (the name must be *free* vs. must
 * *exist*) no longer multiplexed behind one flag. Reattach never disables the
 * prior machine (re-stamping `OWNER` is its only remote change), so two live
 * machines on one set stays possible — **discouraged-but-tolerated, never
 * locked out** ([ADR-0024](../../docs/adr/0024-set-name-is-the-whole-identity.md),
 * the OneDrive-synced-directory case).
 *
 * That makes this command the *only* place the "discouraged" is ever said: the
 * marker's prior `OWNER` and the freshly-pulled snapshot history are both in
 * hand here, so naming the other machine costs no extra request, where a
 * backup-time check would cost a marker GET on every run. It stays a warning —
 * the reasoning against a gate (or a prompt) is at the call site.
 *
 * @param {string} [name] - The existing set's name (required)
 * @param {string[]} [directories] - Rejected: reattach adopts the remote's dirs
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket holding the set (required)
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function reattach(name, directories = [], options = {}) {
  if (name === undefined) {
    // A distinct undefined-check (not requireArg) so an *empty* string still
    // routes to validateSetName below as invalid, not "missing".
    throw new MissingArgError("set");
  }
  validateSetName(name);
  if (options.bucket !== undefined) {
    validateBucketName(options.bucket);
  }
  if (directories.length) {
    throw new ParseArgsError(
      "reattach takes no directories (it adopts an existing remote set)",
    );
  }
  if (!options.bucket) {
    throw new ParseArgsError(
      `Reattaching needs the bucket holding the set:\n` +
        `  s3cab reattach ${name} --bucket <bucket>`,
    );
  }
  const bucket = options.bucket;
  if (listSets().includes(name)) {
    throw new Error(
      `Set '${name}' already exists on this machine. Delete it first to ` +
        `reattach it fresh from the bucket.`,
    );
  }

  // First S3 touch: the set doesn't exist here yet, so credentials come from the
  // ambient AWS chain (~/.aws / exported AWS_*) — there is no set env to carry
  // them (ADR-0055).
  const info = await readRemoteInfo(bucket, name);
  if (!info) {
    const available = await listRemoteSets(bucket);
    throw new Error(
      `No backup set '${name}' in bucket '${bucket}' to reattach to.\n` +
        (available.length
          ? `Sets in this bucket:\n  ${available.join("\n  ")}`
          : `This bucket holds no backup sets yet.`),
    );
  }

  // Captured before `writeRemoteInfo` below overwrites it — the marker is the
  // only record of who held the set, and this is the last moment it says so.
  const priorOwner = info.owner;

  const { dirs, exclude } = await readSetConfig(bucket, name);
  const set = writeSet(name, { dirs, bucket });
  // The remote config is reproduced exactly — including *no* exclude file for a
  // set that has none (`pushSetConfig` deletes the remote one when the local set
  // drops it). No starter file here: silently activating excludes would narrow
  // what an established set backs up.
  if (exclude !== undefined) {
    writeSetExclude(name, exclude);
  }

  // Pull the set's snapshot files down so this machine lands with full local
  // history — this is what lets `compare`/`list` stay local-only (ADR-0027).
  console.warn(`Reattaching to '${name}' in bucket '${bucket}'…`);
  const pulled = await downloadRemoteSnapshots(bucket, name, set.snapshotsDir);
  console.warn(
    pulled > 0
      ? `Pulled ${pulled} ${plural(pulled, "snapshot")} from the cloud — ` +
          `local history is ready (try: s3cab list ${name}).`
      : `No snapshots in the cloud for '${name}' yet — nothing to pull.`,
  );

  // A normal set always has member dirs (create requires ≥1 directory), so an
  // empty `dirs` here means a damaged remote marker — `dirs.txt` hand-edited in
  // the console, or a claim whose config push never finished. Not fatal — restore
  // reads paths from the snapshot, not dirs.txt, so the set can still recover
  // files — but warn, since it can't snapshot/back up until directories are added.
  if (dirs.length === 0) {
    console.warn(
      `Reattached to '${name}' with no member directories from the remote config. ` +
        `It can restore, but can't snapshot or back up until you add directories ` +
        `(one absolute path per line) to:\n` +
        `  ${set.dirsPath}`,
    );
  } else {
    // The directory list came verbatim from the machine that claimed the set, so
    // its paths may not exist here (a different drive layout or OS). We don't
    // check them now (#5 — no speculative machinery); a backup validates them and
    // fails loudly if any are missing (ADR-0054). This is the proactive nudge —
    // and it names that machine, which the marker has been carrying all along.
    // Falls back to the old unnamed wording rather than printing '': a
    // hand-edited or half-written marker reports OWNER as an empty string.
    const from = priorOwner
      ? `'${priorOwner}'`
      : `the machine that claimed '${name}'`;
    console.warn(
      `The directory list came from ${from}. ` +
        `If this machine's layout differs, edit it before backing up:\n` +
        `  ${set.dirsPath}`,
    );
  }

  // The one place s3cab can voice the *discouraged* half of
  // "discouraged-but-tolerated" (ADR-0024): a human is here, has stated an
  // intent, and both facts are already in memory — no extra request. Advisory
  // only, never a gate: from the bucket a retired machine and a dormant one look
  // identical (recency is the only signal, and a weekly backup looks dead on day
  // three), and succession is the *dominant* reattach case — gating it to police
  // co-existence would have the common path pay for the rare one.
  if (priorOwner && priorOwner !== hostname()) {
    const latest = listSnapshotNames(set.snapshotsDir).at(0);
    console.warn(
      `Reattaching doesn't stop '${priorOwner}' backing up '${name}'` +
        (latest ? ` (last backed up ${latest})` : "") +
        `. If both computers keep backing up this set, their snapshots ` +
        `interleave and can collide on a name — s3cab allows it, but it is ` +
        `meant for succession. Nothing to do if you're replacing that computer.`,
    );
  }

  // Re-stamp ownership to this machine; preserve the original CREATED.
  await writeRemoteInfo(bucket, name, {
    owner: hostname(),
    created: info.created,
  });
  return set;
}
