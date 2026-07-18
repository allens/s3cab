import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
  StorageClass,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import assert from "node:assert";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import {
  accessDeniedError,
  badSignatureError,
  clockSkewError,
  expiredCredentialsError,
  invalidCredentialsError,
  isAccessDenied,
  isBadSignature,
  isClockSkew,
  isExpiredCredentials,
  isInvalidCredentials,
  resolveCredentials,
} from "./auth.mjs";
import {
  customEndpoint,
  profileSource as resolveProfileSource,
} from "./env.mjs";
import { formatByteValue } from "./format.mjs";
import { createProgress } from "./progress.mjs";
import { isRolesAnywhereMode } from "./roles-anywhere.mjs";
import { isInteractive } from "./style.mjs";

/** @import { S3ClientConfig, _Object, PutObjectCommandInput } from "@aws-sdk/client-s3" */
/** @import { Progress } from "@aws-sdk/lib-storage" */

// This is the single module in the production app that imports the AWS S3 SDK:
// every S3 operation goes through the functions exported here. Keeping the SDK
// behind one boundary localizes the one heavyweight dependency and lets the
// client be constructed lazily — see `client()`.

/** @type {S3Client | undefined} */
let _client;

// The `targets-AWS?` signal, `customEndpoint()`, lives in env.mjs (one spelling
// of the fallback chain for every reader); it is read at call time here, after
// env is loaded (enforced centrally in `client()` — ADR-0022).

/**
 * The one-line notice s3cab prints (to stderr, once) when it first authenticates
 * to the cloud — so "which account/endpoint am I about to touch?" never needs
 * guessing, and so a network-bound command never sits silent before its first
 * request (print *before* the network call — clig.dev responsiveness). Reports
 * the set's credential mode: Roles Anywhere (keyless), else the effective
 * `AWS_PROFILE` and/or custom endpoint; when there's nothing distinctive to say
 * (default AWS credentials, no profile, no custom endpoint) it falls back to a
 * generic contacting-the-cloud line rather than silence. An empty profile
 * (`AWS_PROFILE=`) counts as none.
 *
 * When given a `profileSource` (from env.mjs's `profileSource()`), it appends
 * where that profile came from — `(from set 'photos' config)` or `(from your
 * environment)` — so a surprising profile (a stale shell export shadowing a set,
 * say) is traceable, not a silent mystery.
 *
 * Pure — takes the values, returns the line — so it is unit-testable without a
 * live client; `client()` prints what it returns. We report the *effective*
 * value (after env layering); the `auth` command set it (see commands/auth.mjs).
 * @param {{ profile?: string, profileSource?: string, endpoint?: string,
 *   rolesAnywhere?: boolean }} config
 * @returns {string}
 */
export function authNotice({
  profile,
  profileSource,
  endpoint,
  rolesAnywhere,
}) {
  // Roles Anywhere routes credentials to the certificate signer, not the profile/
  // endpoint chain, so it takes precedence — and an RA set carries no profile or
  // endpoint to report anyway. Mirrors `resolveCredentials`, which checks RA mode
  // before the standard chain.
  if (rolesAnywhere) {
    return "Using Roles Anywhere (keyless)";
  }
  const via = profile && profileSource ? ` (from ${profileSource})` : "";
  if (profile && endpoint) {
    return `Using AWS profile: ${profile}${via}, endpoint: ${endpoint}`;
  }
  if (profile) {
    return `Using AWS profile: ${profile}${via}`;
  }
  if (endpoint) {
    return `Using S3 endpoint: ${endpoint}`;
  }
  return "Contacting the cloud…";
}

/**
 * The S3 client configuration. Split out from `client()` so the endpoint-driven
 * gating below (region, checksum mode, region-redirect) can be asserted directly
 * in tests without a live client — no bucket, no network (src/lib/s3.test.mjs).
 * Reads `process.env` / `customEndpoint()` at call time (env is loaded up front —
 * ADR-0022).
 * @returns {S3ClientConfig}
 */
