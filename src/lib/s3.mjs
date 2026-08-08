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
  isRefusedWithoutReason,
  refusedWithoutReasonError,
  resolveCredentials,
} from "./auth.mjs";
import { customEndpoint, envSource } from "./env.mjs";
import { errorText } from "./error.mjs";
import { formatByteValue } from "./format.mjs";
import { enterNetworkWait, leaveNetworkWait } from "./network-status.mjs";
import { createProgress } from "./progress.mjs";
import { isRolesAnywhereMode } from "./roles-anywhere.mjs";
import { isInteractive } from "./style.mjs";

/** @import { S3ClientConfig, _Object, PutObjectCommandInput } from "@aws-sdk/client-s3" */
/** @import { Progress } from "@aws-sdk/lib-storage" */

/**
 * One file's transfer, as it stands right now: which file, how many of its bytes
 * have gone, and how many there are. Reported by `putFile` to a caller that has
 * taken over the drawing (`onProgress`); `total` is the file's own size rather
 * than the SDK's, which is absent on the first event.
 * @typedef {Object} Transfer
 * @property {string} path - The local file being sent
 * @property {number} loaded - Bytes transferred so far
 * @property {number} total - The file's size in bytes
 */

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
 * When given a `profileSource` (from env.mjs's `envSource("AWS_PROFILE")`), it appends
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

// Bound every request so a dropped or half-open connection fails instead of
// hanging forever (ADR-0065). The SDK's default Node handler sets no socket
// timeout, so a backup that loses its network mid-upload sits frozen with no
// error — the progress bar simply stops. Passing these as a plain options object
// lets the SDK build the NodeHttpHandler itself, so we needn't import the
// transitive @smithy/node-http-handler (dependency policy — ADR-0005).
//
//   socketTimeout     — socket *inactivity* limit: reset by any byte in or out, so
//                       a slow-but-alive transfer never trips it (ADR-0060 shows a
//                       healthy multipart upload streams continuously); only true
//                       silence — a dropped connection — does. It destroys the
//                       request and raises a TimeoutError, which is retryable, so
//                       the SDK retries (default maxAttempts) and a genuinely dead
//                       link then surfaces as a real error.
//   connectionTimeout — cap on establishing the TCP/TLS connection.
//
// Deliberately NOT `requestTimeout` — the trap this first fell into. That one caps
// *total* request duration, not idle time, and by default merely logs a warning
// while the request carries on hanging. @smithy/types says so itself: "because
// requestTimeout was for a long time incorrectly being set as a socket idle timeout,
// users must also opt-in for request timeout thrown errors". Opting in
// (`throwOnRequestTimeout`) would be worse than the bug: a large object on a slow
// link would then fail for taking too long while perfectly healthy.
//
// Reasoned defaults, not measured (unlike ADR-0060's throughput tuning): the value
// only sets how long a dead link waits before erroring, not throughput. Pinned by a
// unit test that hangs a real request against a silent loopback server — asserting
// the *values* is what let the requestTimeout bug through (ADR-0065).
const SOCKET_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 10_000;

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
    requestHandler: {
      socketTimeout: SOCKET_TIMEOUT_MS,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
    },
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
 * @returns {S3Client}
 */
function client() {
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
      profileSource: envSource("AWS_PROFILE"),
      endpoint: customEndpoint(),
      rolesAnywhere: isRolesAnywhereMode(),
    }),
  );
  _client = new S3Client(clientConfig());
  // Added at the outermost (initialize) step so it only fires once the SDK's own
  // retries are exhausted — which is what lets it retry *past* them — and covers
  // every request path: direct sends, the paginator, and lib-storage's Upload,
  // since all share this one client.
  _client.middlewareStack.add(requestErrorRelay(), {
    step: "initialize",
    name: "requestErrors",
  });
  return _client;
}

// The transport failures that mean the request never reached S3 at all — the
// network went away, rather than the server saying no. Matched on the errno
// (`error.code`) because it is the only signal there is: with no HTTP response
// there is no AWS `<Code>` for ADR-0037's `error.name` matching to read, which
// is why these need their own row rather than another entry in auth.mjs's list.
//
// The set is exactly what the SDK's own retry classifier calls transient
// (@smithy/core's NODEJS_TIMEOUT_ERROR_CODES + NODEJS_NETWORK_ERROR_CODES),
// borrowed rather than guessed — and copied, not imported, because @smithy/core
// is a transitive dependency (ADR-0005), the same reason the requestHandler
// above is passed as a plain options object. Anything reaching the relay with
// one of these has therefore already exhausted its retries.
const NETWORK_ERROR_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
];

