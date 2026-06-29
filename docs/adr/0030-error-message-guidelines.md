# Error messages follow Nielsen's usability heuristic #9

**Status:** accepted

s3cab writes every user-facing error or failure message to **Nielsen's usability heuristic
#9**, quoted here in full as our standard:

> **Help users recognize, diagnose, and recover from errors.** Error messages should be
> expressed in plain language (no error codes), precisely indicate the problem, and
> constructively suggest a solution.

— Jakob Nielsen, *[10 Usability Heuristics for User Interface
Design](https://www.nngroup.com/articles/ten-usability-heuristics/)* (Nielsen Norman Group).

This applies to the message text of every `throw new Error(...)` / `throw new
ParseArgsError(...)` and every user-facing `console.warn`/`console.error` — not internal
invariants that "can't happen" or programmer errors (a bad `s3://` URI shape, a failed type
assumption), which are bug signals, not user guidance.

## Why

Transparency is a core project value ([0002](0002-no-lock-in-hard-constraint.md)): a backup
tool earns trust partly by failing *legibly*. A message that names an internal artifact and
stops ("`has no bucket bound (missing S3CAB_BUCKET in …/env)`") tells a user *what tripped*
but not *what they were trying to do that failed* or *how to get unstuck*. Holding every
message to one published principle turns taste into a checklist anyone can apply in review,
so message quality stops being re-argued per PR.

## Applying it in s3cab

The heuristic's three parts, in CLI terms:

1. **Plain language (no error codes)** — a human-readable headline, no codes or jargon.
   Internal identifiers (env-var names, file paths, S3 keys) are *diagnostic detail*, not the
   lead — put them in a parenthetical or a follow-up line, never the first thing the user
   reads. Describe, don't blame ("You need to delete…" → "Remove…").
2. **Precisely indicate the problem** — frame it by the user's **goal**, not an internal
   field. "has no bucket to back up to" beats "is missing its bucket": the first says what the
   user can't do, the second names a struct property.
3. **Constructively suggest a solution** — say how to fix it, concretely. When the fix is a
   command, give the exact one, copy-pasteable, with the values you know filled in (e.g. the
   set name) and clear placeholders like `<bucket>` only where the value genuinely isn't
   available.

### House shape

Mirror the existing well-formed messages (e.g. `collisionError` in
[`src/commands/setup.mjs`](../../src/commands/setup.mjs)): a plain-language statement line,
then the fix introduced by `To <do X>:` (or inline for a one-liner), then the command on its
own indented (`  `) line so it stands out and copies cleanly. Keep the precise diagnostic
(the path, the var) in the statement's parenthetical. Worked example, the bucket-less set:

```
Backup set 'photos' has no bucket to back up to (no S3CAB_BUCKET in …/env).
To fix it, add 'S3CAB_BUCKET=<bucket>' to that file — or remove the set folder and create it again:
  s3cab setup photos <folder>... --bucket <bucket>
```

The headline is the user's goal ("no bucket to back up to"); the env-var name is detail in
the parenthetical; the two fixes are explicit and the command is exact.

## Consequences

- The `/review` Standards axis and Copilot review ([.github/copilot-instructions.md](../../.github/copilot-instructions.md))
  check new/changed user-facing messages against the heuristic, the same way they check
  test coverage ([0020](0020-coverage-review-not-gate.md)) — by reading the diff, not a linter.
  A jargon-first headline or a dead-end message (no fix) is a review finding.
- No machinery is added to enforce this ([0006](0006-minimal-code.md)): it is a writing
  standard, checked by humans, recorded here so it is applied uniformly and not re-derived.
- This is *content* quality; it sits beside [0010](0010-cli-output-conventions.md), which
  governs the *channel* (stdout vs stderr) and serialization. A message obeys both: 0010 says
  an error's text goes to stderr; this ADR says what that text should say.
- Internal/invariant errors are out of scope — they signal bugs, and dressing them up as
  user guidance would mislead. Keep them terse and factual.
