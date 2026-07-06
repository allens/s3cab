# Test layout: co-located tests, tier in the filename suffix

**Status:** accepted

Tests live **next to the code they cover**, with the tier encoded in the filename;
VS Code explorer clutter is solved by file nesting, not by relocating tests into a
`test/` tree. Full taxonomy and reasoning: [docs/design/testing.md](../design/testing.md);
the mechanics (globs, nesting pattern, helper home): [test/README.md](../../test/README.md).

- **Unit** → `foo.test.mjs` beside `foo.mjs`. Covers pure-unit *and* mocked-`s3.mjs`-seam
  tests — both run everywhere, no real infra, so they share the unmarked default.
- **Integration** (real bucket, gated) → `foo.integration.test.mjs` beside `foo.mjs`. The
  suffix marks the one binary that matters at a glance — *does this need AWS creds?* — and
  lets `test:integration` be the glob `src/**/*.integration.test.mjs`, so a new suite auto-enrols.
- **E2E** (subprocess CLI) → `test/e2e.test.mjs`. It owns no single module, so it is the
  one suite that does *not* co-locate; it lives in `test/` with the cross-cutting fixtures
  and helpers.

A second test file for one module qualifies with a **dotted aspect**
(`setup.remote-first.test.mjs`), never a hyphen (which reads as a sibling command).

## Considered options

- **Move unit tests into a `test/` tree** (mirror the source layout) — **rejected.** It only
  *relocates* the clutter (the `test/` tree then looks as large) and deletes a useful signal:
  with co-location, a module with no test file beside it reads as "tested at the `lib`/e2e
  layer, or too thin to own a test" — a coverage radar the move would blind. The actual pain
  (a large VS Code tree) is fixed by `explorer.fileNesting`, which tucks `foo.test.mjs` under
  `foo.mjs` at zero cost — no import churn, no lost signal.
- **Empty or vanity test files for visual uniformity** — **rejected.** An empty test file
  registers as a *passing* test (Node counts the file itself), and any test that asserts
  nothing is false coverage, against [0020](0020-coverage-review-not-gate.md) and
  [0006](0006-minimal-code.md). The different look of an untested thin wrapper is honest
  signal, not a defect to paper over.

## Consequences

Adding a real-bucket suite is "name it `*.integration.test.mjs`" — no hand-maintained file
list. A plain `npm test` still runs every tier (the integration blocks `{ skip }` without a
bucket); `test:integration` runs just the integration glob. The shared gated-suite harness (the
`S3CAB_TEST_BUCKET`/`skip` gate, the env-loaded flag, marker teardown) lives in
[test/helpers/integration.mjs](../../test/helpers/integration.mjs).
