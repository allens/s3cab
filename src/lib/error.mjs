export class ParseArgsError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.code = "ERR_PARSE_ARGS";
  }
}

/**
 * Assert a required positional argument is present, throwing a usage error
 * (named after the argument, e.g. `<bucket>`) if it is missing or empty.
 * @param {unknown} value - The positional value to check
 * @param {string} name - The argument's display name, e.g. `<bucket>`
 * @returns {asserts value}
 */
export function requireArg(value, name) {
  if (!value) {
    throw new ParseArgsError(`Missing required argument: ${name}`);
  }
}

/**
 * Whether an error should print command usage alongside its message — our own
 * ParseArgsError, or Node parseArgs' unknown-option failure. Both are
 * usage-triggering failures, just thrown from different places.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUsageError(error) {
  return (
    error instanceof ParseArgsError ||
    /** @type {NodeJS.ErrnoException} */ (error)?.code ===
      "ERR_PARSE_ARGS_UNKNOWN_OPTION"
  );
}

/**
 * Whether an error is the filesystem "no such file or directory" error — the
 * common "treat a missing file as absent, rethrow everything else" guard.
 * Keeps the unknown→ErrnoException cast in one place.
 * @param {unknown} error
 */
export const isENOENT = (error) =>
  /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";

/**
 * Throw the standard "not built yet" error for a feature awaiting the S3 upload
 * milestone. Used by the stub commands in the registry and by built commands'
 * unimplemented branches (e.g. `--remote`), so the message stays in one place.
 * @param {string} name - The unbuilt feature, e.g. `setup` or `list --remote`
 * @returns {never}
 */
export function notImplemented(name) {
  throw new Error(
    `Not yet implemented: ${name} (S3 upload milestone in progress)`,
  );
}
