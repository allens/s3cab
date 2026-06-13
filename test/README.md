# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework, see [../CLAUDE.md](../CLAUDE.md) #5).

## Where tests live

- **Unit tests are co-located with their source** as `*.test.mjs` next to the
  module they cover (e.g. [../src/commands/tree.test.mjs](../src/commands/tree.test.mjs)).
- **This directory holds cross-cutting tests and shared data:**
  - [e2e.mjs](e2e.mjs) — end-to-end CLI behaviour; spawns `node src/s3cab.mjs` as
    a subprocess.
  - [fixtures/](fixtures/) — input trees used by the tests. (Snapshots now live
    under `~/.s3cab/sets/<set>/snapshots/`, never inside a fixture tree, so tests
    that need a manifest point a temp `HOME`/`USERPROFILE` at a scratch dir — see
    [../src/commands/snapshot.test.mjs](../src/commands/snapshot.test.mjs).)

Node's `node:test` runner executes **every** `*.{js,mjs,cjs}` file under a `test/`
directory, so non-test helpers and scratch scripts must not live here — shared
helpers go beside their consumer, scratch/experiments go in [../scripts/](../scripts/).
