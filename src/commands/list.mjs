import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * @overload
 * @param {string} [dir]
 * @param {{ latest: true }} options
 * @returns {string | undefined}
 */

/**
 * @overload
 * @param {string} [dir]
 * @param {{ latest?: false }} [options]
 * @returns {string[]}
 */

/**
 * List snapshots in a directory.
 * @param {string} dir - Directory to list files from
 * @param {object} [options]
 * @param {boolean} [options.latest] - Return only the latest snapshot file
 * @returns {string[] | string | undefined} Array of snapshot names or the latest snapshot name
 */
export function list(dir = ".", options = {}) {
  dir = realpathSync.native(dir);

  const snapshotDir = join(dir, ".s3cab", "snapshots");

  if (!existsSync(snapshotDir)) {
    return options.latest ? undefined : [];
  }

  const fileNames = readdirSync(snapshotDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name);

  const snapshotNamesDescending = fileNames
    .filter((name) => /\d{4}-\d{2}-\d{2}T\d{4}\.tsv.zst$/.test(name))
    .map((name) => basename(name, ".tsv.zst"))
    .sort()
    .reverse();

  return options.latest
    ? snapshotNamesDescending.at(0)
    : snapshotNamesDescending;
}
