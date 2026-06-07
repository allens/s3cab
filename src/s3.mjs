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
const partSize = 5 * 1024 * 1024;

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
    const metadata = await getMetadata(uri);
    if (metadata === null) {
      return false;
    }
  }

  const upload = new Upload({
    client: client(),
    params: {
      Bucket,
      Key,
      Body: createReadStream(path),
      ServerSideEncryption: ServerSideEncryption.AES256,
      StorageClass: StorageClass.INTELLIGENT_TIERING,
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
 * @typedef {object} ObjectMetadata
 * @property {string} hostname
 * @property {string} username
 * @property {string} path
 * @property {number} size
 * @property {number} mtime
 * @property {Date} date
 */

/**
 * Get the metadata of an S3 object.
 * @param {string} uri - The S3 URI.
 * @returns {Promise<ObjectMetadata | null>} The metadata, or null if absent.
 */
async function getMetadata(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    const { Metadata } = await client().send(
      new HeadObjectCommand({ Bucket, Key }),
    );
    if (!Metadata) {
      return null;
    }
    return {
      hostname: Metadata["x-amz-meta-hostname"],
      username: Metadata["x-amz-meta-username"],
      path: Metadata["x-amz-meta-path"],
      size: parseInt(Metadata["x-amz-meta-size"]),
      mtime: parseInt(Metadata["x-amz-meta-mtime"]),
      date: new Date(Metadata["x-amz-meta-date"]),
    };
  } catch (error) {
    if (/** @type {Error} */ (error).name === "NotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * An IAM policy granting list + per-object access to a bucket.
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
