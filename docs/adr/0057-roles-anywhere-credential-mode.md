# Roles Anywhere: a fourth credential mode, set up generatively and signed natively

**Status:** accepted and **implemented** (native signer validated by a live spike 2026-07-14;
both phases — setup and the runtime signer — now shipped in
[src/lib/roles-anywhere.mjs](../../src/lib/roles-anywhere.mjs) /
[src/lib/auth.mjs](../../src/lib/auth.mjs)). Sits beside
[0055](0055-per-set-credentials-one-mode.md)/[0015](0015-standard-aws-credential-chain.md);
setup delivery depends on [0056](0056-onboarding-via-cloudformation.md). Subsystem design + the
cert-shape requirements the spike found: [docs/design/roles-anywhere.md](../design/roles-anywhere.md).

s3cab's AWS identity options are long-lived access keys (weakest practice) or a profile/SSO/ambient
chain. AWS's guidance for workloads *outside* AWS is **IAM Roles Anywhere**: a machine authenticates
with an X.509 client certificate and receives short-lived STS session credentials — no long-lived
AWS keys. We add it as a **first-class fourth credential mode** (beside profile / keys / ambient —
[0055](0055-per-set-credentials-one-mode.md)). The goal, deliberately narrow: *one level above
access keys — approved short-lived session credentials — not an enterprise PKI.*

## Identity model — machine-level, generate-and-forget

- **One machine RA identity**: a self-signed CA (avoiding AWS Private CA fees), one client cert +
  key, one trust anchor, one role/profile. A set opts in with a **pointer/marker** in its env file —
  as profile mode stores `AWS_PROFILE` (a pointer to a machine-level thing, never the material),
  consistent with [0055](0055-per-set-credentials-one-mode.md). Stored in `~/.s3cab/roles-anywhere/`
  (the PEMs + an **env-format** metadata file carrying the ARNs + region, `0600/0700`), matching the
  `~/.s3cab/sets/<set>/` cluster convention.
- **Long-lived cert (~10y), generate-and-forget.** No renew/rotate/revoke; loss/compromise ⇒
  regenerate (new CA → new trust anchor, same role/bucket). The cert's lifetime does **not** weaken
  the goal: RA still mints *short-lived* session creds, so a long-lived *local* cert is not a
  long-lived *AWS* key. Keeps s3cab out of CA-platform territory by design.

## Setup is generative (Phase A)

Folded into `s3cab aws <bucket> --roles-anywhere`, the keyless alternative to the default IAM-user
path ([0056](0056-onboarding-via-cloudformation.md)). s3cab **actively generates the CA + client
cert locally** — the one active step, but no AWS call, no admin creds, no *AWS* secret, so squarely
inside [0032](0032-generative-onboarding-not-active-provisioning.md)/[0056](0056-onboarding-via-cloudformation.md)
— and emits the CloudFormation template for the trust anchor (external-CA `CERTIFICATE_BUNDLE`, CA
PEM inline — public), the IAM role (RA trust policy + the managed `s3cab-bucket-access-<bucket>`
policy), and the profile. Post-deploy, the three ARNs are captured by a **read-only**
`describe-stacks` (`s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>`) — which is why
s3cab takes on `@aws-sdk/client-cloudformation`: cheap once `client-s3` has pulled in the shared
`@smithy/*` machinery, and read-only (not the `client-iam` hard line).

## Runtime is a native signer (Phase B)

The AWS JS SDK ships **no** Roles Anywhere credential provider, so credentials come from a bespoke
**SigV4-X509** signer — no `aws_signing_helper` (a Go binary). **Validated end-to-end by a live spike**
(2026-07-14: a `201` + session credentials; [scripts/roles-anywhere-signer-spike.mjs](../../scripts/roles-anywhere-signer-spike.mjs)).
It `POST`s to `rolesanywhere.{region}.amazonaws.com/sessions`, signing the canonical request with the
client key: standard SigV4 with two swaps — the credential id is the cert serial (decimal) not an
access key, and the cert rides in an `X-Amz-X509` header. A single `createSign("SHA256")` handles both
key types — RSA → PKCS#1 v1.5, EC → DER R/S. The crypto is Node builtins; the canonicalization reuses
**`@smithy/signature-v4`** (promoted to a direct dependency — already present transitively via
`client-s3`, and its `createStringToSign` takes the algorithm id as a parameter), so only ~40
X509-specific lines are bespoke. It slots into
`resolveCredentials` as a fourth source — the set marker routes RA → native signer, else → the
standard chain — the pluggable seam [auth.md](../design/auth.md) already reserved. `provider
--roles-anywhere <set>` is the fourth mutually-exclusive mode (sets the marker, clears
profile/keys); `credentialCase` gains a fifth "RA identity missing/broken" case. s3cab never
touches `~/.aws`.

