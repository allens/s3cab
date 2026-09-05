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

## Amendment (2026-09-05): what a fake at this seam may claim

_Added when nine hand-written adapters were replaced by one stencil
([test/helpers/s3-seam.mjs](../../test/helpers/s3-seam.mjs), PR #335). The decision above says
**where** to fake; this says **what a fake may assert about itself**._

`mock.module` replaces the whole module, so every test faking this seam must supply everything
its module graph imports — including methods it never calls. That forces a default on each one,
and the defaults are not interchangeable. **They split by direction:**

- **A read may default to a coherent zero state** — an empty store: nothing listed, no text or
  size, a GET that throws `NoSuchKey`. That is not a claim, it is a *state*, and every part of it
  is falsifiable: a test expecting content gets none and fails.
- **A write may not.** There is no truthful zero state for a PUT or a DELETE, so an unmodelled
  write **throws**. A `putFile: async () => true` is the one default that can make *broken
  production code pass*, because [0083](0083-streamed-digest-upload-guard.md) put the
  streamed-digest guard **inside** `putFile`: a fake that returns `true` has skipped the guard and
  reported success. A test that needs a write to succeed says so at its own site, where the claim
  is visible to a reviewer.

This is [test/model/CAPABILITIES.md](../../test/model/CAPABILITIES.md)'s prime rule — *declare
only what you truly model; an optimistic fake that claims what it fakes poorly is how a suite
passes against broken code* — applied to a tier that has no capability set to declare in. The
throw **is** the declaration, enforced at the only moment it matters. It is deliberately not a
capability set: nothing here can `t.skip`, so a set would have no consumer
([0006](0006-minimal-code.md)).

**The stencil is not the model tier's fake, and must not grow into one.**
[test/model/harness/fake-s3.mjs](../../test/model/harness/fake-s3.mjs) is a real in-memory
backend with a keyspace, a virtual clock, fault injection and `FAKE_CAPABILITIES`; the stencil
holds no state at all. The tiers differ on purpose
([0049](0049-centralize-cross-cutting-test-tiers.md)). Two conveniences were declined for that
reason and should stay declined: a named "every write succeeds" preset (one import from being the
default again) and a built-in call recorder (what each test records differs in shape and in what
it proves).

The stencil's surface is exactly the exports production imports, kept equal by
[test/s3-seam.test.mjs](../../test/s3-seam.test.mjs) rather than by a rule in prose — the
automate-it clause of CLAUDE.md's working rule #1. It is typed `Pick<typeof import("…/s3.mjs"),
…>`, so a default whose signature drifts from production's fails `typecheck` naming the method.

Worked example of why the write side is not theoretical: on the first file migrated, dropping a
`putText: async () => {}` stub revealed that `backup`'s cloud-config refresh — which only *warns*
when it fails — had been silently exercising its success branch in both backup suites.

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