export function clientConfig() {
  const endpoint = customEndpoint();
  return {
    // Bootstrap region only, so ordinary users needn't configure AWS: SigV4 needs
    // *a* region to sign the first request, so default to us-east-1 when none is
    // set. An explicit env override still wins (and is required by providers that
    // care about the region label). On AWS, `followRegionRedirects` then
    // auto-corrects to the bucket's real region via its 301 — an AWS-only
    // behaviour, so it is dropped (and `endpoint` used instead) off AWS.
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    ...(endpoint
      ? {
          endpoint,
          // Off-AWS, don't add the SDK's default data-integrity checksum. Recent
          // AWS SDK v3 (since v3.730) computes a checksum whenever the operation
          // supports one — its default mode — so every upload carries a CRC trailer
          // (CRC64NVME for S3 multipart), which several S3-compatible providers
          // (R2 / B2 / MinIO / Wasabi) reject, and whose CRC64NVME path can require
          // the `@aws-sdk/crc64-nvme` addon our SEA bundle externalizes. s3cab already
          // SHA-256s every file, so the wire checksum adds nothing here. Switching to
          // the required-only mode still sends a checksum for the few operations that
          // mandate one. On AWS the default stands (free integrity).
          // (docs/design/s3-provider-compatibility.md)
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
        }
      : { followRegionRedirects: true }),
    credentials: resolveCredentials,
  };
}

/**
 * The shared S3 client, constructed on first use. Deferred on purpose: it
 * resolves AWS region/credentials, so building it eagerly would make commands
 * that never touch S3 (`list`, `tree`, …) fail when none are configured — even
 * though they share this app's single entry point. Only the S3 operations below
 * call this, so those commands never trigger it.
 *
 * Credentials come from `src/lib/auth.mjs` (env files → standard AWS chain →
 * actionable error — see docs/design/auth.md).
 *
 * It also carries the one development tripwire for the "env loaded before any S3
 * op" invariant (ADR-0022): every S3 op routes through here, so a single `assert`
 * on the `__S3CAB_ENV_LOADED` breadcrumb `loadEnv` drops covers them all. It only
 * ever fires on incorrect wiring — a lib consumer who skipped `loadEnv` — turning
 * that into a clear error instead of a client built against an unconfigured
 * environment. Asserted before the memoized `??=`, so cached-client ops are too.
 * @returns {S3Client}
 */
function client() {
  assert(
    process.env.__S3CAB_ENV_LOADED,
    "S3 operation reached before env was loaded — loadEnv() runs at the CLI " +
      "entry point; a direct caller (test/library) must call it first.",
  );
  if (_client) {
    return _client;
  }
  // Confirm which identity/endpoint we're about to use (or at minimum that the
  // cloud is about to be touched) — printed here (not per op) so it fires
  // exactly once, on the first S3 touch, and never for the offline commands
  // that never build a client. stderr: diagnostic, not data.
  console.warn(
    authNotice({
      profile: process.env.AWS_PROFILE,
      profileSource: resolveProfileSource(),
      endpoint: customEndpoint(),
      rolesAnywhere: isRolesAnywhereMode(),
    }),
  );
  _client = new S3Client(clientConfig());
  // Added at the outermost (initialize) step so it only fires once the SDK's own
  // retries are exhausted, and covers every request path — direct sends, the
  // paginator, and lib-storage's Upload — since all share this one client.
  _client.middlewareStack.add(credentialErrorRelay, {
    step: "initialize",
    name: "credentialErrors",
  });
  return _client;
}

/**
 * The ordered table of request-time AWS credential rejections s3cab translates
 * into friendly, actionable errors (ADR-0037). Each row pairs a predicate
 * (matched on the AWS error *code*, `error.name`, never HTTP status) with the
 * factory that builds its message; the relay walks the rows in order, first
 * match wins, and anything unmatched rethrows raw. `ctx` carries the request's
 * bucket and the custom endpoint (if any) so `accessDeniedError` can name the
 * bucket and pick the AWS-vs-provider remedy. Data, not branching (ADR-0006) —
 * the existing expired case is just the first row.
 * @type {{
 *   match: (error: unknown) => boolean,
 *   make: (cause: unknown, ctx: { bucket?: string, endpoint?: string }) => Error,
 * }[]}
 */
const credentialErrorTable = [
  {
    match: isExpiredCredentials,
    make: (cause) => expiredCredentialsError(cause),
  },
  {
    match: isAccessDenied,
    make: (cause, ctx) => accessDeniedError(cause, ctx),
  },
  {
    match: isInvalidCredentials,
    make: (cause) => invalidCredentialsError(cause),
  },
  { match: isBadSignature, make: (cause) => badSignatureError(cause) },
  { match: isClockSkew, make: (cause) => clockSkewError(cause) },
];

