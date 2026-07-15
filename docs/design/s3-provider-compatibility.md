# S3 Provider Compatibility — auth & data-path portability

## Status

Research / design note. Records how S3-compatible providers handle authentication and what
s3cab must do to be genuinely provider-agnostic. The **refinement checklist** below has since
been applied — items 1, 2, and 4 are done; provider-aware onboarding (item 3) stays deferred.

Companion to [auth.md](auth.md), which specifies the AWS credential-resolution model in
detail. This note is the *cross-provider* lens on the same surface.

## Why this exists

s3cab uses the AWS SDK and at one point had built a sophisticated AWS auth stack (the env-file
→ standard chain → app-managed `login` cache resolver, an SSO/OIDC device-auth `login`
command, and a `credential-process` helper). That sophistication was **AWS-specific**. This
note scopes the auth complexity against what the wider S3-compatible ecosystem actually
offers, so the design is calibrated to reality rather than guessed at. (The conclusion has
since been acted on: the Tier 2 machinery was removed in 2026-06 — see the History note in
[auth.md](auth.md).)

**Decision:** s3cab targets S3-compatible providers (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …) as **first-class**. AWS is still the most important provider, but s3cab is
deliberately provider-agnostic; AWS SSO is an optional convenience, not the centerpiece.

## Finding 1 — Static access-key + secret-key (SigV4) is the universal denominator

Every S3-compatible provider supports exactly one thing in common: a long-lived **access key
+ secret key**, signed with **SigV4**, against a **custom endpoint**. That *is* what
"S3-compatible" means for auth. Nothing richer is portable across providers.

