import { existsSync } from "node:fs";
import { attachSet } from "../lib/attach.mjs";
import { loadSet } from "../lib/env.mjs";
import { MissingArgError, ParseArgsError } from "../lib/error.mjs";
import {
  claimRemoteSet,
  freshInfo,
  holding,
  readSetConfig,
  writeClaim,
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
import { shellCommand } from "../lib/style.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * Make this machine the holder of a set, the one machine that backs it up
 * ([ADR-0108](../../docs/adr/0108-set-ownership.md)). It attaches the set if
 * it isn't here, refreshes its snapshots as `reattach` does, pulls `dirs.txt`
 * and `exclude.txt` from the bucket's `.s3cab/sets/<set>/` wherever this
 * machine has no file of its own, then claims the set: it rewrites the marker's
 * `OWNER` and `CLAIMED`, keeping `CREATED`, or creates the marker if the set
 * has none. The previous holder's next backup is refused.
 *
 * No prompt: it deletes nothing, the old holder can take the set back the same
 * way, and the output names the machine it took over from. On a set this
 * machine already holds it does nothing.
 *
 * @param {string} [name] - The set's name (required)
 * @param {string[]} [directories] - Rejected: a set's directories are edited in its `dirs.txt`
 * @param {object} [options]
 * @param {string} [options.bucket] - The bucket holding the set: required unless it is already attached
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function takeover(name, directories = [], options = {}) {
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
      "takeover takes no directories (edit the set's dirs.txt instead)",
    );
  }

  if (listSets().includes(name)) {
    const here = loadSet(name);
    const { held } = await holding(here.bucket, name, here.claimPath);
    if (held) {
      console.warn(
        `This machine already holds '${name}' (bucket '${here.bucket}'). Nothing to do.`,
      );
      return here;
    }
  }

  console.warn(`Taking over '${name}'…`);
  const { set, info } = await attachSet(name, options.bucket);

  // A file this machine already has is its own say on what to back up.
  const needDirs = !existsSync(set.dirsPath);
  const needExclude = readSetExclude(name) === undefined;
  let pulledDirs = false;
  if (needDirs || needExclude) {
    const { dirs, exclude } = await readSetConfig(set.bucket, name);
    if (needDirs && dirs.length > 0) {
      writeSet(name, { dirs });
      pulledDirs = true;
    }
    if (needExclude && exclude !== undefined) {
      writeSetExclude(name, exclude);
    }
  }

  // `||`, not `??`: a `.info` with no `CREATED` line reads as an empty one.
  const claim = freshInfo(info?.created || undefined);
  if (info) {
    await writeRemoteInfo(set.bucket, name, claim);
  } else {
    const won = await claimRemoteSet(set.bucket, name, claim);
    if (!won) {
      throw new Error(
        `Another machine claimed '${name}' while this one was taking it over.\n\n` +
          `To take it over from them:\n` +
          `  ${shellCommand(`s3cab takeover ${name}`)}`,
      );
    }
  }
  writeClaim(set.claimPath, claim);

  console.warn(
    info?.owner
      ? `Took over '${name}' from ${info.owner}, whose backups of it will now be refused.`
      : `Claimed '${name}', which had no holder.`,
  );
  const taken = readSet(name);
  if (taken.dirs.length === 0) {
    console.warn(
      `'${name}' has no member directories on this machine, so it can't be ` +
        `backed up yet. Add them, one absolute path per line, to:\n` +
        `  ${taken.dirsPath}`,
    );
  } else if (pulledDirs) {
    // The paths are the previous holder's, and may not exist here (another
    // drive layout or OS). Not checked now: a backup validates them and fails
    // loudly on a missing one (ADR-0054).
    console.warn(
      `The directory list came from ${info?.owner || "the previous holder"}. ` +
        `If this machine's layout differs, edit it before backing up:\n` +
        `  ${taken.dirsPath}`,
    );
  }
  return taken;
}
