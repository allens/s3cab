# Roles Anywhere certs: hand-rolled ASN.1 DER, key stored as a 0600 PEM

**Status:** accepted (cert generator **validated by a live spike** 2026-07-14 —
[scripts/roles-anywhere-certgen.mjs](../../scripts/roles-anywhere-certgen.mjs)).
Resolves the "certificate generation & storage" sub-decision left open in
[0057](0057-roles-anywhere-credential-mode.md); it is an [0005](0005-builtins-over-dependencies.md)
call. Subsystem design + the cert-shape requirements the signer spike found:
[docs/design/roles-anywhere.md](../design/roles-anywhere.md).

[ADR-0057](0057-roles-anywhere-credential-mode.md) settled Roles Anywhere as a fourth credential
mode and validated the *runtime signer* on Node builtins, but deferred two coupled questions: **how
does s3cab generate the CA + client certificate, and how does it store the client private key?** The
storage answer pins the *signer's* key interface (Phase B) — a `0600` PEM you
`crypto.createSign(keyPem)` versus a non-exportable OS-keystore handle you sign *through* an OS API
are fundamentally different signers — so it is resolved here, before Phase B is built.

## Decision

- **Generate the certs with a hand-rolled ASN.1 DER encoder on Node builtins** (`node:crypto`), zero
  runtime dependency. It emits the exact CA/client cert shape RA enforces (the spike found these the
  hard way — recorded in [the design doc](../design/roles-anywhere.md)):
  - **CA:** `basicConstraints = critical, CA:TRUE, pathlen:0` + `keyUsage = critical, keyCertSign, cRLSign`
  - **client:** `basicConstraints = critical, CA:FALSE` + `keyUsage = critical, digitalSignature` + `extendedKeyUsage = clientAuth` (non-critical)
  - ECDSA **P-256**, ~10-year validity, generate-and-forget.
- **Store the client private key as a `0600` PEM** under `~/.s3cab/roles-anywhere/` (dir `0700`),
  beside the CA key, the two certs, and the ARN `env` file — the cluster
  [0057](0057-roles-anywhere-credential-mode.md) already specified.
- **The signer's key interface (Phase B) is therefore: a PEM private-key string read from
  `client.key`, passed to `crypto.createSign("SHA256").sign(keyPem)`** — exactly what the signer
  spike already does. Uniform across every OS; no OS-specific signing path.

## Why hand-rolled DER is tractable, not ~200 lines of danger

The fear behind hand-rolling X.509 is bignum/curve/signing code. **Node hands us the two hard parts
for free**, so the bespoke code is only DER TLV encoding + a fixed TBSCertificate skeleton — no
crypto primitives of our own:

1. the **SubjectPublicKeyInfo** comes out as SPKI DER (`publicKey.export({type:"spki", format:"der"})`)
   and is spliced in **verbatim** — we never encode an EC point;
2. the **signature** comes out as DER ECDSA (`createSign("SHA256").sign(caKey)`) — already exactly the
   `ecdsa-with-SHA256` `signatureValue` X.509 wants.

Measured cost in [src/lib/roles-anywhere.mjs](../../src/lib/roles-anywhere.mjs): **~200 code lines**
for the whole generator (DER primitives + X.509 assembly + `buildIdentity`), plus ~46 for storage and
~42 for ARN capture. The cert is **generate-and-forget** (one write, ~10-year life), so this is not a
maintenance treadmill; and the correctness oracle is strong (`openssl x509 -text` / `verify` for
shape, the existing signer spike's live `201` for the end-to-end contract).

**Nothing in the AWS SDK could have done this for us.** A survey of the whole AWS JS SDK v3 (service
clients + `@smithy/*` + `@aws-crypto/*`, not just what s3cab imports) turns up **no ASN.1/X.509/DER
encoder** anywhere — AWS's own model is server-side issuance via ACM / ACM-PCA (an API call, which
would defeat the offline/generative posture and cost money — ACM-PCA is billed). The one SDK asset
that *does* help is `@smithy/signature-v4` (`createStringToSign` takes the algorithm id as a
parameter), which shrinks the Phase-B *signer* to ~40 lines — but it does nothing for cert
generation or key storage. So the ~200 generator lines are irreducible once a local, offline,
dependency-free identity is the goal.

