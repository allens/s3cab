# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework,
[ADR-0005](../docs/adr/0005-builtins-over-dependencies.md)).

## Where tests live

Five tiers. **Co-locate the module-owned tier (unit); centralize the cross-cutting tiers
(integration, model-based and crash in folders, e2e as its single file)**
([ADR-0049](../docs/adr/0049-centralize-cross-cutting-test-tiers.md), superseding
[0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md)'s integration placement; the
*why* — the tier taxonomy and mock-vs-DI-vs-real — is
[docs/design/testing.md](../docs/design/testing.md)):

- **Unit** — co-located with their source as `*.test.mjs` next to the module they cover
  (e.g. [../src/commands/list.test.mjs](../src/commands/list.test.mjs)). Run everywhere, no
  real infra. This *includes* the mocked-`s3.mjs`-seam tests (e.g.
  [../src/lib/objects.test.mjs](../src/lib/objects.test.mjs)) — the mock is a technique, not a
  separate location.
- **Integration** — real S3 round-trips, gated on `S3CAB_TEST_BUCKET`, in
  [integration/](integration/) (e.g. [integration/remote.test.mjs](integration/remote.test.mjs)).
  **The folder is the tier marker** — no `.integration.` suffix; `npm run test:integration`
  globs `test/integration/**/*.test.mjs`, so a new suite auto-enrols by being dropped in. A run
  that opts in **without** a bucket **hard-fails** with an actionable error (no silent skip that
  "passes" having tested nothing). The shared gate + marker teardown live in
  [helpers/integration.mjs](helpers/integration.mjs). Name each by the truest thing — a scenario
  name where cross-cutting (`backup-restore-roundtrip`, `set-lifecycle`), a module name where
  clearest (`remote`, `upload`, `set-marker`).
- **E2E** — [e2e.test.mjs](e2e.test.mjs): the one suite that owns no single module (it spawns
  `node src/s3cab.mjs` as a subprocess), so it lives here rather than co-located. One file, so
  no `test/e2e/` folder yet — count would earn it.
- **Model-based** — [model/](model/): random command sequences against an in-memory fake of the
  `s3.mjs` seam, an independent model of expected repository state as the oracle, invariants
  (every snapshot restores byte-identically, content-addressing holds, …) checked after every
  step, and delta-debugging shrinking on failure. Runs in plain `npm test`;
  `.github/workflows/nightly.yml` re-runs it widened over a fresh seed window every night. Its
  own [conformance/](model/conformance/) subfolder is the real-S3 twin — capability-gated,
  sole-owner bucket, `npm run test:conformance` only, **never** in `test:all`. The
  backend-capability contract is [model/CAPABILITIES.md](model/CAPABILITIES.md); what only
  wall-clock time can test is written down in
  [model/tier3-procedure.md](model/tier3-procedure.md).
- **Crash/concurrency** — [crash/](crash/): the real CLI spawned as child processes against a
  real sole-owner bucket, hard-killed (`SIGKILL`) or deterministically parked at chosen
  S3-request boundaries by the [crash/killswitch.mjs](crash/killswitch.mjs) `--import` preload.
  Interruption cases tear every multi-step transition and assert the store stays restorable;
  concurrency cases run backup/cleanup/forget/setup from separate processes with separate
  `S3CAB_HOME`s against one bucket. Gated on `S3CAB_CRASH_BUCKET` (`test-s3cab-<owner>-crash` —
  cases wipe the bucket), `npm run test:crash` only, **never** in `test:all`. Assertions go
  through the model tier's independent inspector/parser, never `src/lib/s3.mjs`. The two `PIN`
  tests in [crash/concurrency.test.mjs](crash/concurrency.test.mjs) assert *current wrong*
  behaviour (the [concurrency epic](../proposals/concurrency-and-locking.md) §1 races) and flip
  loudly when a fix lands, like `model.findings`.

A second test file for one module qualifies with a **dotted aspect**
(`setup.remote-first.test.mjs`), not a hyphen — a hyphen reads as a sibling command.

**This directory also holds cross-cutting support:**
  - [fixtures/](fixtures/) — input trees used by the tests. (Snapshots now live
    under `~/.s3cab/sets/<set>/snapshots/`, never inside a fixture tree, so tests
    that need a snapshot point `S3CAB_HOME` at a scratch dir — see
    [helpers/temp-home.mjs](helpers/temp-home.mjs).)
  - [helpers/](helpers/) — shared, importable test helpers, not run as tests
    (`temp-home.mjs`, `write-snapshot.mjs`, and `integration.mjs` — the gated-suite harness).

The `test` script points the runner at explicit globs —
`"src/**/*.test.mjs" "test/*.test.mjs" "test/model/*.test.mjs"` — rather than default
discovery, which would run **every** `.mjs` under `test/`. That's what lets `helpers/`,
`fixtures/` and `model/harness/` hold non-test `.mjs` here without them executing as phantom
empty tests. The **shallow** `test/*.test.mjs` catches e2e ([e2e.test.mjs](e2e.test.mjs)) but
*not* `test/integration/`, and `test/model/*.test.mjs` deliberately stops above
`model/conformance/` — so a plain `npm test` is unit + e2e + model — hermetic, no bucket.
(Node's positional globs can't negate, which is exactly why the tiers are split by directory
rather than by suffix — [ADR-0049](../docs/adr/0049-centralize-cross-cutting-test-tiers.md).)
`test:integration` runs just the integration folder; `test:model` just the model tier;
`test:all` runs everything a bucket-equipped dev can share (conformance and crash stay
separate — their bucket wipes brook no co-tenants).

### VS Code file nesting

`.vscode/settings.json` nests each `*.test.mjs` under its source file in the explorer
(`explorer.fileNesting`, pattern `${capture}.test.mjs, ${capture}.*.test.mjs`), so a module and
its tests read as one tree entry. A module showing **no** nested test is honest signal —
tested at the `lib`/e2e layer, or too thin to own a test — not a gap to paper over
([ADR-0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md)). Scratch and experiments
still go in [../scripts/](../scripts/).