/**
 * Whether an error is the network failing rather than S3 refusing — including
 * the SDK's own `TimeoutError`, which `socketTimeout`/`connectionTimeout` raise
 * when a link goes silent (ADR-0065).
 *
 * Checking `code` alone also catches the `AggregateError` Node's happy-eyeballs
 * connect throws when *every* address a host resolves to fails (S3 endpoints
 * resolve to several): Node promotes the first sub-failure's `code` onto the
 * wrapper, so there is no need to walk `.errors`. That aggregate is also the
 * case that carries no message — see `errorText`.
 * @param {unknown} error
 * @returns {boolean}
 */
export const isNetworkError = (error) =>
  Error.isError(error) &&
  (error.name === "TimeoutError" ||
    NETWORK_ERROR_CODES.includes(
      /** @type {NodeJS.ErrnoException} */ (error).code ?? "",
    ));

/**
 * The actionable "your connection dropped" error (ADR-0030 wording). Like the
 * credential rejections with no single-command fix, it leads with a
 * plain-language headline and embeds the raw failure for googling — but the
 * remedy here is only ever "get back online and run it again", so the reassuring
 * part is what earns its place: a backup dying half-way *looks* like lost work,
 * and content-addressed storage means it isn't. Nothing catches it by type, so a
 * plain `Error`; `cause` keeps the original for the S3CAB_DEBUG dump.
 * @param {unknown} cause - The transport error that triggered it.
 */
const networkError = (cause) =>
  new Error(
    `Couldn't reach the cloud — your network connection dropped.

The request never got a reply, so this is the connection rather than
anything wrong with your bucket or your credentials. A VPN switching on,
Wi-Fi dropping, or a laptop waking from sleep will all do it.

Everything already uploaded is safely stored. Once you're back online, run
the same command again — s3cab skips whatever it has already uploaded, so
it picks up close to where it stopped.

The connection failed with:
     ${errorText(cause).replaceAll("\n", "\n     ")}`,
    { cause },
  );

/**
 * The ordered table of request-time failures s3cab translates into friendly,
 * actionable errors: the AWS credential rejections (matched on the AWS error
 * *code*, `error.name`, never HTTP status — ADR-0037) plus the transport
 * failures where no response arrived at all (matched on the errno). Each row
 * pairs a predicate with the factory that builds its message; the relay walks
 * the rows in order, first match wins, and anything unmatched rethrows raw.
 * `ctx` carries the request's bucket and the custom endpoint (if any) so
 * `accessDeniedError` can name the bucket and pick the AWS-vs-provider remedy.
 * Data, not branching (ADR-0006).
 *
 * Three kinds of row, and the order encodes their precedence. The code-keyed
 * rejections come first, so a response that named its problem always gets the
 * remedy for *that* problem. Then the two rows that key on something else
 * because there was no code to key on: a refusal that arrived without one (a
 * HEAD's bodiless 403 — `isRefusedWithoutReason`), and a transport failure where
 * no response arrived at all (matched on the errno). Neither of those can
 * collide with a code row or with each other — an AWS code never arrives without
 * a response, and a request that got a 403 got a reply.
 * @type {{
 *   match: (error: unknown) => boolean,
 *   make: (cause: unknown, ctx: { bucket?: string, endpoint?: string }) => Error,
 * }[]}
 */
const requestErrorTable = [
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
  // After every code-keyed row, because it is the fallback for a refusal that
  // carried no code to key on (a HEAD's bodiless 403). Ordering is what keeps
  // ADR-0037 intact: a genuine `AccessDenied` still matches its own row above
  // and gets its own remedy, and only a response with nothing to match reaches
  // this one.
  {
    match: isRefusedWithoutReason,
    make: (cause, ctx) => refusedWithoutReasonError(cause, ctx),
  },
  { match: isNetworkError, make: (cause) => networkError(cause) },
];