/**
 * SDK middleware relay that translates AWS's terse request-time credential
 * rejections (expired/invalid token, missing permission, bad signature, clock
 * skew) into the actionable errors in `credentialErrorTable`, passing every
 * other outcome — success or unrecognized error — through untouched. Credentials
 * resolve fine at startup and the *server* rejects later, so auth.mjs is off the
 * stack by then; the SDK boundary is where these request-time failures can be
 * caught. Exported (and pure of any live client) so the routing is unit-testable
 * directly with a fake `next`.
 * @param {(args: any) => Promise<any>} next
 */
export const credentialErrorRelay =
  (next) => async (/** @type {any} */ args) => {
    try {
      return await next(args);
    } catch (error) {
      for (const { match, make } of credentialErrorTable) {
        if (match(error)) {
          throw make(error, {
            bucket: args.input?.Bucket,
            endpoint: customEndpoint(),
          });
        }
      }
      throw error;
    }
  };

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
 * @returns {AsyncGenerator<_Object>}
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
 * Open a readable over an S3 object — the SDK's `GetObject` `Body`, already a
 * Node `Readable`, returned directly with no wrapper. Callers feed it into a
 * `pipeline` (as `writeFileAtomic` does), so a mid-download failure propagates
 * and the streams tear down through that primitive — nothing here needs to
 * swallow the error. The streaming counterpart of `getText`, which buffers the
 * whole body to a string.
 * @param {string} uri - The `s3://bucket/key` URI of the object.
 * @returns {Promise<Readable>}
 */
export async function getStream(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  const { Body } = await client().send(new GetObjectCommand({ Bucket, Key }));
  assert(
    Body instanceof Readable,
    `S3 GetObject returned no readable body for ${uri}`,
  );
  return Body;
}

const PROGRESS_BAR_RANGE = 20;
// Width to pad each humanized size to. "999.9GB" is 7 chars, so 8 aligns every
// realistic per-file size; a rarer giant just nudges its own line's path right.
const SIZE_COL = 8;
// Multipart upload tuning — measured against a real bucket from three network
// distances, not guessed (ADR-0060). `partSize` is the chunk each part carries;
// `queueSize` is how many parts fly concurrently. Their product is the bytes *in
// flight*, and that is the lever: it has to cover the link's bandwidth-delay
// product (speed × round-trip time) before the pipe fills. lib-storage's default
// queueSize of 4 is the binding constraint — it left roughly half the throughput
// unused on every link measured. Both self-scale down: concurrency is
// `min(queueSize, partCount)` and buffered bytes never exceed the file, so a
// small file neither engages the deep queue nor pays for it.
const partSize = 16 * 1024 * 1024;
const queueSize = 32;

/**
 * Build the upload-progress line (pure): an ASCII bar and the humanized byte
 * counts, labelled by the local file being uploaded. `total` can be absent in an
 * httpUploadProgress event, so it omits the "of <total>" segment rather than
 * rendering a misleading "of 0B". Returns the rendered `message` and the bar
 * `fill` (lit chars), which the handler reuses to position the cursor.
 *
 * Field order and padding are deliberate: the fixed-width bar leads, then the
 * byte counts in fixed-width columns (progress right-aligned so its digits grow
 * leftward from a fixed edge, total left-aligned), then the variable-length path
 * last. Padding the sizes to `SIZE_COL` makes the path start at a constant column
 * so the paths left-align, and the ls -l / log-line convention (unbounded free
 * text trails) keeps everything before it aligned as files vary. Because the bar
 * starts at column 0, `cursor: fill` still parks the terminal cursor inside it.
 *
 * The label is the source *path*, never the object's `s3://bucket/objects/<hash>`
 * key: the content-addressed hash is storage machinery of no interest to someone
 * backing up files (design #1), so the human-facing line names the file (the
 * file's stored hash is recorded in the snapshot manifest).
 * @param {Progress} progress
 * @param {string} label - The local path of the file being uploaded
 * @returns {{ message: string, fill: number }}
 */
