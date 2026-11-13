import { createHash } from "node:crypto";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { DestinationExistsError, IntegrityError } from "./error.mjs";

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
 * partial or unverified file *at `destPath`*. Any failure removes the temp
 * before the error leaves — a torn stream, a digest mismatch, or a name the
 * filesystem refuses, which only the rename finds out, after the whole
 * download — because the caller may carry on past it (`restore` does), and
 * would otherwise finish with a temp beside every file it couldn't place. Only
 * a process that dies mid-write leaves one, and a retry removes it.
 * `destPath`'s parent directory must already exist (the temp file is a
 * sibling, and the rename needs it).
 * @param {string} destPath - Where to write the file (parent must exist)
 * @param {Readable} source - The byte stream to write (typically `await getStream(uri)`)
 * @param {object} [options]
 * @param {string} [options.hash] - Expected content hash (lowercase hex)
 * @param {boolean} [options.noClobber] - Leave whatever is at `destPath` alone,
 *   however late it arrived (see `moveIfFree`)
 * @returns {Promise<void>}
 * @throws {IntegrityError} The content hashes differently from `hash` (nothing
 *   is left at `destPath` or in the temp)
 * @throws {DestinationExistsError} Under `noClobber`, something is at
 *   `destPath` (it is left as it is, and nothing in the temp)
 * @throws {NodeJS.ErrnoException} `EEXIST`: what sits at the temp's name
 *   couldn't be removed — a folder, a leftover a program on Windows holds open
 *   without sharing deletion, or one in a folder this process can't write to
 */
