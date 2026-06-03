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
