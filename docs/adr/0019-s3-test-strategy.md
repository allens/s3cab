# S3 test strategy: mock at s3.mjs, real-AWS gated, no emulator

Three tiers, settled deliberately. Full reasoning: [specs/testing.md](../../specs/testing.md).

1. **Pure diff/cache logic** (`uploadCandidates`, the objects cache) → ordinary **unit tests**,
   no bucket.
2. **Command orchestration + deterministic error injection** → **mock the `s3.mjs` seam**
   (`node:test`'s `mock.module`/`mock.fn`, zero-dep), run everywhere incl. fork PRs.
3. **Real round-trips** → **real AWS**, gated on `S3CAB_TEST_BUCKET` (+ ambient creds) and
   `describe(..., { skip })`-ed with a message when unset, so offline/fork runs stay green.

## Mock at `s3.mjs`, not the AWS SDK

The SDK is a real boundary but it's large, AWS-owned, and version-churny (the checksum-trailer
default shifted in v3.730), so faking its command/response shapes just relocates the drift and
needs a dep (`aws-sdk-client-mock`). `s3.mjs` is our small, stable, zero-dep contract and the
single SDK boundary the architecture already draws ([0013](0013-one-repository-one-bucket.md)).
The one place tests legitimately drop to the request layer is asserting `s3.mjs`'s **own**
request shaping (non-AWS checksum/SSE/storage-class gating).

## Considered options

- **An emulator (MinIO / LocalStack)** — rejected (see the spec).

## Consequences

The real-AWS suite runs **automatically on same-repo PRs** (no approval click; the Environment
was removed 2026-06-17): only collaborators can open same-repo PRs and OIDC trust is scoped to
this repo's `:pull_request` subject; fork PRs get no credentials and skip. The enforcing
required check is **`ci-gate`** (fails iff a job that ran failed), not `s3-integration` directly,
so a skipped check on forks can't wedge the PR. Plus a periodic **Cloudflare R2** canary
(pending) for non-AWS compatibility. Setup guide:
[docs/integration-testing.md](../integration-testing.md).
