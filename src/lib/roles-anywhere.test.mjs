import assert from "node:assert/strict";
import { X509Certificate, createHash, verify } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseEnv } from "node:util";
import {
  buildIdentity,
  buildSignedRequest,
  ensureMachineIdentity,
  isRolesAnywhereMode,
  machineIdentityDir,
  machineIdentityExists,
  parseSessionResponse,
  readSigningIdentity,
  saveArnsFromStack,
} from "./roles-anywhere.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// The Roles Anywhere identity is security-sensitive: RA rejects the trust anchor
// or the session unless the CA/client certs carry an EXACT set of extensions
// (ADR-0057/0058, found the hard way by the spike). So `buildIdentity` is asserted
// against those exact DER bytes (not just "has a basicConstraints"), plus the
// chain verifies and the serial round-trips for the signer's swap #1. The
// hand-rolled DER encoder is validated end-to-end against `openssl` by
// scripts/roles-anywhere-certgen-spike.mjs — kept out of the test suite so
// `openssl` isn't a test dependency; here we assert the observable contract via
// node:crypto only.

const mkTmpDir = () => mkdtempDisposable(join("test", ".tmp"));

/** Bytes as a Buffer, from a spaced hex string (readability). @param {string} hex */
const bytes = (hex) => Buffer.from(hex.replaceAll(" ", ""), "hex");

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("buildIdentity", () => {
  const id = buildIdentity();
  const ca = new X509Certificate(id.caPem);
  const client = new X509Certificate(id.clientPem);

  it("makes both certs ECDSA P-256", () => {
    for (const cert of [ca, client]) {
      assert.equal(cert.publicKey.asymmetricKeyType, "ec");
      assert.equal(
        cert.publicKey.asymmetricKeyDetails?.namedCurve,
        "prime256v1",
      );
    }
  });

  it("names the CA and the CA-issued client", () => {
    assert.equal(ca.subject, "CN=s3cab-ca");
    assert.equal(ca.issuer, "CN=s3cab-ca"); // self-signed
    assert.equal(client.subject, "CN=s3cab-client");
    assert.equal(client.issuer, "CN=s3cab-ca");
  });

  it("chains: the client verifies against the CA, and the CA is self-signed", () => {
    assert.ok(client.verify(ca.publicKey));
    assert.ok(ca.verify(ca.publicKey));
  });

  it("gives the CA basicConstraints critical CA:TRUE pathlen:0 + keyUsage keyCertSign,cRLSign", () => {
    assert.equal(ca.ca, true);
    // basicConstraints ext: OID 2.5.29.19, critical TRUE, {cA TRUE, pathLen 0}
    assert.ok(
      ca.raw.includes(bytes("55 1d 13 01 01 ff 04 08 30 06 01 01 ff 02 01 00")),
    );
    // keyUsage ext: OID 2.5.29.15, critical TRUE, BIT STRING keyCertSign+cRLSign
    assert.ok(ca.raw.includes(bytes("55 1d 0f 01 01 ff 04 04 03 02 01 06")));
  });

  it("gives the client basicConstraints critical CA:FALSE + keyUsage digitalSignature", () => {
    assert.equal(client.ca, false);
    // basicConstraints ext: critical, empty SEQUENCE (cA defaults FALSE)
    assert.ok(client.raw.includes(bytes("55 1d 13 01 01 ff 04 02 30 00")));
    // keyUsage ext: critical, BIT STRING digitalSignature only
    assert.ok(
      client.raw.includes(bytes("55 1d 0f 01 01 ff 04 04 03 02 07 80")),
    );
  });

  it("gives the client extendedKeyUsage = clientAuth, non-critical", () => {
    // node:crypto's `.keyUsage` surfaces the EXTENDED key usages (OIDs).
    assert.deepEqual(client.keyUsage, ["1.3.6.1.5.5.7.3.2"]);
    // EKU ext present; no `critical` BOOLEAN between its OID and the OCTET STRING.
    assert.ok(
      client.raw.includes(
        bytes("55 1d 25 04 0c 30 0a 06 08 2b 06 01 05 05 07 03 02"),
      ),
    );
    assert.equal(ca.keyUsage, undefined); // the CA carries no EKU
  });

  it("dates the certs ~10 years out (generate-and-forget)", () => {
    const years =
      (new Date(client.validTo).getTime() -
        new Date(client.validFrom).getTime()) /
      (365 * 24 * 60 * 60 * 1000);
    assert.ok(
      years > 9.9 && years < 10.1,
      `validity was ~${years.toFixed(2)}y`,
    );
  });

  it("uses a positive, non-zero serial the signer can render as a decimal (swap #1)", () => {
    // Guarded against the (astronomically unlikely) all-zero serial RFC 5280
    // forbids — > 0n asserts both positive and non-zero.
    assert.ok(BigInt("0x" + client.serialNumber) > 0n);
    assert.ok(BigInt("0x" + ca.serialNumber) > 0n);
  });

  it("exports both private keys as PKCS#8 PEM (the signer reads client.key)", () => {
    assert.match(id.clientKeyPem, /-----BEGIN PRIVATE KEY-----/);
    assert.match(id.caKeyPem, /-----BEGIN PRIVATE KEY-----/);
  });
});

