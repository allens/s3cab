import { parseArgs } from "node:util";
const args = ["-f", "--bar", "b", "--no-hash"];
const options = /** @type {const} */ ({
  foo: {
    type: "boolean",
    short: "f",
  },
  bar: {
    type: "string",
  },
  "baz-boz": {
    type: "string",
  },
  hash: {
    type: "boolean",
    short: "h",
    description: "Compute SHA-256 hash of the file",
    default: true,
  },
});
const { values, positionals } = parseArgs({
  args,
  options,
  allowNegative: true,
});
console.log(values, positionals);
// Prints: [Object: null prototype] { foo: true, bar: 'b' } []