export async function writeFileAtomic(
  destPath,
  source,
  { hash, noClobber = false } = {},
) {
  const hasher = hash ? createHash("sha256") : undefined;
  const tmpPath = tempPathFor(destPath);
  // Derived from the name, so whatever is there is a dead run's leftover or
  // something planted, and a link or hard link must not carry the bytes out
  // of this folder (ADR-0116). `wx` alone isn't enough: NTFS's exclusive open
  // goes through a link whose target doesn't exist, creating the target
  // (measured; ext4 refuses). So it is removed first, not on `EEXIST`, and
  // what can't be removed is the `EEXIST` the open answers with.
  await rm(tmpPath, { force: true }).catch(() => {});
  // Opened before any byte flows, not `createWriteStream(tmpPath)`: that opens
  // lazily, so `pipeline` can reject before the temp exists, and the open
  // creates it after the cleanup below has run. Outside the `try` so that
  // `EEXIST` leaves what is there alone: it isn't this call's temp.
  const fd = await open(tmpPath, "wx").catch((error) => {
    // Nothing else will read `source`, and an S3 body left open keeps its
    // connection.
    source.destroy();
    throw error;
  });
  try {
    try {
      // Tee every chunk to disk unchanged, hashing en route only when verifying.
      await pipeline(
        source,
        async function* (/** @type {AsyncIterable<Buffer | string>} */ chunks) {
          for await (const chunk of chunks) {
            hasher?.update(chunk);
            yield chunk;
          }
        },
        fd.createWriteStream(),
      );
    } catch (error) {
      // Once `pipeline` rejects, the stream lets go of the file in its own time,
      // and the cleanup below can't remove the temp until it has. A failed close
      // is dropped here: the error that stopped the download is the one to report.
      await fd.close().catch(() => {});
      throw error;
    }
    await fd.close();
    if (hasher) {
      const got = hasher.digest("hex");
      if (got !== hash) {
        throw new IntegrityError(
          `Integrity check failed writing ${destPath}: its content hashes ` +
            `to ${got}, not ${hash}. The stored object is corrupt or mismatched.`,
        );
      }
    }
    if (noClobber) {
      await moveIfFree(tmpPath, destPath);
    } else {
      await rename(tmpPath, destPath);
    }
  } catch (error) {
    // The cleanup's own failure is dropped: the caller needs the error that
    // says why the file didn't land, not why its temp outlived it.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Move `tmpPath` to `destPath` only if nothing is there. Not a check and then
 * a rename, which replaces whatever arrives between the two: a hard link, which
 * the filesystem itself refuses over anything at all — a file, a folder, any
 * kind of link — with `EEXIST` (measured on NTFS and ext4, ADR-0116). A
 * filesystem without hard links (FAT, exFAT) fails the link some other way;
 * there `destPath` is looked at once more and the temp renamed, which leaves
 * only the moment between the two. A name the filesystem refuses fails the link
 * as it fails a rename, so the rename then throws what a caller already reads.
 * @param {string} tmpPath
 * @param {string} destPath
 * @throws {DestinationExistsError} Something is at `destPath`
 */
async function moveIfFree(tmpPath, destPath) {
  const taken = () =>
    new DestinationExistsError(`Something is already at ${destPath}`);
  try {
    await link(tmpPath, destPath);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") {
      throw taken();
    }
    const there = await lstat(destPath).catch(() => undefined);
    if (there !== undefined) {
      throw taken();
    }
    await rename(tmpPath, destPath);
    return;
  }
  await rm(tmpPath);
}

/**
 * The temp sibling `writeFileAtomic` writes `destPath` through. Fixed-length,
 * not `.<name>.s3cab-tmp`: a temp 11 characters longer than the name pushes a
 * legal name near the filesystem's 255 limit past it.
 * @param {string} destPath
 */
export function tempPathFor(destPath) {
  const nameDigest = createHash("sha256")
    .update(basename(destPath))
    .digest("hex")
    .slice(0, 16);
  return join(dirname(destPath), `.${nameDigest}.s3cab-tmp`);
}

/**
 * Copy the file at `from` to `destPath` the way `writeFileAtomic` lands a
 * download, digest check included. Not `copyFile`, which can't say what it read
 * (ADR-0116), and writes *through* a link already at its destination.
 * @param {string} from - A file landed earlier
 * @param {string} destPath - Where to write the copy (parent must exist)
 * @param {object} options
 * @param {string} options.hash - Expected content hash (lowercase hex)
 * @param {boolean} [options.noClobber] - As `writeFileAtomic`'s
 * @returns {Promise<boolean>} Whether the copy landed. `false` is the source's
 *   doing, whatever it is now: gone, unreadable, no longer a regular file, or
 *   content that hashes differently from `hash`. Nothing is left at `destPath`
 *   or in the temp, and the caller still has the content to fetch. A fault at
 *   the destination throws as `writeFileAtomic` does.
 */
export async function copyFileAtomic(from, destPath, { hash, noClobber }) {
  // Opened here, not `createReadStream(from)`: that opens lazily, and a failed
  // open would be an uncaught 'error' before `pipeline` is listening.
  let source;
  try {
    source = await open(from);
  } catch {
    return false;
  }
  // Only a regular file is a landed file: a folder opens fine, and a device
  // reports size 0 and never ends.
  const stat = await source.stat().catch(() => undefined);
  if (!stat?.isFile()) {
    await source.close();
    return false;
  }
  // Reads of up to 1 MiB, not the 64 KiB default, which costs a large copy
  // most of its time; capped at the file's size, since a stream allocates each
  // read in full and a 1 MiB read costs a small file more than it saves
  // (ADR-0116). An empty file still gets one read, where 0 ends the stream
  // unread.
  const chunks = source.createReadStream({
    highWaterMark: Math.min(stat.size, 1024 * 1024) || 1,
  });
  try {
    await writeFileAtomic(destPath, chunks, { hash, noClobber });
  } catch (error) {
    // `pipeline` destroys every stream on any failure, so the source's own
    // 'error' can't tell its failure from the writer's; the errno's syscall
    // can, and only the source reads.
    if (
      error instanceof IntegrityError ||
      /** @type {NodeJS.ErrnoException} */ (error).syscall === "read"
    ) {
      return false;
    }
    throw error;
  }
  return true;
}
