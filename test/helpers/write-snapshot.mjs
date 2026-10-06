import crypto from "node:crypto";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileProps } from "../../src/lib/file-props.mjs";
import {
  stringifySnapshot,
  withSnapshotFile,
} from "../../src/lib/snapshot-file.mjs";

/** @import { Props } from "../../src/lib/snapshot-file.mjs" */

// Test fixture builder: write a snapshot file from a list of paths or `File`
// objects, in the real `.tsv.zst` form (so a snapshot lister sees it when the
// name is datestamped). It writes file rows only — no `#SNAPSHOT`/`#DIR`
// headers — which is all the compare/remote tests need; production snapshots
// (with headers) are written by `snapshot()`. On-disk paths go through the lib
// `fileProps`; a `File` carries its own in-memory bytes, so it is hashed inline
// here — production `fileProps`/`prop` are path-only, and synthesizing props
// from in-memory bytes is a test-only convenience that stays in the test layer.

/**
 * Props from a `File`'s in-memory bytes (no disk, no `hashDuration` — snapshot
 * rows don't store one). Mirrors how `fileProps` shapes an on-disk file's props.
 * @param {File} file
 * @returns {Promise<Props>}
 */
const propsOfFile = async (file) => ({
  size: file.size,
  mtime: Temporal.Instant.fromEpochMilliseconds(file.lastModified).toString(),
  // Hash the raw bytes (not `file.text()`, which UTF-8-decodes), so a `File`
  // hashes byte-identically to its on-disk twin (`fileProps` reads bytes too).
  hash: crypto.hash("sha256", await file.bytes(), "hex"),
});

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
    // A string path is resolved against `base` and hashed at that resolved path
    // (so the key and the file `fileProps` reads agree). A File carries its own
    // bytes, so it is hashed inline and `base` only places its key.
    if (typeof file === "string") {
      const resolved = resolve(base, file);
      snapshot.set(resolved, await fileProps(resolved));
    } else {
      snapshot.set(resolve(base, file.name), await propsOfFile(file));
    }
  }
  return withSnapshotFile(snapshotDir, name, (stream) =>
    pipeline(stringifySnapshot(snapshot), stream),
  );
}
