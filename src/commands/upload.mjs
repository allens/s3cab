import { requireArg } from "../lib/error.mjs";
import { objectKey, putObject } from "../lib/objects.mjs";
import { prop } from "./prop.mjs";

/**
 * Upload one file to a repository's content-addressed object store.
 *
 * A low-level plumbing command (cf. git porcelain vs plumbing, like its `hashes`
 * sibling): it hashes the file and PUTs it at `objects/<sha256>`, the fixed layout
 * `hashes` reads and `backup` populates. The higher-level snapshot-driven
 * `backup` is what ordinary users run; this uploads a single file by hand.
 *
 * Because the object key *is* the content hash, identical bytes always map to the
 * same key, so an object already in the store needn't be re-PUT — a
 * content-addressed store never has to overwrite an existing object with the same
 * content. So this skips the upload when the object already exists (the object
 * store's conditional PUT), unless `--force` overwrites it.
 *
 * The object store (`src/lib/objects.mjs`) sits over the `src/lib/s3.mjs` SDK
 * boundary, whose lazily-constructed client means this command costs nothing
 * (and needs no AWS creds) until run.
 *
 * TODO (important, not yet wired): a `--if-modified-from <snapshot>` option.
 * Given a previous snapshot, skip the upload when this file is *unchanged* since
 * it (same size + mtime) — and skip even the hashing, by passing the snapshot
 * through to `prop()`'s existing `lookup` (which reuses the stored hash for an
 * unchanged file). This is the snapshot-aware skip that `backup` is built on:
 * back up only what changed since the last backed-up snapshot. Deferred with the
 * rest of the `backup` milestone, but it's load-bearing for that flow, so don't
 * lose it.
 *
 * @param {string} [bucket] - The repository's S3 bucket name.
 * @param {string} [file] - The file to upload.
 * @param {object} [options]
 * @param {boolean} [options.force] - Re-upload even if the object already exists.
 * @returns {Promise<{ hash: string, size: number, key: string, uploaded: boolean }>}
 */
export async function upload(bucket, file, options = {}) {
  requireArg(bucket, "bucket");
  requireArg(file, "file");

  // prop() does the file validation (rejects non-regular files) and the streaming
  // SHA-256 hash; reuse it rather than re-deriving either here (#6).
  const { hash, size } = await prop(file);

  const uploaded = await putObject(bucket, hash, file, {
    force: options.force,
  });

  return { hash, size, key: objectKey(hash), uploaded };
}
