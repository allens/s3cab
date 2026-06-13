# S3 Provider Compatibility — auth & data-path portability

## Status

Research / design note. Records how S3-compatible providers handle authentication and what
s3cab must do to be genuinely provider-agnostic. The **refinement checklist** below is meant
to be applied *after* the in-flight AWS-focused auth reimplementation lands — start from the
hard provider (AWS), then generalize.

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

This answered the CLAUDE.md open question ("undecided whether s3cab keeps a bespoke SSO flow
or leans on the standard chain"): the bespoke SSO flow was pure AWS-CLI-replacement
convenience, independent of provider-agnostic support. Tier 1 won; Tier 2 was removed.

## Finding 3 — Refinement checklist (apply *after* the AWS auth work lands)

Concrete code touch-points to provider-neutralize, recorded now so they aren't lost. All in
[../src/lib/s3.mjs](../src/lib/s3.mjs) unless noted.

1. **Make the custom endpoint first-class.** ✅ **Done.** `client()`
   ([../src/lib/s3.mjs](../src/lib/s3.mjs)) now reads the endpoint explicitly via `customEndpoint()`
   (honouring SDK-native `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`) and passes it as
   `endpoint`; its presence is the single "not AWS" signal driving the gating below. We did
   **not** add an `S3CAB_ENDPOINT` alias — leaning on the SDK-native var (CLAUDE.md #5/#6); a
   friendlier per-destination endpoint UX belongs to the `setup` command (a stub today).

2. **Gate AWS-only upload options.** ✅ **Done.** `putFile` now omits
   `StorageClass: INTELLIGENT_TIERING` and `ServerSideEncryption: AES256` when a custom
   endpoint is set (R2 / B2 / Spaces reject them), and `client()` passes `followRegionRedirects`
   only on AWS. The portable `x-amz-meta-*` object metadata is kept in all cases.

3. **`bucketPolicy` is AWS-only.** It emits `arn:aws:s3:::` ARNs and AWS IAM JSON, meaningless
   off AWS. Now carries an AWS-only doc note; still unused (only `setup`, a stub, would call
   it). Provider-aware bucket creation/policy is deferred to when `setup` is actually built.

4. **Gate the default integrity checksum off-AWS.** ✅ **Done.** Since AWS SDK v3.730
   `requestChecksumCalculation` defaults to `"when_supported"`, so the SDK adds a CRC trailer
   (CRC64NVME for S3 multipart) to *every* upload. Several S3-compatible providers
   (R2 / B2 / MinIO / Wasabi) reject the newer trailer, and the CRC64NVME path can require the
   `@aws-sdk/crc64-nvme` addon that the SEA bundle externalizes (`--external:aws-crt`).
   `client()` now sets `requestChecksumCalculation` / `responseChecksumValidation` to
   `"WHEN_REQUIRED"` when a custom endpoint is present; on AWS the default stands (free wire
   integrity). s3cab already SHA-256s every file, so the trailer adds nothing off-AWS.

## Verification (for the future code work, not now)

- Existing tests stay green: `node --test` across [../test/](../test/) and `src/**/*.test.mjs`.
- Commands that never touch S3 (`list`, `tree`) keep working with **no** credentials
  configured (the lazy-`client()` guarantee must survive the endpoint change).
- Exercise the object path against a **non-AWS** target — easiest is a local **MinIO**
  container (static keys + endpoint), or real **Cloudflare R2 / Backblaze B2** credentials.
  Confirm `objects` (list) and the upload path succeed **with the storage-class/SSE options
  correctly omitted** — i.e. an upload that would fail today against R2/B2 now succeeds.
- **AWS regression:** with no custom endpoint, confirm `StorageClass` / SSE / region-redirect
  still apply exactly as before.

## Out of scope

- Building `setup` / `backup` / `restore` (still stubs).
- Provider-aware bucket creation and IAM policy in `setup`.
- A friendlier per-destination endpoint/credential UX.
