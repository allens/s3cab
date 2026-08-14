import { Buffer } from "node:buffer";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Tier 2's real-AWS backend: the gate for the conformance bucket and the
// out-of-band inspector the model reads the bucket through.
//
// The inspector deliberately builds its **own** SDK client instead of reusing
// src/lib/s3.mjs — the code under test must not be the instrument that
// verifies it (a listing bug in the seam would hide itself from a model that
// lists through the seam). Importing the SDK here is not an ADR-0059 breach:
// that boundary quarantines *provisioning* APIs to the `aws` command; this is
// the S3 data plane, in test code, on purpose.
//
// The conformance bucket is sole-owner and assertions cover whole-bucket
// state (docs/integration-testing.md, "Create a bucket"), which is why
// `wipe()` exists and why this gate refuses to point at anything outside the
// test-bucket naming convention.

const CONFORMANCE_BUCKET = process.env.S3CAB_CONFORMANCE_BUCKET;

if (!CONFORMANCE_BUCKET) {
  throw new Error(
    "No conformance bucket configured. Tier 2 conformance tests need a real,\n" +
      "versioned, sole-owner S3 bucket (docs/integration-testing.md):\n\n" +
      "    export S3CAB_CONFORMANCE_BUCKET=test-s3cab-<you>-conformance\n\n" +
      "  Working in a worktree? `.env.test` is gitignored and stays in the\n" +
      "  main checkout. Copy it across:\n" +
      "    cp ../../../.env.test .env.test\n",
  );
}
if (
  !CONFORMANCE_BUCKET.startsWith("test-s3cab-") ||
  !CONFORMANCE_BUCKET.endsWith("-conformance")
) {
  // wipe() deletes every version of every object — the name convention is the
  // safety boundary that keeps that away from real backups and from the
  // shared integration bucket.
  throw new Error(
    `Refusing conformance bucket '${CONFORMANCE_BUCKET}': the name must match ` +
      "test-s3cab-<owner>-conformance (docs/integration-testing.md). " +
      "Conformance tests wipe the whole bucket between cases.",
  );
}

/** The gated bucket — guaranteed set (the import above throws otherwise). */
export const bucket = CONFORMANCE_BUCKET;

/**
 * What real AWS S3 truthfully provides — see test/model/CAPABILITIES.md.
 * @type {ReadonlySet<string>}
 */
export const REAL_CAPABILITIES = new Set([
  "conditional-put",
  "strong-consistency",
  "list-last-modified",
  "inspection",
  "versioning",
  "multipart",
  "list-pagination",
  "throttling",
]);

const client = new S3Client({});

/**
 * The harness's inspection interface over real S3 (the same surface the
 * Tier 1 fake exposes, minus the fake-only extras — no `virtualMs`, no
 * fault plan).
 */
export class RealS3 {
  get capabilities() {
    return REAL_CAPABILITIES;
  }

  /**
   * Every key in the bucket, paginated, sorted (S3 lists lexicographically).
   * @param {string} bucketName
   * @returns {Promise<{ key: string, size: number }[]>}
   */
  async listAll(bucketName) {
    /** @type {{ key: string, size: number }[]} */
    const all = [];
    /** @type {string | undefined} */
    let token;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        all.push({
          key: /** @type {string} */ (object.Key),
          size: object.Size ?? 0,
        });
      }
      token = page.NextContinuationToken;
    } while (token);
    return all;
  }

  /**
   * @param {string} bucketName
   * @param {string} key
   * @returns {Promise<Buffer | undefined>} undefined when the key is absent
   */
  async getBytes(bucketName, key) {
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
      );
      const body = await response.Body?.transformToByteArray();
      return body === undefined ? undefined : Buffer.from(body);
    } catch (error) {
      if (/** @type {{ name?: string }} */ (error).name === "NoSuchKey") {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * @param {string} bucketName
   * @param {string} key
   * @param {Buffer | string} bytes
   */
  async putBytes(bucketName, key, bytes) {
    await client.send(
      new PutObjectCommand({ Bucket: bucketName, Key: key, Body: bytes }),
    );
  }

  /**
   * @param {string} bucketName
   * @param {string} key
   */
  async deleteKey(bucketName, key) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: [{ Key: key }] },
      }),
    );
  }

  /**
   * The object's raw head — for ETag-shape assertions (multipart uploads
   * produce `"…-N"` ETags).
   * @param {string} bucketName
   * @param {string} key
   */
  async head(bucketName, key) {
    return client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
  }

  /**
   * All versions and delete markers under a prefix — what versioning actually
   * retains, which nothing in s3cab ever looks at.
   * @param {string} bucketName
   * @param {string} prefix
   * @returns {Promise<{ versions: { key: string, latest: boolean }[],
   *   deleteMarkers: { key: string, latest: boolean }[] }>}
   */
  async listVersions(bucketName, prefix) {
    /** @type {{ key: string, latest: boolean }[]} */
    const versions = [];
    /** @type {{ key: string, latest: boolean }[]} */
    const deleteMarkers = [];
    /** @type {string | undefined} */
    let keyMarker;
    /** @type {string | undefined} */
    let versionMarker;
    do {
      const page = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const v of page.Versions ?? []) {
        versions.push({
          key: /** @type {string} */ (v.Key),
          latest: v.IsLatest === true,
        });
      }
      for (const m of page.DeleteMarkers ?? []) {
        deleteMarkers.push({
          key: /** @type {string} */ (m.Key),
          latest: m.IsLatest === true,
        });
      }
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    } while (keyMarker !== undefined || versionMarker !== undefined);
    return { versions, deleteMarkers };
  }

  /**
   * Delete **every version and delete marker** in the bucket — the
   * whole-bucket reset conformance cases start from. Sole-owner bucket only;
   * the module-level name guard is what makes this callable at all.
   * @param {string} bucketName
   */
  async wipe(bucketName) {
    for (;;) {
      /** @type {{ Key: string, VersionId: string }[]} */
      const targets = [];
      const page = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucketName }),
      );
      for (const v of page.Versions ?? []) {
        targets.push({
          Key: /** @type {string} */ (v.Key),
          VersionId: /** @type {string} */ (v.VersionId),
        });
      }
      for (const m of page.DeleteMarkers ?? []) {
        targets.push({
          Key: /** @type {string} */ (m.Key),
          VersionId: /** @type {string} */ (m.VersionId),
        });
      }
      if (targets.length === 0) {
        return;
      }
      for (let i = 0; i < targets.length; i += 1000) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: targets.slice(i, i + 1000), Quiet: true },
          }),
        );
      }
    }
  }
}
