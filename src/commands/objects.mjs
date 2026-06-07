import { writeFile } from "node:fs/promises";
import { ParseArgsError } from "../error.mjs";
import { listObjects } from "../s3.mjs";

// An s3cab repository is one bucket with a fixed, well-known layout: every
// content-addressed object lives under `objects/<sha256>` at the bucket root
// (see the S3 layout in CLAUDE.md / README.md). This lists that one prefix.
const OBJECTS_PREFIX = "objects/";

/**
 * List a repository's stored object hashes — one sha256 per line.
 *
 * A plumbing/diagnostic command (cf. git porcelain vs plumbing); ordinary users
 * won't run it directly. Its main job is to produce a newline-delimited file of
 * the hashes already in the store, used as a lookup so `backup` can skip
 * re-uploading objects that already exist remotely. Output is therefore a flat
 * hash-per-line stream — written to `--file` if given, else to stdout —
 * deliberately *not* the JSON the other commands return (a lookup file wants one
 * bare hash per line), so this command writes its own output and returns nothing.
 *
 * S3 access goes through the `src/s3.mjs` SDK boundary, whose lazily-constructed
 * client means this command costs nothing (and needs no AWS creds) until run.
 *
 * @param {string} [bucket] - The repository's S3 bucket name.
 * @param {object} [options]
 * @param {string} [options.file] - Write the hashes here instead of to stdout.
 * @returns {Promise<undefined>} Output is streamed, not returned.
 */
export async function objects(bucket, options = {}) {
  if (!bucket) {
    throw new ParseArgsError("Missing required argument: <bucket>");
  }

  const hashes = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${OBJECTS_PREFIX}`)) {
    if (Key) hashes.push(Key.slice(OBJECTS_PREFIX.length));
  }

  const text = hashes.map((hash) => hash + "\n").join("");

  if (options.file) {
    await writeFile(options.file, text);
    // A confirmation is progress, not the result, so it goes to stderr.
    console.warn(`Wrote ${hashes.length} object hashes to ${options.file}`);
  } else {
    process.stdout.write(text);
  }
}
