# ADR-0036 implementation checklist — `setup`/`list`, drop `sets`

The implementation hand-off for **[ADR-0036](../docs/adr/0036-setup-mutates-list-shows-drop-sets.md)**
(accepted, unbuilt): drop `sets`; `setup` mutates a set (upsert + `--inherit`); `list` shows all
sets with their config and snapshots, optional `<set>` filter. Hand this to a fresh session when
the time is right; delete this file once it's built (it's a proposal, not a record — the decision
lives in the ADR).

[ADR-0035](../docs/adr/0035-aws-profile-sets-command-rationalization.md)'s renames (`bucket`→`aws`,
old-`aws`→`profile`, and the `setup`-into-`sets` merge that 0036 now supersedes) **already shipped
in #122** — `aws.mjs`, `profile.mjs`, `sets.mjs`, `guide/aws.md` exist today. So the *only*
remaining work is 0036's reshaping of that built `sets` command into `setup` + `list`.

Current → target:

```
sets                         → list                          # listing folds into list
sets <set> <folder>… -b <b>  → setup <set> <folder>… -b <b>  # upsert
sets <set> --inherit -b <b>  → setup <set> --inherit -b <b>  # succession
list [<set>]                 → list [<set>]                  # now also shows sets + config
aws <bucket>, profile …      → (unchanged — already shipped in #122)
```

## Checklist

Start from a worktree (CLAUDE.md convention #13). Tests-as-you-go per convention #12.

- [ ] **`sets` → `setup` (mutation only).** Rename `src/commands/sets.mjs` → `setup.mjs`; the one
      export becomes `setup`. **Remove the no-arg listing branch** ([sets.mjs](../src/commands/sets.mjs),
      the `name === undefined` handler) — listing moves to `list`. Keep create/update/inherit and
      `collisionError`. One-export-per-command ([ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md))
      still holds. Move `sets.test.mjs` → `setup.test.mjs`.
- [ ] **`list` shows sets + snapshots.** Extend `src/commands/list.mjs`: no `<set>` → every set with
      its backup target + snapshots (full expansion; dozens not thousands); `<set>` → that set only.
      Generalize, don't break, the sole-set default. `--latest`/`--remote` compose. Decide whether
      the per-set heading carries member folders (ADR-0036 "Deferred" — `set → bucket` is the
      minimum).
- [ ] **Registry** ([src/commands.mjs](../src/commands.mjs)): drop the `sets` entry, add `setup`
      (today's `sets` args/options minus the no-name listing), extend `list`'s arg help. Check the
      `group` headings still read in order.
- [ ] **Help** ([src/help.mjs](../src/help.mjs)): any `s3cab sets` mentions and the `auth` topic;
      reflect the `aws → profile → setup → backup` onboarding order.
- [ ] **CONTEXT.md**: split the "Sets (the command)" term into `setup` (mutation) + `list` (now
      lists sets too); update the `Inherit` term example `s3cab sets … --inherit` → `s3cab setup …`.
- [ ] **Error messages**: every `s3cab sets …` in user-facing text → `s3cab setup …` — incl.
      `collisionError` and the bucket-less-set example in
      [ADR-0030](../docs/adr/0030-error-message-guidelines.md). Re-check each against the NN/g
      criteria while editing (CLAUDE.md coding conventions).
- [ ] **README / guide**: the install/usage walkthrough and command reference.
- [ ] **Docs cross-refs**: sweep `grep -rn "s3cab sets"` (and bare `sets` command mentions) across
      ADRs and the auth/backup specs.
- [ ] **ADR index annotations**: once built, the "*(point 3 superseded by 0036)*" qualifier in
      [docs/adr/README.md](../docs/adr/README.md) has landed — leave it as history or tidy, reviewer's call.
- [ ] Delete this file.
