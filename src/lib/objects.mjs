import { createHash } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isENOENT } from "./error.mjs";
import { assertPathSegment, s3cabDir } from "./home.mjs";
import { createS3ReadStream, listObjects, putFile } from "./s3.mjs";

// The content-addressed object store: the `objects/<sha256>` half of an s3cab
// repository's fixed layout (design #1, docs/specs/backup.md). Every file's content
// is stored once under the SHA-256 of its bytes, so identical content — under
// any name, anywhere — costs one object. This module owns that layout and every
// operation over it: the put/get/list of objects in the bucket, plus the local
// per-bucket presence cache that lets `backup` skip objects it already uploaded.
//
// It is the twin of remote.mjs (which owns the `snapshots/` half) and sits, like
// it, *above* s3.mjs — composing the generic SDK boundary's putFile/listObjects/
// createS3ReadStream so s3.mjs never learns the layout. The `objects/` prefix
// literal lives here and nowhere else; callers (the `hashes`/`upload` plumbing
// commands and backup/restore) compose these operations and never build a key.

const OBJECTS_PREFIX = "objects/";

/**
 * The S3 key of an object: `objects/<hash>`. The one place the object-store
 * layout is turned into a key — callers report or compose it, never spell it.
 * @param {string} hash - The object's SHA-256
 * @returns {string}
 */
export const objectKey = (hash) => OBJECTS_PREFIX + hash;

/**
 * The `s3://bucket/objects/<hash>` URI of one stored object.
 * @param {string} bucket
 * @param {string} hash
 * @returns {string}
 */
const objectUri = (bucket, hash) => `s3://${bucket}/${objectKey(hash)}`;

/**
 * Store one file as the object `objects/<hash>`. Because the key *is* the
 * content hash, identical bytes always map to the same key and an object already
 * present never needs re-storing — so this is a conditional PUT (`noClobber`)
 * that silently no-ops when the object is already there, returning whether it
 * actually uploaded. The caller supplies the hash it computed (from `prop` or a
 * snapshot); the store trusts it on write and verifies only on read
 * (`getObject`), mirroring how the store has always behaved. `force` overwrites
 * an existing object instead of skipping it.
 *
 * Callers must have loaded the bucket's env (`loadEnv({ bucket | set })`) first,
 * so the S3 client picks up the right region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The file's SHA-256, its key under `objects/`
 * @param {string} path - Local path of the file to store
 * @param {object} [options]
 * @param {boolean} [options.force] - Overwrite even if the object already exists
 * @returns {Promise<boolean>} Whether the object was uploaded (false = already present)
 */
export function putObject(bucket, hash, path, { force = false } = {}) {
  return putFile(path, objectUri(bucket, hash), { noClobber: !force });
}

/**
 * Download one content-addressed object to a local path, verifying integrity.
 * The remote twin of `putObject`: stream `objects/<hash>` while hashing it,
 * assert the SHA-256 equals `hash` (the key *is* the content hash, so a mismatch
 * means the stored object is corrupt or wrong — silent data loss is exactly what
 * design #1 guards against), then atomically rename into place. Bytes land in a
 * sibling temp file first, so a crash or a failed integrity check never leaves a
 * half-written or unverified file at `destPath`.
 *
 * The caller owns *where* files go: `destPath`'s parent directory must already
 * exist (the temp file is a sibling, and the rename needs it), and setting the
 * restored mtime is the restore loop's job (it places objects, this fetches
 * their bytes). The `restore` command composes this.
 *
 * Callers must have loaded the bucket's env (`loadEnv({ bucket | set })`) first,
 * so the S3 client picks up the right region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The object's SHA-256, its key under `objects/`
 * @param {string} destPath - Where to write the verified object (parent must exist)
 * @returns {Promise<void>}
 */
export async function getObject(bucket, hash, destPath) {
  const uri = objectUri(bucket, hash);
  const tmpPath = join(dirname(destPath), `.${basename(destPath)}.s3cab-tmp`);

  const hasher = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(createS3ReadStream(uri), tap, createWriteStream(tmpPath));
    const got = hasher.digest("hex");
    if (got !== hash) {
      throw new Error(
        `Integrity check failed for ${uri}: its content hashes to ${got}, ` +
          `not ${hash}. The stored object is corrupt or mismatched.`,
      );
    }
    await rename(tmpPath, destPath);
  } catch (error) {
    // Never leave the partial/unverified temp file behind (best-effort).
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Yield every stored object's hash — the bare SHA-256 of each key under
 * `objects/`, with the prefix stripped. The store's listing, behind which the
 * `hashes` plumbing command and the per-bucket cache seed both sit.
 *
 * Callers must have loaded the bucket's env (`loadEnv({ bucket | set })`) first.
 * @param {string} bucket - The repository's S3 bucket
 * @yields {string} An object hash
 * @returns {AsyncGenerator<string>}
 */
export async function* listObjectHashes(bucket) {
  for await (const { Key } of listObjects(`s3://${bucket}/${OBJECTS_PREFIX}`)) {
    // Skip a zero-byte `objects/` folder marker (an S3-console artifact): it
    // would otherwise slice to an empty hash — a blank line from `hashes`, a
    // blank cache entry — the same stray-key case remote.mjs's
    // listRemoteNamespaces guards.
    const hash = Key?.slice(OBJECTS_PREFIX.length);
    if (hash) yield hash;
  }
}

/**
 * The per-bucket objects cache file, `~/.s3cab/objects.<bucket>` — a local
 * hash-per-line list of objects already known to exist under the bucket's
 * `objects/`, in exactly the format `s3cab hashes -f` writes (it *is* that
 * command's output put to work — composability, docs/specs/backup.md). Sits beside
 * the per-bucket auth file `env.<bucket>` (env.mjs). The bucket name is
 * interpolated into the filename, so it is guarded as a single path segment —
 * the same `assertPathSegment` guard `bucketEnvPath` uses.
 * @param {string} bucket
 * @returns {string}
 */
export const objectsCachePath = (bucket) =>
  join(s3cabDir(), `objects.${assertPathSegment(bucket, "bucket name")}`);

/**
 * Read the per-bucket objects cache into a set of hashes — the objects a prior
 * backup recorded as already present under `objects/`, so the next backup can
 * skip them without a per-object existence check (docs/specs/backup.md, "How
 * `backup` computes the upload set", step 3). A missing or empty cache yields an
 * empty set: every candidate then falls through to the conditional-PUT safety
 * net, which is safe by design — a hash *missing* from the cache costs at most
 * one redundant no-op PUT, never a skipped upload (the staleness asymmetry the
 * design leans on).
 * @param {string} bucket
 * @returns {Set<string>} Hashes known to be in the bucket's object store
 */
export function knownObjects(bucket) {
  let text;
  try {
    text = readFileSync(objectsCachePath(bucket), "utf8");
  } catch (error) {
    if (isENOENT(error)) return new Set();
    throw error;
  }
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Record hashes in the per-bucket objects cache, creating it (and `~/.s3cab`)
 * if absent — every object `backup` uploads is recorded here so a later backup
 * skips it (docs/specs/backup.md step 3). Append-only and newline-terminated,
 * matching the `hashes -f` format; duplicates are harmless (`knownObjects`
 * dedups via a Set), so this never has to read-modify-write.
 * @param {string} bucket
 * @param {Iterable<string>} hashes
 */
export function recordObjects(bucket, hashes) {
  const text = [...hashes].map((hash) => hash + "\n").join("");
  if (!text) return;
  const path = objectsCachePath(bucket);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
}
