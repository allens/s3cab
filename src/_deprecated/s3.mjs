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

/**
 * @type {S3Client}
 */
let _client;
const lazyClient = () => {
  try {
    _client ??= new S3Client({ followRegionRedirects: true });
  } catch (error) {
    console.error(error);
  }
  return _client;
};

/**
 *
 * @param {string} uri S3 URI string
 * @returns {{Bucket: string, Key: string}} S3 Bucket and Key
 */
export const parseS3Uri = (uri) => {
  const url = new URL(uri);

  if (url.protocol !== "s3:") {
    throw new Error("Expected protocol to be 's3:'");
  }

  return { Bucket: url.hostname, Key: url.pathname.slice(1) };
};

class S3ReadStream extends PassThrough {
  constructor(uri) {
    super();
    this.uri = uri;
  }
  _construct(callback) {
    const { Bucket, Key } = parseS3Uri(this.uri);

    lazyClient()
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
export const createS3ReadStream = (uri) => new S3ReadStream(uri);

/**
 * List objects in an S3 bucket.
 * @param {string} uri - The S3 URI.
 */
export async function* listObjects(uri) {
  const { Bucket, Key: Prefix } = parseS3Uri(uri);
  const paginator = paginateListObjectsV2(
    { client: lazyClient() },
    { Bucket, Prefix },
  );
  for await (const page of paginator) {
    yield* page.Contents ?? [];
  }
}

const PROGRESS_BAR_RANGE = 20;
const partSize = 5 * 1024 * 1024;

const httpUploadProgressHandler = ({ Bucket, Key, loaded, total }) => {
  const progress = Math.round((loaded / total) * PROGRESS_BAR_RANGE);

  const progressBar =
    "*".repeat(progress) + ".".repeat(PROGRESS_BAR_RANGE - progress);

  const progressMessage = `${progressBar} s3://${Bucket}/${Key}: uploaded ${loaded} of ${total} `;

  clearLine(process.stdout, -1);
  cursorTo(process.stdout, 0);
  process.stdout.write(progressMessage);
  cursorTo(process.stdout, progress);
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
    client: lazyClient(),
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
    if (noClobber && error.name === "PreconditionFailed") {
      return false;
    } else {
      throw error;
    }
  }

  console.log();
  return true;
}

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
 * Get the metadata of an S3 object.
 * @param {string} uri - The S3 URI.
 * @returns {Promise<object>} The object metadata.
 */
async function getMetadata(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    const { Metadata } = await lazyClient().send(
      new HeadObjectCommand({ Bucket, Key }),
    );
    return {
      hostname: Metadata["x-amz-meta-hostname"],
      username: Metadata["x-amz-meta-username"],
      path: Metadata["x-amz-meta-path"],
      size: parseInt(Metadata["x-amz-meta-size"]),
      mtime: parseInt(Metadata["x-amz-meta-mtime"]),
      date: new Date(Metadata["x-amz-meta-date"]),
    };
  } catch (error) {
    if (error.name === "NotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Empty an S3 bucket.
 * @param {string} bucketName
 */
export async function emptyBucket(bucketName) {
  const objects = listObjects(`s3://${bucketName}`);
  for await (const { Key } of objects) {
    lazyClient().send(new DeleteObjectCommand({ Bucket: bucketName, Key }));
    console.log(`Deleted: ${Key}`);
  }
}
