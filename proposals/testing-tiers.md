# Testing tiers: unpick unit from integration; drop the skip flag

Surfaced 2026-07-11 from a review of how the three test tiers (unit / integration / e2e)
are selected and gated. Provisional — not of record. The *why* behind the current design is
[docs/design/testing.md](../docs/design/testing.md); this is a proposed change to it.

## The problem

`npm test`'s glob `src/**/*.test.mjs` **also matches** `*.integration.test.mjs` (an integration
file is a `.test.mjs` file). So a plain `npm test` sweeps the real-bucket integration tier into
the same run as the unit tier. The only thing keeping that run green without a bucket is the
**`skip` flag** in [test/helpers/integration.mjs](../test/helpers/integration.mjs): every gated
`describe(..., { skip })` silently no-ops when `S3CAB_TEST_BUCKET` is unset.

Two costs fall out of that overlap:

1. **Silent-green hazard.** `npm run test:integration` with no bucket configured (forgot to
   `export`, no `.env.test`, expired SSO) **exits 0 having run nothing** — the skip suppresses
   the very signal you invoked the command for. You asked for integration and got a pass that
   means "tested nothing."
2. **The skip flag is a symptom, not a feature.** Every consumer of `skip` is a consumer *only*
   because of the glob overlap:
   - **Fork PRs** — the credential-less upstream PR check runs `npm test`; the real gating (no
     secrets to forks) is GitHub's, enforced at the `s3-integration` job's `if:` guard, not by
     `skip`. (A fork author can still run integration in their *own* fork CI / locally.)
   - **Dependabot PRs** — excluded at the **job** level (`github.actor != 'dependabot[bot]'`);
     it only touches `skip` incidentally via the `test` job's broad glob.
   - **Local casual dev** — only needs `skip` because `npm test` drags integration in; a
     unit-only default would never attempt S3 for them.

## Settled (this review)

- **Drop the `skip` flag.** Replace it, in the integration harness, with a **hard-fail
  precondition**: if a run has *opted into* integration (`test:integration` / `test:all`) and
  `S3CAB_TEST_BUCKET` is unset, throw a clear, actionable error (ADR-0030 wording) instead of
  skipping — so a misconfigured integration run can't masquerade as a pass. Sketch:

  ```
  No test bucket configured. Integration tests need a real S3 bucket.

      export S3CAB_TEST_BUCKET=your-bucket    # then re-run
      # or run `npm test` for the unit suite (no bucket needed)
  ```