// How long one request keeps retrying a dropped network before it gives up, and
// the ceiling on the wait between those attempts.
//
// s3cab retries transport failures *itself*, above the SDK, because the SDK's
// retries cannot do this job — measured, not assumed:
//
//   | parts in flight | file size | the SDK alone survives |
//   |---------------- | --------- | ---------------------- |
//   | 1               | ≤ 16MB    | 9.0s                   |
//   | 16              | ≤ 256MB   | 0.4s                   |
//   | 32              | ≥ 512MB   | 0.18s                  |
//
// The SDK's retry budget is a token bucket on the *client* (500 tokens, 10 per
// transient retry) shared by every request in flight, so the more parts a large
// file has in the air, the sooner they all stop retrying — and raising
// `maxAttempts` changes nothing, because the bucket binds first (32 concurrent
// requests make the same 82 attempts at maxAttempts 3 and at 8). No built-in
// strategy escapes it: `ConfiguredRetryStrategy` extends the standard one,
// `AdaptiveRetryStrategy` delegates to it and adds rate limiting, and the
// initial capacity is a hard-coded @smithy/core constant.
//
// That budget is not a bug — it is a circuit breaker protecting the *service*
// from retry storms, and for throttling and 5xx it is exactly right, so those
// keep stock SDK behaviour untouched (they never match `isNetworkError`). It is
// only wrong for a failure that is *our own link*, where backing off globally
// helps nobody. Hence: transport errors, and only transport errors, retry here.
//
// A window rather than an attempt count, because the goal is time-shaped — leave
// a backup running and let it survive the wifi dropping for a few seconds. Two
// minutes covers a wifi blip, a VPN coming up, or a laptop waking, and still
// reports a genuinely dead link while someone might plausibly still be watching.
//
// The delay cap is what bounds *recovery* latency: once the network returns, a
// request already asleep can't notice until it wakes, so a high cap makes a 3s
// outage take 12s to recover from (measured in the spike). 2s keeps the wasted
// attempts during an outage cheap — they fail instantly at the TCP layer — while
// getting back to work promptly.
const NETWORK_RETRY_WINDOW_MS = 120_000;
const NETWORK_RETRY_MAX_DELAY_MS = 2_000;

/**
 * The wait before network-retry attempt `n`: exponential with full jitter,
 * capped. Full jitter (`random() × window`, not `window`) staggers the parts of
 * a multipart upload that all failed in the same instant, so they don't
 * stampede the link the moment it comes back. Exported for its unit test.
 * @param {number} attempt - 0 for the first retry.
 * @returns {number} milliseconds
 */
export const networkRetryDelay = (attempt) =>
  Math.floor(
    Math.random() * Math.min(500 * 2 ** attempt, NETWORK_RETRY_MAX_DELAY_MS),
  );

/**
 * Whether a request carries a stream body, which must never be retried: the
 * stream is already consumed, so a second attempt would upload a *truncated*
 * object under the correct hash — silent corruption, the one outcome worse than
 * a failed backup. The SDK's own retry middleware holds this invariant
 * (`isStreamingPayload`), and retrying outside it would quietly break it.
 *
 * Nothing hits this today — lib-storage hands the client Buffers even when
 * `putFile` gives it a file stream, and `putText` sends a string — so it is a
 * tripwire for future code rather than a live branch.
 * @param {any} args - The middleware arguments.
 * @returns {boolean}
 */
const hasStreamBody = (args) => args?.input?.Body instanceof Readable;

/**
 * SDK middleware relay that (1) rides out a dropped network and (2) translates
 * the terse request-time failures in `requestErrorTable` — AWS's credential
 * rejections (expired/invalid token, missing permission, bad signature, clock
 * skew) and the network dying mid-request — into actionable errors, passing
 * every other outcome (success or an unrecognized error) through untouched.
 *
 * It sits at the middleware stack's `initialize` step, *outside* the SDK's own
 * retry middleware (`finalizeRequest`), which is what makes the retry loop work:
 * each pass re-runs serialization and signing and takes a fresh SDK retry token,
 * so a client whose retry budget is spent still gets attempts. Re-signing per
 * pass is a bonus — a retry minutes later carries a current date rather than a
 * stale one.
 *
 * Credentials resolve fine at startup and the *server* rejects later, so
 * auth.mjs is off the stack by then; the SDK boundary is where these
 * request-time failures can be caught. Exported (and pure of any live client) so
 * both the retrying and the routing are unit-testable with a fake `next`.
 * Curried on the window *before* `next` on purpose: the SDK invokes a middleware
 * as `middleware(next, context)`, so an optional second parameter here would
 * silently receive the context object instead — which made the deadline `NaN`
 * and disabled retrying altogether. Taking the option first keeps the shape the
 * SDK expects exactly one argument wide.
 * @param {number} [windowMs] - How long to keep retrying a dropped network.
 *   Production always takes the default; the parameter exists so the give-up
 *   path is testable in milliseconds rather than in two minutes.
 */
