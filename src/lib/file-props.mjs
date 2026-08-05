import crypto, { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";

/** @import { Props, SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * A hash in progress, for a caller drawing a progress line. Reported once, when
 * the read starts, carrying a `read` the caller polls on its own clock rather
 * than an event per chunk — the same read-don't-subscribe shape the upload's
 * transfer state uses, and for the same reason: the renderer's cadence should
 * not be set by how fast bytes happen to arrive.
 *
 * Only the *streaming* branch reports. A file below the slurp boundary is read
 * in one call with no intermediate count — and is far too small to spend the
 * second that would earn it a line anyway.
 * @typedef {Object} HashProgress
 * @property {string} path - The file being hashed
 * @property {number} size - Its size in bytes, from the `lstat` already taken
 * @property {number} startedAt - `performance.now()` when the read began
 * @property {() => number} read - Bytes hashed so far
 */

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
 * @param {(hashing: HashProgress) => void} [onHashStart] - Called when a file is
 *   big enough to be hashed by streaming, so a progress line can report it
 * @returns {Promise<Props>} The file's hash/size/mtime (no `hashDuration` when reused from `lookup`)
 */
export async function fileProps(path, lookup, onHashStart) {
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
  // re-measuring during any future perf pass (proposals/performance.md).
  // The stream path deliberately takes Node's default highWaterMark — an
  // explicit 8 MB read buffer here was measured to buy nothing for SHA-256 and
  // was dropped as a relic. Don't reintroduce one without a measurement.
  if (size >= 5_000_000) {
    const hasher = createHash("sha256");
    const source = createReadStream(path);
    // `bytesRead` is a plain property the stream maintains anyway, so reporting
    // costs one object at the start of a large file's read and nothing per
    // chunk. The size comes from the `lstat` above — no second stat, and none
    // in the caller's render path, which is the whole reason this is reported
    // from in here rather than derived outside.
    onHashStart?.({
      path,
      size,
      startedAt: performance.now(),
      read: () => source.bytesRead,
    });
    await pipeline(source, hasher);
    hash = hasher.digest("hex");
  } else {
    // An empty file needs no special case: `readFileSync` hands back an empty
    // buffer and `crypto.hash` returns the well-known empty-string digest.
    hash = crypto.hash("sha256", readFileSync(path), "hex");
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
