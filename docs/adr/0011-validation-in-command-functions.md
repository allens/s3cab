# Argument validation and env-loading live in the command functions, not the dispatcher

A command that needs a positional checks it itself (`requireArg()` → `ParseArgsError`), and
loads its env scope itself (`loadEnv` right after validating args) — neither is done by the
dispatcher.

## Why

The per-command functions are the **library surface**. A direct caller of `hashes(bucket)`
must get the same guard — and resolve env the same way — a CLI user does; doing either in the
dispatcher would protect only the CLI path. This also keeps `s3.mjs` a pure SDK boundary that
only reads `process.env`.

## Considered options

- **A registry-driven scheme** (the dispatcher inferring required-ness from the `args` keys) —
  **rejected**: it protects only the CLI path, and deriving required-ness by parsing
  `<name>`/`[<name>]` display strings is stringly-typed and couples help formatting to
  validation. The `args` keys are therefore honest about optionality and nothing more
  (`[brackets]` = optional, bare `<name>` = required); `usage()` prints them verbatim, never
  parses them.