export const requestErrorRelay =
  (windowMs = NETWORK_RETRY_WINDOW_MS) =>
  (/** @type {(args: any) => Promise<any>} */ next) =>
  async (/** @type {any} */ args) => {
    const deadline = Date.now() + windowMs;
    // Whether this request has been counted into the shared outage, and whether
    // it got through — read by the `finally`, which is the only place that can
    // balance the count on every exit (return, give-up, and a throw from the
    // translation below alike).
    let waiting = false;
    let recovered = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await next(args);
          recovered = true;
          return result;
        } catch (error) {
          if (
            isNetworkError(error) &&
            Date.now() < deadline &&
            !hasStreamBody(args)
          ) {
            // Announce from the *second* retry: a blip that clears inside one
            // backoff resolves in well under a second, and saying so would put a
            // line in the log every time a flaky link hiccups. `attempt` is 0 on
            // the first retry, so this waits for one failed retry first.
            if (attempt >= 1 && !waiting) {
              waiting = true;
              enterNetworkWait(process.stderr, windowMs);
            }
            const delay = networkRetryDelay(attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          for (const { match, make } of requestErrorTable) {
            if (match(error)) {
              throw make(error, {
                bucket: args.input?.Bucket,
                endpoint: customEndpoint(),
              });
            }
          }
          throw error;
        }
      }
    } finally {
      if (waiting) {
        leaveNetworkWait(process.stderr, { recovered });
      }
    }
  };

/**
 * Parse an `s3://bucket/key` URI into its bucket and key. Module-private: every
 * operation here takes a URI and splits it on the way through, so the parse never
 * needs to cross the SDK boundary.
 * @param {string} uri
 * @returns {{ Bucket: string, Key: string }}
 */
