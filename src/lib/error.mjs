// How s3cab shapes its *own* errors — a deliberate three-way mix, decided by two
// orthogonal questions, not an inconsistency:
//
//   1. Is the error caught by *type* at some catch site to branch behaviour?
//        yes → an Error *subclass* (this file's `ParseArgsError`, `MissingArgError`,
//              `ValidationError`), so the catch can `instanceof` it. `ParseArgsError`
//              also guarantees a discriminator (`code`) across many throw sites by
//              setting it once in the constructor. Reserve a subclass for owned types
//              whose identity is read — `ParseArgsError`/`ValidationError` drive the
//              CLI's exit code (`isInputError` → 2), and `MissingArgError` decides
//              whether the dispatcher may re-spell the message (ADR-0038).
//        no  → a plain `Error`; nothing inspects its type, it just flows to the
//              CLI's top-level catch (src/s3cab.mjs) which prints `message`.
//   2. (plain-Error branch only) Is the message heavy / actionable / reused?
//        yes → a named factory returning `new Error(msg, { cause })` —
//              `noCredentialsError` / `expiredCredentialsError` (auth.mjs),
//              `collisionError` (commands/setup.mjs).
//        no  → an inline `throw new Error("…")` at the site (the URI /
//              validation / invariant throws).
//
// Foreign errors we can't subclass (Node's `ERR_PARSE_ARGS_UNKNOWN_OPTION`, the
// AWS SDK's `ExpiredToken` / `NotFound`) sit outside this — match them by
// `code` / `name`, as `isUsageError` and the s3.mjs guards do. The *wording* of
// user-facing messages is ADR-0030; this is only about their *shape*.

export class ParseArgsError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions & { argName?: string }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.code = "ERR_PARSE_ARGS";
    /**
     * The registry arg this concerns (plain name, e.g. `set`/`bucket`), so the
     * dispatcher can gloss the error with its description (ADR-0038). Undefined
     * for generic parse failures that name no single arg. Naming an arg is *only*
     * a request for that gloss — it does not license rewriting the message, which
     * is what {@link MissingArgError} exists to signal (`aws` names `from-stack`
     * on its `--save needs --from-stack` error and must keep its own wording).
     * @type {string | undefined}
     */
    this.argName = options?.argName;
  }
}

/**
 * A bad argument *value* — e.g. an invalid set name or bucket. An input error
 * (exit 2) like a parse failure, but it carries its own tailored fix, so unlike
 * `ParseArgsError` it does NOT also dump the generic usage block. Reserve it for
 * malformed argument *values*; operational/state failures (directory not found, a
 * name already claimed) stay plain Errors at exit 1.
 */
export class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "ValidationError";
  }
}

/**
 * Roles Anywhere's `CreateSession` endpoint answered, and the answer was not a
 * session: a rejection (a 403 for a profile or trust anchor the region doesn't
 * know, a 400 for a certificate the trust anchor doesn't vouch for), a body that
 * wasn't the session JSON, or a connected socket that went silent past the
 * timeout — raised by `createSession` / `sessionTimeoutError` (lib/roles-anywhere.mjs).
 *
 * A subclass because `resolveCredentials` (lib/auth.mjs) catches it *by type* to
 * branch behaviour: these are a **credential** failure and get the same set-scoped
 * "no credentials for set X, looked in …" frame the standard chain's failures get
 * ([ADR-0075](../../docs/adr/0075-resolve-time-credential-expiry.md)). Anything
 * else the request throws — an `ENOTFOUND`/`ECONNRESET` from the socket — is a
 * transport failure that must reach the request-time relay (lib/s3.mjs) untouched,
 * so its errno still drives the network retry.
 */
export class RolesAnywhereSessionError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "RolesAnywhereSessionError";
  }
}

/**
 * The exit code for a run the user interrupted: 128 + SIGINT(2), the shell's
 * convention for a signal-terminated process. One constant rather than a
 * signal→code table — Ctrl+C is the documented interrupt, and on the
 * best-effort SIGHUP/SIGTERM paths the console is going away anyway, so nobody
 * reads the code.
 */
export const EXIT_INTERRUPTED = 130;

