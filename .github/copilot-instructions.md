# Copilot instructions for s3cab

s3cab is a content-addressable S3 backup CLI. The authoritative design philosophy,
architecture, and contributor conventions live in [CLAUDE.md](../CLAUDE.md) and the specs
under `docs/specs/` — read those for the _why_. This file is the short brief for Copilot (code
completion **and** code review).

## When reviewing a pull request, prioritise — in order:

1. **Test coverage of the change — the top review concern.** Every new or changed behaviour
   should ship a test that makes a _real assertion about the result_, not one that merely
   executes the line. Flag:
   - new branches, error paths, or command logic added with no accompanying test;
   - tests that call code but assert little or nothing ("coverage theatre");
   - a behaviour change that doesn't update or add the test pinning the old behaviour.

   Coverage is deliberately **not** enforced by a CI threshold here — review is the gate, so
   this judgement is yours to make. CI prints a coverage number, but it is advisory only. If
   coverage drops, the PR should either cover the gap or explain why the drop is legitimate
   (deleted tested code, or logic exercised only by the bucket-gated S3 integration suite).

2. **Correctness**, especially around SHA-256 hashing, the TSV snapshot format, path
   handling, and platform branches (`win32` case-insensitive globbing, `\`→`/`
   normalization).

3. **House style** (see CLAUDE.md): Node built-ins over dependencies — the AWS SDK is the
   _only_ sanctioned runtime dep, and tests use `node:test`, never Jest/Vitest; small,
   low-surface-area code; no speculative structure ("build the small thing the current need
   justifies"); don't bury `await` inside a larger statement.

4. **Docs honesty** — README/CLAUDE.md claims must match the code, and must distinguish what
   is built today from what is planned.

## Testing notes

- Run tests with `node --test`; unit tests are co-located as `*.test.mjs`.
- Real-AWS round-trip tests are gated on `S3CAB_TEST_BUCKET` and skipped (with a message)
  when unset — so a low coverage number on `s3.mjs` / `remote.mjs` / `restore.mjs` in an
  offline run is **expected**, not a missing test.
- Mock at the `s3.mjs` seam, **never** the AWS SDK directly (see `docs/specs/testing.md`).
