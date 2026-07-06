# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework,
[ADR-0005](../docs/adr/0005-builtins-over-dependencies.md)).

## Where tests live

Three tiers, distinguished by **filename** and location
([ADR-0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md); the *why* — the tier
taxonomy and mock-vs-DI-vs-real — is [docs/design/testing.md](../docs/design/testing.md)):

- **Unit** — co-located with their source as `*.test.mjs` next to the module they cover
  (e.g. [../src/commands/list.test.mjs](../src/commands/list.test.mjs)). Run everywhere, no
  real infra. This *includes* the mocked-`s3.mjs`-seam tests (e.g.
  [../src/lib/objects.test.mjs](../src/lib/objects.test.mjs)) — the mock is a technique, not a
  separate location.
- **Integration** — co-located as `*.integration.test.mjs` (e.g.
  [../src/lib/remote.integration.test.mjs](../src/lib/remote.integration.test.mjs)). Real S3
  round-trips, gated on `S3CAB_TEST_BUCKET`; each `describe(..., { skip })`-s with a message
  when unset. `npm run test:integration` runs the glob `src/**/*.integration.test.mjs`, so a new suite
  auto-enrols by name. The shared gate + marker teardown live in
  [helpers/integration.mjs](helpers/integration.mjs).
- **E2E** — [e2e.test.mjs](e2e.test.mjs): the one suite that owns no single module (it spawns
  `node src/s3cab.mjs` as a subprocess), so it lives here rather than co-located.

A second test file for one module qualifies with a **dotted aspect**
(`setup.remote-first.test.mjs`), not a hyphen — a hyphen reads as a sibling command.

**This directory also holds cross-cutting support:**
  - [fixtures/](fixtures/) — input trees used by the tests. (Snapshots now live
    under `~/.s3cab/sets/<set>/snapshots/`, never inside a fixture tree, so tests
    that need a snapshot point `S3CAB_HOME` at a scratch dir — see
    [helpers/temp-home.mjs](helpers/temp-home.mjs).)
  - [helpers/](helpers/) — shared, importable test helpers, not run as tests
    (`temp-home.mjs`, `write-snapshot.mjs`, and `integration.mjs` — the gated-suite harness).

The `test` script points the runner at an explicit glob —
`node --test --experimental-test-module-mocks "src/**/*.test.mjs" "test/**/*.test.mjs"` —
rather than default discovery, which would run **every** `.mjs` under `test/`. That's what
lets `helpers/` and `fixtures/` hold non-test `.mjs` here without them executing as phantom
empty tests. (The `*.test.mjs` glob also matches `*.integration.test.mjs`, so a plain
`npm test` runs every tier — the integration blocks just skip without a bucket.)

### VS Code file nesting

`.vscode/settings.json` nests each `*.test.mjs` under its source file in the explorer
(`explorer.fileNesting`, pattern `${capture}.test.mjs, ${capture}.*.test.mjs`), so a module and
its tests read as one tree entry. A module showing **no** nested test is honest signal —
tested at the `lib`/e2e layer, or too thin to own a test — not a gap to paper over
([ADR-0046](../docs/adr/0046-test-layout-colocated-tier-suffix.md)). Scratch and experiments
still go in [../scripts/](../scripts/).