/**
 * A run the user stopped with Ctrl+C (or SIGHUP/SIGTERM) part-way through —
 * thrown by the snapshot writer once it has parked its work
 * ([ADR-0067](../../docs/adr/0067-park-hashes-on-interrupt.md)). A subclass
 * because the CLI catches it *by type* to branch behaviour: a deliberate stop
 * prints as a stop and exits {@link EXIT_INTERRUPTED}, never as an `ERROR:` at
 * exit 1.
 */
export class InterruptedError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "InterruptedError";
  }
}

/**
 * A file that changed (or vanished) between being hashed and its bytes being
 * uploaded — raised by `uploadObjects` (lib/upload.mjs), which never stores
 * mismatched bytes under the hash recorded for them. A subclass because `backup`
 * catches it *by type* to branch behaviour
 * ([ADR-0069](../../docs/adr/0069-fused-snapshot-upload-pipeline.md)): every other
 * upload failure is retryable with `upload <set> --snapshot <name>`, but this one
 * needs a fresh backup, because the file itself has moved on.
 */
export class FileChangedError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "FileChangedError";
  }
}

/**
 * The bytes actually streamed to the store did not hash to the digest the
 * caller promised — raised by `putFile` (lib/s3.mjs) *after* it has removed the
 * mis-stored object, so throwing it certifies the store holds nothing wrong.
 * The one way this happens in practice is a file rewritten mid-transfer: the
 * drift guard re-checks size/mtime before the PUT starts, but a multipart
 * upload re-reads the file for minutes, and a write landing inside that window
 * produces bytes that are not the preimage of the object's key.
 *
 * A subclass because `uploadObjects` (lib/upload.mjs) catches it *by type* to
 * branch behaviour: this is a per-file drift (skip the file, keep uploading the
 * rest, report it like every other drift), while any other `putFile` throw is a
 * transport failure that stops the remaining transfers.
 */
export class ContentMismatchError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "ContentMismatchError";
  }
}

/**
 * A file whose bytes are not on this disk: a cloud-sync placeholder left by
 * Windows Files On-Demand (OneDrive, Dropbox, Google Drive), which reads back
 * with its full logical size but nothing allocated behind it, and downloads
 * itself the moment anything opens it. Raised by `fileProps` (lib/file-props.mjs)
 * *instead of* reading such a file, so a first backup over a synced folder
 * doesn't quietly pull the whole cloud account onto the local disk
 * ([ADR-0081](../../docs/adr/0081-online-only-files-skipped.md)).
 *
 * A subclass because the snapshot pipeline catches it *by type* to branch
 * behaviour, and the branch is the whole point: every other throw out of
 * `fileProps` is a **fault** and becomes an `#ERROR` row, while this one is a
 * **choice** and becomes a `#SKIPPED` row beside the symlinks and the sockets.
 * Recording "OneDrive downloaded nothing today" as a failure to read a file
 * would say something untrue about a backup that worked exactly as designed.
 */
export class OnlineOnlyFileError extends Error {
  /**
   * @param {string} path - The placeholder that was not read
   */
  constructor(path) {
    // Terse and factual: this message is never printed as an error. It lands in
    // the `#SKIPPED` row's reason column, under a `dirent_type` of
    // `Online-Only File` that already carries the explanation — and `compare`
    // prints the type, not the reason (see `skippedSection` in src/render.mjs).
    super(`Stored online, not on this computer: ${path}`);
    this.name = "OnlineOnlyFileError";
    /** The placeholder's absolute path, so a catcher needn't re-parse the message. */
    this.path = path;
  }
}

/**
 * The missing-argument sentence, given an argument's *display* form. One home for
 * the wording, two callers: {@link MissingArgError} composes it from the plain
 * name at the throw site, and the dispatcher recomposes it from the registry's
 * spelling — `<snapshot>` for a positional, `-b, --bucket` for a flag (ADR-0038).
 * A command module can't render that spelling itself: it would have to import the
 * registry that imports it.
 * @param {string} display - The argument as shown to the user, e.g. `-b, --bucket`
 * @returns {string}
 */
export const missingArg = (display) => `Missing required argument: ${display}`;

/**
 * "You left out a required argument" — the one usage error the dispatcher is
 * allowed to *rewrite*, re-spelling the arg from the registry so a flag shows its
 * short form (ADR-0038). That permission is the whole reason this is a subclass
 * rather than a `ParseArgsError` with a flag set: `argName` alone means only
 * "gloss me with this arg's description", and other errors set it for exactly
 * that (`aws`'s `--save needs --from-stack`), so identity is what separates the
 * two. The message stores the *bare* name; every CLI path replaces it, so the
 * undecorated form surfaces only to a direct caller (a unit test) or when the
 * name isn't in the registry at all, which is a bug rather than a user error.
 */
