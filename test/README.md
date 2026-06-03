# Tests

Test layout for s3cab. Run the suite with `npm test` (Node's built-in
`node:test` runner — no framework, see [../CLAUDE.md](../CLAUDE.md) #5).

## Where tests live

- **Unit tests are co-located with their source** as `*.test.mjs` next to the
  module they cover (e.g. [../src/commands/tree.test.mjs](../src/commands/tree.test.mjs)).
- **This directory holds cross-cutting tests and shared data:**
  - [e2e.mjs](e2e.mjs) — end-to-end CLI behaviour; spawns `node src/cli.mjs` as
    a subprocess.
  - [fixtures/](fixtures/) — input trees and committed snapshot manifests used
    by the tests. (Note: `/.s3cab/snapshots/` is gitignored at the repo root only,
    so fixture snapshots under `fixtures/**/.s3cab/snapshots/` stay tracked.)
  - [_poc/home/](_poc/home/) — mock-`$HOME` data (AWS config, profile fixtures)
    for the experimental S3/SSO POC in [../src/_poc/](../src/_poc/). The helper that
    points `$HOME` here lives beside that POC
    ([../src/_poc/helper.mjs](../src/_poc/helper.mjs)) rather than under `test/`, so
    the runner doesn't execute it as a phantom test. Not used by any active test;
    kept until that path is promoted or removed.

Node's `node:test` runner executes **every** `*.{js,mjs,cjs}` file under a `test/`
directory, so non-test helpers and scratch scripts must not live here — shared
helpers go beside their consumer, scratch/experiments go in [../scripts/](../scripts/).
