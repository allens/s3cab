import { requireArg } from "../lib/error.mjs";
import { listObjectHashes } from "../lib/objects.mjs";

/**
 * List a repository's stored object hashes — one sha256 per line.
 *
 * A plumbing/diagnostic command (cf. git porcelain vs plumbing); ordinary users
 * won't run it directly. Its output is the flat **hash-per-line stream** that is
 * the composition medium behind `backup`'s per-bucket objects cache — the same
 * format `writeObjectsCache` stores (docs/design/backup.md). That stream is the
 * result, returned for the render layer (ADR-0043) and rendered one hash per line;
 * a file is produced with plain shell redirection (`s3cab hashes <bucket> > file`),
 * so the command does no I/O of its own (the old `--output` flag was pure
 * redundancy with `>` — dropped, ADR-0006).
 *
 * The object store (`src/lib/objects.mjs`) sits over the `src/lib/s3.mjs` SDK
 * boundary, whose lazily-constructed client means this command costs nothing
 * (and needs no AWS creds) until run.
 *
 * @param {string} [bucket] - The repository's S3 bucket name.
 * @returns {Promise<string[]>} The stored object hashes, in LIST order.
 */
export async function hashes(bucket) {
  requireArg(bucket, "bucket");
  return Array.fromAsync(listObjectHashes(bucket));
}
