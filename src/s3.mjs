import { paginateListObjectsV2, S3Client } from "@aws-sdk/client-s3";

// This is the single module in the production app that imports the AWS S3 SDK:
// every S3 operation goes through the functions exported here. Keeping the SDK
// behind one boundary localizes the one heavyweight dependency and lets the
// client be constructed lazily — see `client()`. (The `_poc/` sandbox has its
// own copy with the not-yet-promoted upload/download operations.)

/** @type {S3Client | undefined} */
let _client;

/**
 * The shared S3 client, constructed on first use. Construction is deferred on
 * purpose: it resolves AWS region/credentials, so building it eagerly would make
 * commands that never touch S3 (`list`, `tree`, …) fail when no AWS credentials
 * are configured — even though they share this app's single entry point. Only
 * the S3 operations below call this, so those commands never trigger it.
 * @returns {S3Client}
 */
function client() {
  return (_client ??= new S3Client({ followRegionRedirects: true }));
}

/**
 * List the objects stored under an `s3://bucket/prefix` URI. Takes a URI (not a
 * bare bucket) so it stays general — callers can list any bucket+prefix.
 * @param {string} uri - An S3 URI; its path is used as the key prefix.
 * @returns {AsyncGenerator<import("@aws-sdk/client-s3")._Object>}
 */
export async function* listObjects(uri) {
  const { Bucket, Key: Prefix } = parseS3Uri(uri);
  for await (const page of paginateListObjectsV2(
    { client: client() },
    { Bucket, Prefix },
  )) {
    yield* page.Contents ?? [];
  }
}

/**
 * Parse an `s3://bucket/key` URI into its bucket and key.
 * @param {string} uri
 * @returns {{ Bucket: string, Key: string }}
 */
export function parseS3Uri(uri) {
  const url = new URL(uri);
  if (url.protocol !== "s3:") {
    throw new Error(`Expected an s3:// URI (got ${url.protocol}//)`);
  }
  return { Bucket: url.hostname, Key: url.pathname.slice(1) };
}
