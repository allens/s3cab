# S3 test strategy: mock at s3.mjs, real-AWS gated, no emulator

**Status:** accepted

Three tiers, settled deliberately. Full reasoning: [docs/design/testing.md](../design/testing.md).
(The inventory has since grown beyond these three: `test/model/` — model-based conformance,
with a real-bucket variant — and `test/crash/`, run by their own `test:*` scripts and the
nightly workflow. The tiering *decision* here still governs where a mock is allowed.)

1. **Pure logic** (diffing, exclude matching, formatting) → ordinary **unit tests**,
   no bucket. (The original examples, `uploadCandidates` and the objects cache, are gone —
   the cache dropped by [0045](0045-change-detection-local-baseline-list-fallback.md).)
2. **Command orchestration + deterministic error injection** → **mock the `s3.mjs` seam**
   (`node:test`'s `mock.module`/`mock.fn`, zero-dep), run everywhere incl. fork PRs.
3. **Real round-trips** → **real AWS**, gated on `S3CAB_TEST_BUCKET` (+ ambient creds). Offline
   and fork runs stay green because the gated suites live in their own `test/integration/`
   directory a plain `npm test` never globs; a run that *opts into* integration without a bucket
   **hard-fails** (not silently skips) — [0049](0049-centralize-cross-cutting-test-tiers.md).

## Mock at `s3.mjs`, not the AWS SDK

The SDK is a real boundary but it's large, AWS-owned, and version-churny (the checksum-trailer
default shifted in v3.730), so faking its command/response shapes just relocates the drift and
needs a dep (`aws-sdk-client-mock`). `s3.mjs` is our small, stable, zero-dep contract and the
single SDK boundary the architecture already draws ([0013](0013-one-repository-one-bucket.md)).
The one place tests legitimately drop to the request layer is asserting `s3.mjs`'s **own**
request shaping (non-AWS checksum/SSE/storage-class gating).

We swap `s3.mjs` with `mock.module` rather than **injecting** an `s3` client through the
call chain: DI would thread an infrastructure parameter through a layered, **single-backend**
CLI purely to enable a test double — added lines against [0006](0006-minimal-code.md), and it
pollutes the one-export command seam. The escape hatch is a real *second* store (e.g. a
filesystem backend): that would make a `Store` interface justified on its own merits, tests
would run against a real implementation, and the mock would retire — but until such a store
exists that abstraction is speculative (0006 / convention #7). Full reasoning in
[docs/design/testing.md](../design/testing.md).

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
