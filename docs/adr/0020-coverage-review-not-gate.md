# Test coverage is judged by review, not a CI percentage gate

Good, *asserting* tests for new or changed behaviour are a per-PR obligation, checked by
**reading the diff** (the `/review` skill's Standards axis, and Copilot review via
[.github/copilot-instructions.md](../../.github/copilot-instructions.md)) — not by a CI
threshold. CI still **emits** the coverage number (the `lint` job's `test:coverage:report`
step) as advisory output; it never fails the build on coverage.

_(Demoted from a hard gate 2026-06-16.)_

## Why

A percentage measures *execution, not verification* — it rewards assertion-free "coverage
theatre" — whereas a reviewer reading the diff catches the quality the number is blind to. The
floor's one real job, catching *silent* erosion, is subsumed by review now that every PR is
reviewed.

## Consequences

- When you add or change behaviour, add a test that asserts the **result**, not one that merely
  executes the line.
- **Footnote**: the prior threshold gate was a silent no-op — `node --test` only collects
  coverage when `--experimental-test-coverage` precedes the glob positionals, but the
  `npm run test -- …` pattern appended it *after*, so it collected zero and exited 0. Both
  scripts were rebuilt standalone (flags first). **Don't reintroduce the
  `npm run test -- --experimental-test-coverage` shape** — it measures nothing.