- **Principle:** `skip` is the wrong tool for "I asked for X but can't do X." That's a *scope*
  concern (don't select the tier), never a *result* concern (pretend it passed). A run that
  didn't opt into integration simply shouldn't select those files; a run that did and can't
  satisfy it should fail loudly. Hard-fail > silently-skipped, wherever integration was
  requested.

- **Fork / Dependabot protection is untouched** — it lives in the job-level `if:` guards in
  [.github/workflows/ci.yml](../.github/workflows/ci.yml), independent of the flag.

## Chosen direction — integration tests move to their own folder

**Constraint that killed the suffix-glob approaches (verified 2026-07-11, Node 26.3.0):** Node's
test-runner positional globs do **not** support negation — `"!src/**/*.integration.test.mjs"` is
ignored, the files still run; `--test-skip-pattern` matches test *names*, not file paths. So "all
`.test.mjs` **except** `.integration.`" can't be expressed while both tiers share `src/`.

Rather than force disjoint *suffixes* (rename 44 unit files → `*.unit.test.mjs`) or add a runner
wrapper that filters the file list — both rejected — **separate by directory**: move the (5)
integration tests out of `src/` into `test/integration/`. Path-based separation globs trivially,
and it also fixes a **layout inconsistency**, not just the scripts:

- **The real motivation (layout).** [ADR-0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md)
  already exempts **e2e** from co-location because "it owns no single module." Integration is the
  *same kind of thing* — cross-cutting, real deps, owns no single module — yet 0046 co-locates it
  anyway. That's inconsistent by 0046's own logic. Evidence it's cross-cutting: `restore`'s
  integration test is a **setup → backup → wipe → restore** journey (filing it under "restore"
  undersells it); `setup` already carries **three** test files (`setup.test.mjs`,
  `setup.remote-first.test.mjs`, `setup.integration.test.mjs`) — the `.remote-first` "dotted
  aspect" name is itself a co-location workaround. Only `set-marker` / `remote` / `upload` are
  even arguably module-ish, and even those span `objects` + `s3` underneath.
- **Revised principle:** co-locate the *module-owned* tier (unit); **centralize the cross-cutting
  tiers** (integration **and** e2e) in `test/`. 0046's "an absent co-located test file is honest
  signal" only ever meant anything for unit — 39/44 modules "missing" an integration file was
  noise, not signal. A `test/integration/` folder makes "what real-bucket coverage exists?" a
  `ls`, which is *more* useful than scanning modules.
- **Frees the scripts for nothing:** once integration leaves `src/`, `src/**/*.test.mjs` is
  unit-only automatically. No negation, no rename, no wrapper.

### Resulting script shape

- `test` → `src/**/*.test.mjs` + `test/*.test.mjs` (**shallow** `test/` — catches e2e, not
  `test/integration/`). Unit + e2e; fast, hermetic, no creds — the default.
- `test:integration` → `test/integration/**/*.test.mjs`. Opt-in; **hard-fails** without a bucket
  (see Settled). Auto-enrols any file dropped in the folder — 0046's one genuinely-nice property,
  preserved.
- `test:all` → both, for a bucket-equipped dev.
- CI's `s3-integration` job runs `test:integration` instead of `npm test`. The 3-OS `test` matrix
  keeps covering the unit/mocked-seam tier cross-platform.

### The cost being accepted

The genuinely module-ish tests (`set-marker`, `remote`, `upload`) lose side-by-side locality with
their module — a reader of `remote.mjs` won't see there's a real-bucket test for it. Judged a good
trade: the folder-as-catalog more than pays for it.

### Sub-decisions (confirmed 2026-07-11)

1. **Drop the `.integration.` suffix** — under `test/integration/` it's redundant; the folder is
   the tier marker (`test/integration/backup-restore.test.mjs`, not `…backup-restore.integration.test.mjs`).
2. **Name by the truest thing, not a blanket rule** — scenario names where genuinely cross-cutting
   (`backup-restore-roundtrip`, `set-lifecycle`); keep a module name where that's honestly clearest
   (`remote`, `upload`). Don't force scenario names everywhere (manufacturing structure) or module
   names everywhere (the thing we're moving away from).

### e2e stays put — the tiers get three placements, each earned

e2e is **not** moved into `src/` (a `src/` co-located test reads as *unit* by convention; e2e owns
no module and would masquerade as one) and does **not** get its own `test/e2e/` folder yet (one
file — a folder is premature structure per CLAUDE.md #5; count earns it if e2e ever grows). It
stays **`test/e2e.test.mjs`**, caught by the shallow `test/*.test.mjs` glob, and runs under `test`
with **no separate `test:e2e`** — unlike integration it's hermetic and always-on (no creds, no
gate), so it isn't a tier that needs isolating. Net principle: **co-locate the module-owned tier
(unit); centralize the cross-cutting tiers (integration in a folder, e2e as its single file).**

### Supersedes ADR-0046

This reverses 0046's placement of integration (co-located → centralized) and its suffix-as-marker
for that tier. Pre-1.0, a bold-but-correct layout change is fine (CLAUDE.md #5), but it needs a
**superseding ADR** recording the revised principle (co-locate module-owned; centralize
cross-cutting) — plus updates to `test/README.md`, `docs/design/testing.md`, and the
`.vscode/settings.json` nesting pattern.

## Platform-specific real-S3 coverage — settled 2026-07-11

**The gap.** Real-bucket networking is exercised on **Linux only**: ci.yml's `s3-integration`
job is `ubuntu-latest`, the 3-OS `test` matrix runs with no bucket, and — starkly — release.yml
ships per-platform native binaries **having never touched real S3 on any platform** (`verify`
runs `npm test` with no bucket, so integration skips there too). No tier does a real round-trip
on Windows or macOS.

**Why it matters more than first argued.** The initial "TLS is the same code, so it's abstracted
away" framing was too strong and was walked back. Same *source* removes cipher/cert divergence,
but not how sockets, the event-loop model (**IOCP** on Windows vs epoll/kqueue), and **file I/O**
(rename-over-open-file, AV locks, fsync) behave under it — all genuinely platform-divergent. The
clinching evidence is empirical: this month-old codebase was **already bitten** by #171, a
stream-teardown/abort bug (`ABORT_ERR`) that only the real S3 body exhibited and every mock
passed. That is exactly the seam most likely to diverge by platform, so "accept the bet" is the
weak option, not the default.

### Decision — a real round-trip on release.yml's `build` matrix (Option 3)

Extend the **existing per-platform `build` job** — which already builds each SEA binary on its
own OS runner and smoke-tests it — with a gated **`setup → backup → restore` round-trip against
the test bucket, asserting byte-identical restore**, run by the built binary on its native OS.
Highest fidelity available (real binary, real OS, real S3) and it reuses a job that already
exists — pure addition, no new infrastructure.

- **Rejected: a per-PR 3-OS integration matrix** — triples the slowest/flakiest/credentialed tier
  every PR for a class that (post-#171 aside) is still low-frequency. Over-engineering
  ([ADR-0006](../docs/adr/0006-minimal-code.md) / CLAUDE.md #5).
- **The ship boundary is the right cadence.** The platform-specific artifact only reaches a user
  *at release*, so "don't publish a `macos-arm64` / `win-x64` binary without one real
  backup→restore on that OS" is the exact gate. It also upgrades the per-platform check from "the
  binary boots" to "the binary actually backs up and restores," and closes the long-standing
  known-gap "possible ride-along: a gated CLI-subprocess e2e round-trip."

### On-demand, not scheduled — `workflow_dispatch` already exists

The worry behind a periodic canary was "discovering a Windows-only failure *at* release, on a
deadline." No schedule is needed: release.yml already triggers on **`workflow_dispatch`**, and
only `release`/`publish-npm` are tag-gated — `verify` + the full per-platform `build`/smoke run
on a manual dispatch **without publishing**. So the flow is **dispatch-first, tag-when-green**:
dry-run the whole matrix (round-trip included) on demand, days ahead, and tag only once clean.
That is a strictly better Option 4 than a weekly cron.

### Obsoletes nothing; keeps the credential-free floor

- The `--version` / `prop` smoke steps **stay** — they must remain credential-free (the floor
  that still runs when a dispatch/fork has no bucket). The round-trip is **gated on the bucket
  var + additive** on top, not a replacement.
- The per-PR Linux `s3-integration` job **stays** — it's the fast dev-loop signal; the release
  round-trip is the per-platform ship-gate. Different cadence, different purpose.

### Cost accepted — trust-policy widening (no new weakness *in kind*)

The Windows/macOS `build` runners need the OIDC credential, so the role's trust policy must allow
two contexts it doesn't today: the **`v*` tag** push and the **`workflow_dispatch`** ref (both
maintainer-gated — only write access can tag or dispatch).

Security-reviewed and judged acceptable: all three trigger types (PR / tag / dispatch) gate on
the **same** boundary — **write access** — and in all three a write-access actor can run
unreviewed code with the credential, which the PR path *already* permits today. So it's **1→3 in
surface count, not a new weakness in kind**: no new class of actor, same blast radius (same role
/ bucket / 1-day lifecycle), forks doubly-excluded (no OIDC to forks + the `sub` embeds the repo
slug). If anything the added triggers are *more deliberate* than the auto-on-every-push PR path
that's already live. **One hygiene requirement:** scope the new `sub` conditions precisely
(`…:ref:refs/tags/v*` + the dispatch context), not a lazy `repo:allens/s3cab:*`.

### Implementation notes (for the handoff)

- Gate the round-trip step with a job/step `if:` on the bucket var (mirror `s3-integration`'s
  gate), **not** the test-runner hard-fail — so a no-cred dispatch still builds artifacts.
- Add `permissions: id-token: write` + the `configure-aws-credentials` assume-role step to the
  `build` job; pass `S3CAB_TEST_BUCKET` from the repo var.
- Update the trust policy (`ci/aws/trust-policy.json`) with the two precisely-scoped subjects;
  reflect it in `ci/aws/README.md`.
- The round-trip drives the **built binary** (e2e-style, exercises the shipped artifact +
  per-platform SEA bundling), on unique per-run content so the shared `objects/` store stays
  isolated and teardown is exact.
