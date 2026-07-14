# `s3cab` IAM Roles Anywhere Design

## Status

Design agreed; both the runtime signer and the cert generator are **validated by live spikes**
(2026-07-14 — [scripts/roles-anywhere-signer.mjs](../../scripts/roles-anywhere-signer.mjs),
[scripts/roles-anywhere-certgen.mjs](../../scripts/roles-anywhere-certgen.mjs)).
**Both phases are implemented: setup (Phase A-2) and the runtime signer (Phase B) — the
credential path, the `provider`/`setup --roles-anywhere` mode, and the fifth `credentialCase`
all ship in [src/lib/roles-anywhere.mjs](../../src/lib/roles-anywhere.mjs) /
[src/lib/auth.mjs](../../src/lib/auth.mjs).** Decisions:
[ADR-0057](../adr/0057-roles-anywhere-credential-mode.md) (the credential mode + native signer),
[ADR-0058](../adr/0058-roles-anywhere-cert-generation.md) (cert generation + key storage), and
[ADR-0056](../adr/0056-onboarding-via-cloudformation.md) (the CloudFormation onboarding it rides on).
This doc is the evolving *how*; the ADRs are the *why*.

## Purpose

IAM Roles Anywhere lets a workload **outside** AWS authenticate with an X.509 client certificate and
receive short-lived STS session credentials — no long-lived AWS keys. s3cab adds it as a **fourth
per-set credential mode**, beside profile / keys / ambient ([ADR-0055](../adr/0055-per-set-credentials-one-mode.md)).
The goal is deliberately narrow: *one level above access keys — approved short-lived session
credentials — not an enterprise PKI.* It is **AWS-only** (the RA protocol is AWS IAM/STS, not part of
the S3 API; the credential-mode entry in [auth.md](auth.md) covers where RA sits among the modes).

## The machine RA identity

One **machine-level** identity, shared by every set in RA mode the way sets share a machine-level
`AWS_PROFILE` (a set stores only a *pointer/marker*, never the material). It is a cluster under
`~/.s3cab/roles-anywhere/` (`0700`, files `0600`):

| File | What |
| --- | --- |
| `ca.pem` / `ca.key` | the self-signed CA (avoids AWS Private CA fees). `ca.key` is the *cold* key — only re-issues client certs; back it up. |
| `client.pem` / `client.key` | the client certificate + key — the machine's identity; `client.key` is the runtime signing key, never sent to AWS. |
| `env` | an env-format file (reusing `env-file.mjs`) with `S3CAB_RA_TRUST_ANCHOR_ARN` / `S3CAB_RA_PROFILE_ARN` / `S3CAB_RA_ROLE_ARN` / `AWS_REGION`. |

**Long-lived cert (~10y), generate-and-forget** — no renew/rotate/revoke machinery; loss or
compromise ⇒ regenerate (new CA → new trust anchor, same role/bucket). The cert's lifetime does not
weaken the goal: RA still mints *short-lived* session creds, so a long-lived *local* cert is not a
long-lived *AWS* key.

## Setup (Phase A) — generative

`s3cab aws <bucket> --roles-anywhere`, the keyless alternative to the default IAM-user path
([ADR-0056](../adr/0056-onboarding-via-cloudformation.md)):

1. **Generate the CA + client cert locally** — the one active step, but no AWS call, no admin creds,
   no *AWS* secret, so squarely inside the generative posture ([ADR-0032](../adr/0032-generative-onboarding-not-active-provisioning.md)).
2. **Emit a CloudFormation template** for the trust anchor (external-CA `CERTIFICATE_BUNDLE`, CA PEM
   inline — public), the IAM role (RA trust policy + the managed `s3cab-bucket-access-<bucket>`
   policy), and the profile. The user applies it with one `aws cloudformation deploy … --capabilities
   CAPABILITY_NAMED_IAM`.
3. **Capture the ARNs** into the machine `env` with a read-only `describe-stacks`
   (`s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>`, via `@aws-sdk/client-cloudformation`).

### Cert-shape requirements (RA rejects the trust anchor / session otherwise)

The live spike established these are **mandatory** — whatever generates the certs (see the open
sub-decision) must emit exactly:

| Cert | Extensions |
| --- | --- |
| **CA** (→ trust anchor) | `basicConstraints = critical, CA:TRUE, pathlen:0` **and** `keyUsage = critical, keyCertSign, cRLSign` |
| **client** (→ signs `CreateSession`) | `basicConstraints = critical, CA:FALSE`, `keyUsage = critical, digitalSignature`, `extendedKeyUsage = clientAuth` |

A CA without `keyUsage: keyCertSign` fails trust-anchor creation with *"Incorrect basic constraints
for CA certificate."*

