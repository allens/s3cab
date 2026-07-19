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
 * Whether an error is the filesystem "no such file or directory" error — the
 * common "treat a missing file as absent, rethrow everything else" guard.
 * Keeps the unknown→ErrnoException cast in one place.
 * @param {unknown} error
 */
export const isENOENT = (error) =>
  /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";

/**
 * Throw the standard "not built yet" error for a `planned` stub command in the
 * registry, keeping the message in one place. No command uses it right now (the
 * last stub, `verify`, is built) — kept as the convention's factory for the next
 * scaffolded-but-unbuilt command, and exercised by error.test.mjs.
 * @param {string} name - The unbuilt feature, e.g. `verify`
 * @returns {never}
 */
export function notImplemented(name) {
  throw new Error(`Not yet implemented: ${name}`);
}
