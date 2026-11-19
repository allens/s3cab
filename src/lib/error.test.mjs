import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { inspect } from "node:util";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  EXIT_INTERRUPTED,
  InterruptedError,
  ParseArgsError,
  ValidationError,
  errorText,
  exitCodeFor,
  isInputError,
  isUsageError,
  redactEchoedCredentials,
  requireArg,
} from "./error.mjs";

/** @import { Server } from "node:http" */
/** @import { AddressInfo } from "node:net" */

// Real SDK errors from a stand-in S3, so a field the SDK renames or adds shows
// up here rather than in a debug dump. The replies are S3's shapes.
describe("redactEchoedCredentials", () => {
  const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLETOKEN";
  const hex = (/** @type {string} */ text) =>
    [...Buffer.from(text)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  const canonical = `GET\n/b/k\n\nhost:127.0.0.1\nx-amz-security-token:${TOKEN}\n\nhost;x-amz-security-token\nUNSIGNED-PAYLOAD`;
  /** @type {Record<string, string>} */
  const replies = {
    SignatureDoesNotMatch: `<CanonicalRequest>${canonical}</CanonicalRequest><CanonicalRequestBytes>${hex(canonical)}</CanonicalRequestBytes>`,
    ExpiredToken: `<Token-0>${TOKEN}</Token-0>`,
  };
  let code = "";
  /** @type {Server} */
  let server;
  /** @type {S3Client} */
  let client;

  before(async () => {
    server = createServer((request, response) => {
      request.resume();
      response.writeHead(400, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
          `<Message>m</Message>${replies[code]}<RequestId>R</RequestId></Error>`,
      );
    });
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(undefined)),
    );
    const { port } = /** @type {AddressInfo} */ (server.address());
    client = new S3Client({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: TOKEN,
      },
    });
  });
  after(() => {
    client.destroy();
    server.close();
  });

  /** The SDK's error for `reply`, wrapped as s3.mjs's relay wraps it. */
  const rejection = async (/** @type {string} */ reply) => {
    code = reply;
    try {
      await client.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));
    } catch (cause) {
      return new Error("translated", { cause });
    }
    throw new Error("the stand-in S3 accepted the request");
  };

  for (const reply of Object.keys(replies)) {
    it(`leaves no session token in a ${reply} dump`, async () => {
      const error = await rejection(reply);
      assert.ok(inspect(error).includes(TOKEN), "the reply echoes the token");

      redactEchoedCredentials(error);

      const dump = inspect(error);
      assert.ok(!dump.includes(TOKEN));
      assert.ok(!dump.includes(hex(TOKEN)));
      assert.match(dump, /\[redacted\]/);
    });
  }

  it("keeps the rest of the canonical request", async () => {
    const error = await rejection("SignatureDoesNotMatch");
    redactEchoedCredentials(error);
    assert.equal(
      /** @type {any} */ (error).cause.CanonicalRequest,
      canonical.replace(TOKEN, "[redacted]"),
    );
  });
});

describe("ParseArgsError", () => {
  it("sets ERR_PARSE_ARGS code and message", () => {
    const err = new ParseArgsError("bad arg");
    assert.equal(err.code, "ERR_PARSE_ARGS");
    assert.equal(err.message, "bad arg");
    assert.ok(err instanceof Error);
  });
});

describe("requireArg", () => {
  it("throws ParseArgsError when value is absent, wrapping the plain name", () => {
    assert.throws(() => requireArg(undefined, "bucket"), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: bucket",
    });
  });

  it("tags the error with the plain argName for the description lookup", () => {
    assert.throws(
      () => requireArg(undefined, "bucket"),
      (err) => err instanceof ParseArgsError && err.argName === "bucket",
    );
  });

  it("throws ParseArgsError when value is empty string", () => {
    assert.throws(() => requireArg("", "file"), { code: "ERR_PARSE_ARGS" });
  });

  it("does not throw when value is present", () => {
    assert.doesNotThrow(() => requireArg("something", "bucket"));
  });
});

