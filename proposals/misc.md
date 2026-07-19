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
- **New vocabulary: `unrestorable` for the file side; `orphan` stays object-only —
  grilled 2026-07-19 with `/grilling`, replacing an earlier swap proposal.** That earlier idea
  (move `orphan` to files, coin **unreferenced** for objects) was grilled on the premise first
  and didn't survive it: the object-side convention argument doesn't hold up (git/docker
  actually favor "unreachable"/"dangling" over "orphan" for storage objects), and there turns
  out to be no second reference-counted entity to name — a **path** has no persistent stored
  identity of its own (no `paths/<path>` object; it exists only as row-content inside snapshot
  files), so it cannot "lose a reference" the way an **object** can.
  [`orphans.mjs`](../src/lib/orphans.mjs)'s `planOrphans` was never computing a second state; it
  renders the *same* orphan-object state by path instead of hash, because a hash means nothing
  to a person.

  What `delete`'s report actually needs to name is a **user consequence**, not a storage fact:
  which paths `restore` can never produce again once these snapshots are gone. "Orphan" imports
  the wrong layer (object accounting) onto that. The replacement, **`unrestorable`**, hooks onto
  the **Restore** entry already in [CONTEXT.md](../CONTEXT.md) instead of borrowing `cleanup`'s
  vocabulary: *a path no surviving snapshot lists, so `restore` can no longer produce it.*
  `orphan`'s existing CONTEXT.md definition is untouched; `unrestorable` would be a new entry
  cross-referencing both `Orphan` and `Restore`. The computation in `planOrphans` doesn't need
  to change — bucket-wide hash-reference survival is still accepted as the right practical
  answer, even though in a rare case it can call a path unrestorable while its content is
  technically still retrievable under a different path or snapshot — only what's exposed does.

  **Scope, if it proceeds to code:** confined to
  [`src/lib/orphans.mjs`](../src/lib/orphans.mjs) (module + types — `planOrphans` →
  `planUnrestorable`, `OrphanPlan` → `UnrestorablePlan` — and its test),
  [`src/commands/delete.mjs`](../src/commands/delete.mjs)'s use of it, the stdout header
  ("Orphan preview" → something in the unrestorable family), the report filenames
  (`delete-orphans-preview.txt` → `delete-unrestorable-preview.txt`,
  `delete-orphans-<timestamp>.txt` → `delete-unrestorable-<timestamp>.txt`), delete's section of
  [guide/maintenance.md](../guide/maintenance.md), and
  [snapshot-deletion.md](../docs/design/snapshot-deletion.md). Does **not** touch `cleanup`,
  `CleanupResult.orphanObjects`, [`src/lib/cleanup.mjs`](../src/lib/cleanup.mjs), `objects.mjs`,
  or the object-store half of the guide — no JSON-contract break, nowhere near the
  ~185-occurrence/37-file scope the swap proposal measured. Needs a worktree + PR (CLAUDE.md
  #7 — this is code, not doc-only); rescope from a fresh `grep` at build time, not from this
  note.
- **`scripts/`: empty-a-versioned-bucket helper for manual testing** (write fresh when asked).
  The deleted `emptyBucket` in s3.mjs was meant for this but never did it — a plain per-key
  `DeleteObjectCommand` only adds delete markers on a versioned bucket. The real thing needs
  `ListObjectVersions` + per-`{Key, VersionId}` deletes so the bucket can actually be emptied
  and removed.