# Testing strategy

## Status

**Planned — a dedicated session, not yet decided.** This doc captures the framing for that
session so it survives across machines (it was developed in conversation 2026-06-14 and would
otherwise live only in one machine's local assistant memory). It records the _current_
posture, the _open_ questions, and a proposed order to settle them — it is **not** a settled
design. Treat the current scheme (below) as the working default until this session lands.

The trigger to do it now: after PR #44 (restore + adoption), the **fundamentals are in
place**. The full data lifecycle exists end-to-end — hash → snapshot → backup → restore,
exercised by the gated round-trip in `src/commands/restore.test.mjs` — and **every
architectural seam a test strategy targets is built and stable**: `s3.mjs` (the single SDK
boundary), the snapshot TSV parser, the set store (`sets.mjs`), the auth env-layering, and
the remote engine (`remote.mjs`). The still-unbuilt commands (`verify`, `cleanup`, `delete`,
`compare --remote`, `restore --output`) add new _logic_ but **no new seams** — they recompose
existing primitives — so a strategy settled now won't be invalidated by them.

## Current posture (the working default)

- **S3-touching code → gated integration tests against a real bucket.** Anything that calls
  `s3.mjs` (remote listing/read, the uploader, verified download, namespace discovery) is
  covered by integration tests gated on `S3CAB_TEST_BUCKET` (+ ambient AWS credentials) and
  `describe(..., { skip })`-ed **with a message** when unset — so local, offline, and fork-CI
  runs stay green, and real coverage runs only where the bucket is wired.
- **Pure logic → ordinary unit tests** needing no bucket (e.g. `uploadCandidates`, the objects
  cache, `selectEntries`, `validateNamespace`/`isNamespace`).
- **CLI → e2e subprocess** (`test/e2e.mjs`) spawns the built CLI and asserts on stdout/stderr.
- **Preference, not a hard rule, to avoid mocking:** a fake of the AWS _wire_ drifts from real
  conditional-PUT / LIST semantics. (See the open question below — this is exactly what the
  session revisits.)

### Gated suites that exist today (what the bucket must support)

- `src/lib/remote.test.mjs` — `remote snapshot listing`, `uploadSnapshot`,
  `listRemoteNamespaces`, `downloadObject` (verified download).
- `src/commands/restore.test.mjs` — the **`backup → restore` round-trip** (set up → backup →
  wipe originals → restore asserting byte-identical + mtime → skip → `--overwrite`). The
  single most valuable integration test; **has never actually run** (no bucket wired yet).

All tear down via `deleteObject` in a `finally`; content is unique per run so the shared
`objects/` store stays isolated and cleanup is exact.

## The central open question: mock-or-not at the `s3.mjs` seam

The likely resolution (recorded in CLAUDE.md's tooling section): **mock at the `s3.mjs`
seam** — stub its exported functions with `node:test`'s built-in `mock.module`/`mock.fn`
(zero dependency) to test command orchestration offline — **and keep real AWS semantics e2e
on the gated bucket**. Mocking the seam exercises _our_ code, not AWS, so the wire-drift
concern doesn't apply. Not yet committed; the session decides.

## The anchoring question: where may real S3 run, and whose code touches it?

**This is the user's live concern — abuse of the real bucket in PRs — and it is the _same_
decision as mock-or-not wearing two hats.** Answer "where does real S3 run?" and both the
security posture and the mocking approach fall out together. Settle this first.

- **Fork PRs are already safe by GitHub default.** `pull_request` runs from a fork get a
  read-only token and **no secrets / no OIDC**, so the gated S3 tests simply skip (today's
  behaviour). Don't break this — and never use `pull_request_target` to run untrusted code
  with credentials (that is the footgun).
- **The real exposure is same-repo _collaborator_ branch PRs** — those do get credentials.
  Containment ladder, increasing strictness:
  - Tight IAM role: only `Get/Put/Delete/List` on the one test bucket, nothing else.
  - Bucket **lifecycle auto-expiry** (delete objects after ~a day) + a billing alarm — caps
    cost and self-heals if a test's teardown is skipped by a crash.
  - A **GitHub Environment with required-reviewer approval** gating the credentials, so the S3
    job won't run on a PR until approved.
  - **OIDC trust policy scoped to `main` only** — no PR branch (even a collaborator's) can
    assume the role.
- **The collapse:** if the `s3.mjs` seam is **mocked**, PRs get full command-orchestration
  coverage _offline_ and need **no** real S3 — so the real bucket can be restricted to
  **post-merge on `main`**, removing essentially the whole abuse surface. The real-bucket
  suite becomes a `main` gate, not a PR gate.

## Proposed session order

1. **Where may real S3 run?** (`main`-only / Environment-approved / gated PR) — the anchor.
2. **Mock the `s3.mjs` seam, or not?** — falls out of (1).
3. **Concrete bucket + IAM + OIDC + lifecycle config** (see provisioning below).
4. **Re-baseline the coverage floors** once the gated suites actually execute (today's
   thresholds are Windows-measured floors that read low _because_ the S3 modules are gated
   off; CLAUDE.md "Known gaps").

## Bucket / CI provisioning notes (pickup brief)

- **What the gated tests need of the bucket/role:** IAM `Get/Put/List` **plus `Delete`**
  (teardown deletes; normal backup creds wouldn't need delete — the tests do). On AWS,
  `putFile` sends SSE AES256 + intelligent-tiering; off a custom endpoint it drops those (see
  `customEndpoint()` in `src/lib/s3.mjs`), so a plain bucket is fine.
- **Credentials must come from the _environment_, not `~/.aws`:** the gated tests call
  `useTempHome` (redirects `HOME`/`USERPROFILE`), which hides any `~/.aws` profile. CI OIDC /
  `AWS_*` env vars work; a local run needs `AWS_*` env vars set.
- **Creds mechanism:** lean **OIDC role** via `aws-actions/configure-aws-credentials` (matches
  the repo's no-long-lived-secrets ethos — it already uses npm Trusted Publishing OIDC).
  Alternative: access-key GitHub secrets (quicker, long-lived — less aligned).
- **Which OS runs S3 tests:** lean **one (ubuntu)** — the S3 code doesn't branch on platform;
  the 3-OS matrix exists for the platform-branching code (globs, separator normalization).
- **Bucket:** create one (e.g. `s3cab-ci-test`), pick a region, add a **lifecycle rule to
  expire objects after N days** to sweep orphans from any crashed mid-run test.
- **Cost/secret-free alternative worth weighing:** point the gated tests at a **non-AWS / local
  S3** (MinIO / LocalStack / R2) via `AWS_ENDPOINT_URL_S3` — `putFile` already drops the
  AWS-isms off-endpoint, so the gated suites could run in CI with no AWS account at all.
- **Possible ride-along:** a gated CLI-subprocess e2e round-trip in `test/e2e.mjs` (the
  current e2e only covers the always-run, no-S3 paths).

## Related

Design specs: [backup.md](backup.md), [auth.md](auth.md),
[s3-provider-compatibility.md](s3-provider-compatibility.md). The short posture + the
mock-or-not lean also live in CLAUDE.md's "Formatting, line endings & tooling" section.
