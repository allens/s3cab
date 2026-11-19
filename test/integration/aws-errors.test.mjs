import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { resolveCredentials } from "../../src/lib/auth.mjs";
import { customEndpoint } from "../../src/lib/env.mjs";
import { redactEchoedCredentials } from "../../src/lib/error.mjs";
import { clientConfig } from "../../src/lib/s3.mjs";
import { bucket } from "../helpers/integration.mjs";

/** @import { AwsCredentialIdentity } from "@aws-sdk/types" */

// What AWS S3 itself echoes back when it turns a request down. The stand-in
// replies in src/lib/error.test.mjs are written to match these.
const credentials = await resolveCredentials();
const skip = customEndpoint()
  ? "measures AWS S3's own replies, and a custom endpoint is set"
  : !credentials.sessionToken &&
    "needs temporary credentials (SSO, a role), as CI's are";

describe("S3's rejections, redacted (real bucket)", { skip }, () => {
  /**
   * The SDK's own error for a GetObject signed with `credentials`.
   * @param {AwsCredentialIdentity} credentials
   * @returns {Promise<any>}
   */
  const rejection = async (credentials) => {
    const client = new S3Client({
      ...clientConfig(),
      credentials,
      maxAttempts: 1,
    });
    try {
      await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: "objects/absent" }),
      );
    } catch (error) {
      return error;
    } finally {
      client.destroy();
    }
    throw new Error("S3 accepted the request");
  };

  it("SignatureDoesNotMatch echoes the canonical request, as text and as hex", async () => {
    const token = /** @type {string} */ (credentials.sessionToken);
    const error = await rejection({
      ...credentials,
      secretAccessKey: "not-the-secret-key",
    });
    assert.equal(error.name, "SignatureDoesNotMatch");
    assert.ok(error.CanonicalRequest.includes(`x-amz-security-token:${token}`));
    assert.match(error.CanonicalRequestBytes, /^[0-9a-f]{2}( [0-9a-f]{2})*$/);

    redactEchoedCredentials(error);

    assert.ok(!inspect(error).includes(token));
  });

  it("InvalidToken echoes the token itself", async () => {
    const token = "not-a-session-token";
    const error = await rejection({ ...credentials, sessionToken: token });
    assert.equal(error.name, "InvalidToken");
    assert.equal(error["Token-0"], token);

    redactEchoedCredentials(error);

    assert.ok(!inspect(error).includes(token));
  });
});
