import { loadSet } from "./env.mjs";
import { ParseArgsError } from "./error.mjs";
import { downloadRemoteSnapshots, listRemoteSnapshots } from "./remote.mjs";
import { holding, listRemoteSets, readRemoteInfo } from "./set-marker.mjs";
import { listSets, writeSet } from "./sets.mjs";

/** @import { BackupSet } from "./sets.mjs" */
/** @import { SetInfo } from "./set-marker.mjs" */

/**
 * Attach a set from its bucket, or refresh the one already attached: the step
 * `reattach` and `takeover` share (ADR-0108). It pulls the snapshots this
 * machine lacks and nothing else: no config comes down and no marker is
 * written, and a set with neither a marker nor s3cab's config attaches all the
 * same, so s3cab can restore a set another client wrote.
 * @param {string} name - The set's name
 * @param {string} [bucket] - The bucket holding it: required to attach, and
 *   when given to a refresh, must be the bucket the set is attached from
 * @returns {Promise<{ set: BackupSet, info: SetInfo | undefined, held: boolean, pulled: number }>}
 *   `info` is the bucket's marker, `held` whether this machine holds the set,
 *   `pulled` how many snapshots came down
 */
export async function attachSet(name, bucket) {
  /** @type {BackupSet} */
  let set;
  /** @type {SetInfo | undefined} */
  let info;
  let held = false;
  if (listSets().includes(name)) {
    set = loadSet(name);
    if (bucket !== undefined && bucket !== set.bucket) {
      throw new Error(
        `Set '${name}' on this machine is attached from bucket '${set.bucket}', ` +
          `not '${bucket}'. Leave out --bucket to refresh it.`,
      );
    }
    ({ info, held } = await holding(set.bucket, name, set.claimPath));
  } else {
    if (!bucket) {
      throw new ParseArgsError(
        `Set '${name}' isn't on this machine yet: name the bucket holding it ` +
          `with --bucket <bucket>.`,
      );
    }
    // First S3 touch: the set isn't here yet, so credentials come from the
    // ambient AWS chain — there is no set env to carry them (ADR-0055).
    info = await readRemoteInfo(bucket, name);
    if (!info) {
      const snapshots = await listRemoteSnapshots(bucket, name);
      if (snapshots.length === 0) {
        throw await noSuchSetError(name, bucket);
      }
    }
    set = writeSet(name, { bucket });
  }
  const pulled = await downloadRemoteSnapshots(
    set.bucket,
    name,
    set.snapshotsDir,
  );
  return { set, info, held, pulled };
}

/**
 * A bucket with no such set, listing the ones it has: a fresh machine's user
 * won't recall exact names.
 * @param {string} name
 * @param {string} bucket
 * @returns {Promise<Error>}
 */
async function noSuchSetError(name, bucket) {
  const available = await listRemoteSets(bucket);
  return new Error(
    `No backup set '${name}' in bucket '${bucket}'.\n` +
      (available.length
        ? `Sets in this bucket:\n  ${available.join("\n  ")}`
        : `This bucket holds no backup sets yet.`),
  );
}
