import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseEnv } from "node:util";
import {
  buildIdentity,
  ensureMachineIdentity,
  machineIdentityDir,
  machineIdentityExists,
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
