import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { RequestOptions } from "node:https" */

// `resolveCredentials` end to end, in Roles Anywhere mode: which failures of the
// exchange get the set-scoped "no credentials for set X" frame and which are
// rethrown raw for the request-time relay (ADR-0075 / ADR-0037). The endpoint is
// a fake `node:https` — mocked *before* roles-anywhere.mjs binds `request` at
// import, so this file dynamically imports auth.mjs after the mock, like
// roles-anywhere.timeout.test.mjs (Node's per-file isolation keeps the real https
// for every other suite). Everything else is real: a temp home holding a complete
// machine identity, a set loaded through `loadSet` so the error names it, and the
// live signer producing the request the fake answers.

/**
 * How the fake endpoint answers the next request: a status + body, or a socket
 * error emitted instead of any response.
 * @type {{ status: number, body: string } | { error: Error }}
 */
let answer = { status: 500, body: "" };

mock.module("node:https", {
  exports: {
    /**
     * A fake `https.request` that plays back {@link answer}: on `end()` either
     * streams the canned response through a response emitter, or emits the
     * canned socket error on the request.
     * @param {RequestOptions} _options
     * @param {(res: EventEmitter) => void} onResponse
     */
    request(_options, onResponse) {
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() {
          setImmediate(() => {
            if ("error" in answer) {
              req.emit("error", answer.error);
              return;
            }
            const res = Object.assign(new EventEmitter(), {
              statusCode: answer.status,
              setEncoding() {},
            });
            onResponse(res);
            res.emit("data", answer.body);
            res.emit("end");
          });
        },
        destroy() {},
      });
      return req;
    },
  },
});

const { resolveCredentials } = await import("./auth.mjs");
const { loadSet } = await import("./env.mjs");
const { ensureMachineIdentity, identityEnvPath } =
  await import("./roles-anywhere.mjs");
const { writeSet } = await import("./sets.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  answer = { status: 500, body: "" };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A set in Roles Anywhere mode, loaded the way a set-first command loads it —
 * so `loadedSet()` names it and `S3CAB_RA` / `S3CAB_BUCKET` are in the
 * environment `resolveCredentials` reads.
 * @param {string} root
 */
function loadRaSet(root) {
  useTempHome(root);
  writeSet("photos", { dirs: ["/data/photos"], bucket: "my-bucket" });
  const set = loadSet("photos");
  process.env.S3CAB_RA = "1";
  return set;
}

/** A complete machine identity: the four files plus the captured ARNs. */
function makeIdentity() {
  ensureMachineIdentity();
  writeFileSync(
    identityEnvPath(),
    "S3CAB_RA_TRUST_ANCHOR_ARN=arn:ta\nS3CAB_RA_PROFILE_ARN=arn:profile\n" +
      "S3CAB_RA_ROLE_ARN=arn:role\nAWS_REGION=eu-west-1\n",
  );
}

/** The rejection of a `resolveCredentials` call (the test fails if it resolves). */
const rejectionOf = () =>
  resolveCredentials({}).then(
    () => {
      throw new Error("expected resolveCredentials to reject");
    },
    (/** @type {Error} */ error) => error,
  );

describe("resolveCredentials in Roles Anywhere mode", () => {
  it("frames a missing identity as the set's credential problem, naming the bucket", async () => {
    await using dir = await mkTmpDir();
    loadRaSet(dir.path);
    // No identity under the temp home at all.

    const error = await rejectionOf();

    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.match(error.message, /certificate identity is missing, incomplete/);
    assert.match(error.message, /s3cab aws my-bucket --roles-anywhere/);
    assert.match(error.message, /--from-stack s3cab-my-bucket/);
  });

  it("frames a refused session the same way, quoting the endpoint's reason", async () => {
    await using dir = await mkTmpDir();
    loadRaSet(dir.path);
    makeIdentity();
    // The live shape: a 403 for a profile ARN this region doesn't know.
    answer = {
      status: 403,
      body: '{"message":"Invalid or empty profile provided."}',
    };

    const error = await rejectionOf();

    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.match(error.message, /AWS would not exchange it for a session/);
    assert.match(error.message, /HTTP 403.*Invalid or empty profile provided/);
    assert.match(error.message, /--from-stack s3cab-my-bucket/);
    // The set's env file is step 1 of "looked in", as for every set-scoped error.
    assert.match(
      error.message,
      /the set's own settings:.*sets[\\/]photos[\\/]env/,
    );
    // The original exchange error is kept for the debug path.
    assert.equal(
      /** @type {Error} */ (error.cause).name,
      "RolesAnywhereSessionError",
    );
  });

  it("frames a 2xx without credentials as a refused session too", async () => {
    await using dir = await mkTmpDir();
    loadRaSet(dir.path);
    makeIdentity();
    answer = { status: 200, body: '{"credentialSet":[]}' };

    const error = await rejectionOf();

    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.match(error.message, /returned no credentials/);
  });

  it("rethrows a socket error raw, errno intact, for the request-time relay", async () => {
    await using dir = await mkTmpDir();
    loadRaSet(dir.path);
    makeIdentity();
    // What a dropped network produces: a Node system error, not a session error.
    // Wrapping it would hide the errno the relay keys its retry on (ADR-0037).
    const socketError = Object.assign(
      new Error("getaddrinfo ENOTFOUND rolesanywhere.eu-west-1.amazonaws.com"),
      { code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo" },
    );
    answer = { error: socketError };

    const error = await rejectionOf();

    assert.equal(error, socketError);
    assert.doesNotMatch(error.message, /No credentials found/);
  });

  it("resolves real session credentials, with expiration as a Date", async () => {
    await using dir = await mkTmpDir();
    loadRaSet(dir.path);
    makeIdentity();
    answer = {
      status: 201,
      body: JSON.stringify({
        credentialSet: [
          {
            credentials: {
              accessKeyId: "ASIAEXAMPLE",
              secretAccessKey: "secret",
              sessionToken: "token",
              expiration: "2030-01-01T00:00:00Z",
            },
          },
        ],
      }),
    };

    const credentials = await resolveCredentials({});

    assert.equal(credentials.accessKeyId, "ASIAEXAMPLE");
    assert.equal(credentials.sessionToken, "token");
    assert.ok(credentials.expiration instanceof Date);
    assert.equal(
      credentials.expiration.toISOString(),
      "2030-01-01T00:00:00.000Z",
    );
  });
});
