import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { notImplemented } from "../lib/error.mjs";
import { resolveSet, setSnapshotsDir } from "../lib/sets.mjs";

/**
 * @overload
 * @param {string} [setName]
 * @param {{ latest: true }} options
 * @returns {string | undefined}
 */

/**
 * @overload
 * @param {string} [setName]
 * @param {{ latest?: false, remote?: boolean }} [options]
 * @returns {string[]}
 */

/**
 * List a backup set's snapshots (specs/backup.md).
 * @param {string} [setName] - Backup set whose snapshots to list (default: the only set)
 * @param {object} [options]
 * @param {boolean} [options.latest] - Return only the latest snapshot name
 * @param {boolean} [options.remote] - List snapshots backed up to the remote
 * @returns {string[] | string | undefined} Snapshot names, or the latest name
 */
export function list(setName, options = {}) {
  if (options.remote) {
    notImplemented("list --remote");
  }

  const snapshotDir = setSnapshotsDir(resolveSet(setName).name);
  return options.latest
    ? listSnapshotNames(snapshotDir, { latest: true })
    : listSnapshotNames(snapshotDir, {});
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

  const snapshotNamesDescending = fileNames
    .filter((name) => /\d{4}-\d{2}-\d{2}T\d{4}\.tsv\.zst$/.test(name))
    .map((name) => basename(name, ".tsv.zst"))
    .sort()
    .reverse();

  return options.latest
    ? snapshotNamesDescending.at(0)
    : snapshotNamesDescending;
}
