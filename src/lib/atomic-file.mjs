import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

/** @import { Readable } from "node:stream" */

// A hardened `fs.writeFile` for the download path: write a byte stream to a
// local file *atomically* (temp sibling + rename) and, when a hash is given,
// *verify* it before committing. It makes no S3/network call — the source
// stream is handed in — which is what keeps this correctness-critical logic
// unit-testable with an in-memory stream (no client, no mocks) and is why it
// lives here rather than in s3.mjs (the generic SDK boundary). This is where
// design #1's content-addressable guarantee is enforced on the way in: a
// downloaded object must hash back to its key, or it is corrupt and never lands.

/**
 * Write `source` to `destPath` atomically, optionally verifying its content
 * hash — a specialized `fsPromises.writeFile(file, data, options)` whose `data`
 * is always a stream, adding atomicity + integrity. Bytes go to a sibling temp
 * file first, and only once the pipeline — and, when `hash` is given, the digest
 * check — has succeeded is the file renamed into place. The `rename` is the
 * atomic gate: a crash, a failed download, or a corrupt object never leaves a
 * partial or unverified file *at `destPath`*. A failed write may leave the temp
 * sibling behind — harmless: it's plainly a temp by its extension (never
 * mistaken for the real file) and a retry overwrites it, so there's no
 * failure-path cleanup to risk masking the real error. `destPath`'s parent
 * directory must already exist (the temp file is a sibling, and the rename needs it).
 * @param {string} destPath - Where to write the file (parent must exist)
 * @param {Readable} source - The byte stream to write (typically `await getStream(uri)`)
 * @param {object} [options]
 * @param {string} [options.hash] - Expected content hash (lowercase hex); a mismatch throws, before the rename
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(destPath, source, { hash } = {}) {
  const tmpPath = join(dirname(destPath), `.${basename(destPath)}.s3cab-tmp`);
  const hasher = hash ? createHash("sha256") : undefined;
  // Tee every chunk to disk unchanged, hashing en route only when verifying.
  await pipeline(
    source,
    async function* (/** @type {AsyncIterable<Buffer | string>} */ chunks) {
      for await (const chunk of chunks) {
        hasher?.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(tmpPath),
  );
  if (hasher) {
    const got = hasher.digest("hex");
    if (got !== hash) {
      throw new Error(
        `Integrity check failed writing ${destPath}: its content hashes ` +
          `to ${got}, not ${hash}. The stored object is corrupt or mismatched.`,
      );
    }
  }
  await rename(tmpPath, destPath);
}
