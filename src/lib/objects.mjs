import { writeFileAtomic } from "./atomic-file.mjs";
import {
  deleteObject,
  getStream,
  listObjects,
  objectSize,
  putFile,
} from "./s3.mjs";

/** @import { Transfer } from "./s3.mjs" */

// The content-addressed object store: the `objects/<sha256>` half of an s3cab
// repository's fixed layout (design #1, docs/design/backup.md). Every file's content
// is stored once under the SHA-256 of its bytes, so identical content — under
// any name, anywhere — costs one object. This module owns that layout and every
// operation over it: the put/get/list of objects in the bucket.
//
// It is the twin of remote.mjs (which owns the `snapshots/` half) and sits, like
// it, *above* s3.mjs — composing the generic SDK boundary's putFile/listObjects/
// getStream so s3.mjs never learns the layout. The `objects/` prefix
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
 * snapshot); the write is held to it — `putFile` hashes the bytes it actually
 * streams and refuses if they no longer match, so a file rewritten mid-transfer
 * can't be stored under the stale hash — and the read verifies again
 * (`getObject`). The refusal removes the object it just created; under `force`,
 * which overwrites an existing object instead of skipping it, it can't (the
 * name may have held content this call already destroyed), so there the object
 * is left and the error says so.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The file's SHA-256, its key under `objects/`
 * @param {string} path - Local path of the file to store
 * @param {object} [options]
 * @param {boolean} [options.force] - Overwrite even if the object already exists
 * @param {(transfer: Transfer) => void} [options.onProgress] - Take the transfer's
 *   bytes instead of `putFile`'s byte bar, for a caller drawing its own line
 * @returns {Promise<boolean>} Whether the object was uploaded (false = already present)
 */
export function putObject(
  bucket,
  hash,
  path,
  { force = false, onProgress } = {},
) {
  return putFile(path, objectUri(bucket, hash), {
    noClobber: !force,
    onProgress,
    sha256: hash,
  });
}

/**
 * Download one content-addressed object to a local path, verifying integrity.
 * The remote twin of `putObject`: the key *is* the content hash, so it is
 * passed to `writeFileAtomic` as the expected digest — a mismatch means the
 * stored object is corrupt or wrong (silent data loss is exactly what design
 * #1 guards against) and throws before anything reaches `destPath`; the atomic
 * write lives in `writeFileAtomic`.
 *
 * The caller owns *where* files go: `destPath`'s parent directory must already
 * exist, and setting the restored mtime is the restore loop's job (it places
 * objects, this fetches their bytes). The `restore` command composes this.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The object's SHA-256, its key under `objects/`
 * @param {string} destPath - Where to write the verified object (parent must exist)
 * @returns {Promise<void>}
 */
export async function getObject(bucket, hash, destPath) {
  const uri = objectUri(bucket, hash);
  await writeFileAtomic(destPath, await getStream(uri), { hash });
}

/**
 * Yield every stored object as `{ hash, size, lastModified }` — the bare SHA-256
 * of each key under `objects/` (prefix stripped) with its LIST `Size` and
 * `LastModified`. The one enumeration of the object store, from which the
 * hash-only listing (`listObjectHashes`), `verify`'s size cross-check, and
 * `cleanup`'s orphan sweep all draw: a LIST already returns each key with its size
 * *and* age, so `verify` gets sizes and `cleanup` gets the grace-window age for
 * free, with no per-object HEAD (docs/design/backup.md). `lastModified` is absent
 * only if S3 omits it (it never does for a real object); `cleanup` treats absent
 * as too-new-to-delete.
 * @param {string} bucket - The repository's S3 bucket
 * @yields {{ hash: string, size: number, lastModified?: Date }} A stored object's hash, size, and age
 * @returns {AsyncGenerator<{ hash: string, size: number, lastModified?: Date }>}
 */
export async function* listStoredObjects(bucket) {
  for await (const { Key, Size, LastModified } of listObjects(
    `s3://${bucket}/${OBJECTS_PREFIX}`,
  )) {
    // Skip a zero-byte `objects/` folder marker (an S3-console artifact): it
    // would otherwise slice to an empty hash — a blank line from `hashes`, a
    // phantom stored object.
    const hash = Key?.slice(OBJECTS_PREFIX.length);
    if (hash) {
      yield { hash, size: Size ?? 0, lastModified: LastModified };
    }
  }
}

/**
 * One stored object's size in bytes, or `undefined` if it isn't stored — the
 * per-hash HEAD behind `delete`'s preflight, which is how a hash the bucket
 * doesn't hold gets reported-and-skipped before anything is destroyed, and
 * where the deletion record's size column comes from. One HEAD per hash is the
 * honest cost of an exact preflight over a handful of named objects; a
 * whole-store LIST ({@link listStoredObjects}) wins only when the question is
 * about *every* object.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The object's SHA-256, its key under `objects/`
 * @returns {Promise<number | undefined>}
 */
export function storedObjectSize(bucket, hash) {
  return objectSize(objectUri(bucket, hash));
}

/**
 * Delete one stored object — `objects/<hash>` — the reclamation `cleanup`
 * performs (docs/design/backup.md). The **only** operation that removes from
 * `objects/`; every everyday command leaves it alone. Composes the generic
 * `deleteObject` over this module's key layout, so callers never spell the key.
 * On a versioned bucket this is a soft delete (a delete marker), the
 * ransomware-safety model (ADR-0033) — permanent reclamation needs a lifecycle
 * rule, which `cleanup`'s docs recommend.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The object's SHA-256, its key under `objects/`
 * @returns {Promise<void>}
 */
export async function deleteStoredObject(bucket, hash) {
  await deleteObject(objectUri(bucket, hash));
}

/**
 * Yield every stored object's hash — the bare SHA-256 of each key under
 * `objects/`, with the prefix stripped. The store's listing behind the `hashes`
 * plumbing command, and the on-demand baseline a first `backup` diffs against
 * (there being no previous local snapshot to skip against, docs/design/backup.md).
 * A thin hash-only view of {@link listStoredObjects} (callers that don't need sizes).
 * @param {string} bucket - The repository's S3 bucket
 * @yields {string} An object hash
 * @returns {AsyncGenerator<string>}
 */
export async function* listObjectHashes(bucket) {
  for await (const { hash } of listStoredObjects(bucket)) {
    yield hash;
  }
}
