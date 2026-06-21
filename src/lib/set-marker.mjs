import { parseEnv } from "node:util";
import { getData, listObjects, putData } from "./s3.mjs";

// The remote `sets/<set>/` area of an s3cab repository: a backup set's published
// config and ownership marker (ADR-0024). The third remote concern, beside
// objects.mjs (`objects/<sha256>`) and remote.mjs (`snapshots/<set>/`):
//
//   sets/<set>/dirs.txt     the member directories (DR hint), one absolute path per line
//   sets/<set>/exclude.txt  the exclude patterns (optional), verbatim
//   sets/<set>/info         KEY=value: OWNER (raw hostname), CREATED (ISO minute)
//
// `info` doubles as the collision-registration marker and the atomic claim token:
// `setup` claims a name by conditional-PUTting `info` (first writer wins), and the
// presence of `info` is how the collision check and `--inherit` learn a name is
// taken. The set name is canonical `[a-z0-9-]+` (validateSetName), so it is a safe
// key segment with no escaping. The set `env` is NEVER pushed here (it may hold
// credentials); only this explicit allowlist (dirs/exclude/info) leaves the
// machine — the secret boundary is the push list, not physical separation
// (ADR-0024).

const SETS_PREFIX = "sets/";

/**
 * The S3 key prefix holding one set's remote marker: `sets/<set>/`.
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {string}
 */
export const remoteSetPrefix = (set) => `${SETS_PREFIX}${set}/`;

/**
 * @param {string} bucket
 * @param {string} set
 * @param {string} file
 * @returns {string}
 */
const fileUri = (bucket, set, file) =>
  `s3://${bucket}/${remoteSetPrefix(set)}${file}`;

/**
 * A set's remote ownership marker (the `info` file's fields).
 * @typedef {Object} SetInfo
 * @property {string} owner - The machine that owns the set (raw hostname)
 * @property {string} created - When the set was first created (ISO 8601, minute precision)
 */

/**
 * Serialize the `info` marker to its KEY=value text.
 * @param {SetInfo} info
 * @returns {string}
 */
const formatInfo = ({ owner, created }) =>
  `OWNER=${owner}\nCREATED=${created}\n`;

/**
 * Try to claim a set name by atomically writing its `info` marker — the "first
 * person wins" gate (ADR-0024). A conditional PUT (`noClobber`): the first
 * machine to write `info` wins (`true`); a second gets `false` without
 * overwriting, which the caller turns into the collision error. Push the set's
 * config (`pushSetConfig`) only after winning.
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @param {string} set
 * @param {SetInfo} info
 * @returns {Promise<boolean>} True if this machine won the claim.
 */
export function claimRemoteSet(bucket, set, info) {
  return putData(fileUri(bucket, set, "info"), formatInfo(info), {
    noClobber: true,
  });
}

/**
 * Read a set's remote `info` marker, or `undefined` if the set isn't claimed in
 * this bucket — the presence test behind the collision error (who owns it) and
 * `--inherit` (which preserves `CREATED`).
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @param {string} set
 * @returns {Promise<SetInfo | undefined>}
 */
export async function readRemoteInfo(bucket, set) {
  const text = await getData(fileUri(bucket, set, "info"));
  if (text === undefined) return undefined;
  const env = parseEnv(text);
  return { owner: env.OWNER ?? "", created: env.CREATED ?? "" };
}

/**
 * Overwrite a set's remote `info` marker — used by `--inherit` to re-stamp
 * `OWNER` to the inheriting machine (the caller preserves `CREATED`). A plain
 * (non-conditional) PUT: the marker already exists and we are deliberately
 * taking ownership.
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @param {string} set
 * @param {SetInfo} info
 * @returns {Promise<void>}
 */
export async function writeRemoteInfo(bucket, set, info) {
  await putData(fileUri(bucket, set, "info"), formatInfo(info));
}

/**
 * Push a set's config to its remote marker for the full-DR story: `dirs.txt`
 * always, `exclude.txt` only when the set has one (`exclude` undefined ⇒ none).
 * Plain overwrites — the caller owns the set (it won the claim or inherited it).
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @param {string} set
 * @param {object} config
 * @param {string[]} config.dirs - Member directories (absolute paths)
 * @param {string} [config.exclude] - The exclude file's verbatim text, if any
 * @returns {Promise<void>}
 */
export async function pushSetConfig(bucket, set, { dirs, exclude }) {
  await putData(fileUri(bucket, set, "dirs.txt"), dirs.join("\n") + "\n");
  if (exclude !== undefined) {
    await putData(fileUri(bucket, set, "exclude.txt"), exclude);
  }
}

/**
 * Read a set's published config back from its remote marker — what `--inherit`
 * recreates the local set from. `dirs` is parsed like the local `dirs.txt` (one
 * absolute path per non-blank line); `exclude` is the verbatim file text, or
 * `undefined` if the set has none remotely.
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @param {string} set
 * @returns {Promise<{ dirs: string[], exclude: string | undefined }>}
 */
export async function readSetConfig(bucket, set) {
  const dirsText = await getData(fileUri(bucket, set, "dirs.txt"));
  const dirs = (dirsText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const exclude = await getData(fileUri(bucket, set, "exclude.txt"));
  return { dirs, exclude };
}

/**
 * List the names of the backup sets present in a bucket — the distinct first
 * segments under `sets/`. The discovery aid in `--inherit`'s "no such set"
 * error, where a fresh machine won't recall exact names. Only canonical
 * `[a-z0-9-]+` segments count, so a stray console-made key can't surface as a
 * bogus target (the parity of remote.mjs's old namespace filter). Sorted, deduped.
 *
 * Callers must have loaded their env first.
 * @param {string} bucket
 * @returns {Promise<string[]>} Distinct set names, sorted
 */
export async function listRemoteSets(bucket) {
  /** @type {Set<string>} */
  const names = new Set();
  for await (const { Key } of listObjects(`s3://${bucket}/${SETS_PREFIX}`)) {
    const rest = Key?.slice(SETS_PREFIX.length) ?? "";
    const cut = rest.indexOf("/");
    if (cut === -1) continue;
    const name = rest.slice(0, cut);
    if (/^[a-z0-9-]+$/.test(name)) names.add(name);
  }
  return [...names].sort();
}
