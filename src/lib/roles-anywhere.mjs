import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateEnvFile } from "./env-file.mjs";
import { ValidationError } from "./error.mjs";
import { s3cabDir, tildeify } from "./home.mjs";

// The machine-level IAM Roles Anywhere identity (ADR-0057/0058): one self-signed
// CA + one client certificate, shared by every set in RA mode the way sets share
// a machine-level AWS_PROFILE. Stored under `~/.s3cab/roles-anywhere/` (dir 0700,
// files 0600), matching the `~/.s3cab/sets/<set>/` cluster convention:
//
//   ca.pem / ca.key         the self-signed CA (avoids AWS Private CA fees). ca.key
//                           is the *cold* key — only re-issues client certs.
//   client.pem / client.key the machine's identity; client.key is the runtime
//                           signing key (Phase B), NEVER sent to AWS.
//   env                     KEY=value: the three RA ARNs + AWS_REGION, captured
//                           from the deployed CloudFormation stack (--save).
//
// This module owns cert **generation** and **storage** (Phase A-2). The runtime
// signer (Phase B) will live here too and read `client.key` as a PEM string,
// calling `crypto.createSign("SHA256").sign(keyPem)` (ADR-0058 pins that interface).
//
// Node builtins cannot *create* X.509 certificates (X509Certificate is parse-only),
// so the certs are built by a hand-rolled ASN.1 DER encoder below — zero
// dependency (ADR-0058, over @peculiar/x509 / node-forge / OS keystores). It is
// tractable because Node supplies the two hard parts: the SubjectPublicKeyInfo as
// SPKI DER (spliced in verbatim) and the signature as DER ECDSA (already the
// `ecdsa-with-SHA256` signatureValue X.509 wants). Validated end-to-end against
// `openssl` and the live CreateSession endpoint by the two spikes in scripts/.

// ── DER primitives ──────────────────────────────────────────────────────────
// A minimal DER (distinguished encoding rules) TLV builder — just enough to
// assemble a certificate. Not a general ASN.1 library (ADR-0006): only the tags
// an X.509 cert needs, each a `(tag, content) -> Buffer` that prepends the
// length. See docs/adr/0058 for why this is smaller than the dependency it avoids.

/**
 * Encode a DER length octet(s) for a content of `n` bytes (short form < 128,
 * else long form: a count byte with the high bit set, then big-endian length).
 * @param {number} n
 * @returns {Buffer}
 */
function derLength(n) {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) {
    bytes.unshift(v & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * A DER TLV: one tag byte, the encoded length, then the content.
 * @param {number} tag
 * @param {Buffer} content
 * @returns {Buffer}
 */
function tlv(tag, content) {
  return Buffer.concat([
    Buffer.from([tag]),
    derLength(content.length),
    content,
  ]);
}

/** DER SEQUENCE (0x30) of its parts. @param {...Buffer} parts */
const sequence = (...parts) => tlv(0x30, Buffer.concat(parts));
/** DER SET (0x31) of its parts. @param {...Buffer} parts */
const setOf = (...parts) => tlv(0x31, Buffer.concat(parts));

/**
 * DER INTEGER from an unsigned big-endian magnitude: strip leading zero bytes,
 * then prepend one 0x00 if the top bit is set (so it stays positive). This is
 * how the certificate serial (random 16 bytes) and small ints are encoded.
 * @param {Buffer} magnitude
 * @returns {Buffer}
 */
function integer(magnitude) {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) {
    start++;
  }
  let body = magnitude.subarray(start);
  if (body.length === 0) {
    body = Buffer.from([0]);
  }
  if ((body[0] ?? 0) & 0x80) {
    body = Buffer.concat([Buffer.from([0]), body]);
  }
  return tlv(0x02, body);
}

/** DER INTEGER from a small non-negative number (cert version, pathlen). @param {number} n */
const smallInteger = (n) => integer(Buffer.from([n]));

/** DER BOOLEAN (0xff for true, per DER). @param {boolean} value */
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

/**
 * DER OBJECT IDENTIFIER from a dotted string (e.g. "2.5.29.19"). The first two
 * arcs pack into one byte (40*a + b); the rest are base-128, high bit set on all
 * but the last byte of each arc.
 * @param {string} dotted
 * @returns {Buffer}
 */
function objectId(dotted) {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const stack = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) {
      stack.unshift((v & 0x7f) | 0x80);
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** DER UTF8String (0x0c). @param {string} text */
const utf8String = (text) => tlv(0x0c, Buffer.from(text, "utf8"));

/**
 * DER BIT STRING (0x03): a leading unused-bits count, then the data. Used for
 * the KeyUsage value and the outer signature.
 * @param {number} unusedBits
 * @param {Buffer} data
 */
const bitString = (unusedBits, data) =>
  tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), data]));