## Rejected

- **A focused X.509 library (`@peculiar/x509`, `node-forge`).** Both **ship to users** and add
  recovery-adjacent supply-chain surface for a *one-time, offline* operation — the [0005](0005-builtins-over-dependencies.md)
  bar the AWS SDK alone clears. Concretely: `@peculiar/x509` pulls **10** transitive packages (seven
  `@peculiar/asn1-*`, `pvtsutils`, `tslib`, and `tsyringe` — a reflection-based DI framework, absurd
  weight for emitting one cert); `node-forge` is a single but large package carrying its *own* bespoke
  BigInteger/RSA/AES — the exact "reimplemented crypto" surface [0005](0005-builtins-over-dependencies.md)
  guards against. Node already ships P-256 keygen, SPKI export, and ECDSA signing; the only gap is DER
  assembly, ~200 lines, smaller than the dependency it would replace ([0006](0006-minimal-code.md)).

## The key-storage security model — why a `0600` PEM is the honest default

The `0600` PEM was challenged hard in review: *if the key file leaks, is it any better than a leaked
access key?* The honest answer shaped this decision, so it is recorded here rather than glossed.

**Against pure file exfiltration, a `0600` PEM is only marginally better than an access key.** If
`client.key` leaks, an attacker can call `CreateSession` and mint fresh short-lived STS credentials
*repeatedly*, for the cert's ~10-year life or until the trust anchor is disabled. The
"credentials are short-lived" framing does **not** rescue this: the *signing key* is long-lived, and
short-lived creds re-mint on demand. (It is `client.key` that matters — `client.pem` is sent in a
header on every request and is not secret.)

**Where RA is genuinely better even as a PEM** — and this is the story to highlight when the feature
ships — none of it being "the local secret is better protected":

1. **The durable secret never travels.** An access-key secret is *designed* to be displayed once and
   pasted around (shell history, clipboard, config sync). The RA private key is generated locally,
   never shown, never transmitted — fewer leak vectors at setup and in operation.
2. **What flows to AWS / logs / process memory is a ~1-hour session token**, not a permanent key. A
   token scraped from a log is game-over for an hour, not forever.
3. **Central revocation, two granularities.** Disable/delete the trust anchor → every session from
   that CA dies immediately, no per-consumer key rotation and nothing to touch on the machine; RA
   also supports importing a **CRL** to revoke one specific client cert.
4. **AWS-side scoping + cleaner CloudTrail identity** (session duration caps, scoped session
   policies, the cert as the logged identity).

### Machine-binding cannot be faked in software — considered and set aside

The one property that would make RA *categorically* better than an access key is
**non-exportability**: a key that cannot be copied off the machine, so a stolen file is useless
elsewhere. Every cheaper approximation was examined and rejected, for one root reason:

> For AWS to check something, s3cab must put it in the CreateSession request; everything s3cab can put
> in the request derives from the key + on-disk material (the ARNs live next to the key); the
> key-thief has all of it. **s3cab holds no secret the thief lacks.** So there is no value "only
> s3cab-on-this-machine could produce" — machine-binding must come from a secret the attacker cannot
> take, or be enforced by AWS on a signal the attacker cannot reproduce.

Consequences of that argument:

- **A client-side "s3cab checks the machine" (cert CN = hostname, machine-id match, …) is hygiene,
  not security.** An attacker with the key runs their own signer (the SigV4-X509 exchange is ~80
  lines, or `aws_signing_helper`, or curl) and never invokes our check. Worth nothing against theft;
  it only catches an *accidental* `~/.s3cab` copy. Not built as a security control.
- **RA certificate-attribute / `sts:SourceIdentity` conditions** don't help either — the thief
  presents the same cert and sets the same fields.
- **`aws:SourceIp` in the RA trust policy** is the *one* trivial, AWS-enforced binding (rejects a
  stolen key used from another IP, zero client code, one block in the emitted template). Considered
  and **not adopted**: it is IP-binding not machine-binding, useless for roaming/dynamic-IP hosts,
  and judged not worth the surface for the target user.
