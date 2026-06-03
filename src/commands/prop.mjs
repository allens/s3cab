import { Temporal } from "@js-temporal/polyfill";
import { assert } from "node:console";
import crypto, { createHash } from "node:crypto";
import fs, { createReadStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { ParseArgsError } from "../error.mjs";
import { readSnapshotFile } from "../snapshot-file.mjs";

/**
 * @typedef {Object} Props
 * @property {number} size
 * @property {string} mtime
 * @property {string} hash
 * @property {number} [hashDuration]
 */

/**
 * SHA-256 hash of an empty file.
 */
export const SHA256_EMPTY_FILE =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Show properties of a file.
 * @param {string | File} path - File path
 * @param {object} [options]
 * @param {import("../snapshot-file.mjs").SnapshotLookup | string} [options.lookup] - Snapshot data or path to snapshot file to lookup properties from
 * @returns {Promise<Props>} File properties
 */
export async function prop(path, options = {}) {
  const start = Temporal.Now.instant();

  let { lookup } = options;

  if (!path) {
    throw new ParseArgsError("No file path specified");
  }

  if (path instanceof File) {
    assert(!lookup, "Cannot use lookup with File object");
    return {
      size: path.size,
      mtime: Temporal.Instant.fromEpochMilliseconds(
        path.lastModified,
      ).toString(),
      hash: crypto.hash("sha256", await path.text(), "hex"),
      hashDuration: Temporal.Now.instant().since(start).total("milliseconds"),
    };
  }

  const stat = lstatSync(path);

  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  if (typeof lookup === "string") {
    console.warn("Reading snapshot file:", lookup);
    lookup = await readSnapshotFile(lookup);
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
  if (size >= 5_000_000) {
    hash = await streamHash(path);
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

/**
 * Compute the SHA-256 hash of a file using a stream.
 * @param {string} path - File path
 * @returns {Promise<string>} SHA-256 hash of the file
 */
async function streamHash(path) {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path, { highWaterMark: 8 * 1024 * 1024 }),
    hash,
  );
  return hash.digest("hex");
}

/** @type {{ path: string, stat: fs.Stats } | undefined} */
let _lstatCache;

/**
 * Cached lstatSync to avoid multiple fs.lstatSync calls for the same path.
 * @param {string} path - File path
 * @returns {fs.Stats} File stats
 */
function lstatSync(path) {
  if (!_lstatCache || _lstatCache.path !== path) {
    _lstatCache = { path, stat: fs.lstatSync(path) };
  }
  return _lstatCache.stat;
}
