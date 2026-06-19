import assert from "node:assert";
import crypto, { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { requireArg } from "../lib/error.mjs";
import { readSnapshotFile } from "../lib/snapshot-file.mjs";

/** @import { Props } from "../lib/snapshot-file.mjs" */

/**
 * SHA-256 hash of an empty file. Module-private — only `prop` (below) needs it.
 */
const SHA256_EMPTY_FILE =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Show properties of a file.
 * @param {string | File} [path] - File path
 * @param {object} [options]
 * @param {import("../lib/snapshot-file.mjs").SnapshotEntries | string} [options.lookup] - Snapshot data or path to snapshot file to lookup properties from
 * @returns {Promise<Props>} File properties
 */
export async function prop(path, options = {}) {
  const start = Temporal.Now.instant();

  let { lookup } = options;

  requireArg(path, "<file>");

  if (path instanceof File) {
    assert(!lookup, "Cannot use lookup with File object");
    return {
      size: path.size,
      mtime: Temporal.Instant.fromEpochMilliseconds(
        path.lastModified,
      ).toString(),
      hash: crypto.hash("sha256", await path.text(), "hex"),
      hashDuration: Temporal.Now.instant()
        .since(start)
        .round({ smallestUnit: "milliseconds" })
        .total({ unit: "seconds" }),
    };
  }

  const stat = lstatSync(path);

  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  if (typeof lookup === "string") {
    console.warn("Reading snapshot file:", lookup);
    const { entries } = await readSnapshotFile(lookup);
    lookup = entries;
  }

  const fromLookup = lookup && lookup.get(path);

  const { size, mtime } = stat;

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
