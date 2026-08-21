# `setup` mutates a set, `list` shows sets; drop the `sets` command

**Status:** accepted (design decided via a design session 2026-06-28) — **implemented**
(2026-06-28); **§2's upsert (the *update* half) partly superseded by
[0052](0052-retire-setup-update-mode.md)** — `setup` is create-or-inherit only now, a set's
directories are edited in `dirs.txt`; create/inherit and everything else here stand.
**Supersedes [0035](0035-aws-profile-sets-command-rationalization.md)
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
in-house error-message standard ([0030](0030-error-message-guidelines.md)) for
message *wording*.

## Decision

1. **Drop the `sets` command.** Its two jobs split by the read/write seam: its *listing* folds
   into `list`; its *mutation* (create/update/inherit) moves to `setup`.

2. **`setup` is the set-mutation verb.** `setup <set> <directory>… --bucket <b>` upserts (creates the
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
   definition** (directories, bucket). Keeping it out of `setup` is deliberate: `setup` needs working
   credentials to run (it claims/publishes to S3), so the profile is *logically prior* to it — the
   thing you set first and the thing you fix offline when `setup` can't even authenticate — and
   `profile`'s user-wide scope (no set named) can't be expressed on a per-set `setup`.

   > **Reversed by [0055](0055-per-set-credentials-one-mode.md)'s implementation (PR #183):**
   > once 0055 removed the user env layer, credentials became per-set — and a set's creds can't
   > be configured before the set exists, so "logically prior" stopped being expressible. `setup`
   > now accepts the full provider knob set (`--profile`/`--keys`/`--endpoint`/`--region`, later
   > `--roles-anywhere`), authenticates the first claim with them, and saves them to the set's
   > env on a win; `provider` remains the door for changing them later. Rationale in 0055.

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
  _(Resolved by [ADR-0053](0053-reattach-command.md): once [0052](0052-retire-setup-update-mode.md)
  removed update mode, `--inherit` was the last invisible-mode flag left, so it was split out as
  the standalone `reattach` command — `setup` is create-only.)_
- **Set-config detail in `list`.** A set's member directories are config, not snapshots; whether
  `list`'s per-set heading carries the directories (vs. just `set → bucket`, with directories left to a
  detail view) is a presentation call left to implementation.
- **Renaming the *concept* `set` → `plan`** (warmer consumer vocabulary) is orthogonal and parked
  — it changes a noun, not this command shape.

## Consequences

Pure rename/regroup of the management surface — no change to what create/update/inherit or listing
*do*. Implemented across one branch (0035's renames had already shipped in #122, so only this ADR's
reshaping remained). It touched: the command registry ([src/commands.mjs](../../src/commands.mjs)) —
dropped `sets`, added `setup`, extended `list`; the command file `src/commands/sets.mjs`, renamed to
[`setup.mjs`](../../src/commands/setup.mjs) (one-export-per-command [0023](0023-porcelain-plumbing-lib-layers.md)
still holds); help ([src/help.mjs](../../src/help.mjs)); [CONTEXT.md](../../CONTEXT.md) (the "Sets (the
command)" term split into `setup` + `list`; the `Inherit` example became `s3cab setup … --inherit`);
and the README/guide. Error-message examples that showed `s3cab sets …` (e.g. `collisionError`, the
bucket-less-set message in [0030](0030-error-message-guidelines.md)) now read `s3cab setup …`.

### Implementation notes (2026-06-28)

Two presentation/behaviour calls left open above were settled while building it (see
[docs/design/backup.md](../design/backup.md) for the resulting CLI surface):

1. **`list` does use an overview/detail split — but on *relevance*, not volume.** No-arg `list` shows
   every set *compactly* (`name:` + snapshot times only); naming a set switches to a *detail* view
   that adds the set's bucket, member directories, and the path to its exclude file. The `dirs.txt` and
   `exclude.txt` paths are shown absolute and platform-native so a capable terminal opens them in the
   editor ("the files are the API", [0002](0002-no-lock-in-hard-constraint.md)). This refines point
   3's "don't add an overview/detail tier the volume doesn't justify": the tier here keeps the
   *all-sets* view scannable (per-set config would bury the snapshots), not to cap volume — the
   single-set user still gets their snapshots from a bare `list`, the hard constraint.
2. **`--remote` resolves a *single* set (sole-set default), not all sets.** It is a network call
   carrying the set's own auth, so listing every set remotely would be N round-trips under N stacked
   env layers; one set keeps it cheap and the credentials unambiguous. A deliberate narrowing of
   point 3's "`--remote` composes over the grouped form" — the grouped form is just one group.
