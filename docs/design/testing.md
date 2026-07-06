# Testing strategy

## Status

**Settled (2026-06-14); AWS wiring built (PR #50, 2026-06-15); auto-run 2026-06-17.** The
real bucket + OIDC CI are live and the gated suites run green on same-repo PRs — automatically,
with no approval click (the required-reviewer Environment was removed; see "Where real S3
runs"). See Provisioning for the as-built layout;
[docs/integration-testing.md](../integration-testing.md) is the how-to.
Still pending: the non-AWS R2 canary. (Coverage thresholds are gone entirely — coverage is
judged by review, [ADR-0020](../adr/0020-coverage-review-not-gate.md).)

The trigger was PR #44 (restore + adoption): the full data lifecycle now exists end-to-end
— hash → snapshot → backup → restore — and **every seam a test strategy targets is built and
stable**: `s3.mjs` (the single SDK boundary), the snapshot TSV parser, the set store
(`sets.mjs`), the auth env-layering, and the remote engine (`remote.mjs`). The still-unbuilt
commands (`verify`, `cleanup`, `delete`) add new _logic_ but **no new seams** — so the strategy
won't be invalidated by them. (The `setup --inherit` snapshot-file sync of
[0027](../adr/0027-compare-local-only-adoption-syncs-manifests.md) adds one small new
plumbing op — download-object-to-file — but still no new seam.)

## Test tiers

- **Unit tests** — pure logic, no I/O, no credentials. The largest, fastest, strongest tier
  (e.g. `uploadCandidates`, `backup`'s baseline resolution, `selectEntries`,
  `validateNamespace`, the snapshot TSV parser, `read-lines`, `error`). Run everywhere, always.
- **Mocked-`s3.mjs`-seam tests** — exercise **command orchestration** ("given these objects
  exist remotely, does `backup` upload the right diff and write the snapshot last?") and
  **deterministic error injection** that real S3 won't produce on demand (mid-upload failure
  after objects land, truncated download, LIST mid-pagination). Mock at the `s3.mjs` seam —
  **our** boundary — so the test exercises our code, not AWS, and the wire-drift concern
  doesn't apply. `node:test`'s `mock.module` / `mock.fn`, zero dependency (`mock.module`
  needs `--experimental-test-module-mocks`, now on the `test`/`test:coverage*` scripts;
  first realized in `src/lib/objects.test.mjs` for the object store's cache + `getObject`
  integrity check, mocking `createS3ReadStream`. One ordering rule it forces: import the
  module-under-test *dynamically, after* the mock — a static import binds the real seam
  first and the cached binding wins). Run everywhere, always — **including fork PRs** (no
  credentials, no container), so a fork contributor's S3-path logic is still covered offline.
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
   the SDK ergonomically pulls in `aws-sdk-client-mock` — a dependency against
   [ADR-0005](../adr/0005-builtins-over-dependencies.md) (the high bar for dependencies).

**Not dogma — the boundary follows what's under test:**

| Under test | Mock / drive at | Why |
| --- | --- | --- |
| Orchestration above `s3.mjs` (upload diff, snapshot-last, skip/overwrite) | the **`s3.mjs` seam** | small, stable, owned contract; tests our code |
| `s3.mjs`'s **own request shaping** (non-AWS checksum/SSE/storage-class *omission*) | the **SDK / outgoing request** | the behaviour *only* exists in the request the client emits (the always-on header assertion) |
| `s3.mjs`'s **response handling** (pagination, verified-download checksum) | **real S3** (integration tier) | real SDK → real responses; no hand-authored shapes to drift |

Each layer gets the mechanism that fakes the least.

### Gated suites that exist today

The `test:s3` script names them:

- `src/lib/remote.test.mjs` — remote snapshot listing, `downloadRemoteSnapshots`,
  `uploadSnapshot`. (`getObject`'s verified download is exercised offline by the
  mocked-seam tests in `src/lib/objects.test.mjs`, and end-to-end by the restore round-trip
  below.)
- `src/lib/set-marker.test.mjs` — the `sets/<set>/` claim marker (conditional-PUT claim,
  listing, config publish).
- `src/commands/setup.test.mjs` — `setup`'s collision check and `--inherit` against a real
  bucket.
- `src/commands/restore.test.mjs` — the **`backup → restore` round-trip** (set up → backup →
  wipe originals → restore asserting byte-identical + mtime → skip → `--overwrite`). The
  single most valuable integration test.

All tear down via `deleteObject` in a `finally`; content is unique per run so the shared
`objects/` store stays isolated and cleanup is exact.

## Where real S3 runs (the security model)

**Real AWS runs automatically on same-repo (collaborator) PRs, before merge — no approval
click.** The safety rests on *who can trigger it*: a same-repo PR can only be opened by a
collaborator with push access (a trusted actor), and the OIDC trust policy is scoped to this
repo's `:pull_request` subject, so the role is assumable only from such a run. An untrusted
actor has no way in — their only route is a fork PR, which GitHub gives no credentials at all.

We **dropped the earlier required-reviewer approval Environment** (2026-06-17). With the
trigger already restricted to trusted collaborators, the approval click was pure friction —
and worse, it was a *human decision*: `s3-integration` was not a required check, so a
credentialed change could be merged having never been approved or run. Auto-run plus the
`ci-gate` required check (below) closes that hole; spend is now capped by defense-in-depth
rather than by an approval gate.

- **Fork PRs are safe by GitHub default.** A `pull_request` run from a fork gets a read-only
  token and **no secrets / no OIDC** — GitHub never passes secrets to a fork-triggered run.
  So the gated real-S3 tests simply **skip** in fork PR CI. Never use `pull_request_target`
  to run untrusted code with credentials (the footgun). A fork contributor still gets full
  *orchestration* coverage from the mocked-seam tier in their PR CI; to run the **real**
  round-trip on a fork PR, a maintainer reproduces its commits as a same-repo branch
  (`gh pr checkout <n>` → `git push origin HEAD:pr-<n>`), which then runs it pre-merge like
  any collaborator PR. So "real S3 before merge" holds for collaborator PRs directly, and for
  fork PRs once reproduced in-repo. (We do **not** run it on push-to-main: a same-repo PR
  already tested that commit, so it would be a redundant second credentialed run.)
- **`ci-gate` is the enforcing required check, not `s3-integration` directly.** The S3 job is
  *skipped* on fork PRs, and a skipped required check is treated as forever-pending — which
  would wedge fork PRs unmergeable. So an always-running `ci-gate` job (fails iff a job that
  ran failed; a skipped job is not a failure) is the single required check. That makes "the
  right jobs for this diff went green" the merge condition, with no human deciding.
- **Collaborators are trusted as much as the owner** — opening a same-repo PR is itself the
  trust boundary; there is no further gating.
- **Defense-in-depth regardless** (cheap, self-healing — and now the *primary* spend control,
  with approval gone):
  - **Tight IAM** — `Get/Put/Delete/List` on the one test bucket, nothing else. (`Delete`
    because teardown deletes; normal backup creds wouldn't need it — the tests do.)
  - **Bucket lifecycle auto-expiry** (delete objects after ~a day) — caps cost and
    self-heals when a crashed mid-run test skips its `finally` teardown.
  - **Billing alarm** — a backstop for an accidental runaway loop, not just malice.
  - **OIDC role** over long-lived keys (matches the repo's npm Trusted Publishing OIDC
    ethos), scoped via the `:pull_request` subject so a credentialed assume is only reachable
    from a same-repo PR run.

### No emulator — and why

The harness is **provider-agnostic by construction**: it reads `S3CAB_TEST_BUCKET` +
`AWS_*` (+ `AWS_ENDPOINT_URL_S3` for a custom endpoint). A contributor can therefore point
it at **anything** S3-compatible — AWS, R2, B2, Wasabi, or a MinIO they stand up themselves —
*their* choice, *their* account. We **neutrally support** any target without **depending on**
one. That is strictly better than baking an emulator into CI, and it's free.

- **MinIO — rejected.** The server is AGPL-licensed (open), but we're wary of building CI on a
  dependency whose open edition's long-term direction feels uncertain to us — the caution
  behind [ADR-0002](../adr/0002-no-lock-in-hard-constraint.md) (no lock-in). No criticism of the project intended; a
  contributor choosing it for their *own* local runs is fine — that's "choose," not "depend."
- **LocalStack — rejected.** Open-source core (Apache-2.0) and S3 is in the free tier, so the
  license bar is met — but it's a heavyweight all-of-AWS emulator shipped as a large
  container, far too much surface to bolt onto CI for one service
  ([ADR-0005](../adr/0005-builtins-over-dependencies.md) /
  [ADR-0006](../adr/0006-minimal-code.md) / CLAUDE.md convention #7 — built-ins over deps,
  minimal code, don't over-engineer).
- **Why no emulator at all:** the only genuine advantage an emulator has over real S3 is
  *no credentials* (so it could run on fork CI / for a contributor with no AWS account). Cost
  is negligible at test volume; the speed difference is seconds. Since fork-CI real-S3 is a
  *nice-to-have, not essential* (local devs use their own bucket), the emulator's sole
  justification mostly evaporates — and the mocked-seam tier already covers the
  credential-free path. Adding a container dependency to buy a deprioritised capability is
  the over-engineering #7 warns against.

## Non-AWS provider compatibility

s3cab targets non-AWS S3 providers as first-class (see
[s3-provider-compatibility.md](s3-provider-compatibility.md)); `putFile` already omits
intelligent-tiering, SSE, and the integrity-checksum trailer when a custom endpoint is set
(that note's Finding 3). The gating is the **most likely thing to silently regress**. Two
layers guard it, covering different failure modes:

- **Always-on header assertion (no bucket, every PR, incl. forks) — ✅ built**
  ([src/lib/s3.test.mjs](../../src/lib/s3.test.mjs)): captures the *outgoing request* (via a
  custom `requestHandler`, no network) and asserts a custom-endpoint upload carries **no**
  `x-amz-checksum-*` / CRC trailer, **no** SSE, **no** storage-class — with the AWS path
  asserted to still carry all three. The capture matters because "upload succeeds against a
  provider" doesn't prove it (a trailer-tolerant provider passes vacuously). To make the two
  gates assertable without a live client, `s3.mjs` exposes `clientConfig()` (checksum mode)
  and `putObjectParams()` (SSE/storage-class). Closes that note's Finding 3.4; guards **our**
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

**Built in PR #50 (2026-06-15); approval Environment removed for auto-run 2026-06-17.** The
live resource names/values are recorded in [`ci/aws/README.md`](../../ci/aws/README.md), and
[docs/integration-testing.md](../integration-testing.md) is the generic walkthrough — IAM
verbs, lifecycle, credential resolution (`useTempHome` relocates only `S3CAB_HOME`, so
`~/.aws` stays visible), and `npm run test:s3` all live there, not here. What *is*
design-level:

- **Regions:** CI bucket in **`us-east-1`** (a lowest-cost reference region, and closest to
  the US-based GitHub-hosted runners; egress to a non-AWS runner is unavoidable but rounds to
  nothing at test-object volume). Local dev in whatever region is nearest the developer —
  inter-region cost differences are noise.
- **Region/bucket are read from the environment, never hardcoded:** tests take the region
  from `AWS_REGION` and the bucket from `S3CAB_TEST_BUCKET`, so the `us-east-1` CI run and a
  `eu-west-*` local run are the *same* code path.
- **Which OS runs S3 tests:** one (**ubuntu**) — the S3 code doesn't branch on platform; the
  3-OS matrix exists for the platform-branching code (globs, separator normalization).
- **Non-AWS canary (the still-pending piece):** a *second*, separate gated set of credentials
  (R2 token → access key/secret + `AWS_ENDPOINT_URL_S3`), run on the periodic/manual cadence
  above — not the per-PR job.
- **Possible ride-along:** a gated CLI-subprocess e2e round-trip in `test/e2e.test.mjs`
  (today's e2e only covers the always-run, no-S3 paths). **Deliberately not built for the
  human-first-output action confirmations** (backup/upload/restore/delete/cleanup renderers,
  ADR-0043): the only untested bit was the *wiring* (dispatcher → the right renderer → stdout),
  and `render` is now a **required, `tsc`-enforced** registry field — an unwired renderer won't
  compile — so the compiler closes that gap. Their result-shaping is already covered by the
  gated `remote`/`objects` round-trips and the offline renderer unit tests (`render.test.mjs`).
  A live round-trip asserting human + `--json` stdout stays a low-to-moderate-value future
  option, not a gap.

## Related

Design docs: [backup.md](backup.md), [auth.md](auth.md),
[s3-provider-compatibility.md](s3-provider-compatibility.md). The short posture also lives in
[ADR-0019](../adr/0019-s3-test-strategy.md), which pins it and points here for the full
reasoning.
