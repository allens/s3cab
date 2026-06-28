# `setup` mutates a set, `list` shows sets; drop the `sets` command

Status: **accepted** (design decided via a design session 2026-06-28; not yet implemented — see
[proposals/cli-command-rationalization.md](../../proposals/cli-command-rationalization.md) for
the implementation checklist). **Supersedes [0035](0035-aws-profile-sets-command-rationalization.md)
point 3** (the `setup`-folds-into-`sets` half); 0035's points 1–2 (`bucket`→`aws`, old-`aws`→`profile`)
stand untouched.

## Context

[0035](0035-aws-profile-sets-command-rationalization.md) point 3 folded the former `setup`
command's create/update/inherit behaviour **into** `sets`, making `sets` the single command for
the whole backup-set lifecycle (no-arg listing + create/update/inherit). That removed the
`setup`/`sets` near-synonym, but working the shape further surfaced that the merged `sets` is a
**four-mode multiplexer** — `list` (no name), `create` / `update` (name, dispatched by invisible
local state), and `inherit` (`--inherit`) — all under one noun. The mode you get is inferred from
which args/flags are present, which the 0035 session itself already flagged as a "real shape smell"
and deferred.

The cleanest seam through that multiplexer is **read vs write**: listing is a read; create/update/
inherit are writes. Splitting on that seam lets each survivor be named for what it is — a *verb*
for the write action, the existing *verb* `list` for the read — and dissolves the multiplexer
rather than renaming it.

This is reasoned under the project's two UX references (see CLAUDE.md → coding conventions): the
**Command Line Interface Guidelines** ([clig.dev](https://clig.dev)) for command *shape*, and the
Nielsen Norman Group error-message guidelines ([0030](0030-error-message-guidelines.md)) for
message *wording*.

## Decision

1. **Drop the `sets` command.** Its two jobs split by the read/write seam: its *listing* folds
   into `list`; its *mutation* (create/update/inherit) moves to `setup`.

2. **`setup` is the set-mutation verb.** `setup <set> <folder>… --bucket <b>` upserts (creates the
   set the first time, updates it after — the same declarative upsert `sets` had, which is fine:
   non-destructive and idempotent, the model `kubectl apply` / `terraform` use deliberately);
   `setup <set> --inherit --bucket <b>` inherits (machine succession). The `setup` name that 0035
   retired comes back — the `setup`/`sets` synonym collision that justified retiring it is
   dissolved here by **removing `sets`**, not by keeping it. `setup` is a verb for a write action,
   which fits the "name a command for its salient word — the verb when there is a meaningful verb"
   convention better than the noun `sets` did.

3. **`list` shows every set, its config, and its snapshots; an optional `<set>` filters.**
   `s3cab list` lists all sets with their backup target and snapshots; `s3cab list <set>` narrows
   to one. This *generalizes* the sole-set default rather than fighting it: no-arg `list` still
   shows snapshots — now for every set instead of the only one — so a single-set user does not lose
   `s3cab list` → their snapshots. Full expansion is acceptable because sets and snapshots number in
   the dozens, not thousands ([0006](0006-minimal-code.md): don't add an overview/detail tier the
   volume doesn't justify). `--latest`/`--remote` compose over the grouped form.

4. **The AWS profile stays in `profile`, separate from `setup`.** A set's profile is its **auth
   pointer** ([0031](0031-aws-profile-config-door.md)), a different layer from its **backup
   definition** (folders, bucket). Keeping it out of `setup` is deliberate: `setup` needs working
   credentials to run (it claims/publishes to S3), so the profile is *logically prior* to it — the
   thing you set first and the thing you fix offline when `setup` can't even authenticate — and
   `profile`'s user-wide scope (no set named) can't be expressed on a per-set `setup`.

5. **The three config commands form an onboarding order:** `aws` (provision the cloud side) →
   `profile` (point at credentials) → `setup` (define a backup set) → `backup`. Seen this way
   `profile` is not a missing piece of `setup` but the step before it, which is what makes the
   layer split (point 4) read as deliberate rather than odd.

The net surface: `setup` (verb, writes a set) + `list` (verb, reads sets/snapshots); the `sets`
noun is gone, and the CRUD multiplexer with it. Verbs name actions, nouns name reads/resources.

## Rejected alternatives

- **Roll set-listing into `list` as set *names*** (the first cut of point 3). Rejected: redefining
  no-arg `list` to mean "list set names" collides with the **sole-set default** that
  `snapshot`/`backup`/`restore`/`compare`/`status`/`tree`/`list` all share — the single-set user
  (the common case) would lose `s3cab list` → snapshots and have to name their only set every time.
  Listing *all sets with their snapshots* (point 3) avoids this: no-arg `list` stays snapshot-bearing.

- **Keep a modeless, read-only `sets` lister** alongside `setup`. Rejected: `list` already covers
  it once it shows every set, so a second listing command is surface the need doesn't justify
  ([0006](0006-minimal-code.md)). It would also re-create a `setup`/`sets` pair, even if a crisp
  verb/noun, read/write one.

- **`setup --profile <p>` to set the per-set profile** (symmetry: "all set config in `setup`").
  Rejected — and 0035 already rejected the same fold for reasons that still hold: the profile-pointer
  is offline-always while `setup` touches S3, so folding makes network behaviour depend on a flag
  (invisible-mode complexity, clig.dev's "don't surprise the user"); and `profile`'s `<set>` is
  optional-meaningful (no set = user-wide default) while `setup`'s set is required, so `setup`
  cannot express the user-wide case. The asymmetry is principled (point 4), not a gap to close.

- **A subcommand layer** (`set create`, `set list`). Already rejected by
  [0035](0035-aws-profile-sets-command-rationalization.md) (the dispatch model has no subcommand
  concept; not worth introducing one for a naming/grouping fix). Unchanged here — the flat-verb
  split achieves the same de-multiplexing without it.

## Deferred, not decided here

- **`--inherit` stays a flag on `setup`** rather than its own `inherit` verb. Pulling it out would
  make `setup` a *pure* upsert (one job per command), at the cost of one more command — declined
  for now under [0006](0006-minimal-code.md); revisit only if the flag-mode grates in use.
- **Set-config detail in `list`.** A set's member folders are config, not snapshots; whether
  `list`'s per-set heading carries the folders (vs. just `set → bucket`, with folders left to a
  detail view) is a presentation call left to implementation.
- **Renaming the *concept* `set` → `plan`** (warmer consumer vocabulary) is orthogonal and parked
  — it changes a noun, not this command shape.

## Consequences

Pure rename/regroup of the management surface — no change to what create/update/inherit or listing
*do*. Implementation is deferred to a future session; the checklist is
[proposals/cli-command-rationalization.md](../../proposals/cli-command-rationalization.md)
(0035's renames already shipped in #122, so only this ADR's reshaping remains). It
touches: the command registry ([src/commands.mjs](../../src/commands.mjs)) — remove `sets`, add
`setup`, extend `list`; the command file ([src/commands/sets.mjs](../../src/commands/sets.mjs) →
`setup.mjs`, one-export-per-command [0023](0023-porcelain-plumbing-lib-layers.md) still holds);
help ([src/help.mjs](../../src/help.mjs)); [CONTEXT.md](../../CONTEXT.md) (the "Sets (the command)"
term splits into `setup` + `list`; the `Inherit` term's `s3cab sets … --inherit` example becomes
`s3cab setup … --inherit`); and the README/guide. Error-message examples that show `s3cab sets …`
(e.g. `collisionError`, the bucket-less-set message in [0030](0030-error-message-guidelines.md))
update to `s3cab setup …`.
