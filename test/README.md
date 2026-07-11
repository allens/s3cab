# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework,
[ADR-0005](../docs/adr/0005-builtins-over-dependencies.md)).

## Where tests live

Three tiers. **Co-locate the module-owned tier (unit); centralize the cross-cutting tiers
(integration in a folder, e2e as its single file)**
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
`node --test --experimental-test-module-mocks "src/**/*.test.mjs" "test/*.test.mjs"` — rather
than default discovery, which would run **every** `.mjs` under `test/`. That's what lets
`helpers/` and `fixtures/` hold non-test `.mjs` here without them executing as phantom empty
tests. The **shallow** `test/*.test.mjs` catches e2e ([e2e.test.mjs](e2e.test.mjs)) but *not*
`test/integration/`, so a plain `npm test` is unit + e2e — hermetic, no bucket. (Node's
positional globs can't negate, which is exactly why the tiers are split by directory rather
than by suffix — [ADR-0049](../docs/adr/0049-centralize-cross-cutting-test-tiers.md).)
`test:integration` runs just the integration folder; `test:all` runs both tiers for a
bucket-equipped dev.

### VS Code file nesting

`.vscode/settings.json` nests each `*.test.mjs` under its source file in the explorer
(`explorer.fileNesting`, pattern `${capture}.test.mjs, ${capture}.*.test.mjs`), so a module and
its tests read as one tree entry. A module showing **no** nested test is honest signal —
tested at the `lib`/e2e layer, or too thin to own a test — not a gap to paper over
([ADR-0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md)). Scratch and experiments
still go in [../scripts/](../scripts/).
