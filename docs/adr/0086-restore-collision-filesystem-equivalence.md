# Restore detects folded-name collisions by the filesystem's own equivalence

**Status:** accepted — designed and implemented 2026-08-14. Extends `restore`'s
faithful-or-loud reporting (the report-then-exit-1 pattern of
[0064](0064-path-scoped-delete-deletion-record.md)'s exit-code split); detection deliberately
does **not** reuse the string case-folding of `pathMatcher`/`reroot`.

## Context

A manifest is allowed to list two paths that differ only by letter case (`file.txt` /
`File.txt`) or Unicode normalization (NFC/NFD `café`): a case-sensitive source filesystem,
another machine, or a crafted edit can all produce one. Restored onto a volume that folds those
differences — Windows and default macOS fold case, APFS folds normalization — the rows land on
**one** file: the last row's bytes silently overwrite the first's, while `restore` reported both
paths restored and exited 0. The count lied (Nielsen #1/#9; the model-tier hostile suite pinned
it, and macOS CI collapsed the suite's NFC/NFD café pair the same way on 2026-08-14).

String folding cannot detect this. Lowercasing catches ASCII case only — not APFS's
normalization folding, not case-folding outside ASCII — and hard-codes *this* code's idea of
equivalence where the ground truth is the destination volume's. The volume itself answers
cheaply: `existsSync` folds however the volume folds, and `realpathSync.native` returns the
canonical stored name of whatever a path resolves to.

## Decision

**The restore loop keys collision detection on the filesystem's own answers.** After each write,
the destination's `realpathSync.native` is recorded. Before each write, a destination that
already *exists* and canonicalizes into that record is a **collision**: reported in a new
`collided` result list (rendered in full with the keep-both fix: restore the colliding path to
its own `--output`), never written, and the run sets **exit 1** — a file the user asked for was
not produced, unlike the deliberate-deletion skips that stay exit 0.

Two subtleties the mechanism carries:

- **A later row sharing a collided row's content never copies from its name.** The collision
  leaves that name resolving to another row's survivor, so copying from it would duplicate the
  wrong bytes. The loop records where each hash actually *landed*, and a collision records
  nothing: the next holder fetches, and the holders after it copy from that one.
  - **Amended 2026-10-04: dedupe moved from the plan into the loop.** `planRestore` used to point
    every later holder at the first holder's destination, and this ADR re-fetched every one of
    them behind a collision rather than redirect them — N same-hash rows behind a collision was a
    crafted-manifest corner, not worth machinery. Refused names (PR #354) made a write that fails
    while its content is sound an ordinary cross-OS case, and with the loop recording where
    content landed, redirecting is the simpler code rather than extra machinery.
- **The per-file `realpathSync.native` is deliberate**, not the walk-hot-path mistake CLAUDE.md
  warns about: the loop is download-bound, and no pure-string function can say whether two names
  are one file — trusting strings is the bug this closes.

## Consequences

- The first row's bytes survive; every folded-away later row is named, with exit 1 — silent
  last-wins is gone, on every folding the volume itself performs (case, normalization, and
  anything a future filesystem invents).
- The detection also fires if a concurrent writer creates the destination between the plan's
  existence check and the write *and* it aliases a file this run wrote; an unrelated new file
  keeps the plan's decision (written, as before — `--overwrite` semantics are unchanged).
- `RestoreResult` gains `collided`; the renderer lists it before `missing` so the
  unexplained-absence alarm stays last on screen.
- Restoring the same snapshot *twice* into one output is unaffected: the second run's plan
  skips existing files (or overwrites them wholesale under `--overwrite`), and neither path
  enters the collision branch because nothing this run wrote aliases them.
