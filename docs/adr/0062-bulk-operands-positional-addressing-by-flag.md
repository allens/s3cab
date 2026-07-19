# Bulk operands are positional; a command's addressing moves to `--set`

**Status:** accepted (design settled 2026-07-19 in a grilling session) — **implemented**
(see *Delivery* below). Answers the question [0040](0040-restore-requires-set-name.md) deferred
("a future `verify`/`delete` shape should weigh the same question when built"). Reasoned
under the **Command Line Interface Guidelines** ([clig.dev](https://clig.dev), the
`cli-design` skill).

> **The command this ADR calls `delete` is now `forget`**
> ([0063](0063-forget-snapshots-delete-paths.md) freed `delete` for path-scoped content
> removal). The shape decided here is unchanged and applies to `forget`; the old name is
> kept below as the record of what was decided when.

## Context

`delete` is gaining the ability to name **several snapshots in one run** (see
[docs/design/snapshot-deletion.md](../design/snapshot-deletion.md) — the orphan check it
performs is expensive, so doing the housekeeping in one pass is what makes it affordable).
That forces a shape question: where does the *set name* go once snapshots are the repeated
operand?

A survey of the registry found the CLI is more consistent than it looks. **Exactly two
commands take multiple or variadic positionals**, and they are the same two that mix
positional *kinds*:

```
setup     <set> [directory]...
restore   <set> [path]...
```

The other fourteen commands take exactly one positional — a `[set]`, a `<bucket>` or a
`<file>` — where there is nothing to be ambiguous with. So the tension is not CLI-wide; it is
confined to commands that have a **bulk operand**, and `delete` is about to become the third.

The skill's guidance points the same way: *prefer flags to positional args*; *multiple
positionals of the same kind are fine for bulk actions*; *avoid multiple positionals of
different kinds*.

## Decision

**A command with a bulk operand puts that operand in the positionals and moves its
addressing to flags. A command with only addressing keeps it positional.**

That rule reaches exactly three commands, and explains every mixed-kind case in the CLI with
nothing left over:

| Command | Before | After |
| --- | --- | --- |
| `delete` | `<set> --snapshot <name>` | `--set <set> <snapshot>...` |
| `restore` | `<set> [path]...` | `--set <set> <path>...` |
| `setup` | `<set> [directory]...` | `--set <set> <directory>...` |

The remaining fourteen commands are unchanged. In particular the **sole-set default stays**
for the everyday commands (`snapshot`, `backup`, `list`, …): with one positional there is
nothing to disambiguate, and forcing `--set` there would cost the one-set user keystrokes to
solve a problem those commands do not have — the opposite of clig's *right defaults beat
required flags*.

**Short forms: `-S` is `--set`; `-s` stays `--snapshot`.** `-s` means `--snapshot` today in
`restore`, `delete` and `upload`. After this change `delete` has no `--snapshot` at all (its
snapshots are positional) and `setup` never had one, so **`restore` is the only command where
both flags coexist**. `-s` keeps its established meaning there and in `upload`; `--set` takes
`-S`.

## Why not the alternatives

- **Keep the set positional and repeat the flag** (`delete photos --snapshot A --snapshot B`).
  Also avoids mixed positionals, and was the front-runner for a while. Rejected on
  ergonomics: this feature exists for bulk housekeeping, and the repetition compounds exactly
  when you are doing the thing it is for.
- **Mixed positionals** (`delete photos A B C`). Rejected — it is the shape
  [0040](0040-restore-requires-set-name.md) was cleaning up, and re-introducing it in a new
  command while `restore` moves away from it would be incoherent.
- **Apply the rule universally** (every command takes `--set`/`--bucket`). Rejected: see the
  sole-set default above.
- **No short form for `--set`.** Argued for a while on the grounds that a case-only pair
  (`-s`/`-S`) is the pattern users reliably complain about (`curl -o`/`-O`). Weighed and
  rejected: the only command carrying both is `restore`, where a slip yields a *confusing
  error*, not a wrong action (`-S <timestamp>` → "set not found"), so the risk is low rather
  than dangerous. No non-initial letter was a defensible alternative — `-e` collides with the
  conventional "exclude/expression", `-n` is the conventional `--dry-run`, and the rest have
  no mnemonic at all, which is worse than none.

## Consequences

- **Breaking changes to `restore` and `setup`**, neither of which is *broken* today —
  [0040](0040-restore-requires-set-name.md) already removed the real ambiguity by making
  `<set>` required. This buys consistency, not correctness. Taken now because `package.json`
  is pre-1.0 (`0.1.0-alpha.1`), where CLAUDE.md convention #5 gives explicit free rein to get
  the design right over minimizing churn.
- `setup`'s `directory` is enforced as required inside the command
  ([0011](0011-validation-in-command-functions.md)), so the registry renders `[directory]...`
  while its doc comment writes `<directory>...`. Align them while changing the signature.
- README's command table, the `guide/` prose and every example string in the registry change
  shape.
- The missing-argument error for a required `--set` should name `-S, --set`; today usage
  errors show the long form only. That is a separate, unrecorded gap — see
  [proposals/output-ux.md](../../proposals/output-ux.md).

## Delivery

**One ADR, not two.** Splitting this so `restore`/`setup` moved separately from `delete` was
weighed and rejected: the decision's whole content is the *rule*, and the rule is what
explains all three commands. Two ADRs would either duplicate it or leave one of them stating
a shape with no reason behind it. What *is* separable is delivery, and it is separated here:

- **All three commands moved their addressing to `--set` in one change**, and `delete`'s
  snapshots are genuinely variadic from the start: it validates every name, prompts once for
  the whole run, then deletes them in order.
- **What `delete` still owes** is [snapshot-deletion.md](../design/snapshot-deletion.md)'s
  *analysis*, not its shape: the whole-bucket orphan check, the report file, `-o` and
  `--force`. That design's confirmation model (one prompt, non-interactive proceeds) is
  already what ships.
- The distinction that matters: **operand count is this ADR's decision** and lands here; the
  expensive check built *on top of* several operands is a feature, and lands with the design.
  Whole-selection validation before any deletion is not optional either way — a bad third name
  must never leave the first two already gone.

## `-o` means a file on `delete` and a directory on `restore` — accepted

`restore -o` names a directory to re-root under; the designed `delete -o` names the file the
orphan report is written to. **Keep both as `-o`/`--output`.** `-o` is among the most
entrenched conventions in the ecosystem and its operand *type* is command-determined
everywhere it appears (`curl -o file`, `gcc -o file`); no invocation ever carries both
meanings at once, so the ambiguity is never in front of a user — the worst case is a
wrong-type path rejected immediately. Renaming `restore -o` breaks a shipped, documented flag
to buy nothing, and giving `delete` a `--report` instead costs it the flag people try first.

The genuinely arguable point is not the asymmetry but whether `delete`'s file is *output* at
all: the command's output is the summary on stdout, and the file is a side artifact `-o`
relocates rather than redirects. That was weighed and judged not worth a bespoke flag name —
but it is the argument to revisit if the report ever grows into something other than "the
long form of what you just read".

### Amendment: that condition was met — `delete` has no `-o`

**Superseded when the orphan check was built** ([snapshot-deletion.md](../design/snapshot-deletion.md)).
The report did grow into something else: **two artifacts with different lifecycles** — a
transient preview at `~/.s3cab/delete-orphans-preview.txt`, and a kept audit record at
`~/.s3cab/sets/<set>/delete-orphans-<timestamp>.txt`.

That dissolves the flag's justification rather than merely weakening it. `-o` existed because
two concurrent deletes would clobber the single file; the audit trail solves that properly,
since the record of each deletion is preserved and only the transient preview is overwritten
— and nothing of value is lost when it is. A flag that relocates a file which is rewritten
every run and read within seconds is a surface with no use behind it, so it goes
([ADR-0006](0006-minimal-code.md)).

**`delete` therefore takes `--set`/`-S` and `--force`/`-f`, and no `--output`.** The
file-vs-directory asymmetry this section defends is retired with it: `-o` now means a
directory on `restore` and nothing anywhere else. The reasoning above is kept rather than
deleted because it remains the right answer *if* a future command wants a `-o` naming a file
— the conclusion held; its premise expired.
