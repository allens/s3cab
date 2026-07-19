# Misc — unsorted ideas

Ideas that don't fit a theme yet and aren't enough on their own to earn an epic file. When a
cluster here grows, split it out into its own `proposals/<topic>.md` (these two look like a
future "platform / release" epic).

- **Selective bulk restore via a path list on stdin** (`s3cab restore --set <set> -`, the
  `rsync --files-from` pattern; clig.dev's `-` convention). Restoring *many specific files*
  conveniently is an open pain: today's positional filters don't scale past a handful. A
  path-per-line list on stdin composes with the tools that produce such lists —
  `s3cab tree photos | grep 2024 | s3cab restore --set photos -`, or a future compare/`verify`
  output — and a `--files-from <file>` twin would cover the non-pipe case. Would also want
  clig's guard: if stdin is an interactive terminal, don't hang waiting — show help instead.
- **Windows long paths** (`\\?\` prefix, >260 chars) and reserved device names (`CON`,
  `NUL`…) — a photo/video archive will eventually hit one.
- **Distribution**: winget / scoop / Homebrew manifests once released; a real Windows
  code-signing cert eventually (same class of trust problem as the macOS notarization gap).
- **Use nodejs test runner tags** https://nodejs.org/docs/latest/api/test.html#test-tags
- **`upload --snapshot` manifest opt-out** ("upload the objects but not the snapshot file";
  name TBD — `--no-manifest` / `--objects-only`). Deferred from the upload epic (ADR-0044) per
  #7 — no use has appeared. Harmless if added: orphan objects with no manifest are the *safe*
  direction (wasted space, not corruption).
- **Split the vocabulary: `orphan` for the _file_ side, `unreferenced` for the _object_ side.**
  Today [CONTEXT.md](../CONTEXT.md) defines **orphan** as an *object* nothing references, and
  `cleanup` is built on it (`orphanHashes`, `orphanObjects`), as are the guide and
  [backup.md](../docs/design/backup.md). The proposal is to move `orphan` to files and call the
  object state **unreferenced**. Three arguments for it: the glossary already defines orphan
  *by* the word unreferenced ("an object that no snapshot **references** any more"), which
  usually means the defining word is the better term; the two are genuinely **different states
  in a many-to-one relationship** — a file can lose its last reference while its object stays
  referenced by another set, and "the orphan is still referenced" is unsayable in one
  vocabulary; and the split matches audience, since the guide talks in files and `cleanup`
  talks in storage, so a skim-reader picks up which world they are in from the term alone.
  Against: `orphan` is the conventional term in this space and is a noun where `unreferenced`
  is an adjective ("the unreferenced objects" is fine, but longer);
  [ADR-0012](../docs/adr/0012-consumer-vocabulary-naming.md) permits keeping genuinely
  technical terms rather than contorting them. **Deliberately not done inside the orphan-check
  workstream** (PR #217) — a rename landing inside a feature diff makes that diff
  unreviewable; it wants its own commit.

  **Settle this first — what an _orphaned file_ is.** (a) no snapshot lists this path any
  more, or (b) no snapshot lists it **and** its content is now unreferenced. `delete`'s report
  is (b); (a) is the larger set and arguably the more natural reading. Both may deserve names.
  The constraint that decides it: **`verify` already calls a file whose content is absent from
  the store `missing`** (a `problem` value in verify.mjs, documented in
  [guide/maintenance.md](../guide/maintenance.md)), so part of the file-side space is named
  already — check what is genuinely vacant before moving `orphan` into it.

  **Scope, measured (2026-07-19):** 37 files mention `orphan`, ~185 occurrences in `.mjs`
  alone. The heaviest carriers are `src/lib/orphans.mjs` + its test (a whole module named for
  the term, added by #217 — and note `planOrphans` computes *objects* that become unreferenced
  while reporting them as *files*, so the split cuts straight through it),
  `src/lib/cleanup.mjs` (`orphanHashes`), `src/commands/cleanup.mjs` (`orphanObjects`),
  `src/render.mjs`, `src/commands/delete.mjs`, plus [CONTEXT.md](../CONTEXT.md),
  [backup.md](../docs/design/backup.md),
  [snapshot-deletion.md](../docs/design/snapshot-deletion.md) and
  [guide/maintenance.md](../guide/maintenance.md). Sweep by `grep`, not from memory — the
  earlier estimate in this note listed five files and was badly short.

  **It is a breaking change to the JSON contract, not only prose.** `--json` emits the raw
  result structure (s3cab.mjs), so `CleanupResult.orphanObjects` is a *field name* anyone
  scripting against `s3cab cleanup --json` depends on. Pre-1.0 gives free rein (CLAUDE.md #5),
  but the rename must be taken as a deliberate output-contract break, not slipped through as a
  tidy-up.
- **`scripts/`: empty-a-versioned-bucket helper for manual testing** (write fresh when asked).
  The deleted `emptyBucket` in s3.mjs was meant for this but never did it — a plain per-key
  `DeleteObjectCommand` only adds delete markers on a versioned bucket. The real thing needs
  `ListObjectVersions` + per-`{Key, VersionId}` deletes so the bucket can actually be emptied
  and removed.