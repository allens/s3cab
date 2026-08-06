import {
  X509Certificate,
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import {
  SignatureV4Base,
  createScope,
  getCanonicalHeaders,
  getPayloadHash,
} from "@smithy/signature-v4";
import { parseEnvFile } from "./env.mjs";
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
// This module owns cert **generation** and **storage** (Phase A-2) and the
// runtime **SigV4-X509 signer** (Phase B, at the foot of the file): it reads
// `client.key` as a PEM string and calls `crypto.createSign("SHA256").sign(keyPem)`
// (ADR-0058 pins that interface), reusing `@smithy/signature-v4` for the SigV4
// canonicalization so only the ~40 X509-specific lines are bespoke.
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
 * @param {KeyObject} params.subjectPublicKey
 * @param {KeyObject} params.issuerPrivateKey
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

  // A random 16-byte serial, forced positive and non-zero: clear the top bit (so
  // it stays a positive INTEGER without a leading 0x00 pad) and set 0x40 (so it is
  // never the all-zero serial RFC 5280 forbids). ~127 bits of randomness remain.
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;

  const tbsCertificate = sequence(
    explicit(0, smallInteger(2)), // version: v3
    integer(serial), // serialNumber
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

  const pkcs8 = (/** @type {KeyObject} */ key) =>
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
export const identityEnvPath = () => identityPath("env");

/** The four files that together make up a complete machine identity. */
const IDENTITY_FILES = ["ca.pem", "ca.key", "client.pem", "client.key"];

/**
 * Whether a **complete** machine RA identity is present — all four files, not just
 * one. Keying on a single file would misread a half-written or partly-deleted
 * identity as "present" (or, worse, as "absent" and regenerate over it). A partial
 * state is neither present nor absent; {@link ensureMachineIdentity} treats it as
 * an error.
 */
export const machineIdentityExists = () =>
  IDENTITY_FILES.every((file) => existsSync(identityPath(file)));

/**
 * Ensure a machine RA identity exists, returning its CA certificate (the trust
 * anchor's `CERTIFICATE_BUNDLE`). Generate-and-forget (ADR-0057), with three
 * states so re-running `aws --roles-anywhere` **never silently mints a new CA**
 * (which would orphan an already-deployed trust anchor):
 *   - **none of the four files** → generate + persist a fresh identity;
 *   - **all four** → reuse; re-read the CA and re-print the same template;
 *   - **some but not all** → a hard error (ADR-0030). A partial identity (an
 *     interrupted write, a hand-deleted file) must not fall through to
 *     regeneration, which would replace the CA behind the user's back.
 * @returns {{ caPem: string, created: boolean, dir: string }}
 */
export function ensureMachineIdentity() {
  const dir = machineIdentityDir();
  const present = IDENTITY_FILES.filter((file) =>
    existsSync(identityPath(file)),
  );
  if (present.length === IDENTITY_FILES.length) {
    return {
      caPem: readFileSync(identityPath("ca.pem"), "utf8"),
      created: false,
      dir,
    };
  }
  if (present.length > 0) {
    const missing = IDENTITY_FILES.filter((file) => !present.includes(file));
    throw new ValidationError(
      `The Roles Anywhere identity at ${tildeify(dir)} is incomplete (missing ${missing.join(", ")}).\n` +
        `Regenerating would mint a new CA and orphan any deployed trust anchor, so\n` +
        `s3cab won't do it automatically. Remove the directory to start fresh:\n` +
        `   rm -rf ${tildeify(dir)}`,
    );
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

// ── The RA ARN contract (--save reads a deployed stack through it) ─────────────

/**
 * The single source of the Roles Anywhere ARN contract: each CloudFormation stack
 * **output name** paired with the identity `env` **key** it lands in (design doc +
 * auth.md). Every side of the round-trip reads it, so the three names can't drift:
 * {@link arnsFromOutputs} maps outputs → env keys through it, {@link readSigningIdentity}
 * reads the identity's ARNs back through its values, and an `aws.test.mjs`
 * contract test asserts the RA template emits exactly these output names — a rename
 * here that the template misses would otherwise fail `--save` silently.
 */
export const ARN_ENV = {
  TrustAnchorArn: "S3CAB_RA_TRUST_ANCHOR_ARN",
  ProfileArn: "S3CAB_RA_PROFILE_ARN",
  RoleArn: "S3CAB_RA_ROLE_ARN",
};

/**
 * Map a deployed stack's `Outputs` onto the RA identity's ARN env record, pairing
 * each output with its `S3CAB_RA_*` key via {@link ARN_ENV}. Pure — no I/O, no SDK
 * client — so the mapping and the "which outputs are absent" check are unit-testable
 * against a plain array. Returns the populated `arns` (keyed by env key) and the
 * `missing` env keys ({@link ARN_ENV} values no output supplied); the actionable
 * throw stays with the I/O caller (`saveArnsFromStack` in stack-arns.mjs, the
 * aws-only CloudFormation boundary — ADR-0059), which alone has the stack/region
 * context ADR-0030's message needs. `Output` is a structural type, so a
 * plain `{ OutputKey, OutputValue }[]` (what the tests pass) satisfies it too.
 * @param {Output[]} outputs
 * @returns {{ arns: Record<string, string>, missing: string[] }}
 */
export function arnsFromOutputs(outputs) {
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
  return { arns, missing };
}

// ── The set marker + the machine signing identity (Phase B) ───────────────────

/**
 * The set-level Roles Anywhere marker key. A set opts into RA mode by carrying
 * `S3CAB_RA=1` in its env file — a *pointer* only, never the identity material,
 * exactly as a profile-mode set stores `AWS_PROFILE` (ADR-0055/0057). `loadSet`
 * merges it into `process.env`, where {@link isRolesAnywhereMode} reads it to
 * route `resolveCredentials` (auth.mjs) to the signer instead of the standard AWS
 * chain. It is one of the four mutually-exclusive credential modes, so writing it
 * clears any `AWS_PROFILE`/keys and vice versa (commands/provider.mjs).
 */
export const RA_MARKER = "S3CAB_RA";

/**
 * Whether the active configuration selects Roles Anywhere mode — the set's marker
 * (merged into the environment by `loadSet`) is present and set.
 * @param {NodeJS.Dict<string>} [env] - The variables to read (default `process.env`).
 * @returns {boolean}
 */
export const isRolesAnywhereMode = (env = process.env) =>
  env[RA_MARKER] === "1";

/**
 * The machine RA identity the signer needs, read off disk: the client cert + key
 * PEMs and the ARNs + region captured into its env file by `--save`.
 * @typedef {Object} SigningIdentity
 * @property {string} region - The region hosting the trust anchor/profile.
 * @property {string} certPem - The client certificate (PEM), sent in X-Amz-X509.
 * @property {string} keyPem - The client private key (PEM), the signing key.
 * @property {string} trustAnchorArn
 * @property {string} profileArn
 * @property {string} roleArn
 */

/**
 * Read the machine RA identity the signer signs with, or `undefined` when it is
 * absent, incomplete, **or unreadable/corrupt** — no identity files, the env file
 * missing an ARN or the region (a set in RA mode whose `--save` step never ran), or
 * a file that exists but can't be read/parsed (EACCES, a malformed `env`). The
 * signer's inputs come from the **machine identity**, not the set (the set carries
 * only the marker): the two certs/keys live beside the `env` file under
 * `~/.s3cab/roles-anywhere/`. Returning `undefined` in every "not usable" case (not
 * throwing) lets the credential layer raise the actionable "RA identity
 * missing/broken" error (auth.mjs, ADR-0030) — whose remedy, regenerate, fits a
 * corrupt identity too — rather than an opaque read/parse failure here.
 * @returns {SigningIdentity | undefined}
 */
export function readSigningIdentity() {
  if (!machineIdentityExists()) {
    return undefined;
  }
  try {
    const env = parseEnvFile(identityEnvPath());
    // Read the ARNs through the same {@link ARN_ENV} keys `--save` wrote them under,
    // so the env-key spelling lives in exactly one place. AWS_REGION is a standard
    // AWS key, not part of the ARN contract, so it stays literal.
    const trustAnchorArn = env[ARN_ENV.TrustAnchorArn];
    const profileArn = env[ARN_ENV.ProfileArn];
    const roleArn = env[ARN_ENV.RoleArn];
    const region = env.AWS_REGION;
    if (!trustAnchorArn || !profileArn || !roleArn || !region) {
      return undefined;
    }
    return {
      region,
      certPem: readFileSync(identityPath("client.pem"), "utf8"),
      keyPem: readFileSync(identityPath("client.key"), "utf8"),
      trustAnchorArn,
      profileArn,
      roleArn,
    };
  } catch {
    // Present-but-unreadable/corrupt (EACCES, a directory where a file should be,
    // a malformed env) is "broken", not "readable" — treat it as no usable
    // identity so the caller gives the regenerate guidance, not a raw error.
    return undefined;
  }
}

// ── The native SigV4-X509 signer (Phase B) ────────────────────────────────────
// Roles Anywhere `CreateSession` is a special X509-signed STS endpoint the AWS JS
// SDK ships no provider for (ADR-0057), so credentials come from this bespoke
// signer — validated end-to-end by scripts/roles-anywhere-signer.mjs. It is
// standard SigV4 with two swaps: the credential id is the client cert SERIAL as a
// decimal (not an access-key id), and the cert rides in an `X-Amz-X509` header as
// single-line base64(DER). Canonicalization is `@smithy/signature-v4`'s — its
// `createStringToSign` takes the algorithm id as a parameter — so only the two
// swaps + the X509 algorithm id are ours (the spike's inline version, now retired
// to a byte-for-byte-identical reuse).

/** @import { SignatureV4Init, SignatureV4CryptoInit } from "@smithy/signature-v4" */
/** @import { KeyObject } from "node:crypto" */
/** @import { Output } from "@aws-sdk/client-cloudformation" */

/** The Roles Anywhere STS service id (the SigV4 scope + host component). */
const RA_SERVICE = "rolesanywhere";
/** The three headers the reference credential-helper signs, canonical order. */
const RA_SIGNED_HEADERS = new Set(["host", "x-amz-date", "x-amz-x509"]);

/**
 * A `node:crypto` adapter for the `@smithy/*` hash-constructor interface
 * (`new () => { update, digest }`) — the SigV4 machinery hashes the payload and
 * the canonical request through it. Node's own SHA-256, no `@aws-crypto/*` shim.
 */
class Sha256 {
  #hash = createHash("sha256");
  /** @param {Uint8Array | string} data */
  update(data) {
    this.#hash.update(data);
  }
  /** @returns {Promise<Uint8Array>} */
  digest() {
    return Promise.resolve(this.#hash.digest());
  }
}

/**
 * Reach `@smithy/signature-v4`'s canonicalization, whose constructor and
 * `createCanonicalRequest`/`createStringToSign` are `protected`. Subclassing is
 * the intended door — we take the exact SigV4 canonical request and string-to-sign
 * (the correctness we're reusing) and only supply the X509 signature ourselves.
 */
class RaCanonicalizer extends SignatureV4Base {
  // Not redundant, however much it looks it: `SignatureV4Base`'s constructor is
  // `protected`, and an implicit one inherits that visibility — so without this
  // redeclaration `new RaCanonicalizer(…)` below fails the type check (TS2674).
  // Widening it to public is the whole job; the `super(init)` is incidental.
  /** @param {SignatureV4Init & SignatureV4CryptoInit} init */
  constructor(init) {
    super(init);
  }
  /** @type {SignatureV4Base["createCanonicalRequest"]} */
  canonicalRequest(request, canonicalHeaders, payloadHash) {
    return this.createCanonicalRequest(request, canonicalHeaders, payloadHash);
  }
  /** @type {SignatureV4Base["createStringToSign"]} */
  stringToSign(longDate, scope, canonicalRequest, algorithm) {
    return this.createStringToSign(
      longDate,
      scope,
      canonicalRequest,
      algorithm,
    );
  }
}

/**
 * The `CreateSession` request body + the machine identity to sign it with.
 * @typedef {Object} SessionInput
 * @property {string} region
 * @property {string} certPem - The client certificate (PEM).
 * @property {string} keyPem - The client private key (PEM).
 * @property {string} trustAnchorArn
 * @property {string} profileArn
 * @property {string} roleArn
 * @property {number} [durationSeconds] - Requested credential lifetime (default 3600).
 */

/**
 * Build the signed `POST /sessions` request for Roles Anywhere `CreateSession`.
 * Pure (no I/O); returns exactly what {@link createSession} POSTs. Standard SigV4
 * (canonicalization via `@smithy/signature-v4`) with the two X509 swaps and the
 * `AWS4-X509-{ECDSA,RSA}-SHA256` algorithm id keyed on the client key type. The
 * signature is `createSign("SHA256").sign(keyPem)` — EC yields DER R/S (matching
 * the reference), RSA PKCS#1 v1.5 — hex-encoded into `Authorization`.
 * @param {SessionInput} input
 * @returns {Promise<{ host: string, path: string, body: string, headers: Record<string, string> }>}
 */
export async function buildSignedRequest(input) {
  const { region, certPem, keyPem, trustAnchorArn, profileArn, roleArn } =
    input;
  const durationSeconds = input.durationSeconds ?? 3600;

  const cert = new X509Certificate(certPem);

  // The algorithm id is the SigV4-X509 variant, keyed on the client key type.
  const keyType = cert.publicKey.asymmetricKeyType;
  const algorithm =
    keyType === "ec"
      ? "AWS4-X509-ECDSA-SHA256"
      : keyType === "rsa"
        ? "AWS4-X509-RSA-SHA256"
        : undefined;
  if (!algorithm) {
    throw new Error(`unsupported client key type: ${keyType}`);
  }

  // Swap #1: the credential id is the cert serial as a DECIMAL string (Node hands
  // it back as hex), not an access-key id.
  const serialDecimal = BigInt(`0x${cert.serialNumber}`).toString();
  // Swap #2: the leaf cert rides in X-Amz-X509 as single-line base64(DER).
  const x509Header = cert.raw.toString("base64");

  const host = `${RA_SERVICE}.${region}.amazonaws.com`;
  const path = "/sessions";
  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const shortDate = amzDate.slice(0, 8);

  const body = JSON.stringify({
    durationSeconds,
    profileArn,
    roleArn,
    trustAnchorArn,
  });

  // Reuse `@smithy/signature-v4` for the SigV4 canonicalization — the request
  // shape is a plain object with the fields its methods read (method/path/query/
  // headers/body). No credentials are needed: we call only the pure canonical/
  // string-to-sign builders, then sign the string-to-sign ourselves with the
  // client key below.
  const httpRequest = {
    method: "POST",
    protocol: "https:",
    hostname: host,
    path,
    query: {},
    headers: { host, "x-amz-date": amzDate, "x-amz-x509": x509Header },
    body,
  };
  const sigv4 = new RaCanonicalizer({
    service: RA_SERVICE,
    region,
    sha256: Sha256,
    applyChecksum: false,
    credentials: { accessKeyId: "", secretAccessKey: "" },
  });
  const canonicalHeaders = getCanonicalHeaders(
    httpRequest,
    undefined,
    RA_SIGNED_HEADERS,
  );
  const payloadHash = await getPayloadHash(httpRequest, Sha256);
  const canonicalRequest = sigv4.canonicalRequest(
    httpRequest,
    canonicalHeaders,
    payloadHash,
  );
  const scope = createScope(shortDate, region, RA_SERVICE);
  const stringToSign = await sigv4.stringToSign(
    amzDate,
    scope,
    canonicalRequest,
    algorithm,
  );
  const signedHeaders = Object.keys(canonicalHeaders).sort().join(";");

  const signature = createSign("SHA256")
    .update(stringToSign)
    .sign(keyPem, "hex");
  const authorization =
    `${algorithm} Credential=${serialDecimal}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    host,
    path,
    body,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-Amz-Date": amzDate,
      "X-Amz-X509": x509Header,
      Authorization: authorization,
    },
  };
}

/**
 * The short-lived STS credentials `CreateSession` returns (its
 * `credentialSet[0].credentials`), field-for-field as AWS names them.
 * @typedef {Object} SessionCredentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} sessionToken
 * @property {string} expiration - ISO 8601, when the token expires.
 */

/**
 * Parse a `CreateSession` HTTP result into its session credentials, or throw a
 * legible error. A non-2xx (a disabled/mismatched trust anchor, a wrong region)
 * surfaces the server's own body; a 2xx without the credential block is treated as
 * a protocol surprise rather than silently yielding partial credentials. Pure, so
 * the mapping is unit-testable without a live endpoint.
 * @param {{ status: number | undefined, body: string }} result
 * @returns {SessionCredentials}
 */
export function parseSessionResponse({ status, body }) {
  if (status === undefined || status < 200 || status >= 300) {
    throw new Error(
      `Roles Anywhere CreateSession failed (HTTP ${status ?? "?"}): ${body || "(empty body)"}`,
    );
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `Roles Anywhere CreateSession returned a non-JSON body: ${body}`,
    );
  }
  const credentials = parsed?.credentialSet?.[0]?.credentials;
  if (
    !credentials?.accessKeyId ||
    !credentials?.secretAccessKey ||
    !credentials?.sessionToken ||
    !credentials?.expiration
  ) {
    throw new Error(
      `Roles Anywhere CreateSession returned no credentials: ${body}`,
    );
  }
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: credentials.expiration,
  };
}

/** How long to wait on the `CreateSession` exchange before aborting (ADR-0030). */
const SESSION_TIMEOUT_MS = 10_000;

/**
 * The actionable timeout error (ADR-0030 — goal-framed, names the likely fix). A
 * plain `Error`: nothing catches it by type, it flows to the CLI's top-level catch.
 * @param {string} host
 */
const sessionTimeoutError = (host) =>
  new Error(
    `Timed out reaching the Roles Anywhere endpoint (${host}) after ${SESSION_TIMEOUT_MS / 1000}s.
Check your network connection, and that AWS_REGION in the identity's env file
(${tildeify(machineIdentityDir())}/env) matches where the trust anchor was deployed.`,
  );

/**
 * Sign and POST a `CreateSession` request, resolving its session credentials. The
 * one network call in the RA credential path (`node:https`, no SDK client — this
 * exchange authenticates with the cert, so it needs no AWS credentials of its own).
 * Bounded by {@link SESSION_TIMEOUT_MS} so a stalled connection can't hang the
 * command indefinitely.
 * @param {SessionInput} input
 * @returns {Promise<SessionCredentials>}
 */
export async function createSession(input) {
  const signed = await buildSignedRequest(input);
  const result = await new Promise(
    (
      /** @type {(value: { status: number | undefined, body: string }) => void} */ resolve,
      reject,
    ) => {
      const req = request(
        {
          host: signed.host,
          path: signed.path,
          method: "POST",
          headers: signed.headers,
          // Bound the wait: credential resolution sits on the critical path of
          // every RA-mode command, so a silent (connected-but-unresponsive)
          // endpoint must not hang `backup`/`restore` forever (clig.dev: sane
          // network timeouts). `timeout` only *signals* inactivity — we abort the
          // socket ourselves in the handler below.
          timeout: SESSION_TIMEOUT_MS,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on("timeout", () => req.destroy(sessionTimeoutError(signed.host)));
      req.on("error", reject);
      req.write(signed.body);
      req.end();
    },
  );
  return parseSessionResponse(result);
}
