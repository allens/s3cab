# Argument validation lives in the command functions, not the dispatcher

**Status:** accepted

A command that needs a positional checks it itself (`requireArg()` → `ParseArgsError`) — not
the dispatcher.

(Env-loading was *later* split out of this ADR's scope by
[0022](0022-prepare-remote-set-front-door.md): the **user** layer is applied once at the entry
point before dispatch, and a set-accepting command loads its **set** layer itself via `loadSet`.
So the per-set env load is still at the command layer, but the up-front user load is the one env
step the dispatcher owns — this ADR governs *parameter validation*, which stays in the commands.)

## Why

The per-command functions are the **library surface**. A direct caller of `hashes(bucket)` must
get the same argument guard a CLI user does; validating in the dispatcher would protect only the
CLI path. (Env is handled per 0022 — the user layer is loaded once before any command runs, so a
direct caller makes that one call too.) `s3.mjs` stays a pure SDK boundary that only reads
`process.env`.

## Considered options

- **A registry-driven scheme** (the dispatcher inferring required-ness from the `args` keys) —
  **rejected**: it protects only the CLI path, and deriving required-ness by parsing
  `<name>`/`[<name>]` display strings is stringly-typed and couples help formatting to
  validation. The `args` keys are therefore honest about optionality and nothing more
  (`[brackets]` = optional, bare `<name>` = required); `usage()` prints them verbatim, never
  parses them.