/**
 * A context-specific [n] EXPLICIT wrapper (the version and extensions tags).
 * @param {number} n
 * @param {Buffer} content
 */
const explicit = (n, content) => tlv(0xa0 | n, content);

// ── X.509 pieces ────────────────────────────────────────────────────────────

/** The OIDs this generator emits. */
const OID = {
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  clientAuth: "1.3.6.1.5.5.7.3.2",
};

/** The `ecdsa-with-SHA256` AlgorithmIdentifier — no parameters (RFC 5758). */
const ecdsaSha256Alg = sequence(objectId(OID.ecdsaWithSHA256));

/** A Name (RDNSequence) with a single CommonName. @param {string} cn */
const distinguishedName = (cn) =>
  sequence(setOf(sequence(objectId(OID.commonName), utf8String(cn))));

/**
 * A validity Time as DER UTCTime (0x17, `YYMMDDHHMMSSZ`) — correct for years
 * < 2050 (RFC 5280). The certs are ~10-year, so both dates are pre-2050 today; a
 * cert generated after ~2039 would cross 2050 and need GeneralizedTime, noted in
 * ADR-0058 as a deliberate not-yet.
 * @param {Date} date
 */
function utcTime(date) {
  const digits = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(digits + "Z", "ascii"));
}

/**
 * A validity SEQUENCE { notBefore, notAfter }.
 * @param {Date} from
 * @param {Date} to
 */
const validity = (from, to) => sequence(utcTime(from), utcTime(to));

/**
 * One X.509v3 Extension: SEQUENCE { extnID, critical BOOLEAN?, extnValue OCTET
 * STRING }. `critical` is omitted when false (DER DEFAULT), matching openssl.
 * @param {string} extnOid
 * @param {boolean} critical
 * @param {Buffer} valueDer - The DER of the extension's value.
 */
function extension(extnOid, critical, valueDer) {
  const parts = [objectId(extnOid)];
  if (critical) {
    parts.push(boolean(true));
  }
  parts.push(tlv(0x04, valueDer));
  return sequence(...parts);
}

/** KeyUsage named-bit positions (RFC 5280). */
const KEY_USAGE_BIT = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 };

/**
 * A KeyUsage extension value: a BIT STRING with the given named bits set, DER's
 * trailing zero bits dropped (so the unused-bit count reflects the highest set
 * bit). @param {...number} bits
 */
function keyUsageValue(...bits) {
  const highest = Math.max(...bits);
  const data = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) {
    const i = Math.floor(bit / 8);
    data[i] = (data[i] ?? 0) | (0x80 >> (bit % 8));
  }
  return bitString(7 - (highest % 8), data);
}

