/**
 * SPIKE (scratch) — prove the bespoke **SigV4-X509** signer for AWS IAM Roles
 * Anywhere works end-to-end against the live `CreateSession` endpoint, using
 * ONLY Node builtins (`crypto`/`https`) — no `aws_signing_helper` (a Go binary),
 * no dependency. This is the one genuine unknown behind the Roles Anywhere
 * credential mode (ADR-0057); it authenticates with an X.509 client certificate
 * and gets back short-lived STS credentials.
 *
 * VALIDATED 2026-07-14: live `201` + a `credentialSet[0].credentials` block from
 * `rolesanywhere.eu-west-1.amazonaws.com/sessions`. Kept as the runnable
 * reference for the real signer, which will live in `src/lib/` and reuse
 * `@smithy/signature-v4`'s canonicalization instead of the inline version here
 * (see docs/design/roles-anywhere.md).
 *
 * The signing is standard SigV4 with exactly two swaps: the credential id is the
 * cert SERIAL (as a decimal string) not an access key, and the cert rides in an
 * `X-Amz-X509` header (base64 DER). Signature is over the usual string-to-sign,
 * made with the client private key (`crypto.createSign`) — EC yields DER, RSA
 * PKCS#1 v1.5.
 *
 * ── Cert-shape requirements (RA validates these; getting them wrong is what bit
 *    the first spike run) ──────────────────────────────────────────────────────
 *   CA cert (uploaded as the trust anchor):
 *     basicConstraints = critical, CA:TRUE, pathlen:0
 *     keyUsage         = critical, keyCertSign, cRLSign
 *   client cert (used here to sign):
 *     basicConstraints  = critical, CA:FALSE
 *     keyUsage          = critical, digitalSignature
 *     extendedKeyUsage  = clientAuth
 *
 * ── Run ───────────────────────────────────────────────────────────────────────
 *   1. Generate a throwaway CA + client cert with the extensions above, e.g.:
 *        openssl ecparam -name prime256v1 -genkey -noout -out ca.key
 *        openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=ca" \
 *          -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
 *          -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem
 *        openssl ecparam -name prime256v1 -genkey -noout -out client.key
 *        openssl req -new -key client.key -subj "/CN=client" -out client.csr
 *        printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
 *          'keyUsage=critical,digitalSignature' 'extendedKeyUsage=clientAuth' > client.ext
 *        openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
 *          -sha256 -days 3650 -extfile client.ext -out client.pem
 *   2. Create a Roles Anywhere trust anchor (CERTIFICATE_BUNDLE = ca.pem), an IAM
 *      role trusting `rolesanywhere.amazonaws.com`, and a profile pointing at it.
 *   3. Run (authenticates with the cert — needs no AWS credentials):
 *        RA_REGION=eu-west-1 RA_CERT=client.pem RA_KEY=client.key \
 *        RA_TRUST_ANCHOR_ARN=... RA_PROFILE_ARN=... RA_ROLE_ARN=... \
 *        node scripts/roles-anywhere-signer-spike.mjs
 */
import { X509Certificate, createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";

/**
 * @typedef {Object} SessionInput
 * @property {string} region       - AWS region hosting the trust anchor/profile.
 * @property {string} certPem       - The client certificate (PEM).
 * @property {string} keyPem        - The client private key (PEM).
 * @property {string} trustAnchorArn
 * @property {string} profileArn
 * @property {string} roleArn
 * @property {number} [durationSeconds] - Requested credential lifetime (default 3600).
 */

/**
 * Build the signed `POST /sessions` request for Roles Anywhere `CreateSession`.
 * Pure: no I/O. Returns the pieces {@link createSession} sends.
 * @param {SessionInput} input
 * @returns {{ host: string, path: string, body: string, headers: Record<string, string> }}
 */
export function buildSignedRequest(input) {
  const { region, certPem, keyPem, trustAnchorArn, profileArn, roleArn } =
    input;
  const durationSeconds = input.durationSeconds ?? 3600;

  const cert = new X509Certificate(certPem);

  // Algorithm id is the SigV4-X509 variant, keyed on the client key type.
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

  // Swap #1: the credential id is the cert serial as a DECIMAL string (Node
  // hands it back as hex), not an access key id.
  const serialDecimal = BigInt(`0x${cert.serialNumber}`).toString();
  // Swap #2: the leaf cert rides in X-Amz-X509 as single-line base64(DER).
  const x509Header = cert.raw.toString("base64");

  const host = `rolesanywhere.${region}.amazonaws.com`;
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
  const payloadHash = createHash("sha256").update(body).digest("hex");

  // Sign the same three headers the reference credential-helper signs, sorted
  // lowercase as SigV4 requires.
  const signedPairs = /** @type {[string, string][]} */ ([
    ["host", host],
    ["x-amz-date", amzDate],
    ["x-amz-x509", x509Header],
  ]).sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalHeaders = signedPairs
    .map(([name, value]) => `${name}:${value.trim()}`)
    .join("\n");
  const signedHeaders = signedPairs.map(([name]) => name).join(";");

  // Standard SigV4 canonical request (the empty strings are the empty query
  // line and the blank line before SignedHeaders).
  const canonicalRequest = [
    "POST",
    path,
    "",
    canonicalHeaders,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const canonicalHash = createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");

  const scope = `${shortDate}/${region}/rolesanywhere/aws4_request`;
  const stringToSign = [algorithm, amzDate, scope, canonicalHash].join("\n");

  // Sign with the client private key: EC -> DER ECDSA (matches the reference's
  // encodeEcdsaSigValue), RSA -> PKCS#1 v1.5. Hex-encoded into the header.
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
 * Sign and POST a `CreateSession` request, resolving the raw HTTP result.
 * @param {SessionInput} input
 * @returns {Promise<{ status: number | undefined, body: string }>}
 */
export function createSession(input) {
  const req = buildSignedRequest(input);
  return new Promise((resolve, reject) => {
    const r = request(
      { host: req.host, path: req.path, method: "POST", headers: req.headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    r.on("error", reject);
    r.write(req.body);
    r.end();
  });
}

/** @param {string} name */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

async function main() {
  const input = {
    region: requireEnv("RA_REGION"),
    certPem: readFileSync(requireEnv("RA_CERT"), "utf8"),
    keyPem: readFileSync(requireEnv("RA_KEY"), "utf8"),
    trustAnchorArn: requireEnv("RA_TRUST_ANCHOR_ARN"),
    profileArn: requireEnv("RA_PROFILE_ARN"),
    roleArn: requireEnv("RA_ROLE_ARN"),
  };

  const result = await createSession(input);
  console.log("status:", result.status);
  const parsed = JSON.parse(result.body);
  const creds = parsed.credentialSet?.[0]?.credentials;
  if (creds) {
    console.log("✅ session credentials:");
    console.log("  accessKeyId: ", creds.accessKeyId);
    console.log(
      "  secretAccessKey:",
      creds.secretAccessKey ? "<present>" : "<MISSING>",
    );
    console.log(
      "  sessionToken:",
      creds.sessionToken ? "<present>" : "<MISSING>",
    );
    console.log("  expiration: ", creds.expiration);
  } else {
    console.log(result.body);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