## AWS-only, like `aws`

Roles Anywhere is an AWS IAM/STS *control-plane* feature, not part of the S3 API — no
S3-compatible provider (Cloudflare R2, Backblaze B2, Wasabi; MinIO has its own *different*
`AssumeRoleWithCertificate` STS) implements it, and none is likely to, since each has its own
native token/key auth. So RA is **AWS-only**, parallel to how `aws` narrows to AWS
([0047](0047-provider-command-neutral-config-door.md)): `provider --roles-anywhere` is mutually
exclusive with a custom endpoint (a set with `AWS_ENDPOINT_URL_S3` set can't use RA and is
refused), and **access keys remain the cross-provider path**.

## Open: certificate generation & storage → **resolved by [0058](0058-roles-anywhere-cert-generation.md)**

Two sub-decisions the design above left open — the **signer** is builtins-only, but the **PKI**
half is not. Both are now **resolved by [ADR-0058](0058-roles-anywhere-cert-generation.md)**:
hand-rolled ASN.1 DER (zero-dep, validated), client key stored as a `0600` PEM (so the signer reads
a PEM and calls `createSign(keyPem)`), OS keystores rejected. The reasoning that was open:

- **Cert generation needs more than builtins.** Node core signs arbitrary data (`createSign`) and
  *parses* X.509 (`X509Certificate`), but **cannot create/sign a certificate** — no cert-creation
  API exists in `crypto` or WebCrypto. So generating the CA + client cert needs either hand-rolled
  ASN.1 DER (zero-dependency, ~200 security-sensitive lines) or a focused library (`@peculiar/x509`,
  `node-forge`) — an [0005](0005-builtins-over-dependencies.md) call to resolve by prototype, not
  assumed free. Whatever generates them **must** emit the exact CA/client cert extensions RA enforces
  (the spike found them the hard way — recorded in [docs/design/roles-anywhere.md](../design/roles-anywhere.md)).
- **OS-native keystores are a candidate for both.** Windows Certificate Store (DPAPI), macOS
  Keychain, and Linux libsecret/NSS can *store* the client private key better than a `0600` PEM
  (OS-protected, non-exportable), and several can also *generate* the cert — so OS tooling could
  answer the generation question *and* the storage question at once, at the cost of per-OS shelling
  from the SEA binary. Related to the deferred OS-secure-storage layer in
  [auth.md](../design/auth.md)'s Security Model. Captured, not decided.

## Rejected

- **`aws_signing_helper` + a `credential_process` profile** (the proposal's original v1). Works
  today with zero s3cab code, but it's the *only* thing that would make s3cab reference `~/.aws`,
  and once the native signer was de-risked (a spike confirmed ~a few-hundred builtin-only lines)
  building it first was throwaway scaffolding. Demoted to a doc note.
- **Per-set / per-bucket RA identity** — a CA/trust anchor per set is heavy with no
  per-set-revocation need; the client cert *is the machine's* identity, and machine-level matches
  `AWS_PROFILE` sharing. Multi-bucket role reuse deferred ([0006](0006-minimal-code.md)).
- **Managed cert lifecycle** (short certs + renewal/revocation) — the CA-platform the goal refuses.
- **`@aws-sdk/client-rolesanywhere` at runtime** — that client is the *control plane* (create/list
  anchors), not the SigV4-X509 *session* exchange; the signing is bespoke regardless.

## Consequences

`resolveCredentials` branches on the RA marker; a new `src/lib/roles-anywhere.mjs` owns cert
generation + the signer; `provider`/`setup` gain `--roles-anywhere`; `aws` gains the RA template
path. Two dependency moves: `@aws-sdk/client-cloudformation` (read-only, for ARN capture) and
`@smithy/signature-v4` promoted to a direct dependency (already transitively present). Main
maintenance risk: the bespoke AWS signing, bounded by testing against the reference and the live
endpoint. Full mechanics: [docs/design/roles-anywhere.md](../design/roles-anywhere.md).

## References

- AWS SigV4-X509 reference implementation (Apache-2.0), the correctness oracle for the native
  signer: <https://github.com/aws/rolesanywhere-credential-helper>
- IAM Roles Anywhere with an external certificate authority (the self-signed-CA pattern):
  <https://aws.amazon.com/blogs/security/iam-roles-anywhere-with-an-external-certificate-authority/>
