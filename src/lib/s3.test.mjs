import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { clientConfig, putObjectParams } from "./s3.mjs";

// Always-on, no-bucket guard for the non-AWS request shaping: an upload through a
// custom endpoint must carry NO data-integrity checksum trailer, NO server-side
// encryption, and NO storage-class header (several S3-compatible providers reject
// them — specs/s3-provider-compatibility.md Finding 3). The gating lives in two
// places — clientConfig() (checksum mode) and putObjectParams() (SSE/storage-class)
// — and only manifests in the *outgoing request*, so we capture the request the SDK
// would put on the wire rather than asserting an upload "succeeds" (a trailer-tolerant
// provider would pass that vacuously — see specs/testing.md, the request-shaping row).

/**
 * Send `command` through a client built from `config` plus a capturing
 * requestHandler (static creds, no network), and return the serialized HTTP
 * request the SDK would have sent.
 * @param {import("@aws-sdk/client-s3").S3ClientConfig} config
 * @param {PutObjectCommand} command
 * @returns {Promise<any>}
 */
async function captureRequest(config, command) {
  /** @type {any} */
  let captured;
  /** @type {any} */
  const requestHandler = {
    async handle(/** @type {any} */ request) {
      captured = request;
      return {
        response: {
          statusCode: 200,
          headers: { etag: '"test"' },
          body: undefined,
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };
  const client = new S3Client({
    ...config,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestHandler,
  });
  await client.send(command);
  return captured;
}

/**
 * The lowercased `x-amz-*` header names on a captured request.
 * @param {any} request
 * @returns {string[]}
 */
const amzHeaders = (request) =>
  Object.keys(request.headers)
    .map((h) => h.toLowerCase())
    .filter((h) => h.startsWith("x-amz-"));

const ENDPOINT_VARS = ["AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"];

/** @type {Record<string, string | undefined>} */
let savedEnv;
/** @type {string} */
let tmpDir;
/** @type {string} */
let tmpFile;

beforeEach(() => {
  // Start each test from a known no-endpoint state, restoring the host's env after.
  savedEnv = {};
  for (const v of ENDPOINT_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  tmpDir = mkdtempSync(join(tmpdir(), "s3cab-s3-test-"));
  tmpFile = join(tmpDir, "file.txt");
  writeFileSync(tmpFile, "hello");
});

afterEach(() => {
  for (const v of ENDPOINT_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Capture the PutObject request that `putFile` would send for the current env,
 * built from the real `clientConfig()` + `putObjectParams()`. The Body is replaced
 * with a small string so the raw command serializes cleanly (putFile uploads via a
 * stream); the header gating under test is independent of the body.
 * @returns {Promise<any>}
 */
function putRequest() {
  const { size, mtime } = statSync(tmpFile);
  const params = putObjectParams(tmpFile, "s3://bucket/key", {
    size,
    mtime,
    noClobber: false,
  });
  return captureRequest(
    clientConfig(),
    new PutObjectCommand({ ...params, Body: "hello" }),
  );
}

describe("off-AWS upload request shaping (custom endpoint)", () => {
  beforeEach(() => {
    process.env.AWS_ENDPOINT_URL_S3 = "https://s3.example-provider.test";
  });

  it("omits the integrity checksum, SSE, and storage-class headers", async () => {
    const request = await putRequest();
    const headers = amzHeaders(request);

    assert.ok(
      !headers.some((h) => h.startsWith("x-amz-checksum-")),
      `unexpected checksum header off-AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      !headers.includes("x-amz-sdk-checksum-algorithm"),
      `unexpected checksum-algorithm header off-AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      // The checksum can ride as a trailer (streamed body) rather than an
      // x-amz-checksum-* header — assert that channel is clear too.
      !headers.includes("x-amz-trailer"),
      `unexpected checksum trailer off-AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      !headers.includes("x-amz-server-side-encryption"),
      `unexpected SSE header off-AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      !headers.includes("x-amz-storage-class"),
      `unexpected storage-class header off-AWS: ${headers.join(", ")}`,
    );
  });

  it("still sends the portable x-amz-meta-* metadata", async () => {
    const request = await putRequest();
    const headers = amzHeaders(request);
    assert.ok(
      headers.some((h) => h.startsWith("x-amz-meta-")),
      `portable metadata missing off-AWS: ${headers.join(", ")}`,
    );
  });
});

describe("AWS upload request shaping (no custom endpoint)", () => {
  it("sends the integrity checksum, SSE, and storage-class headers", async () => {
    const request = await putRequest();
    const headers = amzHeaders(request);

    assert.ok(
      // Representation-independent: x-amz-sdk-checksum-algorithm is set whether the
      // checksum rides as an x-amz-checksum-* header (in-memory body) or an
      // x-amz-trailer (streamed body), so this guards the gate regardless of body.
      headers.includes("x-amz-sdk-checksum-algorithm"),
      `missing checksum on AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      headers.includes("x-amz-server-side-encryption"),
      `missing SSE header on AWS: ${headers.join(", ")}`,
    );
    assert.ok(
      headers.includes("x-amz-storage-class"),
      `missing storage-class header on AWS: ${headers.join(", ")}`,
    );
  });
});
