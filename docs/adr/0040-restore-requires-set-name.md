# `restore` requires the set name — no sole-set default

**Status:** accepted (settled 2026-07-03, in a clig.dev conformance review) —
**implemented** (2026-07-03). Sits in the command-shape lineage of
[0035](0035-aws-profile-sets-command-rationalization.md)/[0036](0036-setup-mutates-list-shows-drop-sets.md),
reasoned under clig.dev (the `cli-design` skill).

## Context

The everyday commands (`snapshot`, `backup`, `list`, `compare`, `status`, `tree`) take an
optional `[<set>]` with a sole-set default: the common one-set user just types
`s3cab backup`. `restore` had the same shape — `[<set>] [<path>...]` — which created a
positional ambiguity: the first positional is always parsed as the set name, so the default
only applied with *no* positionals, and `s3cab restore C:\...\beach.jpg` silently parsed the
path as a set name. Filtering therefore already required naming the set; only the bare
whole-set restore could omit it.

## Decision

`restore`'s `<set>` becomes **required**. The sole-set default stays for the everyday
commands (that decision stands — make it easy for the one-set user), but `restore` is the
rarer, more carefully considered command: typing the set name is no burden in that moment,
and requiring it removes the set-or-path ambiguity outright rather than documenting around
it. It also composes cleanly with the proposed stdin path-list mode
(`s3cab restore <set> -`, [proposals/misc.md](../../proposals/misc.md)), which needs the set
named anyway.

## Consequences

- [src/commands.mjs](../../src/commands.mjs): `restore`'s `set` arg gains `required: true`;
  the "name the set first when filtering" caveat disappears from the `path` description.
- [src/commands/restore.mjs](../../src/commands/restore.mjs): `requireArg(setName, "set")`
  before any work (validation in commands, [0011](0011-validation-in-command-functions.md));
  a bare `s3cab restore` now gets the standard missing-arg usage error
  ([0038](0038-usage-error-synopsis-not-full-help.md)) instead of restoring everything.
- README's command table shows `restore <set> [paths…]`.
- A future `verify`/`delete` shape should weigh the same question when built.
