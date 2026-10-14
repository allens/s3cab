import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { isENOENT } from "./error.mjs";
import { localMoment } from "./format.mjs";
import { parseLines } from "./read-lines.mjs";
import { deleteObject, getText, listObjects, putText } from "./s3.mjs";
import { shellCommand } from "./style.mjs";
import { userAtMachine } from "./user-at-machine.mjs";

// Who holds a set, and s3cab's copy of its config (ADR-0108):
//
//   snapshots/<set>.info            the format's ownership marker: OWNER, CLAIMED, CREATED
//   .s3cab/sets/<set>/dirs.txt      s3cab's copy of the member directories, in its own
//   .s3cab/sets/<set>/exclude.txt   client folder (ADR-0107); exclude.txt only if the set has one
//   ~/.s3cab/sets/<set>/claim       the text this machine wrote to `.info`: present = it holds the set
//
// The set's `env` is never uploaded: it may hold credentials, and the secret boundary is
// the push list in `pushSetConfig`, not where the files sit.

/**
 * The S3 key of a set's ownership marker, `snapshots/<set>.info`.
 * @param {string} set
 * @returns {string}
 */
export const remoteInfoKey = (set) => `snapshots/${set}.info`;

/**
 * The S3 key prefix of s3cab's copy of a set's config, `.s3cab/sets/<set>/`.
 * @param {string} set
 * @returns {string}
 */
export const remoteConfigPrefix = (set) => `.s3cab/sets/${set}/`;

/**
 * @param {string} bucket
 * @param {string} set
 */
const infoUri = (bucket, set) => `s3://${bucket}/${remoteInfoKey(set)}`;

/**
 * @param {string} bucket
 * @param {string} set
 * @param {string} file
 */
const configUri = (bucket, set, file) =>
  `s3://${bucket}/${remoteConfigPrefix(set)}${file}`;

/**
 * A set's ownership marker. `owner` and `claimed` together are the pair a
 * holder keeps and checks; `created` never changes.
 * @typedef {Object} SetInfo
 * @property {string} owner - The holder, as `user@machine`
 * @property {string} claimed - When the holder claimed the set or took it over: a UTC instant
 * @property {string} created - When the set was first claimed: a UTC instant
 */

/**
 * A marker for this machine, claimed now.
 * @param {string} [created] - The set's `CREATED`, kept on a takeover; a new set's is now
 * @returns {SetInfo}
 */
export function freshInfo(created) {
  const claimed = localMoment("seconds").instant;
  return { owner: userAtMachine(), claimed, created: created ?? claimed };
}

/**
 * @param {SetInfo} info
 * @returns {string}
 */
const formatInfo = ({ owner, claimed, created }) =>
  `OWNER=${owner}\nCLAIMED=${claimed}\nCREATED=${created}\n`;

/**
 * Read `.info` text by the spec's rule (guide/format.md): split on LF, strip one
 * trailing CR, split each line at its first `=`, skip unknown keys. Not
 * `parseEnv`: `#` starts a comment there, which would cut short a user name
 * holding one.
 * @param {string} text
 * @returns {SetInfo}
 */
export function parseInfo(text) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const cut = line.indexOf("=");
    if (cut !== -1) {
      fields[line.slice(0, cut)] = line.slice(cut + 1);
    }
  }
  return {
    owner: fields.OWNER ?? "",
    claimed: fields.CLAIMED ?? "",
    created: fields.CREATED ?? "",
  };
}

/**
 * Claim a set by creating its marker with a conditional PUT: `true` if this
 * machine created it, `false` if a marker was already there.
 * @param {string} bucket
 * @param {string} set
 * @param {SetInfo} info
 * @returns {Promise<boolean>}
 */
export function claimRemoteSet(bucket, set, info) {
  return putText(infoUri(bucket, set), formatInfo(info), { noClobber: true });
}

/**
 * Read a set's marker, or `undefined` if it has none.
 * @param {string} bucket
 * @param {string} set
 * @returns {Promise<SetInfo | undefined>}
 */
export async function readRemoteInfo(bucket, set) {
  const text = await getText(infoUri(bucket, set));
  return text === undefined ? undefined : parseInfo(text);
}

/**
 * Overwrite a set's marker: a takeover of a set that already has one.
 * @param {string} bucket
 * @param {string} set
 * @param {SetInfo} info
 * @returns {Promise<void>}
 */
export async function writeRemoteInfo(bucket, set, info) {
  await putText(infoUri(bucket, set), formatInfo(info));
}

/**
 * The pair this machine stored when it claimed the set, or `undefined` when it
 * doesn't hold it.
 * @param {string} claimPath - The set's `claim` file
 * @returns {SetInfo | undefined}
 */
