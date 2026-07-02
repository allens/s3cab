# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework,
[ADR-0005](../docs/adr/0005-builtins-over-dependencies.md)).

## Where tests live

- **Unit tests are co-located with their source** as `*.test.mjs` next to the
  module they cover (e.g. [../src/commands/list.test.mjs](../src/commands/list.test.mjs)).
- **This directory holds cross-cutting tests and shared support:**
  - [e2e.test.mjs](e2e.test.mjs) — end-to-end CLI behaviour; spawns `node src/s3cab.mjs`
    as a subprocess.
  - [fixtures/](fixtures/) — input trees used by the tests. (Snapshots now live
    under `~/.s3cab/sets/<set>/snapshots/`, never inside a fixture tree, so tests
    that need a snapshot point `S3CAB_HOME` at a scratch dir — see
    [helpers/temp-home.mjs](helpers/temp-home.mjs).)
  - [helpers/](helpers/) — shared, importable test helpers (not run as tests).

The `test` script points the runner at an explicit glob —
`node --test --experimental-test-module-mocks "src/**/*.test.mjs" "test/**/*.test.mjs"` —
rather than default discovery,
which would run **every** `.mjs` under `test/`. That's what lets `helpers/` and `fixtures/`
hold non-test `.mjs` here without them executing as phantom empty tests. Scratch and
experiments still go in [../scripts/](../scripts/).
