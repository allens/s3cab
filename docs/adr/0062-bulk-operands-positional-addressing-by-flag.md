# Bulk operands are positional; a command's addressing moves to `--set`

**Status:** accepted (design settled 2026-07-19 in a grilling session) — **not yet
implemented.** Answers the question [0040](0040-restore-requires-set-name.md) deferred
("a future `verify`/`delete` shape should weigh the same question when built"). Reasoned
under the **Command Line Interface Guidelines** ([clig.dev](https://clig.dev), the
`cli-design` skill).

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
