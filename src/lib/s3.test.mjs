import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  authNotice,
  bucketPolicy,
  clientConfig,
  credentialErrorRelay,
  formatUploadProgress,
  isObjectNotFound,
  putFile,
  putObjectParams,
} from "./s3.mjs";

/** @import { S3ClientConfig } from "@aws-sdk/client-s3" */
/** @import { Server } from "node:http" */
/** @import { AddressInfo } from "node:net" */

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
 * @param {S3ClientConfig} config
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
  const params = putObjectParams("s3://bucket/key", { noClobber: false });
  return captureRequest(
    clientConfig(),
    new PutObjectCommand({ ...params, Body: "hello" }),
  );
}

// The timeouts, asserted by *behaviour* (ADR-0065). A server that accepts the request
// and then goes silent is precisely the half-open link the timeouts exist for, and the
// only way to tell an idle timeout that kills the request from one that merely logs a
// warning and lets it hang. Loopback only; no bucket, no network.
//
// This suite used to assert the *values* ("both timeouts are set and non-zero") — which
// is exactly how the bug it now guards shipped: `requestTimeout` was non-zero the whole
// time, and never once broke a hang.

describe("clientConfig request timeouts", () => {
  /** @type {Server} */
  let server;

  /** Long enough that only a genuine hang trips it, next to the 500 ms below. */
  const HANG_GUARD_MS = 5_000;

  before(async () => {
    // Accept the connection, drain the request, then never answer — the silence
    // has to come *after* a fully received request, or the socket goes idle for
    // the wrong reason. Left undrained, a body bigger than the socket buffer
    // would stall on write backpressure instead, which trips the same timeout
    // and would pass this test for a scenario it doesn't describe.
    server = createServer((request) => request.resume());
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(undefined)),
    );
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  it("fails a silent connection instead of hanging on it", async () => {
    const { port } = /** @type {AddressInfo} */ (server.address());
    // Production's own handler options, with every duration cut to keep the test
    // quick. Taking the *keys* from clientConfig() is the point: switch back to
    // `requestTimeout` — which only warns — and this fails here rather than in
    // someone's backup.
    const options = /** @type {Record<string, unknown>} */ (
      clientConfig().requestHandler
    );
    const requestHandler = Object.fromEntries(
      Object.entries(options).map(([option, value]) => [
        option,
        typeof value === "number" ? 500 : value,
      ]),
    );
    const client = new S3Client({
      ...clientConfig(),
      requestHandler,
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      // One shot: we're asserting the timeout fires at all, not the retry policy.
      maxAttempts: 1,
    });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let guard;
    const hang = new Promise((_, reject) => {
      guard = setTimeout(
        () => reject(new Error("the request hung: no idle timeout ever fired")),
        HANG_GUARD_MS,
      );
    });
    const put = new PutObjectCommand({
      Bucket: "bucket",
      Key: "key",
      Body: "hello",
    });
    try {
      await assert.rejects(
        () => Promise.race([client.send(put), hang]),
        { name: "TimeoutError" },
        "a silent connection must raise a TimeoutError, not hang",
      );
    } finally {
      clearTimeout(guard);
      client.destroy();
    }
  });

  it("caps the connection phase as well", () => {
    // No behavioural twin for this one: a connect that never completes needs a
    // blackholed address, which isn't hermetic. Non-zero is the invariant — zero
    // or undefined is the SDK default that waits forever.
    const requestHandler = /** @type {{ connectionTimeout?: number }} */ (
      clientConfig().requestHandler
    );
    assert.ok(
      Number.isFinite(requestHandler?.connectionTimeout) &&
        Number(requestHandler.connectionTimeout) > 0,
      `connectionTimeout must be a positive number, got ${requestHandler?.connectionTimeout}`,
    );
  });
});

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

  it("sends no x-amz-meta-* metadata at all", async () => {
    const request = await putRequest();
    const headers = amzHeaders(request);
    // An object under objects/<sha256> is content, not a file: dedup shares it across
    // many paths, so per-file facts stamped here would name an arbitrary one of them.
    // They also can't survive the wire — HTTP headers are Latin-1 (see the non-ASCII
    // putFile test). The snapshot TSV is where per-file facts belong.
    assert.deepEqual(
      headers.filter((h) => h.startsWith("x-amz-meta-")),
      [],
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
    assert.match(message, /1\.0kB of 10\.0kB/);
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
        profileSource: "set 'photos' config",
        endpoint: "https://example.r2",
      }),
      "Using AWS profile: work (from set 'photos' config), endpoint: https://example.r2",
    );
  });

  it("reports the endpoint alone when there's no profile (keys-based)", () => {
    assert.equal(
      authNotice({ endpoint: "https://example.r2" }),
      "Using S3 endpoint: https://example.r2",
    );
  });

  it("reports Roles Anywhere, taking precedence over any profile/endpoint", () => {
    assert.equal(
      authNotice({ rolesAnywhere: true }),
      "Using Roles Anywhere (keyless)",
    );
    // RA routes to the cert signer, so profile/endpoint (even if hand-left in the
    // env) are irrelevant — the notice mirrors resolveCredentials' RA-first check.
    assert.equal(
      authNotice({
        rolesAnywhere: true,
        profile: "work",
        endpoint: "https://example.r2",
      }),
      "Using Roles Anywhere (keyless)",
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
    // Pin the tier, not just its presence: s3cab uploads straight to Glacier
    // Instant Retrieval — the cheapest instant-access class — so an accidental
    // revert to Intelligent-Tiering (which strands sub-128 KB objects at
    // Standard price) fails here. See ADR-0066.
    assert.equal(
      request.headers["x-amz-storage-class"],
      "GLACIER_IR",
      `expected Glacier IR storage class, got ${request.headers["x-amz-storage-class"]}`,
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

describe("putObjectParams", () => {
  it('makes the PUT conditional (IfNoneMatch: "*") only under noClobber', () => {
    // The conditional PUT is no-clobber's correctness backstop (the HEAD
    // preflight is only an optimization), so the flag must map to the param.
    const guarded = putObjectParams("s3://bucket/key", { noClobber: true });
    assert.equal(guarded.IfNoneMatch, "*");
    // …and --force (or a caller passing nothing) must NOT carry it, or every
    // overwrite would 412.
    const forced = putObjectParams("s3://bucket/key", { noClobber: false });
    assert.ok(!("IfNoneMatch" in forced));
    const defaulted = putObjectParams("s3://bucket/key");
    assert.ok(!("IfNoneMatch" in defaulted));
  });
});

// putFile, driven end-to-end against a fake S3 on loopback. What went on the wire is
// only observable *as* the wire traffic, so this runs the real client()/SDK against a
// local server and records the requests it makes — captureRequest() above can't serve
// here: it builds its own client, while putFile goes through the module's memoized
// client(). Loopback only; no bucket, no network.

/**
 * Must match s3.mjs's private `partSize` — the multipart threshold the preflight
 * gates on. Duplicated on purpose: a `partSize` env knob for cheap multipart tests
 * was considered and dropped (2026-07-16) — S3 enforces a 5 MiB minimum part size
 * (`Upload.MIN_PART_SIZE`), so a tiny partSize could never serve the real-bucket
 * tier, and a production knob that exists only for a fake isn't worth it (ADR-0006).
 *
 * The duplication is not merely cosmetic: the sizes below are cut *from* it, so
 * these suites pin the real `partSize` behaviourally. A file of exactly PART_SIZE
 * must go as one PUT and PART_SIZE + 1 as exactly two parts — both assertions
 * break if s3.mjs's value moves without this one (ADR-0060 raised it to 16 MiB).
 */
const PART_SIZE = 16 * 1024 * 1024;

/** A sink that swallows whatever it's given — the `pipeline` end-stop for a body we only need read, not kept. */
const discard = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

/** Env this suite owns; saved and restored so the request-shaping suites stay clean. */
const AWS_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "__S3CAB_ENV_LOADED",
];

describe("putFile (fake S3 on loopback)", () => {
  /** @type {Server} */
  let server;
  /** @type {string[]} The requests the fake S3 received, in order — normalized to
   * "METHOD /path" plus the query key that names the multipart operation
   * (?uploads / ?uploadId / ?partNumber=N); the ?x-id= tag and uploadId values
   * are dropped. */
  let seen;
  /** @type {Map<string, string | undefined>} The If-None-Match header each
   * normalized request carried — the observable form of the conditional guard. */
  let conditions;
  /** @type {number} The status the fake answers the preflight HEAD with. */
  let headStatus;
  /** @type {number} The status for a plain (single-shot) PutObject. */
  let putStatus;
  /** @type {number} The status for CompleteMultipartUpload. */
  let completeStatus;
  /** @type {number} Which UploadPart to refuse with AccessDenied (0 = none). */
  let failPartNumber;
  /** @type {string} */
  let dir;
  /** @type {string} */
  let file;
  /** @type {string} One byte past PART_SIZE — the smallest true multipart body. */
  let multipartFile;
  /** @type {string} Far below PART_SIZE — the preflight must never run for it. */
  let smallFile;
  /** @type {string} A path outside Latin-1 — the class HTTP headers cannot carry. */
  let unicodeFile;
  /** @type {Record<string, string | undefined>} */
  let savedEnv;

  /** The XML S3 answers PreconditionFailed / AccessDenied / multipart calls with. */
  const errorXml = (/** @type {string} */ code) =>
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "s3cab-putfile-"));
    file = join(dir, "big.bin");
    // Exactly PART_SIZE: big enough to take the preflight branch (size >= partSize),
    // small enough that lib-storage still sends it as a single PutObject — so these
    // tests pin the single-shot boundary.
    writeFileSync(file, Buffer.alloc(PART_SIZE));
    // PART_SIZE + 1: the smallest body that forces real multipart choreography
    // (Create/UploadPart×2/Complete) — part 2 is a single byte, which S3 allows
    // for a final part.
    multipartFile = join(dir, "bigger.bin");
    writeFileSync(multipartFile, Buffer.alloc(PART_SIZE + 1));
    smallFile = join(dir, "small.bin");
    writeFileSync(smallFile, "tiny");
    // An accent and a CJK name together: ordinary filenames for most of the world, and
    // both outside what an HTTP header value can hold.
    unicodeFile = join(dir, "café-写真.jpg");
    writeFileSync(unicodeFile, "x");
    server = createServer(async (request, response) => {
      const [path, query = ""] = (request.url ?? "").split("?");
      const params = new URLSearchParams(query);
      const partNumber = params.get("partNumber");
      // One normalized line per operation. The uploadId *value* is noise (the
      // fake mints it), as is the SDK's ?x-id= tag; the query *keys* are what
      // distinguish the multipart operations from a plain PUT/DELETE.
      const op =
        request.method === "HEAD"
          ? `HEAD ${path}`
          : request.method === "POST" && params.has("uploads")
            ? `POST ${path}?uploads`
            : request.method === "POST"
              ? `POST ${path}?uploadId`
              : request.method === "DELETE"
                ? `DELETE ${path}?uploadId`
                : partNumber
                  ? `PUT ${path}?partNumber=${partNumber}`
                  : `PUT ${path}`;
      seen.push(op);
      conditions.set(op, request.headers["if-none-match"]);

      if (request.method === "HEAD") {
        // No x-amz-meta-* headers: an object carrying NO custom metadata.
        response.writeHead(headStatus, { etag: '"abc"' });
        response.end();
        return;
      }
      // Read the body to the end before answering — even before an error — as
      // real S3 does. Replying early lets putFile resolve while the SDK is still
      // writing, so teardown would race an in-flight upload. The body itself is
      // never inspected — only that it was sent at all — so it drains to a sink
      // that discards.
      await pipeline(request, discard());

      /** @param {number} status @param {string} body */
      const xml = (status, body) => {
        response.writeHead(status, { "content-type": "application/xml" });
        response.end(body);
      };

      if (op.endsWith("?uploads")) {
        // CreateMultipartUpload
        xml(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
            `<Bucket>bucket</Bucket><Key>key</Key><UploadId>fake-upload-id</UploadId>` +
            `</InitiateMultipartUploadResult>`,
        );
      } else if (partNumber) {
        // UploadPart — refusable per-test with a non-retryable error (a
        // retryable one would triple the request log under the SDK's default
        // three attempts).
        if (Number(partNumber) === failPartNumber) {
          xml(403, errorXml("AccessDenied"));
        } else {
          response.writeHead(200, { etag: `"part-${partNumber}"` });
          response.end();
        }
      } else if (request.method === "POST") {
        // CompleteMultipartUpload — where IfNoneMatch is evaluated for multipart,
        // i.e. only after every part is already uploaded.
        if (completeStatus === 200) {
          xml(
            200,
            `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
              `<Location>http://127.0.0.1/bucket/key</Location><Bucket>bucket</Bucket>` +
              `<Key>key</Key><ETag>"abc"</ETag></CompleteMultipartUploadResult>`,
          );
        } else {
          xml(completeStatus, errorXml("PreconditionFailed"));
        }
      } else if (request.method === "DELETE") {
        // AbortMultipartUpload
        response.writeHead(204);
        response.end();
      } else if (putStatus === 200) {
        response.writeHead(200, { etag: '"abc"' });
        response.end();
      } else {
        xml(putStatus, errorXml("PreconditionFailed"));
      }
    });
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(undefined)),
    );
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedEnv = {};
    for (const v of AWS_VARS) {
      savedEnv[v] = process.env[v];
    }
    const { port } = /** @type {AddressInfo} */ (server.address());
    // An IP endpoint also puts the SDK in path-style addressing, so the fake sees
    // /bucket/key rather than a virtual host it could never resolve.
    process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${port}`;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE; // static env creds must beat any host profile
    process.env.AWS_REGION = "us-east-1";
    process.env.__S3CAB_ENV_LOADED = "1"; // client()'s ADR-0022 tripwire
    seen = [];
    conditions = new Map();
    headStatus = 404;
    putStatus = 200;
    completeStatus = 200;
    failPartNumber = 0;
  });

  afterEach(() => {
    for (const v of AWS_VARS) {
      if (savedEnv[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = savedEnv[v];
      }
    }
  });

  it("skips the upload when the object exists but carries no custom metadata", async () => {
    headStatus = 200;
    const wrote = await putFile(file, "s3://bucket/key", { noClobber: true });
    assert.equal(wrote, false);
    // The whole point of the preflight: a present object costs one HEAD, never the
    // body. Any successful HEAD is "present" — an object another tool PUT without
    // x-amz-meta-* still counts (the conditional PUT would reject it anyway, but
    // only after the full body had been sent).
    assert.deepEqual(seen, ["HEAD /bucket/key"]);
  });

  it("uploads when the object is absent", async () => {
    headStatus = 404;
    const wrote = await putFile(file, "s3://bucket/key", { noClobber: true });
    assert.equal(wrote, true);
    assert.deepEqual(seen, ["HEAD /bucket/key", "PUT /bucket/key"]);
  });

  it("uploads a file whose path is not ASCII", async () => {
    // Nothing about the *request* may depend on the local path: S3 user metadata
    // rides as HTTP headers, which cannot carry café/写真/emoji — Node rejects the
    // header outright, so stamping the path onto the object made any such file
    // unbackupable, and the error surfaced as a bare TypeError mid-backup.
    const wrote = await putFile(unicodeFile, "s3://bucket/key", {});
    assert.equal(wrote, true);
    assert.deepEqual(seen, ["PUT /bucket/key"]);
  });

  // ——— The skip/accept matrix. Three layers decide whether bytes move: the
  // plan (planUpload — covered in upload.test.mjs, putFile never called), the
  // HEAD preflight (≥ partSize + noClobber only), and the conditional PUT
  // (IfNoneMatch, the correctness backstop). These pin who answers at each
  // size, in both directions, and that multipart never degrades to shipping
  // the whole body just to learn the object already existed.

  it("small + no-clobber, absent: one conditional PUT, no preflight", async () => {
    const wrote = await putFile(smallFile, "s3://bucket/key", {
      noClobber: true,
    });
    assert.equal(wrote, true);
    // Below partSize the HEAD would cost more than it saves — the conditional
    // PUT alone decides.
    assert.deepEqual(seen, ["PUT /bucket/key"]);
    assert.equal(conditions.get("PUT /bucket/key"), "*");
  });

  it("small + no-clobber, present: the conditional PUT itself refuses (412 → false)", async () => {
    putStatus = 412;
    const wrote = await putFile(smallFile, "s3://bucket/key", {
      noClobber: true,
    });
    // The PreconditionFailed catch — the guard that stops a losing racer
    // overwriting, and the one path to uploadSnapshot's "already backed up".
    assert.equal(wrote, false);
    assert.deepEqual(seen, ["PUT /bucket/key"]);
  });

  it("multipart-sized + no-clobber, present: one HEAD, never the body", async () => {
    headStatus = 200;
    const wrote = await putFile(multipartFile, "s3://bucket/key", {
      noClobber: true,
    });
    assert.equal(wrote, false);
    // The preflight's whole purpose: without it, a multipart no-clobber upload
    // ships every part before Complete's IfNoneMatch finally answers 412.
    assert.deepEqual(seen, ["HEAD /bucket/key"]);
  });

  it("multipart-sized + no-clobber, absent: full Create/Parts/Complete, guard on Complete", async () => {
    const wrote = await putFile(multipartFile, "s3://bucket/key", {
      noClobber: true,
    });
    assert.equal(wrote, true);
    // HEAD first, then the multipart choreography — parts may interleave
    // (lib-storage uploads them concurrently), so order-insensitive in the
    // middle, but Create precedes parts and Complete comes last.
    assert.equal(seen[0], "HEAD /bucket/key");
    assert.equal(seen[1], "POST /bucket/key?uploads");
    assert.deepEqual(seen.slice(2, -1).sort(), [
      "PUT /bucket/key?partNumber=1",
      "PUT /bucket/key?partNumber=2",
    ]);
    assert.equal(seen.at(-1), "POST /bucket/key?uploadId");
    // Never a whole-body single PUT once past partSize…
    assert.ok(!seen.includes("PUT /bucket/key"));
    // …and the conditional guard rides on Complete (S3 evaluates IfNoneMatch
    // there for multipart), so no-clobber stays raceproof even above partSize.
    assert.equal(conditions.get("POST /bucket/key?uploadId"), "*");
  });

  it("multipart race: object appears after the HEAD — Complete's 412 reads as already-present", async () => {
    completeStatus = 412;
    const wrote = await putFile(multipartFile, "s3://bucket/key", {
      noClobber: true,
    });
    // Same benign "already there" answer as the small-file 412 — not an error.
    assert.equal(wrote, false);
    // The cost of losing this race is inherent: every part was already sent
    // before the guard could answer. (Why the preflight exists at all.)
    assert.ok(seen.includes("PUT /bucket/key?partNumber=2"));
    // Pins a known limitation: lib-storage only auto-aborts on a *part*
    // failure, so a failed Complete leaves the multipart upload open and its
    // parts billed until aborted. The systemic answer is a bucket lifecycle
    // rule — s3cab-provisioned buckets get one (backupLifecycle, lib/aws.mjs),
    // and bring-your-own-bucket users are told to add it (guide/aws.md). If
    // this assertion ever flips to an abort being sent, that guidance can
    // soften.
    assert.ok(!seen.some((line) => line.startsWith("DELETE ")));
  });

  it("force (noClobber off): no preflight, no condition, even at multipart size", async () => {
    headStatus = 200; // present — and it must not matter
    const wrote = await putFile(multipartFile, "s3://bucket/key", {});
    assert.equal(wrote, true);
    // --force means overwrite: nothing may ask first…
    assert.ok(!seen.some((line) => line.startsWith("HEAD ")));
    // …and nothing may make the write conditional, or the overwrite would 412.
    assert.equal(conditions.get("POST /bucket/key?uploadId"), undefined);
    assert.equal(seen.at(-1), "POST /bucket/key?uploadId");
  });

  it("a failing part aborts the multipart upload — no orphaned parts", async () => {
    failPartNumber = 2;
    await assert.rejects(
      () => putFile(multipartFile, "s3://bucket/key", { noClobber: true }),
      // The raw AccessDenied is relayed into the friendly permissions error
      // (ADR-0037), original kept on cause — assert the cause so this stays
      // about the wire, not the wording.
      (/** @type {any} */ error) => error.cause?.name === "AccessDenied",
    );
    // lib-storage's leavePartsOnError defaults to false; putFile inherits that
    // silently, so this is the assertion keeping the auto-abort we rely on —
    // orphaned parts bill forever.
    assert.deepEqual(
      seen.filter((line) => line.startsWith("DELETE ")),
      ["DELETE /bucket/key?uploadId"],
    );
  });

  it("a HEAD failure that isn't not-found rethrows — never silently re-uploads", async () => {
    headStatus = 403;
    // AccessDenied must not read as "absent": treating it so would re-send
    // bodies on every permissions hiccup and mask the real problem.
    await assert.rejects(() =>
      putFile(multipartFile, "s3://bucket/key", { noClobber: true }),
    );
    assert.deepEqual(seen, ["HEAD /bucket/key"]);
  });
});
