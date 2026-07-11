# Centralize the cross-cutting test tiers; co-locate only the module-owned tier

**Status:** accepted (supersedes [0046](0046-test-layout-colocated-tier-suffix.md)'s placement
of the integration tier)

The revised principle: **co-locate the *module-owned* tier (unit); centralize the
*cross-cutting* tiers.** Integration and e2e both own no single module — they exercise real
dependencies across many — so both live under `test/`, not beside a source file:

- **Unit** → `foo.test.mjs` beside `foo.mjs` (unchanged from 0046). Belongs to one module; its
  absence beside a module is honest "tested elsewhere / too thin" signal.
- **Integration** (real bucket, gated) → `test/integration/**/*.test.mjs`. **No `.integration.`
  suffix** — the folder is the tier marker. `test:integration` globs
  `test/integration/**/*.test.mjs`, so a new suite still auto-enrols by being dropped in.
- **E2E** (subprocess CLI) → `test/e2e.test.mjs`, a single file caught by the shallow
  `test/*.test.mjs` glob. No `test/e2e/` folder yet — one file doesn't earn one
  ([0006](0006-minimal-code.md) / CLAUDE.md #5); count earns it if e2e grows.

Full rationale (the problem, the glob constraint, the naming rule) is in the originating
proposal, distilled here.

## Why this reverses 0046

0046 co-located integration as a `*.integration.test.mjs` suffix *and* already exempted e2e
from co-location because it "owns no single module." Integration is the **same kind of thing** —
cross-cutting, real deps, owns no single module — so co-locating it was inconsistent by 0046's
own logic. The evidence it's cross-cutting: the backup→restore suite is a **setup → backup →
wipe → restore** journey (filing it under "restore" undersold it), and `setup` carried *three*
co-located test files, the `.remote-first` "dotted aspect" name itself a co-location workaround.
0046's "an absent co-located test file is honest signal" only ever meant anything for **unit** —
39/44 modules "missing" an integration file was noise, not signal. A `test/integration/` folder
makes "what real-bucket coverage exists?" an `ls`.

A forcing function sealed it: Node's test-runner positional globs **do not support negation**
(verified Node 26.3.0) — `"!src/**/*.integration.test.mjs"` is ignored, and
`--test-skip-pattern` matches test *names*, not paths. So "all `.test.mjs` **except**
`.integration.`" is inexpressible while both tiers share `src/`. Separating by **directory**
makes `src/**/*.test.mjs` unit-only automatically — no negation, rename, or runner wrapper.

## The skip flag goes with it

Under 0046, a plain `npm test`'s `src/**/*.test.mjs` glob **also** matched the integration
files, so a `skip` flag (no-op when `S3CAB_TEST_BUCKET` is unset) kept that run green without a
bucket. That flag was a *symptom of the glob overlap*, not a feature, and it created a
silent-green hazard: `test:integration` with no bucket **exited 0 having run nothing**. With the
tiers in separate directories, a plain `npm test` never selects integration, so the flag has no
job. It is replaced by a **hard-fail precondition** in the shared harness
([test/helpers/integration.mjs](../../test/helpers/integration.mjs)): a run that *opted into*
integration but has no bucket throws an actionable [0030](0030-error-message-guidelines.md)
error instead of skipping. **Hard-fail > silently-skipped, wherever integration was requested.**
Fork / Dependabot protection is untouched — it lives in the job-level `if:` guards in
[ci.yml](../../.github/workflows/ci.yml), independent of the flag.

## Naming: the truest thing, not a blanket rule

Under `test/integration/`, name each file by what it most truly is — a scenario name where the
suite is genuinely cross-cutting (`backup-restore-roundtrip`, `set-lifecycle`), a module name
where that is honestly clearest (`remote`, `upload`, `set-marker`). Neither extreme (forcing
scenario names everywhere, or module names everywhere) is right.

## Per-platform real-S3 round-trip at release

A companion gap 0046/0019 left open: real-bucket networking was exercised on **Linux only**, so
release.yml shipped per-platform native binaries **having never touched real S3 on any
platform**. Sockets/IOCP-vs-epoll, rename-over-open-file, and AV locks genuinely diverge by
platform (#171 was a real per-platform stream-teardown bug every mock passed). So release.yml's
existing per-platform `build` matrix now runs a gated **setup → backup → restore round-trip**
against the test bucket, on the built binary, asserting byte-identical recovery — the ship-gate
cadence ("don't publish a binary without one real round-trip on that OS"). It is gated on the
bucket var (not the test-runner hard-fail) so a no-cred dispatch still builds artifacts, and
runs on both `v*` tags and `workflow_dispatch` (dispatch-first, tag-when-green). The trust
policy widens 1→3 OIDC subjects — all gated on the **same** write-access boundary the PR path
already permits (see [ci/aws/README.md](../../ci/aws/README.md)).

## Considered options

- **Rename 44 unit files to `*.unit.test.mjs`** so `test:integration` could suffix-glob the
  integration ones — **rejected.** Huge churn to encode in *every* filename what a directory
  encodes once.
- **A runner wrapper that filters the file list** — **rejected.** Custom machinery to work
  around the missing negation, against [0006](0006-minimal-code.md).
- **Keep integration co-located, live with the skip flag** — **rejected.** Preserves the
  silent-green hazard and the 0046 inconsistency; the whole point is to remove both.
- **A per-PR 3-OS integration matrix** (instead of the release round-trip) — **rejected.**
  Triples the slowest, flakiest, credentialed tier every PR for a low-frequency failure class;
  the ship boundary is the right cadence.

## Consequences

The genuinely module-ish suites (`remote`, `upload`, `set-marker`) lose side-by-side locality
with their module — a reader of `remote.mjs` won't see a real-bucket test beside it. Judged a
good trade: the folder-as-catalog more than pays for it. `test:all` runs both tiers for a
bucket-equipped dev; the advisory coverage run stays on the hermetic `src/**` + `test/*` globs
(never the hard-failing integration harness). 0046 stays on file as the superseded record so the
co-located-integration choice isn't re-proposed.
