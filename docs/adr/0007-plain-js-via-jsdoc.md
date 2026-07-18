# Plain JavaScript, typed via JSDoc

**Status:** accepted

Source is plain JS; full type-checking comes from **JSDoc annotations + `jsconfig.json`**,
enforced in the editor and runnable as a whole-project check (the `typecheck` script). No
build/transpile step for source — the code you read is the code that runs.

_(Foundational design principle #7.)_

## Why

In the spirit of open & simple ([0002](0002-no-lock-in-hard-constraint.md),
[0006](0006-minimal-code.md)): no toolchain stands between the source and execution. Cross-module
types use the JSDoc `@import` tag (TS 5.5+ style), not inline `import("…").Type`.

## Not TypeScript — settled

This ADR *is* the record that we chose JSDoc over TypeScript. It was carried for a while as
"flagged for reconsideration" on the grounds that Node now runs TypeScript natively, which
weakens the original avoid-a-toolchain argument. **That reconsideration is closed
(2026-07-18) — JSDoc is working really well.** Two reasons it holds:

1. **No build step is the point, not merely a convenience.** The value isn't "we dodged a
   toolchain" — it's that *the code you read is the code that runs*. The file on disk is
   valid JavaScript the runtime executes as-is: no erasure pass between source and execution,
   stack traces need no source map to make sense, and any JS tool reads the tree without
   configuration. Node's native TypeScript narrows that gap but doesn't close it — type
   stripping is still a transform in front of execution.
2. **JSDoc's types are sufficient in practice.** `jsconfig.json` + the whole-project
   `typecheck` script catch what matters, and nothing in this codebase has been meaningfully
   hard to express — including the cross-module and third-party types the `@import` tag
   carries (see CLAUDE.md's coding conventions).

Should this ever change, it changes *here*. No standing "open question" is tracked anywhere
else.
