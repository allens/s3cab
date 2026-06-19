import { existsSync, readdirSync } from "node:fs";
import { prepareRemoteSet } from "../lib/env.mjs";
import { listRemoteSnapshots } from "../lib/remote.mjs";
import { resolveSet, setSnapshotsDir } from "../lib/sets.mjs";
import { snapshotNames } from "../lib/snapshot-file.mjs";

/**
 * List a backup set's snapshots (specs/backup.md) — the local snapshots by
 * default, or the set's cloud backups under `snapshots/<namespace>/` with
 * `--remote`; either way `--latest` narrows to just the newest name. Async only
 * because the `--remote` path lists S3 (the local path is synchronous work
 * wrapped in the returned promise).
 * @param {string} [setName] - Backup set whose snapshots to list (default: the only set)
 * @param {object} [options]
 * @param {boolean} [options.latest] - Return only the latest snapshot name
 * @param {boolean} [options.remote] - List the set's cloud backups instead of local snapshots
 * @returns {Promise<string[] | string | undefined>} Snapshot names newest-first, or the latest name
 */
export async function list(setName, options = {}) {
  if (options.remote) {
    const set = prepareRemoteSet(setName);
    const names = await listRemoteSnapshots(set.bucket, set.namespace);
    return options.latest ? names.at(0) : names;
  }

  const snapshotDir = setSnapshotsDir(resolveSet(setName).name);
  const names = listSnapshotNames(snapshotDir, {});
  return options.latest ? names.at(0) : names;
}

/**
 * @overload
 * @param {string} snapshotDir
 * @param {{ latest: true }} options
 * @returns {string | undefined}
 */

/**
 * @overload
 * @param {string} snapshotDir
 * @param {{ latest?: false }} [options]
 * @returns {string[]}
 */

/**
 * List the snapshot names in a snapshot directory, newest first. The storage
 * core behind `list` (and reused by `snapshot`/`compare`, which already hold a
 * resolved snapshot directory).
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {object} [options]
 * @param {boolean} [options.latest] - Return only the latest snapshot name
 * @returns {string[] | string | undefined} Snapshot names, or the latest name
 */
export function listSnapshotNames(snapshotDir, options = {}) {
  if (!existsSync(snapshotDir)) {
    return options.latest ? undefined : [];
  }

  const fileNames = readdirSync(snapshotDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name);

  const names = snapshotNames(fileNames);
  return options.latest ? names.at(0) : names;
}
