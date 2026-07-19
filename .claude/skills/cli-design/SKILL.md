---
name: cli-design
description: >-
  s3cab's distilled clig.dev "bible" for CLI surface design. Use BEFORE making
  any command-shape decision — adding or renaming a command, flags vs positional
  args, flag naming/short-forms, output format and the stdout/stderr split, exit
  codes, prompts or destructive-action confirmation, help-text structure, or
  error UX. The trigger is anything that touches the user-facing command surface
  or would warrant an ADR in the ADR-0035/0036 lineage — not internal refactors,
  lib code, or tests. Consult it when designing AND when reviewing such a change.
---

# CLI design — s3cab's clig.dev bible (distilled)

This is the **distilled essence** of the [Command Line Interface
Guidelines](https://clig.dev) (clig.dev), the project's chosen authority for CLI
*shape* (CLAUDE.md names it the bible; the companion authority for error
*wording* is [ADR-0030](../../../docs/adr/0030-error-message-guidelines.md)).
s3cab is a **backup CLI for a casual but technical user** (someone who can stand up
an S3-compatible service, not a git-native developer) — largely non-interactive, run both
by hand and from scripts/cron — so the guidance below is filtered to that case
and anchored to the ADRs where s3cab has already decided something. Apply it; a
violation is a review finding (the `/review` Standards axis + Copilot).

> **Deep dive when the distilled rule isn't enough.** The full source is one big
> markdown file:
> `https://raw.githubusercontent.com/cli-guidelines/cli-guidelines/main/content/_index.md`.
> **Don't pull the whole file into context** (that's the wasteful re-read this
> skill exists to avoid) — WebFetch it with a *specific* question (e.g. "what does
> clig say about exit-code conventions?") so only the relevant slice comes back.

## First principles

- **Human-first.** Design for a person at a terminal first, even when the tool is
  also scriptable. Composability with pipes/scripts comes *through* standard
  mechanisms (stdin/stdout/stderr, exit codes, plain text/JSON), not instead of
  the human.
- **Consistency.** Follow established CLI conventions so users can guess how s3cab
  works from other tools; break a convention only with a clear, deliberate reason.
- **Say enough, not too much.** Too little output reads as "broken"; too much
  drowns the signal. Aim for the middle.
- **Conversational & empathetic.** Use is trial-and-error: suggest corrections,
  make current state legible, confirm dangerous actions, don't dump stack traces.

## Arguments & flags

- **Prefer flags to positional args** — named parameters are clearer and leave
  room to grow. Reserve positionals for the one obvious primary input.
- **Multiple positionals of the *same* kind are fine** for bulk actions and
  globbing (`rm a b c`; s3cab `setup --set <set> <directory>...`). **Avoid
  multiple positionals of *different* kinds** unless it's a memorable primary
  action (`cp src dest`). s3cab resolves the two together in
  [ADR-0062](../../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md):
  a command with a **bulk operand** puts that operand in the positionals and
  moves its addressing to a flag (`--set`); a command with only addressing keeps
  it positional (`s3cab backup [<set>]`).
- **Offer long and short forms;** restrict single-letter flags to common options
  (especially at top level) to keep the namespace clean.
- **Use the conventional flag names** so they behave as users expect:
  `-h/--help`, `--version`, `-v/--verbose`, `-q/--quiet`, `-f/--force`,
  `-n/--dry-run`, `-o/--output`, `-a/--all`, `-d/--debug`, `--json`, `--plain`,
  `--no-input`, `-u/--user`, `-p/--port`. Don't repurpose these for other meanings.
- **Right defaults beat required flags** — if a user must remember a flag to get
  the behaviour they'd expect, the default is wrong.
- **Never take secrets via flags** (they leak in `ps` and shell history) — use a
  file or stdin. s3cab takes credentials via the standard AWS chain / env files
  (→ [ADR-0015](../../../docs/adr/0015-standard-aws-credential-chain.md)), not flags.
- **`-` means stdin/stdout;** keep flags and args order-independent where you can.

## Output (stdout vs stderr, verbosity)

- **stdout = the data** (the primary result, including any `--json`/`--plain`),
  so pipes work. **stderr = everything else** — logs, warnings, errors, status,
  progress. (→ [ADR-0010](../../../docs/adr/0010-cli-output-conventions.md).)
- **Print something on success** so it's clear the command didn't hang — but keep
  it brief. **Explain state changes** ("backed up N files") so the user can model
  what happened, and for remote/file effects make the boundary visible.
- **Show state and suggest the next step** — a `status`-style command with hints
  on what to run next aids discovery.
- **Gate decoration on a TTY:** disable colour/animation/spinners/pagers when
  stdout isn't a terminal (keeps CI and piped logs clean), and honour `NO_COLOR`,
  `TERM=dumb`, `--no-color`.
- **Suppress developer noise by default** — no stack traces, no `ERR`/`WARN`
  labels — surface those only under `-v/--verbose` or `S3CAB_DEBUG`.
- **Offer machine-readable output** (`--json`, and/or `--plain` as one-record-
  per-line) for scripting; that, not the human output, is the stable contract.

## Errors & exit codes

- **Rewrite expected errors for humans** — what failed, framed by the user's goal,
  and the exact fix. This is governed in full by
  [ADR-0030](../../../docs/adr/0030-error-message-guidelines.md) (the wording bible).
- **Keep the signal-to-noise ratio high** — group many similar failures under one
  header rather than printing a line each; put the actionable bit last, where the
  eye rests.
- **Exit `0` on success, non-zero on failure** — map non-zero codes to the
  meaningful failure modes so scripts can branch.
- **Unexpected (programmer) errors** may show a traceback + a pre-filled
  bug-report path; these are *out of scope* for the human-rewrite rule (they
  signal bugs, not user guidance).

## Interactivity & destructive actions

s3cab is mostly non-interactive — but the verify/delete/cleanup surface makes
these rules live:

- **Only prompt when stdin is a TTY,** and **never *require* a prompt** — always
  allow the answer via flag/arg so scripts work. Honour `--no-input` by failing
  with instructions instead of blocking.
- **Confirm before destructive/irreversible actions:** a `y/N` prompt, or require
  `-f/--force` for non-interactive use; for severe/irreversible cases ask the user
  to type a non-trivial string (e.g. the set or bucket name).
- **Never echo a typed password.**

## Subcommands

- **Be consistent across subcommands** — same flag names, output style, and
  behaviour everywhere.
- **Pick one ordering and keep it** — noun-verb (`docker container create`) or
  verb-noun; don't mix. (s3cab's surface is set by
  [ADR-0035](../../../docs/adr/0035-aws-profile-sets-command-rationalization.md) /
  [ADR-0036](../../../docs/adr/0036-setup-mutates-list-shows-drop-sets.md) — match it.)