export const formatUploadProgress = ({ loaded = 0, total = 0 }, label) => {
  const fill = total ? Math.round((loaded / total) * PROGRESS_BAR_RANGE) : 0;
  const bar = "*".repeat(fill) + ".".repeat(PROGRESS_BAR_RANGE - fill);
  const loadedCol = formatByteValue(loaded).padStart(SIZE_COL);
  // Reserve the " of <total>" width even when total is unknown, so the trailing
  // path lands in the same column either way.
  const sizes = total
    ? `${loadedCol} of ${formatByteValue(total).padEnd(SIZE_COL)}`
    : loadedCol.padEnd(SIZE_COL + " of ".length + SIZE_COL);
  return { message: `${bar}  ${sizes}  ${label}`, fill };
};

/**
 * The AWS-only PutObject params (`ServerSideEncryption` + `StorageClass`),
 * omitted off-AWS. These are AWS-isms that S3-compatible providers (R2/B2/Spaces)
 * reject, so they're sent only when targeting AWS (no custom endpoint). Shared by
 * every uploader — `putFile` (via `putObjectParams`) and `putText` — so the
 * gating rule lives in one place. `customEndpoint()` is read here, so the
 * caller's s3cab env must already be loaded.
 * @returns {Partial<PutObjectCommandInput>}
 */
const awsOnlyPutParams = () =>
  customEndpoint()
    ? {}
    : {
        ServerSideEncryption: ServerSideEncryption.AES256,
        StorageClass: StorageClass.INTELLIGENT_TIERING,
      };

/**
 * Build the PutObject params for `putFile`: the off-AWS gating (`awsOnlyPutParams`)
 * plus the conditional-PUT flag. Pure (no I/O) so the gating is assertable without
 * performing an upload — the caller supplies the `Body` stream (src/lib/s3.test.mjs).
 * `customEndpoint()` is read here, so the caller's s3cab env must already be loaded.
 *
 * Deliberately carries **no `x-amz-meta-*` metadata**. It once stamped each object
 * with hostname/username/path/size/mtime/date; nothing ever read them, and they
 * described the wrong thing — an object under `objects/<sha256>` is *content*, which
 * dedup shares across many files, so per-file facts named whichever file happened to
 * upload those bytes first. Worse, S3 user metadata rides as HTTP headers: a path
 * outside Latin-1 (`café`, `写真`, an emoji) made Node reject the header and took the
 * whole backup down with it. Per-file facts live in the snapshot TSV, which is their
 * only honest home (guide/format.md).
 * @param {string} uri - The S3 URI.
 * @param {{ noClobber?: boolean }} [options]
 * @returns {PutObjectCommandInput}
 */
export function putObjectParams(uri, { noClobber } = {}) {
  const { Bucket, Key } = parseS3Uri(uri);
  return {
    Bucket,
    Key,
    ...awsOnlyPutParams(),
    ...(noClobber ? { IfNoneMatch: "*" } : {}),
  };
}

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

  const { size } = statSync(path);

  // No-clobber preflight, worth its round trip only once the body is multipart-sized:
  // one HEAD to avoid streaming a large body the conditional PUT below would reject
  // anyway. Any successful HEAD counts as present, whatever the object looks like —
  // an object another tool PUT is still there. This is only an optimization;
  // `IfNoneMatch: "*"` is the real guard, and unlike this it can't be raced.
  if (noClobber && size >= partSize) {
    const { Bucket, Key } = parseS3Uri(uri);
    try {
      await client().send(new HeadObjectCommand({ Bucket, Key }));
      return false;
    } catch (error) {
      if (!isObjectNotFound(error)) {
        throw error;
      }
    }
  }

  // customEndpoint() is read inside putObjectParams (the caller's env is loaded).
  const upload = new Upload({
    client: client(),
    params: {
      ...putObjectParams(uri, { noClobber }),
      Body: createReadStream(path),
    },
    partSize,
    queueSize,
  });

  // The in-place byte bar (interactive only; the TTY gate and the closing
  // newline — drawn only if a bar was — live in lib/progress.mjs). `cursor: fill`
  // rests the terminal cursor inside the bar. Progress is not the command's
  // result, so it goes to stderr (stream discipline).
  using progress = createProgress(process.stderr);
  upload.on("httpUploadProgress", (event) => {
    const { message, fill } = formatUploadProgress(event, path);
    progress.update(message, { cursor: fill });
  });

  try {
    await upload.done();
  } catch (error) {
    if (
      noClobber &&
      Error.isError(error) &&
      error.name === "PreconditionFailed"
    ) {
      // Already present — no upload, no summary line (`using` closes any bar).
      return false;
    } else {
      throw error;
    }
  }

  if (!isInteractive(process.stderr)) {
    // No bar was drawn — leave one summary line as the log evidence, named by
    // the file (not the object hash), to match the interactive progress line.
    console.warn(`Uploaded ${path} (${formatByteValue(size)})`);
  }
  return true;
}

