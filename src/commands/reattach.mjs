import { attachSet } from "../lib/attach.mjs";
import { MissingArgError, ParseArgsError } from "../lib/error.mjs";
import { validateBucketName, validateSetName } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
import { shellCommand } from "../lib/style.mjs";

/**
 * What `reattach` leaves on this machine.
 * @typedef {Object} ReattachResult
 * @property {string} set - The set's name
 * @property {string} bucket - The bucket it is attached from
 * @property {number} snapshots - How many of its snapshots this machine now has
 * @property {number} pulled - How many of those this run pulled
 * @property {string} [holder] - Who holds it, from the bucket's marker; absent when it has none
 * @property {boolean} held - Whether this machine is the holder
 */

/**
 * Attach a set that already lives in a bucket to this machine, read-only, or
 * refresh one already attached ([ADR-0108](../../docs/adr/0108-set-ownership.md)):
 * pull the snapshot files this machine lacks, which is what lets `list`,
 * `compare`, `find` and `restore` run offline afterwards
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 * The backed-up file *contents* stay in `objects/` until `restore`.
 *
 * Nothing else changes: no config comes down, since `dirs.txt` and `exclude.txt`
 * describe the holder's disk, and the bucket's marker isn't written, so looking
 * at a set never takes it from its holder. Backing a set up from this machine
 * is `takeover`. A set another client wrote, with neither a marker nor s3cab's
 * config, attaches all the same.
 *
 * Refreshing is the same command on a set already here, which is why it
 * doesn't refuse one: the only other refresh would be delete and reattach,
 * which on the holder's machine would give the set up.
 *
 * @param {string} [name] - The set's name (required)
 * @param {string[]} [directories] - Rejected: the set's directories are its holder's
 * @param {object} [options]
 * @param {string} [options.bucket] - The bucket holding the set: required to attach, optional to refresh
 * @returns {Promise<ReattachResult>}
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
      "reattach takes no directories (it attaches an existing set)",
    );
  }

  console.warn(`Reattaching '${name}'…`);
  const { set, info, held, pulled } = await attachSet(name, options.bucket);
  if (!held) {
    console.warn(
      `To back '${name}' up from this machine instead` +
        (info?.owner ? ` of ${info.owner}` : "") +
        `:\n  ${shellCommand(`s3cab takeover ${name}`)}`,
    );
  }
  return {
    set: name,
    bucket: set.bucket,
    snapshots: listSnapshotNames(set.snapshotsDir).length,
    pulled,
    holder: info?.owner || undefined,
    held,
  };
}