function parseS3Uri(uri) {
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
 * reject, so they're sent only when targeting AWS (no custom endpoint). Reached
 * only through `putObjectParams`, which every uploader (`putFile`, `putText`)
 * builds its params with — so the gating rule lives in one place.
 * `customEndpoint()` is read here, so the caller's s3cab env must already be loaded.
 * @returns {Partial<PutObjectCommandInput>}
 */
const awsOnlyPutParams = () =>
  customEndpoint()
    ? {}
    : {
        ServerSideEncryption: ServerSideEncryption.AES256,
        StorageClass: StorageClass.GLACIER_IR,
      };

/**
 * Build the PutObject params every uploader shares: the off-AWS gating
 * (`awsOnlyPutParams`) plus the conditional-PUT flag. Pure (no I/O) so the gating is
 * assertable without performing an upload — the caller supplies only the `Body`
 * (`putFile` a file stream, `putText` the string; src/lib/s3.test.mjs).
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
 * @param {(transfer: Transfer) => void} [options.onProgress] - Take the transfer's
 *   bytes instead of the built-in byte bar, for a caller drawing its own line.
 * @returns {Promise<boolean>} True if the file was uploaded.
 */
export async function putFile(path, uri, options = {}) {
  const { noClobber, onProgress } = options;

  const { size } = statSync(path);

  // No-clobber preflight, worth its round trip only once the body is multipart-sized:
  // one HEAD to avoid streaming a large body the conditional PUT below would reject
  // anyway. Any successful HEAD counts as present, whatever the object looks like —
  // an object another tool PUT is still there. This is only an optimization;
  // `IfNoneMatch: "*"` is the real guard, and unlike this it can't be raced.
  if (noClobber && size >= partSize) {
    const exists = await objectExists(uri);
    if (exists) {
      return false;
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

  // Two ways to show a transfer, and the caller picks by whether it wants the
  // bytes for itself:
  //
  // - `onProgress` given — the caller is drawing a line of its own and this
  //   upload is one part of it, so report and draw nothing. That is the fused
  //   backup pass (ADR-0069), where a bar per file would fight the run counter
  //   for the same row of the terminal; the numbers arrive as the suffix of
  //   *its* line instead.
  // - Otherwise — no one else is drawing, so put up the in-place byte bar, but
  //   only for a body big enough to go up in parts. Below that threshold (the
  //   same one the no-clobber preflight uses above) the upload is a single PUT,
  //   so the bar can only ever paint full: thousands of flashes for a photo
  //   directory. It earns its line on the multi-GB files, where it is the only
  //   thing that moves for minutes.
  //
  // Either way progress is not the command's result, so it goes to stderr
  // (stream discipline), and the TTY gate lives in lib/progress.mjs.
  using progress = createProgress(process.stderr);
  if (onProgress) {
    // `total` is absent on the SDK's first event; the file's own size is the
    // truth anyway, so the caller never sees a percentage of an unknown.
    upload.on("httpUploadProgress", ({ loaded = 0 }) => {
      onProgress({ path, loaded, total: size });
    });
  } else if (size >= partSize) {
    upload.on("httpUploadProgress", (event) => {
      const { message, fill } = formatUploadProgress(event, path);
      progress.update(message, { cursor: fill });
    });
  }

  try {
    await upload.done();
  } catch (error) {
    if (noClobber && isPreconditionFailed(error)) {
      // Already present — no upload, and nothing to leave behind.
      progress.clear();
      return false;
    } else {
      // A real failure keeps its bar: disposal closes the line, so the error
      // prints below the transfer it belongs to rather than over it.
      throw error;
    }
  }

  // The bar was *live* progress, not a record — wipe it now the transfer is
  // done. Left standing, every completed file would keep its finished bar, and a
  // run would scroll a wall of identical full bars past whatever line is
  // actually tracking the run.
  progress.clear();

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
 * Whether an S3 error means a conditional PUT was refused — i.e. `IfNoneMatch: "*"`
 * found something already at the key. The twin of {@link isObjectNotFound}: the
 * single spelling of "the no-clobber guard refused" for this SDK boundary, so
 * `putFile` and `putText` don't each repeat the SDK's name. S3 raises it on the
 * single-shot PUT and on CompleteMultipartUpload alike. Matched by `name`, like the
 * other s3.mjs guards (see error.mjs's header).
 *
 * It says nothing about whether the caller *asked* for no-clobber, so both uploaders
 * still gate on their own `noClobber` before reading a refusal as benign — an
 * unconditional PUT that somehow 412s is a real failure and must throw.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPreconditionFailed(error) {
  return Error.isError(error) && error.name === "PreconditionFailed";
}

/**
 * Whether an object exists — one HEAD, absence mapped through
 * {@link isObjectNotFound}, anything else (network/auth) rethrown. The generic
 * existence question at this SDK boundary: `putFile`'s multipart preflight and
 * upload.mjs's baseline-trust check (is the baseline snapshot still stored?)
 * both ask it. A successful HEAD says nothing about the object's content —
 * present is present, whoever put it.
 * @param {string} uri - The `s3://bucket/key` URI.
 * @returns {Promise<boolean>}
 */
export async function objectExists(uri) {
  const { Bucket, Key } = parseS3Uri(uri);
  try {
    await client().send(new HeadObjectCommand({ Bucket, Key }));
    return true;
  } catch (error) {
    if (isObjectNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Upload a small in-memory string as an S3 object — for the generated marker /
 * config files (a set's `info`, and the pushed `dirs.txt`/`exclude.txt`) that
 * have no local file to stream. The string twin of `putFile`: it returns whether
 * the object was written, and `noClobber` makes the PUT conditional
 * (`IfNoneMatch: "*"`) so a losing racer gets `false` instead of overwriting —
 * the atomic "first person wins" claim ADR-0024's collision check relies on.
 * The request shape *is* `putFile`'s: both build their params with
 * `putObjectParams`, so the off-AWS gating and the conditional flag are spelled
 * once. All this adds is a string body in place of a file stream.
 * @param {string} uri - The `s3://bucket/key` URI.
 * @param {string} content - The object body.
 * @param {object} [options]
 * @param {boolean} [options.noClobber] - Conditional PUT: don't overwrite an existing object.
 * @returns {Promise<boolean>} True if written; false if `noClobber` and it already existed.
 */
export async function putText(uri, content, { noClobber = false } = {}) {
  try {
    await client().send(
      new PutObjectCommand({
        ...putObjectParams(uri, { noClobber }),
        Body: content,
      }),
    );
  } catch (error) {
    if (noClobber && isPreconditionFailed(error)) {
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