/**
 * Whether an S3 error means the object isn't there. A GET on a missing key
 * returns `NoSuchKey`; a HEAD (and some S3-compatible providers) surface a 404 as
 * `NotFound` — both mean absent. The single spelling of "missing object" for this
 * SDK boundary, so callers (`putFile`'s preflight, `getText`, remote.mjs's
 * referenced scan) don't each repeat the SDK's names. Matched by `name`, like the
 * other s3.mjs guards (see error.mjs's header).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isObjectNotFound(error) {
  return (
    Error.isError(error) &&
    (error.name === "NoSuchKey" || error.name === "NotFound")
  );
}

/**
 * Upload a small in-memory string as an S3 object — for the generated marker /
 * config files (a set's `info`, and the pushed `dirs.txt`/`exclude.txt`) that
 * have no local file to stream. The string twin of `putFile`: it returns whether
 * the object was written, and `noClobber` makes the PUT conditional
 * (`IfNoneMatch: "*"`) so a losing racer gets `false` instead of overwriting —
 * the atomic "first person wins" claim ADR-0024's collision check relies on.
 * Off-AWS gating matches `putFile` (`awsOnlyPutParams`).
 * @param {string} uri - The `s3://bucket/key` URI.
 * @param {string} content - The object body.
 * @param {object} [options]
 * @param {boolean} [options.noClobber] - Conditional PUT: don't overwrite an existing object.
 * @returns {Promise<boolean>} True if written; false if `noClobber` and it already existed.
 */
export async function putText(uri, content, { noClobber = false } = {}) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    await client().send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body: content,
        ...awsOnlyPutParams(),
        ...(noClobber ? { IfNoneMatch: "*" } : {}),
      }),
    );
  } catch (error) {
    if (
      noClobber &&
      Error.isError(error) &&
      error.name === "PreconditionFailed"
    ) {
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Read a small S3 object's body as text, or `undefined` if it doesn't exist —
 * the string twin of `getStream` for the marker / config files (`info`,
 * pushed `dirs.txt`/`exclude.txt`) the collision check and `reattach` read back.
 * A missing object yields `undefined` (not a throw), so callers branch on
 * presence — e.g. "is this set already claimed?".
 * @param {string} uri - The `s3://bucket/key` URI.
 * @returns {Promise<string | undefined>}
 */
export async function getText(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    const { Body } = await client().send(new GetObjectCommand({ Bucket, Key }));
    return await Body?.transformToString();
  } catch (error) {
    if (isObjectNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The least-privilege IAM policy for an s3cab everyday identity: bucket-level
 * `ListBucket` plus per-object `Get`/`Put`/`Delete`. **AWS-only** — the
 * `arn:aws:s3:::` ARNs and IAM JSON are meaningless off AWS.
 *
 * The single source of truth for this policy. The `bucket` onboarding command
 * emits it (it is what a user attaches to the identity s3cab backs up as), and
 * docs/integration-testing.md §1 references it as the test identity's policy too
 * — with explicit verbs the everyday-backup and test policies are *identical*, so
 * one definition genuinely serves both. The two statements split because the
 * object actions target `…/*` while bucket-level `ListBucket` targets the bare
 * bucket ARN.
 *
 * The verbs are explicit (`Get`/`Put`/`Delete`Object), not a `s3:*Object`
 * wildcard: this is the *soft-delete* identity — `DeleteObject` writes a delete
 * marker on a versioned bucket, but the key deliberately lacks
 * `DeleteObjectVersion`, so a leaked everyday key can never permanently destroy
 * backup history (the security model — see docs/adr/0033). Widening to `*Object`
 * would silently re-grant that.
 * @param {string} bucketName
 */
export const bucketPolicy = (bucketName) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ListBucket",
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${bucketName}`],
    },
    {
      Sid: "ObjectAccess",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: [`arn:aws:s3:::${bucketName}/*`],
    },
  ],
});

/**
 * Delete a single S3 object.
 * @param {string} uri - The `s3://bucket/key` URI of the object.
 * @returns {Promise<void>}
 */
export async function deleteObject(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  await client().send(new DeleteObjectCommand({ Bucket, Key }));
}
