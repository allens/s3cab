import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { prop } from "../../src/commands/prop.mjs";
import {
  stringifySnapshot,
  withSnapshotFile,
} from "../../src/lib/snapshot-file.mjs";

// Test fixture builder: write a snapshot file from a list of paths or `File`
// objects, in the real `.tsv.zst` form (so a snapshot lister sees it when the
// name is datestamped). It writes file rows only — no `#SNAPSHOT`/`#DIR`
// headers — which is all the compare/remote tests need; production snapshots
// (with headers) are written by `snapshot()`. Lives here, not in
// `snapshot-file.mjs`, so the production module needn't reach into the `prop`
// hashing path under `commands/` (it is the lone reason that import existed).

/**
 * Write a snapshot of the given files into `snapshotDir`, in the same
 * `.tsv.zst` form real snapshots take. File paths are stored absolute, resolved
 * against `base` (defaulting to `snapshotDir` — handy for tests that store
 * snapshots alongside the files they describe).
 * @param {string} snapshotDir
 * @param {string} name
 * @param {Array<string|File>} files
 * @param {string} [base] - Root the file paths resolve against (default: `snapshotDir`)
 * @returns {Promise<string>} path to written snapshot file
 */
export async function writeSnapshot(
  snapshotDir,
  name,
  files,
  base = snapshotDir,
) {
  const snapshot = new Map();
  for (const file of files) {
    const path = typeof file === "string" ? file : file.name;
    snapshot.set(resolve(base, path), await prop(file));
  }
  return withSnapshotFile(snapshotDir, name, (stream) =>
    pipeline(stringifySnapshot(snapshot), stream),
  );
}
