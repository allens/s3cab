# Minimal, simple code — minimize total complexity

Code should be as small and low-surface-area as possible — easy for a newcomer to pick up.
This is in honest tension with [0005](0005-builtins-over-dependencies.md), since avoiding a
library can mean writing bespoke code. The resolution: **minimize total complexity = bespoke
code + dependency weight.**

_(Foundational design principle #6. Where [0002](0002-no-lock-in-hard-constraint.md) protects
the format, this protects the tool.)_

## The extraction & promotion bar — reuse, not tidiness

- **Extract a function** only when the code is actually reused. Inline, locally-obvious code
  beats a one-call helper. (Worked example: `isENOENT` in `src/lib/error.mjs` was added once
  the check had four call sites, and shaped as the specific predicate, not a generic
  `isErrnoCode(error, code)` — no second code needed it.)
- **Promote to a shared module** (`src/lib/`) only once used by **more than one** command
  module. The deliberate exception: `s3.mjs` was promoted ahead of its second caller, because
  keeping the heavyweight AWS SDK behind a single lazy boundary matters more (its unused ops
  tree-shake out of the SEA bundle until imported).

## Don't over-engineer (and when to be bold)

Build the small thing the current need justifies; generalize only when the second case
appears. This forbids **speculative** structure, not **justified** refactoring — when
restructuring genuinely improves clarity or testability, do it, even a sizable refactor.
(Worked example: `clientConfig()`/`putObjectParams()` extracted from `s3.mjs` so non-AWS
request-shaping became unit-testable — see [src/lib/s3.test.mjs](../../src/lib/s3.test.mjs).)

**Version gates boldness.** While pre-1.0 (`package.json` major `0`) you have free rein for
large, correct refactors — favour getting the design right over minimizing churn or
preserving back-compat. Once 1.0 ships this reverses: breaking changes and sweeping refactors
then need real care and a migration story. Check the major version first: `0` → bold;
`≥ 1` → conservative.