describe("ensureMachineIdentity", () => {
  it("generates the four PEMs on first call, owner-only", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.equal(machineIdentityExists(), false);
    const result = ensureMachineIdentity();
    assert.equal(result.created, true);
    assert.equal(machineIdentityExists(), true);

    const raDir = machineIdentityDir();
    for (const file of ["ca.pem", "ca.key", "client.pem", "client.key"]) {
      const path = join(raDir, file);
      assert.ok(readFileSync(path, "utf8").length > 0, file);
      if (process.platform !== "win32") {
        assert.equal(statSync(path).mode & 0o777, 0o600, `${file} mode`);
      }
    }
    if (process.platform !== "win32") {
      assert.equal(statSync(raDir).mode & 0o777, 0o700, "dir mode");
    }
    // The returned CA is exactly the persisted one — a parseable self-signed cert.
    assert.equal(result.caPem, readFileSync(join(raDir, "ca.pem"), "utf8"));
    assert.doesNotThrow(() => new X509Certificate(result.caPem));
  });

  it("reuses the existing identity on a second call — never mints a new CA", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const first = ensureMachineIdentity();
    const second = ensureMachineIdentity();
    assert.equal(second.created, false);
    // Same CA text both times: re-running `aws --roles-anywhere` must not orphan
    // a deployed trust anchor by silently regenerating.
    assert.equal(second.caPem, first.caPem);
  });

  it("refuses to regenerate over a PARTIAL identity — never silently replaces the CA", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    const { caPem } = ensureMachineIdentity();
    const caPath = join(machineIdentityDir(), "ca.pem");
    // An interrupted write / hand-deletion: client.pem gone, the CA survives.
    unlinkSync(join(machineIdentityDir(), "client.pem"));

    assert.equal(machineIdentityExists(), false); // not "present" — it's incomplete
    assert.throws(ensureMachineIdentity, {
      name: "ValidationError",
      message: /incomplete \(missing client\.pem\)/,
    });
    // The surviving CA is left exactly as it was — not silently replaced.
    assert.equal(readFileSync(caPath, "utf8"), caPem);
  });
});

