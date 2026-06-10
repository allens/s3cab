import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  S3Client,
  ServerSideEncryption,
  StorageClass,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { resolveCredentials } from "./auth.mjs";
import { createReadStream, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { clearLine, cursorTo } from "node:readline";
import { PassThrough, Readable } from "node:stream";

// This is the single module in the production app that imports the AWS S3 SDK:
// every S3 operation goes through the functions exported here. Keeping the SDK
// behind one boundary localizes the one heavyweight dependency and lets the
// client be constructed lazily — see `client()`.

/** @type {S3Client | undefined} */
let _client;

/**
 * The custom S3 endpoint, if one is configured — present for any S3-compatible
 * provider that isn't AWS (Cloudflare R2, Backblaze B2, MinIO, Wasabi, …). Its
 * presence is the single `targets-AWS?` signal: a set endpoint means "not AWS",
 * which gates the AWS-only behaviours (region redirects, storage class, SSE).
 *
 * Honours the SDK-native `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` variables
 * rather than inventing new surface (#5/#6); a friendlier per-destination
 * endpoint UX belongs to the `setup` command. Read after the caller has loaded
 * the s3cab env files (e.g. commands call `loadEnv`), so file values are in scope.
 * @returns {string | undefined}
 */
const customEndpoint = () =>
  process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL;

/**
 * The shared S3 client, constructed on first use. Deferred on purpose: it
 * resolves AWS region/credentials, so building it eagerly would make commands
 * that never touch S3 (`list`, `tree`, …) fail when none are configured — even
 * though they share this app's single entry point. Only the S3 operations below
 * call this, so those commands never trigger it.
 *
 * Credentials come from `src/lib/auth.mjs` (env files → standard AWS chain →
 * app-managed `s3cab login` cache → actionable error — see specs/auth.md). The
 * env files are loaded up front by the CLI dispatcher (`s3cab.mjs`) before the
 * command runs, so `process.env` (region / endpoint / credentials) is already in
 * place by the time any S3 operation here builds this client.
 * @returns {S3Client}
 */
function client() {
  if (_client) return _client;
  const endpoint = customEndpoint();
  return (_client = new S3Client({
    // Bootstrap region only, so ordinary users needn't configure AWS: SigV4 needs
    // *a* region to sign the first request, so default to us-east-1 when none is
    // set. An explicit env override still wins (and is required by providers that
    // care about the region label). On AWS, `followRegionRedirects` then
    // auto-corrects to the bucket's real region via its 301 — an AWS-only
    // behaviour, so it is dropped (and `endpoint` used instead) off AWS.
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    ...(endpoint ? { endpoint } : { followRegionRedirects: true }),
    credentials: resolveCredentials,
  }));
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

class S3ReadStream extends PassThrough {
  /** @param {string} uri */
  constructor(uri) {
    super();
    this.uri = uri;
  }
  /** @param {(error?: Error | null) => void} callback */
  _construct(callback) {
    const { Bucket, Key } = parseS3Uri(this.uri);
    client()
      .send(new GetObjectCommand({ Bucket, Key }))
      .then(({ Body }) => {
        if (Body instanceof Readable) {
          Body.pipe(this);
        }
        callback();
      })
      .catch(callback);
  }
}

/**
 * Open a readable stream over an S3 object.
 * @param {string} uri - The `s3://bucket/key` URI of the object.
 * @returns {S3ReadStream}
 */
export const createS3ReadStream = (uri) => new S3ReadStream(uri);

const PROGRESS_BAR_RANGE = 20;
const partSize = 8 * 1024 * 1024; // AWS CLI's default multipart_chunksize

/** @param {import("@aws-sdk/lib-storage").Progress} progress */
const httpUploadProgressHandler = ({ Bucket, Key, loaded = 0, total = 0 }) => {
  const progress = total
    ? Math.round((loaded / total) * PROGRESS_BAR_RANGE)
    : 0;

  const progressBar =
    "*".repeat(progress) + ".".repeat(PROGRESS_BAR_RANGE - progress);

  const progressMessage = `${progressBar} s3://${Bucket}/${Key}: uploaded ${loaded} of ${total} `;

  // Progress is not the command's result, so it goes to stderr (stream discipline).
  clearLine(process.stderr, -1);
  cursorTo(process.stderr, 0);
  process.stderr.write(progressMessage);
  cursorTo(process.stderr, progress);
};

/**
 * Upload a file to S3.
 * @param {string} path - The path to the file.
 * @param {string} uri - The S3 URI.
 * @param {object} [options] - The options.
 * @param {boolean} [options.noClobber] - Do not overwrite existing files.
 * @returns {Promise<boolean>} True if the file was uploaded.
 */
export async function putFile(path, uri, options = {}) {
  const { noClobber } = options;

  const { Bucket, Key } = parseS3Uri(uri);

  const { size, mtime } = statSync(path);

  if (noClobber && size >= partSize) {
    const exists = await objectExists(uri);
    if (exists) {
      return false;
    }
  }

  const s3 = client(); // customEndpoint() is in scope below (env already loaded)

  const upload = new Upload({
    client: s3,
    params: {
      Bucket,
      Key,
      Body: createReadStream(path),
      // StorageClass + ServerSideEncryption are AWS-isms that S3-compatible
      // providers (R2/B2/Spaces) reject; send them only when targeting AWS.
      // The x-amz-meta-* metadata below is portable, so it always goes.
      ...(customEndpoint()
        ? {}
        : {
            ServerSideEncryption: ServerSideEncryption.AES256,
            StorageClass: StorageClass.INTELLIGENT_TIERING,
          }),
      Metadata: {
        "x-amz-meta-hostname": hostname(),
        "x-amz-meta-username": userInfo().username,
        "x-amz-meta-path": path,
        "x-amz-meta-size": size.toString(),
        "x-amz-meta-mtime": mtime.toString(),
        "x-amz-meta-date": new Date().toISOString(),
      },
      ...(noClobber ? { IfNoneMatch: "*" } : {}),
    },
    partSize,
  });

  upload.on("httpUploadProgress", httpUploadProgressHandler);

  try {
    await upload.done();
  } catch (error) {
    if (
      noClobber &&
      /** @type {Error} */ (error).name === "PreconditionFailed"
    ) {
      return false;
    } else {
      throw error;
    }
  }

  // Close off the in-place progress line (which was written to stderr).
  process.stderr.write("\n");
  return true;
}

/**
 * Whether an object should count as existing for `putFile`'s multipart
 * `--no-clobber` preflight. This deliberately mirrors the old `getMetadata()`
 * behaviour: a successful HEAD only counts when the object has custom metadata.
 *
 * This keeps the preflight aligned with the historical semantics: an object that
 * exists but has no custom metadata is treated as absent here and left to the
 * upload's conditional PUT (`IfNoneMatch: "*"`) to reject if needed.
 * @param {string} uri - The S3 URI.
 * @returns {Promise<boolean>}
 */
async function objectExists(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    const { Metadata } = await client().send(
      new HeadObjectCommand({ Bucket, Key }),
    );
    return Object.keys(Metadata ?? {}).length > 0;
  } catch (error) {
    if (/** @type {Error} */ (error).name === "NotFound") {
      return false;
    }
    throw error;
  }
}

/**
 * An IAM policy granting list + per-object access to a bucket. **AWS-only** —
 * the `arn:aws:s3:::` ARNs and IAM JSON are meaningless off AWS. Unused today
 * (only `setup`, a stub, would call it); provider-aware bucket creation/policy is
 * deferred to when `setup` is actually built (see specs/s3-provider-compatibility.md).
 * @param {string} bucketName
 */
export const bucketPolicy = (bucketName) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ListObjectsInBucket",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${bucketName}`],
    },
    {
      Sid: "AllObjectActions",
      Effect: "Allow",
      Action: "s3:*Object",
      Resource: [`arn:aws:s3:::${bucketName}/*`],
    },
  ],
});

/**
 * Empty an S3 bucket (delete every object in it).
 * @param {string} bucketName
 */
export async function emptyBucket(bucketName) {
  for await (const { Key } of listObjects(`s3://${bucketName}`)) {
    if (!Key) continue;
    await client().send(new DeleteObjectCommand({ Bucket: bucketName, Key }));
    // Progress, not a result → stderr.
    console.warn(`Deleted: ${Key}`);
  }
}
