import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  authNotice,
  bucketPolicy,
  clientConfig,
  credentialErrorRelay,
  formatUploadProgress,
  isObjectNotFound,
  putObjectParams,
} from "./s3.mjs";

// Always-on, no-bucket guard for the non-AWS request shaping: an upload through a
// custom endpoint must carry NO data-integrity checksum trailer, NO server-side
// encryption, and NO storage-class header (several S3-compatible providers reject
// them — docs/design/s3-provider-compatibility.md Finding 3). The gating lives in two
// places — clientConfig() (checksum mode) and putObjectParams() (SSE/storage-class)
// — and only manifests in the *outgoing request*, so we capture the request the SDK
// would put on the wire rather than asserting an upload "succeeds" (a trailer-tolerant
// provider would pass that vacuously — see docs/design/testing.md, the request-shaping row).

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

beforeEach(() => {
  // Start each test from a known no-endpoint state, restoring the host's env after.
  savedEnv = {};
  for (const v of ENDPOINT_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of ENDPOINT_VARS) {
    if (savedEnv[v] === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = savedEnv[v];
    }
  }
});

/**
 * Capture the PutObject request that `putFile` would send for the current env,
 * built from the real `clientConfig()` + `putObjectParams()`. `putObjectParams`
 * is pure (putFile supplies the Body stream), so the test needs no real file; a
 * small string Body lets the raw command serialize cleanly, and the header gating
 * under test is independent of the body.
 * @returns {Promise<any>}
 */