describe("saveArnsFromStack", () => {
  it("refuses when no identity has been generated yet", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    await assert.rejects(
      saveArnsFromStack({ stackName: "s3cab-foo", region: "eu-west-1" }),
      { name: "ValidationError", message: /No Roles Anywhere identity/ },
    );
  });

  it("writes the three ARNs + region into the identity env from the stack outputs", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();

    t.mock.module("@aws-sdk/client-cloudformation", {
      exports: {
        CloudFormationClient: class {
          async send() {
            return {
              Stacks: [
                {
                  Outputs: [
                    {
                      OutputKey: "TrustAnchorArn",
                      OutputValue: "arn:aws:ta/1",
                    },
                    {
                      OutputKey: "ProfileArn",
                      OutputValue: "arn:aws:profile/2",
                    },
                    { OutputKey: "RoleArn", OutputValue: "arn:aws:role/3" },
                    { OutputKey: "Ignored", OutputValue: "nope" },
                  ],
                },
              ],
            };
          }
        },
        DescribeStacksCommand: class {
          constructor(/** @type {object} */ input) {
            this.input = input;
          }
        },
      },
    });

    const result = await saveArnsFromStack({
      stackName: "s3cab-foo",
      region: "eu-west-1",
    });
    assert.deepEqual(result.arns, {
      S3CAB_RA_TRUST_ANCHOR_ARN: "arn:aws:ta/1",
      S3CAB_RA_PROFILE_ARN: "arn:aws:profile/2",
      S3CAB_RA_ROLE_ARN: "arn:aws:role/3",
    });

    const env = parseEnv(
      readFileSync(join(machineIdentityDir(), "env"), "utf8"),
    );
    assert.equal(env.S3CAB_RA_TRUST_ANCHOR_ARN, "arn:aws:ta/1");
    assert.equal(env.S3CAB_RA_PROFILE_ARN, "arn:aws:profile/2");
    assert.equal(env.S3CAB_RA_ROLE_ARN, "arn:aws:role/3");
    assert.equal(env.AWS_REGION, "eu-west-1");
  });

  it("errors constructively when the stack is missing the RA outputs", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();

    t.mock.module("@aws-sdk/client-cloudformation", {
      exports: {
        CloudFormationClient: class {
          async send() {
            return { Stacks: [{ Outputs: [] }] }; // e.g. the IAM-user stack
          }
        },
        DescribeStacksCommand: class {},
      },
    });

    await assert.rejects(
      saveArnsFromStack({ stackName: "s3cab-foo", region: "eu-west-1" }),
      {
        name: "ValidationError",
        message: /missing the Roles Anywhere outputs/,
      },
    );
  });
});

// The signer (Phase B) is the one genuinely bespoke bit of AWS crypto, so it is
// tested against an INDEPENDENT reference (`reference()` below): the SigV4-X509
// canonical request / string-to-sign / Authorization, hand-rolled here straight
// from the AWS spec with node:crypto. The signer under test derives the same
// values via `@smithy/signature-v4`, so agreement cross-checks two independent
// implementations. The oracle is the exact formula the live-validated signer spike
// (scripts/roles-anywhere-signer-spike.mjs, a `201` from CreateSession) uses, kept
// here in the test rather than imported from scratch. Two levels: (1) every
// deterministic field matches the reference; (2) the per-run-random ECDSA signature
// is verified cryptographically against the client cert over the reference
// string-to-sign, proving the EC-DER path signs the right bytes.

