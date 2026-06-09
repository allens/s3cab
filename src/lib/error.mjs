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
