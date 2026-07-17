import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, mock } from "node:test";

/** @import { RequestOptions } from "node:https" */

// The `createSession` request timeout, in its own file because it must mock
// `node:https` *before* roles-anywhere.mjs binds `request` at import — the main
// unit suite imports the module statically, so the mock has to precede a dynamic
// import here (each test file runs in its own process, so this doesn't disturb the
// real https the other suites use). Node's default per-file isolation is what makes
// this clean. Asserts the observable contract: a connected-but-silent endpoint
// rejects with an actionable error instead of hanging the command forever.

/** The `timeout` the mocked `request` was last called with (for assertion). */
let lastTimeout = /** @type {number | undefined} */ (undefined);

mock.module("node:https", {
  exports: {
    /**
     * A fake `https.request` whose socket never answers: `end()` fires `timeout`
     * (the inactivity signal), and `destroy(err)` surfaces as an `error` — exactly
     * the sequence the real socket produces when the SUT aborts on timeout.
     * @param {RequestOptions} options
     */
    request(options) {
      lastTimeout = options.timeout;
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() {
          setImmediate(() => req.emit("timeout"));
        },
        destroy(/** @type {Error} */ error) {
          setImmediate(() => req.emit("error", error));
        },
      });
      return req;
    },
  },
});

const { buildIdentity, createSession } = await import("./roles-anywhere.mjs");

describe("createSession timeout", () => {
  const id = buildIdentity();
  const input = {
    region: "eu-west-1",
    certPem: id.clientPem,
    keyPem: id.clientKeyPem,
    trustAnchorArn: "arn:ta",
    profileArn: "arn:profile",
    roleArn: "arn:role",
  };

  it("aborts with an actionable error instead of hanging when the endpoint is silent", async () => {
    const error = await createSession(input).then(
      () => {
        throw new Error("expected createSession to reject on timeout");
      },
      (e) => e,
    );
    assert.match(
      error.message,
      /Timed out reaching the Roles Anywhere endpoint/,
    );
    assert.match(error.message, /rolesanywhere\.eu-west-1\.amazonaws\.com/);
    // A bounded, non-zero timeout was actually set on the request.
    assert.ok(
      lastTimeout !== undefined && lastTimeout > 0 && lastTimeout <= 30_000,
      `expected a bounded timeout, got ${lastTimeout}`,
    );
  });
});
