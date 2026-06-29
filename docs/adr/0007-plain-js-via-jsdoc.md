# Plain JavaScript, typed via JSDoc

**Status:** proposed

Source is plain JS; full type-checking comes from **JSDoc annotations + `jsconfig.json`**,
enforced in the editor and runnable as a whole-project check (the `typecheck` script). No
build/transpile step for source — the code you read is the code that runs.

_(Foundational design principle #7.)_

## Why

In the spirit of open & simple ([0002](0002-no-lock-in-hard-constraint.md),
[0006](0006-minimal-code.md)): no toolchain stands between the source and execution. Cross-module
types use the JSDoc `@import` tag (TS 5.5+ style), not inline `import("…").Type`.

## Status: flagged for reconsideration

The original draw of pure JS was avoiding a toolchain. Node now runs TypeScript natively and
non-experimentally, so that argument is much weaker — parallel to the Temporal polyfill,
which modern Node made obsolete. **JS for now, but this is an open question** to revisit; see
the "Known gaps" list in [CLAUDE.md](../../CLAUDE.md).
