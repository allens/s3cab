import { ParseArgsError } from "../error.mjs";
import { putFile } from "../s3.mjs";
import { prop } from "./prop.mjs";

// An s3cab repository is one bucket with a fixed, well-known layout: every
// content-addressed object lives under `objects/<sha256>` at the bucket root
// (see the S3 layout in CLAUDE.md / README.md). This is the write counterpart of
// the `objects` lister, which reads that same prefix.
const OBJECTS_PREFIX = "objects/";

/**
 * Upload one file to a repository's content-addressed object store.
 *
 * A low-level plumbing command (cf. git porcelain vs plumbing, like its `objects`
 * sibling): it hashes the file and PUTs it at `objects/<sha256>`, the fixed layout
 * `objects` reads and `backup` will populate. The higher-level snapshot-driven
 * `backup` is what ordinary users run; this uploads a single file by hand.
 *
 * Because the object key *is* the content hash, identical bytes always map to the
 * same key, so an object already in the store needn't be re-PUT — a
 * content-addressed store never has to overwrite an existing object with the same
 * content. So this skips the upload when the object already exists (via `putFile`'s
 * conditional PUT), unless `--force` overwrites it.
 *
 * S3 access goes through the `src/s3.mjs` SDK boundary, whose lazily-constructed
 * client means this command costs nothing (and needs no AWS creds) until run.
 *
 * @param {string} [bucket] - The repository's S3 bucket name.
 * @param {string} [file] - The file to upload.
 * @param {object} [options]
 * @param {boolean} [options.force] - Re-upload even if the object already exists.
 * @returns {Promise<{ hash: string, size: number, key: string, uploaded: boolean }>}
 */
export async function upload(bucket, file, options = {}) {
  if (!bucket) {
    throw new ParseArgsError("Missing required argument: <bucket>");
  }
  if (!file) {
    throw new ParseArgsError("Missing required argument: <file>");
  }

  // prop() does the file validation (rejects non-regular files) and the streaming
  // SHA-256 hash; reuse it rather than re-deriving either here (#6).
  const { hash, size } = await prop(file);
  const key = OBJECTS_PREFIX + hash;

  const uploaded = await putFile(file, `s3://${bucket}/${key}`, {
    noClobber: !options.force,
  });

  return { hash, size, key, uploaded };
}