| Provider | Baseline auth | Temporary creds? | STS / federation? |
| --- | --- | --- | --- |
| **AWS S3** | access key/secret | yes (STS) | full: IAM, STS AssumeRole, IAM Identity Center (SSO/OIDC), web identity, instance metadata, credential_process |
| **MinIO** | access key/secret | yes | **AssumeRole + AssumeRoleWithWebIdentity (OIDC)** — the only one that genuinely mirrors AWS, but self-hosted (its own STS endpoint) |
| **Cloudflare R2** | API token → S3 key (secret = SHA-256 of token) | yes, *bespoke* | "Temporary Credentials": scoped + expiring, minted from a parent token via R2's own API or local JWT signing — **not** STS |
| **Wasabi** | access key/secret | yes, *bespoke* | `CreateTemporaryAccessCredentials` (Wasabi-specific API) |
| **Backblaze B2** | application key (keyID + appKey), SigV4 only | no | none (master key isn't even S3-compatible) |
| **DigitalOcean Spaces** | access key/secret, SigV4 | no | none (keys only via control panel) |
| **Google Cloud Storage** (S3 interop) | HMAC key (access id + 40-char secret), long-lived | no | none over the interop endpoint |
| **Storj** | access grant → "generate S3 credentials" → key/secret/endpoint | n/a | none (gateway sees long-lived keys) |

### AWS is the outlier; the sophistication is AWS-only

The rich approach is essentially **AWS alone**. Only AWS has IAM + STS + IAM Identity Center
(SSO with OIDC device-auth) + web identity + instance metadata + `credential_process`. MinIO
replicates the STS/OIDC part but is self-hosted. The few providers with temporary credentials
(R2, Wasabi) each use an **incompatible bespoke mechanism** — there is **no portable STS**
across S3-compatible storage. For every provider except AWS (and self-hosted MinIO), "auth"
reduces to **three strings: endpoint URL, access key, secret key** (+ a region label, often a
dummy).

Consequently, the SSO/OIDC `login` + app-managed-cache machinery **bought nothing for any
non-AWS provider**, and even on AWS only helped users who lack the AWS CLI. It was the largest
single source of auth complexity in the codebase, serving the narrowest audience — which is
why it was removed (2026-06).

## Finding 2 — The two-tier model

Match the auth model to what the ecosystem offers:

- **Tier 1 — portable core (every provider):** static access key + secret + **endpoint**, via
  s3cab env files / environment variables + the standard SDK chain. It is the only auth every
  S3-compatible provider can use, so it is the foundation — and it is what s3cab ships.
- **Tier 2 — AWS convenience (AWS only):** the bespoke `login` SSO flow + `credential-process`.
  Scoped as an **AWS-only enhancement / AWS-CLI replacement**, orthogonal to S3-compatibility —
  and ultimately **dropped** (2026-06): the AWS CLI owns interactive sign-in, and s3cab reads
  the resulting session through the standard chain.

This answered what was then an open question ("undecided whether s3cab keeps a bespoke SSO flow
or leans on the standard chain"), now settled in
[ADR-0015](../adr/0015-standard-aws-credential-chain.md): the bespoke SSO flow was pure
AWS-CLI-replacement convenience, independent of provider-agnostic support. Tier 1 won; Tier 2
was removed.

## Finding 3 — Refinement checklist (apply *after* the AWS auth work lands)

Concrete code touch-points to provider-neutralize, recorded now so they aren't lost. All in
[../../src/lib/s3.mjs](../../src/lib/s3.mjs) unless noted.

1. **Make the custom endpoint first-class.** ✅ **Done.** `client()`
   ([../../src/lib/s3.mjs](../../src/lib/s3.mjs)) now reads the endpoint explicitly via `customEndpoint()`
   (honouring SDK-native `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`) and passes it as
   `endpoint`; its presence is the single "not AWS" signal driving the gating below. We did
   **not** add an `S3CAB_ENDPOINT` alias — leaning on the SDK-native var ([ADR-0005](../adr/0005-builtins-over-dependencies.md) / [ADR-0006](../adr/0006-minimal-code.md)); the
   friendlier per-destination endpoint UX landed as `provider --endpoint`
   ([ADR-0047](../adr/0047-provider-command-neutral-config-door.md)).

2. **Gate AWS-only upload options.** ✅ **Done.** `putFile` now omits
   `StorageClass: INTELLIGENT_TIERING` and `ServerSideEncryption: AES256` when a custom
   endpoint is set (R2 / B2 / Spaces reject them), and `client()` passes `followRegionRedirects`
   only on AWS. The portable `x-amz-meta-*` object metadata is kept in all cases.

3. **`bucketPolicy` is AWS-only.** It emits `arn:aws:s3:::` ARNs and AWS IAM JSON, meaningless
   off AWS. Carries an AWS-only doc note; emitted by the `aws` onboarding command
   ([../../src/lib/aws.mjs](../../src/lib/aws.mjs)). Provider-aware onboarding
   is deferred.

4. **Gate the default integrity checksum off-AWS.** ✅ **Done.** Recent AWS SDK v3
   (since v3.730) computes a data-integrity checksum whenever the operation supports one —
   its default mode — so the SDK adds a CRC trailer (CRC64NVME for S3 multipart) to *every*
   upload. Several S3-compatible providers (R2 / B2 / MinIO / Wasabi) reject the newer
   trailer, and the CRC64NVME path can require the `@aws-sdk/crc64-nvme` addon that the SEA
   bundle externalizes (`--external:aws-crt`). `client()` now switches
   `requestChecksumCalculation` / `responseChecksumValidation` to their required-only mode
   (the `"WHEN_REQUIRED"` client-option value) when a custom endpoint is present; on AWS the
   default stands (free wire integrity). s3cab already SHA-256s every file, so the trailer
   adds nothing off-AWS.

5. **Verify the conditional-write backstop off-AWS.** Change detection leans on the
   conditional PUT (`If-None-Match: *`) as its *correctness* backstop
   ([ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md)) — the baseline is
   only a round-trip optimization, so a store already holding an object must reject a re-PUT.
   What's verified, and the open risk:
   - **AWS S3 — works, including multipart.** `If-None-Match: *` is supported on
     `CompleteMultipartUpload` (general-purpose buckets, Nov 2024; `PutObject`, Aug 2024), and
     the SDK's `lib-storage` `Upload` forwards it (blanket `{ ...this.params }` spread into the
     completion call). So the `IfNoneMatch` on our multipart path is *not* dead code.
   - **But the conditional is evaluated only at completion** — after every part has already
     uploaded. Relying on it alone for a large already-present object would burn the whole
     transfer, which is exactly why `putFile` ([../../src/lib/s3.mjs](../../src/lib/s3.mjs))
     keeps a **HEAD preflight for files ≥ 8 MB** before starting a multipart upload. Keep that
     preflight.
   - **Open risk — off-AWS providers.** Whether R2 / B2 / MinIO / Wasabi honour conditional
     writes on multipart is **unverified**. Because the conditional PUT is the correctness
     backstop, its reliability off-AWS must be confirmed per provider before s3cab leans on it
     there. Sources:
     [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) ·
     [enforcement, Nov 2024](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-enforcement-conditional-write-operations-general-purpose-buckets/) ·
     [CompleteMultipartUpload API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) ·
     [lib-storage Upload.ts](https://github.com/aws/aws-sdk-js-v3/blob/main/lib/lib-storage/src/Upload.ts).

## Verification

- Existing tests stay green: `node --test` across [../../test/](../../test/) and `src/**/*.test.mjs`.
- Commands that never touch S3 (`list`, `tree`) keep working with **no** credentials
  configured (the lazy-`client()` guarantee must survive the endpoint change).
- Exercise the object path against a **non-AWS** target — easiest is a local **MinIO**
  container (static keys + endpoint), or real **Cloudflare R2 / Backblaze B2** credentials.
  Confirm `hashes` (list) and the upload path succeed **with the storage-class/SSE options
  correctly omitted** — i.e. an upload that would fail today against R2/B2 now succeeds.
- **Checksum gating now has automated coverage** (Finding 3 item 4). ✅
  [../../src/lib/s3.test.mjs](../../src/lib/s3.test.mjs) captures the *outgoing request* (via a
  custom `requestHandler`, no bucket / no network) and asserts that a custom-endpoint upload
  carries no `x-amz-checksum-*` / CRC trailer — and, in the same request, no SSE and no
  storage-class — with the AWS path (no endpoint) asserted to still carry all three. This is
  the header-level assertion the planned testing pass owed (it does **not** rely on "upload
  succeeds against a provider", which a trailer-tolerant provider would pass vacuously).
- **AWS regression:** with no custom endpoint, confirm `StorageClass` / SSE / region-redirect
  still apply exactly as before.
- **Conditional-write backstop off-AWS** (Finding 3 item 5): against the same non-AWS target,
  confirm a re-PUT of an already-stored object is rejected (`If-None-Match: *`) — for both the
  single-PUT path and a **multipart** (≥ 8 MB) object. A provider that silently overwrites
  would make the correctness backstop a no-op there.

## Out of scope

- Provider-aware bucket creation and IAM policy in `setup`.
- ~~A friendlier per-destination endpoint/credential UX.~~ **Built** (2026-07): the
  `provider` command records endpoint/region by flag and the key pair by prompt/stdin,
  per set — [ADR-0047](../adr/0047-provider-command-neutral-config-door.md), [ADR-0055](../adr/0055-per-set-credentials-one-mode.md).