- **Avoid easily-confused names** (e.g. `update` vs `upgrade`); disambiguate or
  rename.
- **No catch-all implicit subcommand** (don't let `s3cab foo` silently mean
  `s3cab run foo`) and **no arbitrary prefix-abbreviation** — both foreclose adding
  commands later. Explicit aliases only.

## Help & documentation

- **`-h`/`--help` works everywhere** — top level and every subcommand — and an
  `-h` appended anywhere shows help regardless of other args. Support `s3cab help
  <topic>` too.
- **Concise by default, examples-first** — with no args, show a short description,
  one or two examples, and "pass `--help`"; lead help with the common cases.
- **Link to the fuller web guide** from help. s3cab's split: terminal help carries
  what a user needs *mid-task*; the website/`guide/` carries everything else (the
  placement doctrine in CLAUDE.md). Freeze only stable doc URLs in a shipped binary.

## Configuration & environment

- **Precedence: flags → env vars → project config → user config → system.** Flags
  are per-invocation; env vars are session/context; committed project files are
  stable per-project settings.
- **Read `.env` for project overrides** (s3cab layers a user env then a per-set env
  → [ADR-0022](../../../docs/adr/0022-prepare-remote-set-front-door.md)), but don't
  use `.env` as a substitute for real config.
- **Never store secrets in env vars** (they leak via exports, Docker/systemd
  introspection, logs) — files/pipes/secret managers only.
- **Respect general env vars** (`NO_COLOR`, `DEBUG`, `PAGER`, `EDITOR`,
  `HTTP(S)_PROXY`/`NO_PROXY`, `TERM`, `HOME`, `TMPDIR`, `COLUMNS`…) and **don't
  commandeer POSIX-standard names.** Follow XDG for user config paths.

## Robustness & future-proofing

- **Validate input early and fail fast** with a clear message before anything
  half-happens.
- **Be responsive:** print within ~100ms; if a network call is coming, print
  *before* it so the tool doesn't look hung. Show progress for long operations;
  set sane network timeouts.
- **Make operations recoverable/resumable** — re-running after a transient failure
  should just work; prefer deferring cleanup to the next run over blocking exit.
- **Keep changes additive.** Add flags rather than changing existing behaviour;
  warn (don't break) when a form is deprecated, suggesting the new way. Iterating
  on *human* output is fine — `--json`/`--plain` are the script-facing contract.
  How bold to be is **version-gated** (pre-1.0 free rein vs post-1.0 care) — see
  CLAUDE.md convention #7.

## Naming

- **Name for consumers, not developers** (→
  [ADR-0012](../../../docs/adr/0012-consumer-vocabulary-naming.md)) — plain backup
  vocabulary over git/dev jargon, because plain language reads clearer for everyone (not
  because the user is non-technical). Consumer-honest where it costs nothing; keep a genuinely
  technical term (`verify`, `--remote`) rather than contort. Lowercase, short, easy to type.

---

## Source & license

This skill is a **distilled adaptation** of the **Command Line Interface
Guidelines** by Aanand Prasad, Ben Firshman, Carl Tashian, and Eva Parish —
website <https://clig.dev>, source
<https://github.com/cli-guidelines/cli-guidelines> — used under
**[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)**.

**Changes made:** condensed and reorganized, rewritten in our own words, filtered
to a non-interactive backup CLI, and cross-linked to s3cab's ADRs. As an
adaptation of CC BY-SA 4.0 material, **this file is itself licensed under CC BY-SA
4.0** (the ShareAlike term) — separately from the repository's GPL-3.0-or-later
*code* ([ADR-0008](../../../docs/adr/0008-gpl-3-license.md)); it is contributor
tooling and is not shipped in the npm package or the binary. For anything past
this distillation, go to the source (see the deep-dive note at the top).
