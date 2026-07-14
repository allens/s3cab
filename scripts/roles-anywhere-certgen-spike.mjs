/**
 * SPIKE (scratch) — the openssl oracle for the **hand-rolled ASN.1 DER** X.509
 * generator behind IAM Roles Anywhere (ADR-0057/0058, docs/design/roles-anywhere.md).
 * It exercises the real generator (`buildIdentity` in src/lib/roles-anywhere.mjs)
 * and asserts, via `openssl`, that the emitted CA + client certificates carry the
 * EXACT extensions RA enforces — the shape the first spike run got wrong (recorded
 * in the design doc). Kept out of the unit-test suite so `openssl` isn't a test
 * dependency; the suite (src/lib/roles-anywhere.test.mjs) asserts the same
 * contract via node:crypto only.
 *
 * The bet ADR-0058 rests on — that hand-rolling is tractable — held: Node supplies
 * the two hard parts (the SPKI DER, spliced in verbatim, and the DER ECDSA
 * signature, already the `ecdsa-with-SHA256` signatureValue), so the bespoke code
 * is just DER TLV encoding + a fixed TBSCertificate skeleton.
 *
 * VALIDATED 2026-07-14: every mandated extension present, the chain verifies, and
 * the serial round-trips for the signer's swap #1 (see the signer spike).
 *
 *   node scripts/roles-anywhere-certgen-spike.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdentity } from "../src/lib/roles-anywhere.mjs";

const dir = mkdtempSync(join(tmpdir(), "s3cab-certgen-"));
const id = buildIdentity();
writeFileSync(join(dir, "ca.pem"), id.caPem);
writeFileSync(join(dir, "ca.key"), id.caKeyPem);
writeFileSync(join(dir, "client.pem"), id.clientPem);
writeFileSync(join(dir, "client.key"), id.clientKeyPem);

/** @param {...string} args @returns {string} */
const ossl = (...args) =>
  execFileSync("openssl", args, { cwd: dir, encoding: "utf8" });

const caText = ossl("x509", "-in", "ca.pem", "-noout", "-text");
const clientText = ossl("x509", "-in", "client.pem", "-noout", "-text");

let failures = 0;
/** @param {string} label @param {boolean} ok */
function check(label, ok) {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}`);
  if (!ok) {
    failures++;
  }
}

console.log("CA certificate:");
check(
  "basicConstraints critical, CA:TRUE, pathlen:0",
  /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/.test(caText),
);
check(
  "keyUsage critical = keyCertSign, cRLSign",
  /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/.test(caText),
);
check("ECDSA P-256 key", /ASN1 OID: prime256v1/.test(caText));

console.log("client certificate:");
check(
  "basicConstraints critical, CA:FALSE",
  /X509v3 Basic Constraints: critical\s+CA:FALSE/.test(clientText),
);
check(
  "keyUsage critical = digitalSignature",
  /X509v3 Key Usage: critical\s+Digital Signature/.test(clientText),
);
check(
  "extendedKeyUsage = clientAuth (non-critical)",
  /X509v3 Extended Key Usage:\s+TLS Web Client Authentication/.test(
    clientText,
  ) && !/Extended Key Usage: critical/.test(clientText),
);
check("ECDSA P-256 key", /ASN1 OID: prime256v1/.test(clientText));

console.log("chain:");
try {
  const out = ossl("verify", "-CAfile", "ca.pem", "client.pem");
  check("client verifies against CA", /client\.pem: OK/.test(out));
} catch (error) {
  check("client verifies against CA", false);
  console.log(Error.isError(error) ? error.message : String(error));
}

// The signer's swap #1: serial must round-trip as a positive decimal.
const serialLine = ossl("x509", "-in", "client.pem", "-noout", "-serial");
const serialHex = serialLine.split("=")[1]?.trim() ?? "";
check(
  "serial parses as positive decimal (signer swap #1)",
  BigInt("0x" + serialHex) > 0n,
);

console.log(`\nartifacts: ${dir}`);
console.log(
  failures === 0 ? "\n✅ ALL CHECKS PASSED" : `\n❌ ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