describe("isUsageError", () => {
  it("returns true for ParseArgsError", () => {
    assert.ok(isUsageError(new ParseArgsError("test")));
  });

  it("returns true for any ERR_PARSE_ARGS* failure, not just unknown option", () => {
    for (const code of [
      "ERR_PARSE_ARGS_UNKNOWN_OPTION",
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", // e.g. `--bucket` given no value
      "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
    ]) {
      assert.ok(isUsageError(Object.assign(new Error(code), { code })), code);
    }
  });

  it("returns false for a generic Error", () => {
    assert.equal(isUsageError(new Error("generic")), false);
  });

  it("returns false for non-error values", () => {
    assert.equal(isUsageError(null), false);
    assert.equal(isUsageError("string"), false);
  });

  it("does not treat a ValidationError as a usage (print-usage) error", () => {
    // A bad value exits 2 but carries its own fix, so usage is NOT printed.
    assert.equal(isUsageError(new ValidationError("bad value")), false);
  });
});

describe("isInputError", () => {
  it("is true for every usage error (the structural subset)", () => {
    assert.ok(isInputError(new ParseArgsError("test")));
    assert.ok(
      isInputError(
        Object.assign(new Error("x"), {
          code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
        }),
      ),
    );
  });

  it("is true for a value ValidationError (exit 2, no usage dump)", () => {
    assert.ok(isInputError(new ValidationError("bad value")));
  });

  it("is false for a runtime error and non-errors", () => {
    assert.equal(isInputError(new Error("network down")), false);
    assert.equal(isInputError(null), false);
  });
});

describe("exitCodeFor", () => {
  // The externally-visible promise ADR-0067 makes: a run the user stopped
  // exits 130 (128 + SIGINT), not the generic runtime-failure 1.
  it("is EXIT_INTERRUPTED (130) for a run the user stopped", () => {
    assert.equal(
      exitCodeFor(new InterruptedError("stopped")),
      EXIT_INTERRUPTED,
    );
    assert.equal(EXIT_INTERRUPTED, 130);
  });

  it("is 2 for bad input", () => {
    assert.equal(exitCodeFor(new ParseArgsError("bad arg")), 2);
    assert.equal(exitCodeFor(new ValidationError("bad value")), 2);
  });

  it("is 1 for any other runtime failure", () => {
    assert.equal(exitCodeFor(new Error("network down")), 1);
  });
});

describe("errorText", () => {
  it("is the message for an ordinary error", () => {
    assert.equal(errorText(new Error("bucket not found")), "bucket not found");
  });

  // The bug it exists for: Node's happy-eyeballs connect leaves `.message` empty
  // and puts every per-address failure in `.errors`, so printing `.message` gave
  // a bare `ERROR:` with nothing after it.
  it("joins the sub-errors of a message-less AggregateError", () => {
    const aggregate = new AggregateError([
      new Error("connect ENETUNREACH 52.219.72.100:443"),
      new Error("connect ENETUNREACH 52.219.98.20:443"),
    ]);
    assert.equal(aggregate.message, "");
    assert.equal(
      errorText(aggregate),
      "connect ENETUNREACH 52.219.72.100:443; connect ENETUNREACH 52.219.98.20:443",
    );
  });

  // The hole in the backstop: the sub-error join is "" for an empty `.errors`, so
  // returning it unconditionally handed back the blank line this exists to stop.
  it("still says something for an AggregateError with no sub-errors", () => {
    const empty = new AggregateError([]);
    assert.equal(empty.message, "");
    assert.equal(errorText(empty), "AggregateError");
  });

  it("keeps an AggregateError's own message when it has one", () => {
    const aggregate = new AggregateError([new Error("inner")], "all failed");
    assert.equal(errorText(aggregate), "all failed");
  });

  it("never returns empty — falls back to the error's name", () => {
    const nameless = new Error("");
    nameless.name = "TimeoutError";
    assert.equal(errorText(nameless), "TimeoutError");
  });

  it("stringifies a thrown non-error", () => {
    assert.equal(errorText("just a string"), "just a string");
    assert.equal(errorText(undefined), "undefined");
  });
});