## Runtime (Phase B) — the native SigV4-X509 signer

The AWS JS SDK ships **no** Roles Anywhere credential provider, and `CreateSession` is a
special X509-signed endpoint (not in `@aws-sdk/client-rolesanywhere`, which is control-plane only).
So credentials come from a bespoke signer on Node builtins — **validated end-to-end by the spike**
(`201` + live session credentials). It slots into `resolveCredentials` as a fourth source: the set's
RA marker routes to the signer, else the standard chain runs. `provider --roles-anywhere <set>` is
the fourth mutually-exclusive mode (sets the marker, clears profile/keys), and `credentialCase` gains
a fifth "RA identity missing/broken" case. s3cab never touches `~/.aws`.

### The request

`POST https://rolesanywhere.{region}.amazonaws.com/sessions`, body
`{durationSeconds, profileArn, roleArn, trustAnchorArn}`, response
`credentialSet[0].credentials` (`accessKeyId` / `secretAccessKey` / `sessionToken` / `expiration`).

It is **standard SigV4 with two swaps**:

- the **credential id** is the client cert **serial as a decimal string**
  (`BigInt("0x" + X509Certificate.serialNumber)`), not an access-key id;
- the cert rides in an **`X-Amz-X509`** header as single-line `base64(DER)`.

Algorithm id `AWS4-X509-ECDSA-SHA256` (or `-RSA-`), keyed on the client key type; signed headers
`host;x-amz-date;x-amz-x509`; the signature is `crypto.createSign("SHA256").sign(clientKey)` — EC
yields DER (matching the reference's `encodeEcdsaSigValue`), RSA PKCS#1 v1.5 — hex-encoded.

### Reuse `@smithy/signature-v4`, don't re-hand-roll canonicalization

The spike inlined the canonicalization to isolate the unknown; the real signer instead reuses
`@smithy/signature-v4` (a **direct dependency** — its heavy machinery is already present transitively
via `@aws-sdk/client-s3`). It exports `SignatureV4Base` / `getCanonicalHeaders` / `getPayloadHash` /
`createScope`, and its `createStringToSign` **takes the algorithm identifier as a parameter** — so
only the ~40 X509-specific lines above are ours (in practice a `SignatureV4Base`
subclass, since its constructor and the two methods are `protected`). The credential
provider returns the session credentials **with their `expiration`**, so the AWS
SDK's own provider-memoization refreshes them before expiry — no caching of our own
(the interface `resolveCredentials` already hands the SDK).

## Certificate generation — resolved ([ADR-0058](../adr/0058-roles-anywhere-cert-generation.md))

Node builtins **cannot create X.509 certificates**: `crypto.X509Certificate` is parse-only and there
is no CSR/cert signing in `node:crypto`. So the *signer* is builtins-only but cert **generation** is
not. Prototyped and decided ([ADR-0058](../adr/0058-roles-anywhere-cert-generation.md), cert generator
**validated by a live spike** — [scripts/roles-anywhere-certgen.mjs](../../scripts/roles-anywhere-certgen.mjs)):

- **Chosen: a hand-rolled ASN.1 DER encoder** on `node:crypto`, zero dependency. Tractable because
  Node supplies the two hard parts — SPKI export (spliced in verbatim) and the DER ECDSA signature —
  so the bespoke code is DER TLV + the fixed TBSCertificate skeleton (~150 lines), smaller than the
  library it replaces. It emits exactly the CA/client extensions above.
- **Rejected: a focused library** (`@peculiar/x509` — 10 transitive deps incl. `tsyringe`;
  `node-forge` — its own bespoke crypto). Both ship to users, over the [ADR-0005](../adr/0005-builtins-over-dependencies.md)
  bar for a one-time offline op.
- **Rejected: OS-native keystores.** A non-exportable key would fork the signer per OS (CNG /
  Security.framework), Linux has no clean non-exportable *signing* story (falls back to a PEM
  anyway), and it over-protects relative to how s3cab already stores `AWS_SECRET_ACCESS_KEY` (a
  `0600` env file). Captured for the deferred OS-secure-storage layer in [auth.md](auth.md), not built.

**Storage + the Phase B key interface:** the client private key is a **`0600` PEM** (`client.key`);
the signer reads it as a PEM string and calls `crypto.createSign("SHA256").sign(keyPem)` — uniform
across every OS, exactly as the signer spike does.

## References

- The runnable, validated reference: [scripts/roles-anywhere-signer.mjs](../../scripts/roles-anywhere-signer.mjs)
- Correctness oracle (Apache-2.0): <https://github.com/aws/rolesanywhere-credential-helper>
- Self-signed-CA pattern: <https://aws.amazon.com/blogs/security/iam-roles-anywhere-with-an-external-certificate-authority/>
