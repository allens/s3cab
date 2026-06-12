# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework, see [../CLAUDE.md](../CLAUDE.md) #5).

## Where tests live

- **Unit tests are co-located with their source** as `*.test.mjs` next to the
  module they cover (e.g. [../src/commands/tree.test.mjs](../src/commands/tree.test.mjs)).
- **This directory holds cross-cutting tests and shared data:**
  - [e2e.mjs](e2e.mjs) — end-to-end CLI behaviour; spawns `node src/s3cab.mjs` as
    a subprocess.
  - [fixtures/](fixtures/) — input trees used by the tests. (Note:
    `/.s3cab/snapshots/` is gitignored at the repo root only, so a snapshot
    manifest can be committed as a fixture under `fixtures/**/.s3cab/snapshots/`
    if a test ever needs one.)

Node's `node:test` runner executes **every** `*.{js,mjs,cjs}` file under a `test/`
directory, so non-test helpers and scratch scripts must not live here — shared
helpers go beside their consumer, scratch/experiments go in [../scripts/](../scripts/).
