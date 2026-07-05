# Human-first output; `--json` for machines; a central render layer

**Status:** accepted (settled 2026-07-04 in a grilling session); implemented 2026-07-05.
**Inverts the stdout default of [0010](0010-cli-output-conventions.md)** — the
`JSON.stringify`-everything default there is superseded by this ADR; that serializer now
lives behind `--json`. The build was sliced through `proposals/human-first-output.md`
(the `CompareResult` shape, `verify`'s layout, the slice plan, per-command output), now
deleted as done — the render layer lives in [src/render.mjs](../../src/render.mjs) and
`--json` is documented in [guide/output.md](../../guide/output.md). This ADR records only
the decision and its *why*.

## Context

Today the dispatcher JSON-serializes *every* command result to stdout ([0010](0010-cli-output-conventions.md)).
That was the simplest thing that never truncates — one uniform serializer, no per-command
printer — but it is backwards for a tool aimed at ordinary people. The README quick start
already *shows* the intended UX (`Added:` / `Moved:` sections); the code doesn't match it.

Two project pillars pull against each other here: **simplicity** (of code *and* of use), and
clig.dev's core rule that **human-readable output is paramount — humans first, machines
second**. The JSON-everything default served *code* simplicity; as commands multiplied it
strained *use*, and adopting clig.dev tipped the balance. Pre-1.0, with no scripting consumers
yet, there is no frozen JSON contract to protect — so the inversion is free to be bold.

## Decision

1. **Human-readable text is the stdout default; `--json` emits today's `JSON.stringify(result)`.**
   The flag is **explicit-only** — no TTY/pipe auto-switch. Format stays predictable
   everywhere (`s3cab compare > changes.txt` yields readable text, not JSON), and a user who
   wants machine output asks for it. `--json` is **not** a stability contract yet (pre-1.0;
   documented as "shape may change"), which is what frees the `CompareResult` refactor below
   to happen without a back-compat story.

2. **Command functions stay pure data-returners; nothing prints inside a command.** Each
   `src/commands/` function computes and `return`s a structure (or a finished array) — the
   render/`--json` decision is not its concern. This honours the porcelain/plumbing layering
   ([0023](0023-porcelain-plumbing-lib-layers.md)) and the one-export-per-command rule, and it
   is a *discipline*, not a step toward shipping s3cab as a library (that stays speculative,
   [0006](0006-minimal-code.md)). `list` and `hashes`, which today self-print and return
   `undefined`, are brought into line — they return data too.

3. **One render layer, routed through the one registry.** `commands.mjs` gains a `render`
   reference per command; the renderer *bodies* live in a central `src/render.mjs` composing
   the primitives in `src/lib/format.mjs`. A renderer **returns a string**; the dispatcher owns
   the stream, the colour gate (`styleEnabled`, [style.mjs]), and the `--json` toggle (which it
   **strips before `exec`**). `render` is a **required** field for every built command
   (typecheck-enforced) — there is **no generic fallback**, because a generic object-dumper is
   just the JSON we are leaving. Routing by registry reference (not a result type-tag, not a
   parallel registry) keeps the machine output free of presentation fields and lets `snapshot`
   and `compare` share one `renderCompareResult` (they return the same type).

4. **Never-truncate carries over to human output.** [0010](0010-cli-output-conventions.md)'s
   reason for `JSON.stringify` over `console.log` (it never truncates) now applies to the
   human path too, with a concrete cost behind it: `verify`'s findings are computed from a full
   bucket LIST (network + time), so truncating output would discard results already paid for,
   forcing an expensive re-run. **The tool never truncates; the user manages volume with a
   pager or redirect.**

## Consequences

- The dispatcher's stdout step becomes `json ? JSON.stringify(result) : command.render(result)`.
  Error handling is unchanged: errors stay **human-readable on stderr regardless of `--json`**
  (structured error objects are deferred until a consumer needs them — [0006](0006-minimal-code.md)).
- `compareSnapshots` returns **structured data with absolute paths** — `{ setName, dirs,
  since, until, added, moved, modified, deleted, errors }`, categories carrying `{ path, size,
  … }` — instead of preformatted `→`/`→→`/`==` strings. This is the seam
  `proposals/architecture-improvements.md` flagged ("`compareSnapshots` returns structured
  diff"). The relative-path shortening moves *into* the renderer (a common-ancestor-of-`dirs`
  base), because path shortening is presentation; the domain data is the absolute path snapshots
  already store. Colours (green/cyan/yellow/red) land in `style.mjs`.
- Migration ran through a **temporary** optional-`render` + JSON fallback that the final
  slice deleted (flipping `render` to required, `tsc`-enforced). `verify`'s output became
  file-centric (list the affected files, hash hidden), built on the corrected `verify` finding
  model (`proposals/engine-robustness.md`) that landed first.
- The two follow-on docs are done: [guide/output.md](../../guide/output.md) documents `--json`,
  and this ADR's `Status` is now `accepted … implemented`.