/** Wrap a signed Certificate DER in PEM armor (64-char base64 lines). @param {Buffer} der */
function certPem(der) {
  const b64 = (der.toString("base64").match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * Build and sign one X.509 certificate.
 * @param {object} params
 * @param {string} params.subjectCn
 * @param {string} params.issuerCn
 * @param {import("node:crypto").KeyObject} params.subjectPublicKey
 * @param {import("node:crypto").KeyObject} params.issuerPrivateKey
 * @param {Buffer[]} params.extensions - Pre-built Extension SEQUENCEs.
 * @param {number} params.years - Validity length.
 * @returns {string} The certificate PEM.
 */
function makeCertificate({
  subjectCn,
  issuerCn,
  subjectPublicKey,
  issuerPrivateKey,
  extensions,
  years,
}) {
  const spki = subjectPublicKey.export({ type: "spki", format: "der" });
  const now = new Date();
  // Backdate notBefore 5 minutes so a client with mild clock skew doesn't reject
  // a freshly-minted cert as not-yet-valid.
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + years);

  const tbsCertificate = sequence(
    explicit(0, smallInteger(2)), // version: v3
    integer(randomBytes(16)), // serialNumber
    ecdsaSha256Alg, // signature algorithm
    distinguishedName(issuerCn),
    validity(notBefore, notAfter),
    distinguishedName(subjectCn),
    spki, // subjectPublicKeyInfo (Node's SPKI DER, verbatim)
    explicit(3, sequence(...extensions)), // [3] extensions
  );

  // Node's default EC signature output is DER ECDSA-Sig-Value — exactly the
  // signatureValue an ecdsa-with-SHA256 certificate carries.
  const signature = createSign("SHA256")
    .update(tbsCertificate)
    .sign(issuerPrivateKey);
  const certificate = sequence(
    tbsCertificate,
    ecdsaSha256Alg,
    bitString(0, signature),
  );
  return certPem(certificate);
}

/** Generate an ECDSA P-256 key pair (the curve RA and ADR-0058 require). */
const generateP256 = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/**
 * A generated machine RA identity — the four PEMs, in memory. Pure: no I/O, so it
 * is unit-testable against the mandated cert shape without touching the filesystem.
 * @typedef {Object} MachineIdentity
 * @property {string} caPem - The self-signed CA certificate.
 * @property {string} caKeyPem - The CA private key (PKCS#8 PEM).
 * @property {string} clientPem - The client certificate (signed by the CA).
 * @property {string} clientKeyPem - The client private key (PKCS#8 PEM).
 */

/**
 * Build a fresh CA + client certificate pair with the exact extensions IAM Roles
 * Anywhere enforces (ADR-0057/0058, validated by the spikes):
 *   CA:     basicConstraints critical CA:TRUE pathlen:0; keyUsage critical keyCertSign,cRLSign
 *   client: basicConstraints critical CA:FALSE; keyUsage critical digitalSignature;
 *           extendedKeyUsage clientAuth (non-critical)
 * ECDSA P-256, ~10-year validity. Pure — the caller persists it.
 * @returns {MachineIdentity}
 */
export function buildIdentity() {
  const ca = generateP256();
  const client = generateP256();

  const caPem = makeCertificate({
    subjectCn: "s3cab-ca",
    issuerCn: "s3cab-ca",
    subjectPublicKey: ca.publicKey,
    issuerPrivateKey: ca.privateKey,
    years: 10,
    extensions: [
      // BasicConstraints ::= SEQUENCE { cA TRUE, pathLenConstraint 0 }
      extension(
        OID.basicConstraints,
        true,
        sequence(boolean(true), smallInteger(0)),
      ),
      extension(
        OID.keyUsage,
        true,
        keyUsageValue(KEY_USAGE_BIT.keyCertSign, KEY_USAGE_BIT.cRLSign),
      ),
    ],
  });

  const clientPem = makeCertificate({
    subjectCn: "s3cab-client",
    issuerCn: "s3cab-ca",
    subjectPublicKey: client.publicKey,
    issuerPrivateKey: ca.privateKey, // signed by the CA
    years: 10,
    extensions: [
      // Empty BasicConstraints — cA defaults FALSE (openssl renders "CA:FALSE").
      extension(OID.basicConstraints, true, sequence()),
      extension(
        OID.keyUsage,
        true,
        keyUsageValue(KEY_USAGE_BIT.digitalSignature),
      ),
      // extendedKeyUsage = clientAuth, non-critical (matches the validated recipe).
      extension(OID.extKeyUsage, false, sequence(objectId(OID.clientAuth))),
    ],
  });

  const pkcs8 = (/** @type {import("node:crypto").KeyObject} */ key) =>
    key.export({ type: "pkcs8", format: "pem" }).toString();

  return {
    caPem,
    caKeyPem: pkcs8(ca.privateKey),
    clientPem,
    clientKeyPem: pkcs8(client.privateKey),
  };
}

// ── Storage under ~/.s3cab/roles-anywhere/ ────────────────────────────────────

/** Owner-only mode for the identity dir and its files (POSIX; no-op on Windows). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The machine RA identity directory (`~/.s3cab/roles-anywhere/`). */
export const machineIdentityDir = () => join(s3cabDir(), "roles-anywhere");

/** Path of a file inside the identity dir. @param {string} file */
const identityPath = (file) => join(machineIdentityDir(), file);

/** The identity's env file (the ARNs + region), an env-file.mjs KEY=value file. */
const identityEnvPath = () => identityPath("env");

/** Whether a machine RA identity has already been generated (client cert present). */
export const machineIdentityExists = () =>
  existsSync(identityPath("client.pem"));

/**
 * Ensure a machine RA identity exists, returning its CA certificate (the trust
 * anchor's `CERTIFICATE_BUNDLE`). Generate-and-forget (ADR-0057): the first call
 * generates + persists a new identity; later calls **reuse** it and only re-read
 * the CA, so re-running `aws --roles-anywhere` re-prints the same template without
 * ever silently minting a new CA (which would orphan the deployed trust anchor).
 * @returns {{ caPem: string, created: boolean, dir: string }}
 */
export function ensureMachineIdentity() {
  const dir = machineIdentityDir();
  if (machineIdentityExists()) {
    return {
      caPem: readFileSync(identityPath("ca.pem"), "utf8"),
      created: false,
      dir,
    };
  }
  const identity = buildIdentity();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const write = (/** @type {string} */ file, /** @type {string} */ content) =>
    writeFileSync(identityPath(file), content, { mode: FILE_MODE });
  write("ca.pem", identity.caPem);
  write("ca.key", identity.caKeyPem);
  write("client.pem", identity.clientPem);
  write("client.key", identity.clientKeyPem);
  return { caPem: identity.caPem, created: true, dir };
}

// ── ARN capture from the deployed CloudFormation stack (--save) ────────────────

/** The RA env keys the stack outputs map onto (design doc + auth.md). */
const ARN_ENV = {
  TrustAnchorArn: "S3CAB_RA_TRUST_ANCHOR_ARN",
  ProfileArn: "S3CAB_RA_PROFILE_ARN",
  RoleArn: "S3CAB_RA_ROLE_ARN",
};

/**
 * Read a deployed onboarding stack's three RA ARNs and persist them (plus the
 * region) into the machine identity's `env` file — the `--save --from-stack` step
 * (ADR-0056/0057). Read-only: a single `DescribeStacks` via
 * `@aws-sdk/client-cloudformation`, using the deployer's ambient credentials (the
 * same admin creds that just ran `cloudformation deploy`); it creates nothing.
 *
 * The identity must already have been generated (its dir holds the env file), so a
 * missing identity is a constructive error (ADR-0030) rather than an opaque write
 * failure. Likewise a stack whose outputs are absent (wrong stack, or the IAM-user
 * template) points the user at the right command.
 * @param {{ stackName: string, region: string }} params
 * @returns {Promise<{ dir: string, arns: Record<string, string>, region: string }>}
 */
export async function saveArnsFromStack({ stackName, region }) {
  if (!machineIdentityExists()) {
    throw new ValidationError(
      `No Roles Anywhere identity found at ${tildeify(machineIdentityDir())}.\n` +
        `Generate it first (it also prints the template to deploy):\n` +
        `   s3cab aws <bucket> --roles-anywhere`,
    );
  }

  // Imported lazily: the CloudFormation client is only pulled in on this read-only
  // save path, not on the offline generate path (and not by the pure unit tests).
  const { CloudFormationClient, DescribeStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = new CloudFormationClient({ region });
  const response = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = response.Stacks?.[0]?.Outputs ?? [];

  /** @type {Record<string, string>} */
  const arns = {};
  for (const { OutputKey, OutputValue } of outputs) {
    const envKey =
      OutputKey && ARN_ENV[/** @type {keyof typeof ARN_ENV} */ (OutputKey)];
    if (envKey && OutputValue) {
      arns[envKey] = OutputValue;
    }
  }

  const missing = Object.values(ARN_ENV).filter((key) => !arns[key]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Stack "${stackName}" is missing the Roles Anywhere outputs (${missing.join(", ")}).\n` +
        `Check the stack name, its region (--region ${region}), and that it was\n` +
        `deployed from the --roles-anywhere template (not the IAM-user one).`,
    );
  }

  updateEnvFile(identityEnvPath(), { ...arns, AWS_REGION: region });
  return { dir: machineIdentityDir(), arns, region };
}
