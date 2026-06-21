import { prepareRemoteSet } from "../lib/env.mjs";
import { listRemoteSnapshots } from "../lib/remote.mjs";
import { resolveSet, setSnapshotsDir } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";

/**
 * List a backup set's snapshots (docs/specs/backup.md) — the local snapshots by
 * default, or the set's cloud backups under `snapshots/<set>/` with
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
    const names = await listRemoteSnapshots(set.bucket, set.name);
    return options.latest ? names.at(0) : names;
  }

  const snapshotDir = setSnapshotsDir(resolveSet(setName).name);
  const names = listSnapshotNames(snapshotDir, {});
  return options.latest ? names.at(0) : names;
}