function putRequest() {
  const params = putObjectParams("/example/file.txt", "s3://bucket/key", {
    size: 5,
    mtime: new Date(0),
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

  it("sends the portable metadata as single-prefixed x-amz-meta-* headers", async () => {
    const request = await putRequest();
    const headers = amzHeaders(request);
    assert.ok(
      headers.includes("x-amz-meta-hostname"),
      `expected single-prefixed metadata header: ${headers.join(", ")}`,
    );
    assert.ok(
      // Metadata keys must be bare; pre-prefixing double-prefixes on the wire.
      !headers.some((h) => h.startsWith("x-amz-meta-x-amz-meta-")),
      `metadata header is double-prefixed: ${headers.join(", ")}`,
    );
  });
});

describe("bucketPolicy", () => {
  it("scopes object actions to …/* and ListBucket to the bare bucket ARN", () => {
    const { Statement } = bucketPolicy("my-backups");
    const list = Statement.find((s) => s.Action.includes("s3:ListBucket"));
    const objects = Statement.find((s) => s.Action.includes("s3:GetObject"));
    assert.deepEqual(list?.Resource, ["arn:aws:s3:::my-backups"]);
    assert.deepEqual(objects?.Resource, ["arn:aws:s3:::my-backups/*"]);
  });

  it("grants explicit soft-delete object verbs — never the s3:*Object wildcard", () => {
    const actions = bucketPolicy("my-backups").Statement.flatMap(
      (s) => s.Action,
    );
    assert.deepEqual([...actions].sort(), [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
    // The security seam: a wildcard would silently re-grant DeleteObjectVersion,
    // which the everyday key must never hold (it must never permanently destroy
    // history — docs/adr/0033). Guard both the wildcard and the version verb.
    assert.ok(
      !actions.some((a) => a.includes("*")),
      `unexpected wildcard: ${actions}`,
    );
    assert.ok(
      !actions.includes("s3:DeleteObjectVersion"),
      "everyday policy must not grant DeleteObjectVersion",
    );
  });
});

describe("formatUploadProgress", () => {
  it("humanizes the byte counts rather than printing raw integers", () => {
    const { message } = formatUploadProgress(
      { loaded: 1000, total: 10000 },
      "photos/beach.jpg",
    );
    assert.match(message, /1kB of 10kB/);
    // Guards against the regression to raw integers ("1000 of 10000").
    assert.doesNotMatch(message, /\b1000\b/);
    assert.doesNotMatch(message, /\b10000\b/);
  });

  it("labels the line with the file path, not the object hash", () => {
    const { message } = formatUploadProgress(
      { loaded: 1000, total: 10000 },
      "photos/beach.jpg",
    );
    assert.match(message, /photos\/beach\.jpg/);
    // The content-addressed key is storage machinery, never shown to the user.
    assert.doesNotMatch(message, /s3:\/\//);
    assert.doesNotMatch(message, /objects\//);
  });

  it("leads with the fixed-width bar and trails with the variable path", () => {
    const { message } = formatUploadProgress(
      { loaded: 1000, total: 10000 },
      "photos/beach.jpg",
    );
    // Bar first (fixed 20 chars), path last: fixed columns lead so the bar edge
    // and byte counts stay aligned as paths vary from file to file.
    assert.match(message, /^[*.]{20} /);
    assert.match(message, /photos\/beach\.jpg$/);
    assert.ok(
      message.indexOf("kB") < message.indexOf("photos"),
      "byte counts must precede the trailing path",
    );
  });

  it("pads the byte columns so the path starts at a fixed column", () => {
    const small = formatUploadProgress({ loaded: 41, total: 41 }, "a.txt");
    const large = formatUploadProgress(
      { loaded: 176400, total: 176400 },
      "b.txt",
    );
    // A tiny "41B" file and a "176.4kB" file must put their paths in the same
    // column — the whole point of padding the size fields.
    assert.equal(
      small.message.indexOf("a.txt"),
      large.message.indexOf("b.txt"),
    );
  });

  it("omits the 'of <total>' segment when total is unknown", () => {
    const { message, fill } = formatUploadProgress(
      { loaded: 1500 },
      "photos/beach.jpg",
    );
    assert.match(message, /1\.5kB/);
    assert.doesNotMatch(message, / of /); // no misleading "of 0B"
    assert.equal(fill, 0); // no bar fill without a known total
  });

  it("keeps the path aligned whether or not the total is known", () => {
    const known = formatUploadProgress({ loaded: 41, total: 41 }, "x.txt");
    const unknown = formatUploadProgress({ loaded: 41 }, "x.txt");
    // The unknown-total line reserves the " of <total>" width, so the path does
    // not jump left when a progress event arrives without a total.
    assert.equal(
      known.message.indexOf("x.txt"),
      unknown.message.indexOf("x.txt"),
    );
  });

  it("fills the bar proportionally when total is known", () => {
    const { fill } = formatUploadProgress(
      { loaded: 5, total: 10 },
      "photos/beach.jpg",
    );
    assert.equal(fill, 10); // half of the 20-char bar
  });
});

describe("authNotice", () => {
  it("reports the profile alone when no custom endpoint is set", () => {
    assert.equal(authNotice({ profile: "work" }), "Using AWS profile: work");
  });

  it("appends where the profile came from when a source is given", () => {
    assert.equal(
      authNotice({ profile: "work", profileSource: "your environment" }),
      "Using AWS profile: work (from your environment)",
    );
    assert.equal(
      authNotice({ profile: "work", profileSource: "set 'photos' config" }),
      "Using AWS profile: work (from set 'photos' config)",
    );
  });

  it("reports both profile and endpoint when both are set", () => {
    assert.equal(
      authNotice({ profile: "work", endpoint: "https://example.r2" }),
      "Using AWS profile: work, endpoint: https://example.r2",
    );
  });

  it("places the profile source before the endpoint when both are present", () => {
    assert.equal(
      authNotice({
        profile: "work",
        profileSource: "~/.s3cab/env",
        endpoint: "https://example.r2",
      }),
      "Using AWS profile: work (from ~/.s3cab/env), endpoint: https://example.r2",
    );
  });

  it("reports the endpoint alone when there's no profile (keys-based)", () => {
    assert.equal(
      authNotice({ endpoint: "https://example.r2" }),
      "Using S3 endpoint: https://example.r2",
    );
  });

  it("falls back to a generic line for default AWS credentials with no profile", () => {
    // Never silent: something must print before the first network request so a
    // slow first S3 call doesn't look hung (clig.dev responsiveness).
    assert.equal(authNotice({}), "Contacting the cloud…");
  });

  it("treats an empty profile as none", () => {
    assert.equal(authNotice({ profile: "" }), "Contacting the cloud…");
  });
});

describe("credentialErrorRelay", () => {
  /** An error carrying the AWS-style `name` the SDK sets from the service code. */
  const named = (/** @type {string} */ name) =>
    Object.assign(new Error(`raw text for ${name}`), { name });

  /** Run the relay over a `next` that throws `cause`, optionally with a request input. */
  const rejectWith = (
    /** @type {Error} */ cause,
    /** @type {any} */ input = {},
  ) =>
    credentialErrorRelay(async () => {
      throw cause;
    })({ input });

  // Each recognized code routes to its factory's message; the relay matches on
  // error.name (never HTTP status) and first match wins (ADR-0037).
  for (const { code, expect } of [
    { code: "ExpiredToken", expect: /Your AWS credentials have expired/ },
    {
      code: "TokenRefreshRequired",
      expect: /Your AWS credentials have expired/,
    },
    { code: "InvalidToken", expect: /rejected as invalid/ },
    { code: "InvalidAccessKeyId", expect: /rejected as invalid/ },
    { code: "InvalidSecurity", expect: /rejected as invalid/ },
    { code: "SignatureDoesNotMatch", expect: /signature mismatch/ },
    { code: "RequestTimeTooSkewed", expect: /clock is too far out of sync/ },
  ]) {
    it(`maps a request-time ${code} rejection to its actionable error`, async () => {
      const cause = named(code);
      await assert.rejects(rejectWith(cause), (/** @type {any} */ error) => {
        assert.equal(error.cause, cause); // original kept for the debug path
        assert.match(error.message, expect);
        return true;
      });
    });
  }

  it("threads the request bucket into the AccessDenied remedy", async () => {
    await assert.rejects(
      rejectWith(named("AccessDenied"), { Bucket: "my-backups" }),
      (/** @type {any} */ error) => {
        assert.match(error.message, /the bucket "my-backups"/);
        assert.match(error.message, /s3cab aws my-backups/); // AWS remedy (no custom endpoint)
        return true;
      },
    );
  });

  it("rethrows an unrecognized code raw (no mushy middle)", async () => {
    const cause = named("AccountProblem");
    await assert.rejects(rejectWith(cause), (error) => error === cause);
  });

  it("passes a successful result through", async () => {
    const next = async () => "ok";
    assert.equal(await credentialErrorRelay(next)({ input: {} }), "ok");
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

describe("isObjectNotFound", () => {
  it("recognizes a GET NoSuchKey and a HEAD/provider NotFound", () => {
    assert.equal(
      isObjectNotFound(Object.assign(new Error("gone"), { name: "NoSuchKey" })),
      true,
    );
    assert.equal(
      isObjectNotFound(Object.assign(new Error("gone"), { name: "NotFound" })),
      true,
    );
  });

  it("is false for other S3 / non-Error failures", () => {
    assert.equal(
      isObjectNotFound(
        Object.assign(new Error("denied"), { name: "AccessDenied" }),
      ),
      false,
    );
    assert.equal(isObjectNotFound(new Error("plain")), false);
    assert.equal(isObjectNotFound("NoSuchKey"), false);
    assert.equal(isObjectNotFound(undefined), false);
  });
});