- **True non-exportability needs an OS keystore / TPM, which is complex and non-universal.**
  Node's `crypto` cannot sign *through* an external/non-exportable key (no keystore/PKCS#11/CNG
  binding, no built-in FFI), and a **Node SEA cannot bundle native addons** ([0016](0016-native-executable-build.md)),
  so the only mechanism is shelling to platform CLIs at each (hourly, cached) session refresh. Under
  that lens the platforms are lopsided: **Windows** is tractable (PowerShell `New-SelfSignedCertificate`
  non-exportable + `.NET` `SignData`); **macOS** needs Security.framework — a native addon or a
  shipped, code-signed helper binary (Gatekeeper/notarization, which the project deliberately doesn't
  pay for); **Linux** has no turnkey non-exportable *signing* store (libsecret hands back exportable
  blobs; TPM/PKCS#11 is heavyweight, not universally present, and breaks unattended/headless use),
  so it falls back to a PEM regardless. Delivering this would **fork the Phase-B signer per OS**, add
  a **Windows-only test axis** the Linux dev box and most CI can't run, and land the benefit on one
  platform. Over the top for the payoff.

### The defense-in-depth we *do* rely on

The PEM's honest security posture is **bounded blast radius + clean revocation + detectability**, not
machine-binding:

- **Bounded blast radius (the strongest lever):** the least-privilege policy is *soft-delete-only* —
  `s3:DeleteObject` but deliberately **not** `DeleteObjectVersion`, on a versioned, `Retain`-protected
  bucket ([0033](0033-bucket-onboarding-security-model.md)). Even a fully compromised key cannot
  *permanently destroy* backup history. "Leaked key" is "rotate the trust anchor," not "backups gone."
- **Central revocation:** disable/delete the trust anchor kills all sessions; a CRL revokes one cert.
- **Detection:** CloudTrail logs every `CreateSession`, alertable.
- **Tight session duration + scoped session policy** on the RA profile cap the window and reach of any
  single stolen-key session.

Non-exportability is **not foreclosed** — storage sits behind the signer interface, so a future
**opt-in** "bring-your-own non-exportable key" path (Windows CNG first, as the tractable one) can be
added for higher-assurance users without forking the *default* signer or burdening the common case.
The deferred OS-secure-storage layer in [auth.md](../design/auth.md) can revisit all local secrets
together if it ever lands.

## Consequences

- A new `src/lib/roles-anywhere.mjs` owns the DER generator + the machine-identity read/write under
  `~/.s3cab/roles-anywhere/`; the Phase B signer (also there) reads `client.key` as a PEM string.
- The generator is pure (bytes in → PEM out), unit-tested against the mandated extension set the way
  the spike validates it; `openssl` stays the informal oracle, not a test dependency.
- The client-cert serial is forced positive and non-zero (clear the sign bit, set `0x40`), so the
  all-zero serial RFC 5280 forbids can never be emitted.
- `ensureMachineIdentity` is three-state — **none** of the four identity files → generate, **all
  four** → reuse, **partial** → hard error — so a half-written or partly-deleted identity never falls
  through to regeneration, which would mint a new CA and orphan an already-deployed trust anchor.
- **UTCTime vs GeneralizedTime:** the encoder uses `UTCTime` for validity dates, correct through 2049
  (RFC 5280); a cert generated after ~2039 with a 10-year life crosses 2050 and needs the
  `GeneralizedTime` branch. Noted so it isn't a latent surprise; not built now
  ([0006](0006-minimal-code.md)).

## References

- The runnable, validated cert-gen reference: [scripts/roles-anywhere-certgen.mjs](../../scripts/roles-anywhere-certgen.mjs)
- The signer spike whose key interface this pins: [scripts/roles-anywhere-signer.mjs](../../scripts/roles-anywhere-signer.mjs)
- AWS SigV4-X509 reference implementation (Apache-2.0), the correctness oracle:
  <https://github.com/aws/rolesanywhere-credential-helper>
