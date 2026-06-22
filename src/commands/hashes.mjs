import { writeFile } from "node:fs/promises";
import { requireArg } from "../lib/error.mjs";
import { listObjectHashes } from "../lib/objects.mjs";

/**
 * List a repository's stored object hashes — one sha256 per line.
 *
 * A plumbing/diagnostic command (cf. git porcelain vs plumbing); ordinary users
 * won't run it directly. Its main job is to produce a newline-delimited file of
 * the hashes already in the store, used as a lookup so `backup` can skip
 * re-uploading objects that already exist remotely (it seeds the per-bucket
 * objects cache — `objects.mjs`). Output is therefore a flat hash-per-line
 * list — written to `--file` if given, else to stdout — deliberately *not* the
 * JSON the other commands return (a lookup file wants one bare hash per line), so
 * this command writes its own output and returns nothing.
 *
 * The object store (`src/lib/objects.mjs`) sits over the `src/lib/s3.mjs` SDK
 * boundary, whose lazily-constructed client means this command costs nothing
 * (and needs no AWS creds) until run.
 *
 * @param {string} [bucket] - The repository's S3 bucket name.
 * @param {object} [options]
 * @param {string} [options.file] - Write the hashes here instead of to stdout.
 * @returns {Promise<undefined>} Output is streamed, not returned.
 */
export async function hashes(bucket, options = {}) {
  requireArg(bucket, "<bucket>");

  const all = [];
  for await (const hash of listObjectHashes(bucket)) all.push(hash);

  const text = all.map((hash) => hash + "\n").join("");

  if (options.file) {
    await writeFile(options.file, text);
    // A confirmation is progress, not the result, so it goes to stderr.
    console.warn(`Wrote ${all.length} object hashes to ${options.file}`);
  } else {
    process.stdout.write(text);
  }
}
