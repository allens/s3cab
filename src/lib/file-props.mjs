import crypto, { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";

/** @import { Props, SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * SHA-256 hash of an empty file. Module-private — only `fileProps` needs it.
 */
const SHA256_EMPTY_FILE =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Compute a file's content properties — its `hash`, `size`, and `mtime` — from
 * the file on disk, reusing the stored hash from a previous snapshot's `lookup`
 * when the file is unchanged (same `size` *and* `mtime`), so an unchanged file is
 * never re-hashed.
 *
 * The `lib` hashing primitive behind both callers: the `prop` command (which
 * resolves a `--lookup <snapshot>` path into the `lookup` Map) and the snapshot
 * writer's injected `getProps` (bound by `snapshot`, see commands/snapshot.mjs).
 * It lives in `lib` so the snapshot pipeline reaches it directly instead of
 * smuggling a `commands/` function across the porcelain/lib seam (ADR-0023).
 *
 * One `lstat`, deliberately: its `size`/`mtime` drive both the reuse check and
 * the returned `Props`, so threading a second stat in for either is the per-file
 * overhead CLAUDE.md warns against in the walk/snapshot hot path.
 * @param {string} path - The file to inspect
 * @param {SnapshotEntries} [lookup] - Previous-snapshot entries; an unchanged file reuses its stored hash
 * @returns {Promise<Props>} The file's hash/size/mtime (no `hashDuration` when reused from `lookup`)
 */
export async function fileProps(path, lookup) {
  const start = Temporal.Now.instant();

  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  const { size, mtime } = stat;

  const fromLookup = lookup?.get(path);
  if (
    fromLookup &&
    fromLookup.size === size &&
    fromLookup.mtime === mtime.toISOString()
  ) {
    return fromLookup;
  }

  let hash;
  // Slurp small files (one-shot crypto.hash) and stream larger ones to bound
  // memory. The 5 MB boundary was chosen empirically on real data; worth
  // re-measuring during any future perf pass (see CLAUDE.md "Known gaps").
  if (size >= 5_000_000) {
    const hasher = createHash("sha256");
    await pipeline(createReadStream(path), hasher);
    hash = hasher.digest("hex");
  } else if (size) {
    hash = crypto.hash("sha256", readFileSync(path), "hex");
  } else {
    hash = SHA256_EMPTY_FILE;
  }

  return {
    size,
    mtime: mtime.toISOString(),
    hash,
    hashDuration: Temporal.Now.instant()
      .since(start)
      .round("milliseconds")
      .total("seconds"),
  };
}