export class MissingArgError extends ParseArgsError {
  /**
   * @param {string} name - The argument's plain name, e.g. `bucket`
   */
  constructor(name) {
    super(missingArg(name), { argName: name });
  }
}

/**
 * Assert a required argument is present, throwing {@link MissingArgError} if it is
 * missing or empty. Covers positionals *and* options with one helper: the two used
 * to differ only in the decoration they wrote into the message (`<set>` vs
 * `--set`), and that now comes from the registry, which already knows which map
 * the name lives in. Required options exist because a command with a bulk
 * positional operand addresses its target by flag
 * ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)):
 * `--set` on `setup`/`restore`/`forget`, and `--bucket` on `setup`.
 * @param {unknown} value - The value to check
 * @param {string} name - The argument's plain name, e.g. `bucket`
 * @returns {asserts value}
 */
export function requireArg(value, name) {
  if (!value) {
    throw new MissingArgError(name);
  }
}

/**
 * Whether an error should print command usage alongside its message — our own
 * ParseArgsError, or any of Node parseArgs' argument failures (unknown option,
 * but also a missing/invalid option value, e.g. `--bucket` with no value). Both
 * are usage-triggering failures, just thrown from different places. Matching the
 * whole `ERR_PARSE_ARGS*` family (not one exact code) keeps every malformed
 * invocation on the usage path.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUsageError(error) {
  return (
    error instanceof ParseArgsError ||
    String(/** @type {NodeJS.ErrnoException} */ (error)?.code).startsWith(
      "ERR_PARSE_ARGS",
    )
  );
}

/**
 * Whether an error is the user's bad input (CLI exit 2) rather than a runtime
 * failure (exit 1): any usage error, plus a value `ValidationError`.
 * `isUsageError` — whether to also print the usage block — is the structural
 * *subset* of this, so every usage error is an input error but not vice versa.
 * @param {unknown} error
 * @returns {boolean}
 */
export const isInputError = (error) =>
  isUsageError(error) || error instanceof ValidationError;

/**
 * The CLI's exit code for a caught error — {@link EXIT_INTERRUPTED} for a
 * deliberate stop, 2 for bad input, 1 for anything else. `src/s3cab.mjs`'s
 * top-level catch sets `process.exitCode` from this.
 * @param {unknown} error
 * @returns {number}
 */
export const exitCodeFor = (error) =>
  error instanceof InterruptedError
    ? EXIT_INTERRUPTED
    : isInputError(error)
      ? 2
      : 1;

/**
 * Whether an error is the filesystem "no such file or directory" error — the
 * common "treat a missing file as absent, rethrow everything else" guard.
 * Keeps the unknown→ErrnoException cast in one place.
 * @param {unknown} error
 */
export const isENOENT = (error) =>
  /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";

/**
 * The printable text of an error — including the ones that carry none, which is
 * the whole reason this exists. Node builds a **message-less** `AggregateError`
 * when every address a host resolves to fails to connect: its happy-eyeballs
 * path tries them all, collects the failures in `.errors`, and leaves `.message`
 * empty. S3 endpoints resolve to several addresses, so a network dropping
 * mid-upload printed as a bare `ERROR:` with nothing after it — the one way an
 * error can tell the user less than nothing. Joining the sub-errors is the only
 * way that failure says anything at all, and falling back to `name` means no
 * empty message can ever reach the terminal blank again.
 *
 * The aggregate branch *falls through* rather than returning: an `AggregateError`
 * carrying no sub-errors would otherwise join to `""` and hand the caller the very
 * blank line this exists to prevent. Node's happy-eyeballs path always supplies at
 * least one, so that shape is not reachable from the failure this was written for
 * — but a backstop with a hole in it is not a backstop.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  if (!Error.isError(error)) {
    return String(error);
  }
  if (!error.message && error instanceof AggregateError) {
    const detail = error.errors.map((cause) => errorText(cause)).join("; ");
    if (detail) {
      return detail;
    }
  }
  return error.message || error.name;
}
