# Testing strategy

## Status

**Settled (2026-06-14); AWS wiring built (PR #50, 2026-06-15).** The real bucket + OIDC CI
are live and the gated suites run green on approved same-repo PRs (see Provisioning for the
as-built layout; [doc/integration-testing.md](../doc/integration-testing.md) is the how-to).
Still pending: the non-AWS R2 canary, and (deliberately) the coverage floors stay put — the
gate runs credential-free in the `lint` job, so the gated suites skip *there* and don't move
the measured numbers.

The trigger was PR #44 (restore + adoption): the full data lifecycle now exists end-to-end
— hash → snapshot → backup → restore — and **every seam a test strategy targets is built and
stable**: `s3.mjs` (the single SDK boundary), the snapshot TSV parser, the set store
(`sets.mjs`), the auth env-layering, and the remote engine (`remote.mjs`). The still-unbuilt
commands (`verify`, `cleanup`, `delete`, `compare --remote`, `restore --output`) add new
_logic_ but **no new seams** — so the strategy won't be invalidated by them.

## Test tiers

- **Unit tests** — pure logic, no I/O, no credentials. The largest, fastest, strongest tier
  (e.g. `uploadCandidates`, the objects cache, `selectEntries`, `validateNamespace`, the
  snapshot TSV parser, `read-lines`, `error`). Run everywhere, always.
- **Mocked-`s3.mjs`-seam tests** — exercise **command orchestration** ("given these objects
  exist remotely, does `backup` upload the right diff and write the manifest last?") and
  **deterministic error injection** that real S3 won't produce on demand (mid-upload failure
  after objects land, truncated download, LIST mid-pagination). Mock at the `s3.mjs` seam —
  **our** boundary — so the test exercises our code, not AWS, and the wire-drift concern
  doesn't apply. `node:test`'s `mock.module` / `mock.fn`, zero dependency. Run everywhere,
  always — **including fork PRs** (no credentials, no container), so a fork contributor's
  S3-path logic is still covered offline.
- **Real-AWS integration / e2e** — the actual round-trips (backup→restore, listing, verified
  download, namespace discovery). The **truth layer**: only real S3 validates our
  _assumptions about S3_ (conditional-PUT / LIST / checksum semantics a mock would only
  encode our guesses about).
- **e2e subprocess** (`test/e2e.test.mjs`) — a thin cap: spawns the real CLI, asserts
  stdout/stderr, checks `--version`, smoke-tests the SEA binary when built. Covers CLI
  wiring / dispatch / stream discipline the integration tier skips. Keep it thin (the
  pyramid's slow, brittle top).

**Mock-vs-real is balanced per-test, no dogma:** real S3 to validate AWS behaviour and
round-trips; mocks for failure paths and for offline / no-credential (fork) coverage. They
cover *different failure spaces* — real S3 can't fail on command; mocks can't catch AWS
changing under us.

### Which boundary to mock at — `s3.mjs`, not the AWS SDK

The AWS SDK is a *real* boundary, not the wire — `client.send()` returns parsed JS objects,
not HTTP. So mocking it is legitimate; it's just the **wrong** boundary for orchestration
tests, for four reasons:

1. **Drift doesn't vanish, it moves up a layer.** Mock the SDK and you hand-author its
   *response shapes* (`{ ETag, ChecksumCRC64NVME, IsTruncated, … }`) — encoding *your belief*
   about what the SDK returns, the exact thing you can be wrong about. Mock `s3.mjs` and you
   author only *our* return values (a `string[]` of keys, a `Buffer`), which we define.
2. **Whose contract, how big, how stable.** `s3.mjs` is ~6 functions with plain signatures we
   own and keep stable. The SDK surface is large, AWS-owned, and **version-churny** — the
   checksum-trailer default shifted in v3.730 (it drove `customEndpoint()`'s gating). Tests
   pinned to SDK shapes are fragile across SDK bumps; tests pinned to our wrapper aren't.
3. **It respects the seam.** `s3.mjs` was promoted ahead of its second caller to be the
   *single* SDK boundary — nothing above it knows the SDK exists. Mocking at the SDK leaks SDK
   types into tests of `remote.mjs` / `backup` / `restore`, coupling them to what the boundary
   exists to hide.
4. **Zero-dep.** Mocking `s3.mjs` needs only `node:test`'s `mock.module` / `mock.fn`. Mocking
   the SDK ergonomically pulls in `aws-sdk-client-mock` — a dependency against CLAUDE.md
   design principle #5 (the high bar for dependencies).

**Not dogma — the boundary follows what's under test:**

| Under test | Mock / drive at | Why |
| --- | --- | --- |
| Orchestration above `s3.mjs` (upload diff, manifest-last, skip/overwrite) | the **`s3.mjs` seam** | small, stable, owned contract; tests our code |
| `s3.mjs`'s **own request shaping** (non-AWS checksum/SSE/storage-class *omission*) | the **SDK / outgoing request** | the behaviour *only* exists in the request the client emits (the always-on header assertion) |
| `s3.mjs`'s **response handling** (pagination, verified-download checksum) | **real S3** (integration tier) | real SDK → real responses; no hand-authored shapes to drift |

Each layer gets the mechanism that fakes the least.

### Gated suites that exist today

- `src/lib/remote.test.mjs` — `remote snapshot listing`, `uploadSnapshot`,
  `listRemoteNamespaces`, `downloadObject` (verified download).
- `src/commands/restore.test.mjs` — the **`backup → restore` round-trip** (set up → backup →
  wipe originals → restore asserting byte-identical + mtime → skip → `--overwrite`). The
  single most valuable integration test; **has never actually run** (no bucket wired yet) —
  treat it as a draft until it goes green once.

All tear down via `deleteObject` in a `finally`; content is unique per run so the shared
`objects/` store stays isolated and cleanup is exact.

## Where real S3 runs (the security model)

**Real AWS runs on same-repo (collaborator) PRs, before merge, behind a GitHub Environment
with required-reviewer approval.** Nothing credentialed runs until a maintainer clicks
approve, so an unverified malicious or accidental actor **cannot cause any spend** on the
project's account — their PR sits pending until reviewed. This deliberately beats "post-merge
only" for the PRs it covers: you want the real test *before* merge, and the approval gate
buys the security without deferring the test.

- **Fork PRs are safe by GitHub default — and approval does _not_ change that.** A
  `pull_request` run from a fork gets a read-only token and **no secrets / no OIDC**, and
  GitHub **never passes secrets to a fork-triggered run regardless of environment approval**
  (approval gates the job; it does not grant a fork run credentials). So the gated real-S3
  tests simply **skip** in fork PR CI. Never use `pull_request_target` to run untrusted code
  with credentials (the footgun). A fork contributor still gets full *orchestration* coverage
  from the mocked-seam tier in their PR CI; the **real** round-trip runs **post-merge on
  `main`** (or when a maintainer reproduces the branch in-repo to run it pre-merge) — not in
  fork PR CI. So "real S3 before merge" holds for *collaborator* PRs; fork PRs get it
  post-merge.
- **Collaborators are trusted as much as the owner** — no extra gating beyond the approval
  mechanism (which they pass by being trusted).
- **Defense-in-depth regardless** (cheap, self-healing):
  - **Tight IAM** — `Get/Put/Delete/List` on the one test bucket, nothing else. (`Delete`
    because teardown deletes; normal backup creds wouldn't need it — the tests do.)
  - **Bucket lifecycle auto-expiry** (delete objects after ~a day) — caps cost and
    self-heals when a crashed mid-run test skips its `finally` teardown.
  - **Billing alarm** — a backstop for an accidental runaway loop, not just malice.
  - **OIDC role** over long-lived keys (matches the repo's npm Trusted Publishing OIDC
    ethos), scoped so a credentialed assume is only reachable through the approved job.

### No emulator — and why

The harness is **provider-agnostic by construction**: it reads `S3CAB_TEST_BUCKET` +
`AWS_*` (+ `AWS_ENDPOINT_URL_S3` for a custom endpoint). A contributor can therefore point
it at **anything** S3-compatible — AWS, R2, B2, Wasabi, or a MinIO they stand up themselves —
*their* choice, *their* account. We **neutrally support** any target without **depending on**
one. That is strictly better than baking an emulator into CI, and it's free.

- **MinIO — rejected.** The server is AGPL-licensed (open), but we're wary of building CI on a
  dependency whose open edition's long-term direction feels uncertain to us — the caution
  behind CLAUDE.md design principle #2 (no lock-in). No criticism of the project intended; a
  contributor choosing it for their *own* local runs is fine — that's "choose," not "depend."
- **LocalStack — rejected.** Open-source core (Apache-2.0) and S3 is in the free tier, so the
  license bar is met — but it's a heavyweight all-of-AWS emulator shipped as a large
  container, far too much surface to bolt onto CI for one service (CLAUDE.md design principles
  #5 / #6 / #8 — built-ins over deps, minimal code, don't over-engineer).
- **Why no emulator at all:** the only genuine advantage an emulator has over real S3 is
  *no credentials* (so it could run on fork CI / for a contributor with no AWS account). Cost
  is negligible at test volume; the speed difference is seconds. Since fork-CI real-S3 is a
  *nice-to-have, not essential* (local devs use their own bucket), the emulator's sole
  justification mostly evaporates — and the mocked-seam tier already covers the
  credential-free path. Adding a container dependency to buy a deprioritised capability is
  the over-engineering #8 warns against.

## Non-AWS provider compatibility

s3cab targets non-AWS S3 providers as first-class (see
[s3-provider-compatibility.md](s3-provider-compatibility.md)); `putFile` already omits
intelligent-tiering, SSE, and the integrity-checksum trailer when a custom endpoint is set
(that spec's Finding 3). The gating is the **most likely thing to silently regress**. Two
layers guard it, covering different failure modes:

- **Always-on header assertion (no bucket, every PR, incl. forks) — ✅ built**
  ([src/lib/s3.test.mjs](../src/lib/s3.test.mjs)): captures the *outgoing request* (via a
  custom `requestHandler`, no network) and asserts a custom-endpoint upload carries **no**
  `x-amz-checksum-*` / CRC trailer, **no** SSE, **no** storage-class — with the AWS path
  asserted to still carry all three. The capture matters because "upload succeeds against a
  provider" doesn't prove it (a trailer-tolerant provider passes vacuously). To make the two
  gates assertable without a live client, `s3.mjs` exposes `clientConfig()` (checksum mode)
  and `putObjectParams()` (SSE/storage-class). Closes that spec's Finding 3.4; guards **our**
  regressions for free.
- **Periodic / manual real non-AWS canary:** a small handful of real round-trips (object
  put/list/get, or a backup→restore) against **one** real non-AWS provider, to prove the
  omissions are *actually sufficient* — that the provider genuinely accepts what we send.
  This catches **their** behaviour changing. **Cadence: not per-PR** — manual or scheduled
  (≈weekly) / `main`-only; providers change rarely, and this keeps the *second* credential
  set's exposure minimal.

**Provider: Cloudflare R2** (lead). Free tier, **egress-free** (no bill-surprise risk even if
a test misbehaves), and it genuinely *rejects* the newer checksum trailer — so it validates
the exact gating rather than passing vacuously. Fallback **Backblaze B2** (free 10 GB,
SigV4-only, also rejects the trailer). **Wasabi is a poor fit here:** its documented **90-day
minimum-storage duration** means objects you create and delete immediately still incur
minimum-storage charges — ill-suited to a churny, delete-heavy test bucket (no knock on it
generally; just wrong for *this* workload).

## Provisioning (as-built)

**Built in PR #50 (2026-06-15);** the rationale below is the as-built record. Live AWS
resources: bucket **`s3cab-ci-test`** (`us-east-1`, 1-day expiry lifecycle), IAM policy
**`s3cab-ci-test-access`** attached to OIDC role **`s3cab-ci`** (trust scoped to
`repo:allens/s3cab:environment:s3-integration-tests`), and the approval-gated GitHub
Environment `s3-integration-tests` (required reviewers + `AWS_ROLE_ARN` secret +
`S3CAB_TEST_BUCKET` var). Source of truth: the [`ci/aws/`](../ci/aws/) artifacts +
[doc/integration-testing.md](../doc/integration-testing.md). **Still pending:** the non-AWS
R2 canary (below).

- **Regions:** CI bucket in **`us-east-1`** (a lowest-cost reference region, and closest to
  the US-based GitHub-hosted runners; egress to a non-AWS runner is unavoidable but rounds to
  nothing at test-object volume). Local dev in whatever region is nearest the developer — it's
  read from env (below), so it never matters to the code, and inter-region cost differences
  are noise.
- **Region/bucket are read from the environment, never hardcoded:** tests take the region
  from `AWS_REGION` and the bucket from `S3CAB_TEST_BUCKET`, so the `us-east-1` CI run and a
  `eu-west-*` local run are the *same* code path.
- **What the bucket/role must allow:** IAM `Get/Put/List` **plus `Delete`** (teardown). On
  AWS, `putFile` sends SSE AES256 + intelligent-tiering; off a custom endpoint it drops those
  (`customEndpoint()` in `src/lib/s3.mjs`), so a plain bucket is fine.
- **Credentials come from the _environment_, not `~/.aws`:** the gated tests call
  `useTempHome` (redirects `HOME`/`USERPROFILE`), hiding any `~/.aws` profile. CI OIDC /
  `AWS_*` env vars work; a local run needs `AWS_*` env vars set.
- **CI creds mechanism:** **OIDC role** via `aws-actions/configure-aws-credentials` (no
  long-lived secrets — matches the repo's existing OIDC posture). The credentialed S3 job
  lives behind the approval Environment.
- **Lifecycle:** ✅ a rule expires objects after 1 day (+ aborts incomplete multipart uploads
  after 1 day), to sweep orphans from any crashed mid-run test.
- **Which OS runs S3 tests:** one (**ubuntu**) — the S3 code doesn't branch on platform; the
  3-OS matrix exists for the platform-branching code (globs, separator normalization).
- **Non-AWS canary:** a *second*, separate gated set of credentials (R2 token → access
  key/secret + `AWS_ENDPOINT_URL_S3`), run on the periodic/manual cadence above — not the
  per-PR approval job.
- **Local setup help:** ✅ — [`scripts/setup-test-bucket.mjs`](../scripts/setup-test-bucket.mjs)
  stands up the bucket + lifecycle; `npm run test:s3` (a `node --test --env-file-if-exists`
  one-liner) runs the gated suites locally, with credentials read from the developer's
  `~/.aws` profile — the tests relocate only `S3CAB_HOME`, not `HOME`, so the SDK resolves
  them normally; and [doc/integration-testing.md](../doc/integration-testing.md) is the
  generic, cross-platform walkthrough (local dev + the full GitHub Actions OIDC setup) so
  anyone can replicate it for their own account.
- **Possible ride-along:** a gated CLI-subprocess e2e round-trip in `test/e2e.test.mjs`
  (today's e2e only covers the always-run, no-S3 paths).

## Coverage floors — re-baseline after wiring

Today's global thresholds (lines 80 / branches 68 / functions 70; `*.test.mjs` + `scripts/`
excluded) read low **because** the S3 modules are gated off without a bucket. Once the gated
suites actually execute in CI, re-measure and **raise the floors** to lock in the gained
coverage (they're a floor to bump, not a target — CLAUDE.md "Known gaps").

## Related

Design specs: [backup.md](backup.md), [auth.md](auth.md),
[s3-provider-compatibility.md](s3-provider-compatibility.md). The short posture also lives in
CLAUDE.md's "Formatting, line endings & tooling" section (the S3-test-strategy bullet), which
pins the posture and points here for the full reasoning.
