# CLI command rationalization — implementation checklist

The implementation hand-off for two **accepted-but-unbuilt** decisions about the onboarding/
management command surface. Hand this to a fresh session when the time is right; delete this file
once it's all built (it's a proposal, not a record — the decisions live in the ADRs).

Decisions this implements:

- **[ADR-0035](../docs/adr/0035-aws-profile-sets-command-rationalization.md)** points 1–2:
  `bucket <name>` → `aws <name>`; the former `aws --profile` → a `profile` command.
- **[ADR-0036](../docs/adr/0036-setup-mutates-list-shows-drop-sets.md)** (supersedes 0035 point 3):
  drop `sets`; `setup` mutates a set (upsert + `--inherit`); `list` shows all sets + their config +
  snapshots, optional `<set>` filter; `profile` stays separate; onboarding order `aws` → `profile`
  → `setup` → `backup`.

The target surface when done:

```
aws <bucket>                          # provision the cloud side (was: bucket)
profile --profile <p> [<set>]         # point at AWS credentials (was: aws --profile)
setup <set> <folder>… --bucket <b>    # create/update a set (was: sets <set> …)
setup <set> --inherit --bucket <b>    # inherit a set (was: sets <set> --inherit)
list [<set>]                          # all sets + config + snapshots, or one set's
```

## Checklist

Start from a worktree (CLAUDE.md convention #13). Tests-as-you-go per convention #12.

- [ ] **`bucket` → `aws`.** Rename `src/commands/bucket.mjs` → `aws.mjs`; the *current* `aws.mjs`
      moves to `profile.mjs` (next item), so do these together to avoid a name clash. Update the
      registry entry and `guide/bucket.md` → `guide/aws.md`.
- [ ] **old `aws --profile` → `profile`.** Rename today's `src/commands/aws.mjs` → `profile.mjs`;
      command name `profile`; behaviour unchanged (writes/reads/clears `AWS_PROFILE`, optional
      `<set>` scope, [ADR-0031](../docs/adr/0031-aws-profile-config-door.md)).
- [ ] **`sets` → `setup` (mutation only).** Rename `src/commands/sets.mjs` → `setup.mjs`; the one
      export becomes `setup`. **Remove the no-arg listing branch** ([sets.mjs](../src/commands/sets.mjs)
      lines that handle `name === undefined`) — listing moves to `list`. Keep create/update/inherit.
      One-export-per-command ([ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md)) still holds.
- [ ] **`list` shows sets + snapshots.** Extend `src/commands/list.mjs`: no `<set>` → every set with
      its backup target + snapshots (full expansion; dozens not thousands); `<set>` → that set only.
      Generalize, don't break, the sole-set default. `--latest`/`--remote` compose. Decide whether
      the per-set heading carries member folders (ADR-0036 "Deferred" — `set → bucket` is the
      minimum).
- [ ] **Registry** ([src/commands.mjs](../src/commands.mjs)): drop the `sets` entry, add `setup`
      (today's `sets` args/options minus the no-name listing), rename `bucket`/`aws` entries, extend
      `list`'s arg help. Check the `group` headings still read in order.
- [ ] **Help** ([src/help.mjs](../src/help.mjs)): the `auth` topic and any `s3cab bucket/aws/sets`
      mentions; reflect the `aws → profile → setup → backup` onboarding order.
- [ ] **CONTEXT.md**: split the "Sets (the command)" term into `setup` (mutation) + `list` (now
      lists sets too); update the `Inherit` term example `s3cab sets … --inherit` → `s3cab setup …`;
      confirm the `AWS profile` / `aws` terms match the renames.
- [ ] **Error messages**: every `s3cab sets …` in user-facing text → `s3cab setup …` — incl.
      `collisionError` and the bucket-less-set example in
      [ADR-0030](../docs/adr/0030-error-message-guidelines.md). Re-check each against the NN/g
      criteria while editing (CLAUDE.md coding conventions).
- [ ] **README / guide**: the install/usage walkthrough and command reference.
- [ ] **Docs cross-refs**: ADRs 0026/0030/0031/0033/0034 and the auth/backup specs mention the old
      names; sweep `grep -rn "s3cab sets\|s3cab bucket\|s3cab aws "`.
- [ ] **ADR index annotations**: once built, drop the "*(command name superseded…)*" / "*(point 3
      superseded…)*" qualifiers in [docs/adr/README.md](../docs/adr/README.md) that this file's
      decisions made — or leave them as history; reviewer's call.
- [ ] Delete this file.
