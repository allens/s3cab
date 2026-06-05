export class ParseArgsError extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = "ERR_PARSE_ARGS";
  }
}
