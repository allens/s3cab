import { Buffer } from "node:buffer";
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// The real-AWS out-of-band inspector — the instrument the model reads a real
// bucket through. Extracted from conformance/real-s3.mjs when the crash tier
// became its second consumer: this module is the ungated mechanism, and each
// tier front-ends it with its own bucket gate (conformance/real-s3.mjs
// requires `test-s3cab-*-conformance`; test/crash/harness.mjs requires
// `test-s3cab-*-crash`), because the gate — not the class — is what keeps
// `wipe()` pointed only at a sole-owner test bucket.
//
// The inspector deliberately builds its **own** SDK client instead of reusing
// src/lib/s3.mjs — the code under test must not be the instrument that
// verifies it (a listing bug in the seam would hide itself from a model that
// lists through the seam). Importing the SDK here is not an ADR-0059 breach:
// that boundary quarantines *provisioning* APIs to the `aws` command; this is
// the S3 data plane, in test code, on purpose.

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
   * In-progress (uncompleted) multipart uploads — what a kill mid-multipart
   * strands, invisible to ListObjects.
   * @param {string} bucketName
   * @returns {Promise<{ key: string, uploadId: string }[]>}
   */
  async listMultipartUploads(bucketName) {
    /** @type {{ key: string, uploadId: string }[]} */
    const uploads = [];
    /** @type {string | undefined} */
    let keyMarker;
    /** @type {string | undefined} */
    let idMarker;
    do {
      const page = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          UploadIdMarker: idMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        uploads.push({
          key: /** @type {string} */ (upload.Key),
          uploadId: /** @type {string} */ (upload.UploadId),
        });
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      idMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker !== undefined || idMarker !== undefined);
    return uploads;
  }

  /**
   * Abort one in-progress multipart upload (crash tests strand them; the
   * bucket lifecycle would reap them in a day, but per-case assertions need
   * a clean slate now).
   * @param {string} bucketName
   * @param {string} key
   * @param {string} uploadId
   */
  async abortMultipartUpload(bucketName, key, uploadId) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        UploadId: uploadId,
      }),
    );
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
   * each tier's module-level name gate is what makes this callable at all.
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