describe("buildSignedRequest", () => {
  const id = buildIdentity();
  const input = {
    region: "eu-west-1",
    certPem: id.clientPem,
    keyPem: id.clientKeyPem,
    trustAnchorArn:
      "arn:aws:rolesanywhere:eu-west-1:111122223333:trust-anchor/ta-1",
    profileArn: "arn:aws:rolesanywhere:eu-west-1:111122223333:profile/p-1",
    roleArn: "arn:aws:iam::111122223333:role/s3cab-role-my-backups",
  };
  const cert = new X509Certificate(id.clientPem);
  // A fixed instant so `new Date()` inside the signer is deterministic (ECDSA's
  // random k still varies run-to-run, so the Signature itself is compared out).
  const FIXED_MS = Date.parse("2026-07-14T12:34:56.789Z");
  const EXPECTED_AMZ_DATE = new Date(FIXED_MS)
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "");

  /** Split an Authorization header into everything before `Signature=` and the hex. */
  const splitAuth = (/** @type {string} */ auth) => {
    const [prefix, signature] = auth.split(", Signature=");
    return { prefix, signature };
  };

  /**
   * The SigV4-X509 pieces for `input` at `amzDate`, hand-rolled from the AWS spec
   * (node:crypto) — an oracle independent of the signer's @smithy path.
   * @param {string} amzDate
   */
  const reference = (amzDate) => {
    const host = `rolesanywhere.${input.region}.amazonaws.com`;
    const x509 = cert.raw.toString("base64");
    const body = JSON.stringify({
      durationSeconds: 3600,
      profileArn: input.profileArn,
      roleArn: input.roleArn,
      trustAnchorArn: input.trustAnchorArn,
    });
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const pairs = /** @type {[string, string][]} */ ([
      ["host", host],
      ["x-amz-date", amzDate],
      ["x-amz-x509", x509],
    ]).sort(([a], [b]) => (a < b ? -1 : 1));
    const canonicalRequest = [
      "POST",
      "/sessions",
      "",
      pairs.map(([n, v]) => `${n}:${v}`).join("\n"),
      "",
      pairs.map(([n]) => n).join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${amzDate.slice(0, 8)}/${input.region}/rolesanywhere/aws4_request`;
    const stringToSign = [
      "AWS4-X509-ECDSA-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const serialDecimal = BigInt("0x" + cert.serialNumber).toString();
    return {
      host,
      body,
      x509,
      scope,
      stringToSign,
      authorizationPrefix:
        `AWS4-X509-ECDSA-SHA256 Credential=${serialDecimal}/${scope}, ` +
        `SignedHeaders=host;x-amz-date;x-amz-x509`,
    };
  };

  it("matches the independent SigV4-X509 spec reference on every deterministic field", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: FIXED_MS });
    const signed = await buildSignedRequest(input);
    const want = reference(EXPECTED_AMZ_DATE);

    assert.equal(signed.host, want.host);
    assert.equal(signed.path, "/sessions");
    assert.equal(signed.body, want.body);
    assert.equal(signed.headers["X-Amz-Date"], EXPECTED_AMZ_DATE);
    assert.equal(signed.headers["X-Amz-X509"], want.x509);
    assert.equal(signed.headers["Content-Type"], "application/json");
    // The Authorization prefix — algorithm, Credential=<serial>/<scope>,
    // SignedHeaders — is deterministic and must match; only the trailing
    // Signature= differs (ECDSA nonce), so it is split off.
    assert.equal(
      splitAuth(signed.headers.Authorization ?? "").prefix,
      want.authorizationPrefix,
    );
  });

  it("applies the two SigV4-X509 swaps: serial-as-decimal credential id + base64 DER cert header", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: FIXED_MS });
    const signed = await buildSignedRequest(input);

    // Swap #1: credential id is the cert serial as a DECIMAL string.
    const serialDecimal = BigInt("0x" + cert.serialNumber).toString();
    assert.match(
      signed.headers.Authorization ?? "",
      new RegExp(
        `^AWS4-X509-ECDSA-SHA256 Credential=${serialDecimal}/20260714/eu-west-1/rolesanywhere/aws4_request, `,
      ),
    );
    // Swap #2: the leaf cert rides in X-Amz-X509 as single-line base64(DER).
    assert.equal(signed.headers["X-Amz-X509"], cert.raw.toString("base64"));
    assert.doesNotMatch(signed.headers["X-Amz-X509"] ?? "", /\n/);
    // Exactly the three signed headers, in canonical order.
    assert.match(
      signed.headers.Authorization ?? "",
      /SignedHeaders=host;x-amz-date;x-amz-x509, Signature=[0-9a-f]+$/,
    );
  });

  it("selects the ECDSA algorithm id for a P-256 client key", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: FIXED_MS });
    const signed = await buildSignedRequest(input);
    assert.match(
      signed.headers.Authorization ?? "",
      /^AWS4-X509-ECDSA-SHA256 /,
    );
  });

  it("emits a DER-ECDSA signature that verifies against the client cert over the string-to-sign", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: FIXED_MS });
    const signed = await buildSignedRequest(input);
    const { signature } = splitAuth(signed.headers.Authorization ?? "");

    // Verify the signer's signature is valid for the reference string-to-sign
    // (built independently, from the spec) — proving createSign("SHA256") signed
    // the correct bytes and node's default DER-ECDSA encoding is accepted.
    const { stringToSign } = reference(EXPECTED_AMZ_DATE);
    assert.ok(
      verify(
        "sha256",
        Buffer.from(stringToSign),
        cert.publicKey,
        Buffer.from(signature ?? "", "hex"),
      ),
      "the Authorization signature must verify against the client certificate",
    );
  });

  it("requests the default 1-hour lifetime, overridable", async () => {
    const oneHour = await buildSignedRequest(input);
    assert.match(oneHour.body, /"durationSeconds":3600/);
    const short = await buildSignedRequest({ ...input, durationSeconds: 900 });
    assert.match(short.body, /"durationSeconds":900/);
    // The body is exactly the four CreateSession fields.
    assert.deepEqual(JSON.parse(oneHour.body), {
      durationSeconds: 3600,
      profileArn: input.profileArn,
      roleArn: input.roleArn,
      trustAnchorArn: input.trustAnchorArn,
    });
  });
});

describe("parseSessionResponse", () => {
  const creds = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: "2026-07-14T13:34:56Z",
  };
  const ok = JSON.stringify({ credentialSet: [{ credentials: creds }] });

  it("extracts the credential block from a 2xx body", () => {
    assert.deepEqual(parseSessionResponse({ status: 201, body: ok }), creds);
  });

  it("surfaces the server's body on a non-2xx", () => {
    assert.throws(
      () =>
        parseSessionResponse({
          status: 403,
          body: "AccessDeniedException: trust anchor disabled",
        }),
      /HTTP 403.*trust anchor disabled/s,
    );
  });

  it("rejects a 2xx that carries no credentials", () => {
    assert.throws(
      () => parseSessionResponse({ status: 200, body: '{"credentialSet":[]}' }),
      /returned no credentials/,
    );
  });

  it("rejects a non-JSON body", () => {
    assert.throws(
      () => parseSessionResponse({ status: 200, body: "<html>nope" }),
      /non-JSON body/,
    );
  });
});

describe("isRolesAnywhereMode / readSigningIdentity", () => {
  it("reads the S3CAB_RA marker from the given environment", () => {
    assert.equal(isRolesAnywhereMode({ S3CAB_RA: "1" }), true);
    assert.equal(isRolesAnywhereMode({}), false);
    assert.equal(isRolesAnywhereMode({ S3CAB_RA: "" }), false);
    assert.equal(isRolesAnywhereMode({ S3CAB_RA: "0" }), false);
  });

  it("returns undefined when no identity has been generated", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    assert.equal(readSigningIdentity(), undefined);
  });

  it("returns undefined when the identity exists but its ARNs weren't saved", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity(); // certs exist, but no `env` file yet (no --save)
    assert.equal(readSigningIdentity(), undefined);
  });

  it("reads the cert, key, ARNs and region once the identity is complete", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();
    writeFileSync(
      join(machineIdentityDir(), "env"),
      "S3CAB_RA_TRUST_ANCHOR_ARN=arn:ta\nS3CAB_RA_PROFILE_ARN=arn:profile\n" +
        "S3CAB_RA_ROLE_ARN=arn:role\nAWS_REGION=eu-west-1\n",
    );

    const identity = readSigningIdentity();
    assert.ok(identity);
    assert.equal(identity.region, "eu-west-1");
    assert.equal(identity.trustAnchorArn, "arn:ta");
    assert.equal(identity.profileArn, "arn:profile");
    assert.equal(identity.roleArn, "arn:role");
    assert.match(identity.certPem, /-----BEGIN CERTIFICATE-----/);
    assert.match(identity.keyPem, /-----BEGIN PRIVATE KEY-----/);
    // The identity really can sign — end-to-end through buildSignedRequest.
    const signed = await buildSignedRequest(identity);
    assert.match(
      signed.headers.Authorization ?? "",
      /^AWS4-X509-ECDSA-SHA256 /,
    );
  });

  it("returns undefined when the identity is incomplete (a missing ARN)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    ensureMachineIdentity();
    writeFileSync(
      join(machineIdentityDir(), "env"),
      "S3CAB_RA_TRUST_ANCHOR_ARN=arn:ta\nAWS_REGION=eu-west-1\n", // no profile/role
    );
    assert.equal(readSigningIdentity(), undefined);
  });
});