export function readClaim(claimPath) {
  try {
    return parseInfo(readFileSync(claimPath, "utf8"));
  } catch (error) {
    if (isENOENT(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Store the marker this machine just wrote, making it the set's holder here.
 * @param {string} claimPath - The set's `claim` file
 * @param {SetInfo} info
 */
export function writeClaim(claimPath, info) {
  writeFileSync(claimPath, formatInfo(info));
}

/**
 * Whether this machine holds the set: it has a stored pair, and the bucket's
 * marker carries the same `OWNER` and `CLAIMED`, compared as text and never
 * recomputed (ADR-0108).
 * @param {string} bucket
 * @param {string} set
 * @param {string} claimPath - The set's `claim` file
 * @returns {Promise<{ held: boolean, mine: SetInfo | undefined, info: SetInfo | undefined }>}
 *   `mine` is the stored pair, `info` the bucket's marker
 */
export async function holding(bucket, set, claimPath) {
  const mine = readClaim(claimPath);
  const info = await readRemoteInfo(bucket, set);
  const held = Boolean(
    mine && info?.owner === mine.owner && info.claimed === mine.claimed,
  );
  return { held, mine, info };
}

/**
 * Refuse unless this machine holds the set (`holding`). A pair that no longer
 * matches can never match again, so it is deleted, leaving the set read-only
 * here.
 * @param {string} bucket
 * @param {string} set
 * @param {string} claimPath - The set's `claim` file
 * @returns {Promise<void>}
 */
export async function assertHeld(bucket, set, claimPath) {
  const { held, mine, info } = await holding(bucket, set, claimPath);
  if (held) {
    return;
  }
  if (mine) {
    rmSync(claimPath);
  }
  throw notHeldError(set, info?.owner, Boolean(mine));
}

/**
 * Why a backup, an upload or a forget was refused on a set this machine doesn't
 * hold, and the command that makes it the holder.
 * @param {string} set
 * @param {string | undefined} holder - The marker's `OWNER`, if it has one
 * @param {boolean} lost - This machine held the set until now
 * @returns {Error}
 */
const notHeldError = (set, holder, lost) => {
  const state = holder
    ? lost
      ? `has been taken over by ${holder}`
      : `is held by ${holder}, not this machine`
    : lost
      ? `no longer has a holder in its bucket`
      : `has no holder in its bucket`;
  return new Error(
    `Backup set '${set}' ${state}. This machine can't back it up or forget its ` +
      `snapshots, only list and restore it.\n\n` +
      `To make this machine the holder` +
      (holder
        ? `, so that ${holder}'s backups of it are refused instead`
        : "") +
      `:\n` +
      `  ${shellCommand(`s3cab takeover ${set}`)}`,
  );
};

/**
 * Publish s3cab's copy of a set's config, mirroring the local set: `dirs.txt`
 * always, and `exclude.txt` only when the set has one. When it doesn't, any
 * remote `exclude.txt` is deleted, so a later takeover can't bring back
 * patterns the user removed.
 * @param {string} bucket
 * @param {string} set
 * @param {object} config
 * @param {string[]} config.dirs - Member directories (absolute paths)
 * @param {string} [config.exclude] - The exclude file's verbatim text, if any
 * @returns {Promise<void>}
 */
export async function pushSetConfig(bucket, set, { dirs, exclude }) {
  await putText(configUri(bucket, set, "dirs.txt"), dirs.join("\n") + "\n");
  // An empty file counts as none: `readSetConfig` reads one back as none
  // anyway, and the SDK prints a "Stream of unknown length" warning on every
  // PUT of an empty string.
  if (!exclude) {
    await deleteObject(configUri(bucket, set, "exclude.txt"));
  } else {
    await putText(configUri(bucket, set, "exclude.txt"), exclude);
  }
}

/**
 * Read s3cab's copy of a set's config back. `dirs` is parsed like the local
 * `dirs.txt` (comments and blank lines dropped); `exclude` is the file's
 * verbatim text, `undefined` when the set has none or an empty one.
 * @param {string} bucket
 * @param {string} set
 * @returns {Promise<{ dirs: string[], exclude: string | undefined }>}
 */
export async function readSetConfig(bucket, set) {
  const dirsText = await getText(configUri(bucket, set, "dirs.txt"));
  const dirs = parseLines(dirsText ?? "");
  const excludeText = await getText(configUri(bucket, set, "exclude.txt"));
  const exclude = excludeText || undefined;
  return { dirs, exclude };
}

/**
 * The names of the sets in a bucket, sorted: every `snapshots/<set>/` folder
 * and `snapshots/<set>.info` marker, so a set with a marker and no snapshots
 * yet counts too. Only `[a-z0-9-]+` names count, so a stray key made in a
 * console can't pass for a set.
 * @param {string} bucket
 * @returns {Promise<string[]>}
 */
export async function listRemoteSets(bucket) {
  /** @type {Set<string>} */
  const names = new Set();
  for await (const { Key } of listObjects(`s3://${bucket}/snapshots/`)) {
    const match = /^snapshots\/([a-z0-9-]+)(?:\/|\.info$)/.exec(Key ?? "");
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}
