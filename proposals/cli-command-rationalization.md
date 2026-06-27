# CLI command rationalization: bucket→aws, aws→profile, setup→sets

Implementation checklist for the decision recorded in
[ADR-0035](../docs/adr/0035-aws-profile-sets-command-rationalization.md). Decided via a
`/grilling` session 2026-06-27; nothing below is built yet. Delete this file once it's all done
(its lasting knowledge already lives in the ADR).

## Code

- [ ] Rename `src/commands/aws.mjs` → `src/commands/profile.mjs` (and `aws.test.mjs` →
      `profile.test.mjs`); rename the exported function `aws` → `profile`. Do this *before* the
      next step so nothing collides.
- [ ] Rename `src/commands/bucket.mjs` → `src/commands/aws.mjs` (and `bucket.test.mjs` →
      `aws.test.mjs`); rename the exported function `bucket` → `aws`.
- [ ] Merge `src/commands/setup.mjs`'s logic (the `setup` export: `create`/`update`/`inherit`
      branching) into `src/commands/sets.mjs`'s `sets` export, so `sets` handles both the existing
      no-args listing and the create/update/inherit positional+flag shapes. Delete `setup.mjs`.
      Port `setup.test.mjs`'s cases into a new `sets.test.mjs` (none exists today — `sets.mjs` is
      currently untested beyond `test/e2e.test.mjs`'s one listing check).
- [ ] Update `src/commands.mjs`: remove the `setup` registry entry; remove the old `aws` and
      `bucket` entries; add `aws` (today's `bucket` entry, renamed) and `profile` (today's `aws`
      entry, renamed); fold `setup`'s `args`/`options` into the `sets` entry. Re-check the `group`
      headings (`setup` currently carries `group: "Backup sets"`, which "sticks" for the
      commands listed after it — verify `sets`/`profile`/`aws` land in sensible groups once
      `setup`'s entry is gone).
- [ ] Grep the whole `src/` tree for `from "./aws.mjs"` / `from "./bucket.mjs"` / `from
      "./setup.mjs"` import paths and any in-code string references to the old names (e.g. error
      messages that print `s3cab setup …` / `s3cab aws …` / `s3cab bucket …` as suggested
      commands — `setup.mjs`'s `collisionError`, `set-marker.mjs`, `error.mjs`'s
      `noCredentialsError`/`expiredCredentialsError`, etc.).

## Docs

- [ ] [docs/adr/0026-bucket-required-at-setup.md](../docs/adr/0026-bucket-required-at-setup.md),
      [0030](../docs/adr/0030-error-message-guidelines.md),
      [0031](../docs/adr/0031-aws-profile-config-door.md),
      [0033](../docs/adr/0033-bucket-onboarding-security-model.md),
      [0034](../docs/adr/0034-bucket-command-shape.md): update every `s3cab setup`/`s3cab
      aws`/`s3cab bucket` example to the new names. 0031 and 0034 additionally need a one-line
      "name superseded by [0035](../docs/adr/0035-aws-profile-sets-command-rationalization.md)"
      note (the README index already has the convention, e.g. ADR-0013/0014's "*(partly
      superseded by 0024)*" notes).
- [ ] [docs/adr/README.md](../docs/adr/README.md): add the 0035 index entry; add the superseded
      notes to the 0031/0034 lines.
- [ ] [docs/specs/auth.md](../docs/specs/auth.md), [docs/specs/backup.md](../docs/specs/backup.md),
      [docs/integration-testing.md](../docs/integration-testing.md): update command names.
- [ ] [guide/bucket.md](../guide/bucket.md): rename to `guide/aws.md`; check inbound links (e.g.
      from README.md, help.mjs).
- [ ] [README.md](../README.md), [CONTEXT.md](../CONTEXT.md): update command names wherever they
      appear.
- [ ] [src/help.mjs](../src/help.mjs)'s `help auth` topic (and any other topic text): update
      `s3cab aws --profile` references to `s3cab profile --profile`.

## Tests

- [ ] [test/e2e.test.mjs](../test/e2e.test.mjs) line ~148 runs `sets` as a listing smoke test —
      extend or add cases for the merged create/update/inherit behavior if e2e coverage is
      wanted there (unit coverage in `sets.test.mjs` is the primary bar, per
      [ADR-0020](../docs/adr/0020-coverage-review-not-gate.md)).

## Deliberately not in scope here (separate future item)

- `sets`' create-vs-update mode is still inferred from invisible local state (does the set exist
  locally already?) rather than an explicit flag. Flagged during the grilling session as a real
  shape smell but deliberately left unfixed — idempotent, low-stakes, and orthogonal to this
  rename/merge. Revisit as its own change if it ever causes real confusion in practice.
