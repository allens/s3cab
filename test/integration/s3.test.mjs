import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  clientConfig,
  deleteObject,
  getStream,
  putFile,
} from "../../src/lib/s3.mjs";
import { bucket } from "../helpers/integration.mjs";

// putFile's multipart path against real S3 (S3 test strategy, ADR-0019). The
// loopback fake in src/lib/s3.test.mjs pins what requests lib-storage makes; a
// fake can't prove *S3's* answers — that a multipart body lands intact, that a
// HEAD skip means what we think, that parts-in-flight are invisible to HEAD —
// so those live here. Everything under a unique content-addressed key, deleted
// in teardown, mirroring upload.test.mjs's hygiene.

/** Must match s3.mjs's private `partSize` — the multipart threshold. */
const PART_SIZE = 8 * 1024 * 1024;

/**
 * SHA-256 of a fully-read stream, so a round-trip is checked by content, not
 * just presence.
 * @param {import("node:stream").Readable} stream
 * @returns {Promise<string>}
 */
async function sha256(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(/** @type {Buffer} */ (chunk));
  }
  return hash.digest("hex");
}

describe("putFile multipart (real bucket)", () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let file;
  /** @type {Buffer} */
  let content;
  /** @type {string} Content hash — the object key, as putObject would key it. */
  let hash;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "s3cab-it-multipart-"));
    file = join(dir, "multipart.bin");
    // PART_SIZE + 1: the smallest true multipart body (two parts; the second is
    // one byte). Random content → a unique hash, so the shared store stays
    // isolated from other runs and teardown deletes exactly what we made.
    content = Buffer.concat([randomBytes(PART_SIZE), randomBytes(1)]);
    hash = createHash("sha256").update(content).digest("hex");
    writeFileSync(file, content);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("uploads, HEAD-skips a re-upload, and force-overwrites — bytes intact", async () => {
    const uri = `s3://${bucket}/objects/${hash}`;
    try {
      // Absent → the full multipart choreography runs and the object lands.
      const wrote = await putFile(file, uri, { noClobber: true });
      assert.equal(wrote, true);

      // The round trip is content-true: what S3 assembled from the parts is
      // byte-for-byte what we hashed locally (design #1's whole premise).
      assert.equal(await sha256(await getStream(uri)), hash);

      // Present + no-clobber → skipped. At multipart size that answer comes
      // from the HEAD preflight — the real bucket confirming a skip, not a fake.
      const again = await putFile(file, uri, { noClobber: true });
      assert.equal(again, false);

      // Force (no noClobber) → the overwrite is accepted, even though present.
      const forced = await putFile(file, uri, {});
      assert.equal(forced, true);
      assert.equal(await sha256(await getStream(uri)), hash);
    } finally {
      await deleteObject(uri);
    }
  });

  it("an incomplete multipart upload is not 'present' — the object still uploads fully", async () => {
    // Seed the failure-mode remnant directly through the SDK: a Create +
    // one uploaded part, never Completed — what an interrupted backup leaves
    // behind. Parts-in-flight must be invisible (HEAD 404s) or a resumed backup
    // would "skip" an object that was never actually stored.
    const uri = `s3://${bucket}/objects/${hash}`;
    const client = new S3Client(clientConfig());
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: `objects/${hash}`,
      }),
    );
    try {
      await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: `objects/${hash}`,
          UploadId,
          PartNumber: 1,
          Body: content.subarray(0, 1024),
        }),
      );

      const wrote = await putFile(file, uri, { noClobber: true });
      assert.equal(wrote, true, "seeded parts must not read as present");
      assert.equal(await sha256(await getStream(uri)), hash);
    } finally {
      // Abort the seeded upload — orphaned parts are billed until aborted.
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: `objects/${hash}`,
            UploadId,
          }),
        )
        .catch(() => {});
      await deleteObject(uri);
      client.destroy();
    }
  });
});
