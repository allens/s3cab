# Restore detects folded-name collisions by the filesystem's own equivalence

**Status:** accepted — designed and implemented 2026-08-14, amended 2026-11-17: a written file
is told by its device and inode, not its real path; amended 2026-11-18: where the disk
renumbers a file, a written path spelled alike is asked at the same moment. Extends `restore`'s
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
cheaply: `lstat` folds however the volume folds, and the device and inode it returns say which
file a path reached.

## Decision

**The restore loop keys collision detection on the filesystem's own answers.** After each write,
the destination's device and inode are recorded. Before each write, a destination that already
*exists* and is one of those files is a **collision**: reported in a new
`collided` result list (rendered in full with the keep-both fix: restore the colliding path to
its own `--output`), never written, and the run sets **exit 1** — a file the user asked for was
not produced, unlike the deliberate-deletion skips that stay exit 0.

Two subtleties the mechanism carries:

- **A later row sharing a collided row's content never copies from its name.** The collision
  leaves that name resolving to another row's survivor, so copying from it would duplicate the
  wrong bytes. The loop records where each hash actually *landed*, and a collision records
  nothing: later holders copy from wherever the content has landed, and if it has landed
  nowhere yet, the next one fetches it.
  - **Amended 2026-10-04: dedupe moved from the plan into the loop.** `planRestore` used to point
    every later holder at the first holder's destination, and this ADR re-fetched every one of
    them behind a collision rather than redirect them — N same-hash rows behind a collision was a
    crafted-manifest corner, not worth machinery. Refused names (PR #354) made a write that fails
    while its content is sound an ordinary cross-OS case, and with the loop recording where
    content landed, redirecting is the simpler code rather than extra machinery.
- **Device and inode, not the real path.** glibc's `realpath` never asks the directory how a
  name is spelled, so from Linux onto a disk that ignores case (a `/mnt` drive under WSL,
  measured) it returns each twin as typed, and the second read as another file. The device and
  inode come from the `lstat` each destination already gets on its turn
  ([0116](0116-restore-rechecks-its-target.md)'s amendment), so they cost nothing more, and
  still name the file after something else rewrites it in place. Read as `bigint`: on that `/mnt` drive
  a file index was 6.7 × 10¹⁶, past 2⁵³, where a number drops its low bits.
- **Asked again at the same moment where the number doesn't last.** FAT and exFAT on Linux
  number a file anew once it leaves the cache (measured on loop-mounted images in WSL: the
  number changed once the page cache was dropped), so late in a long run a twin misses the
  recorded number. Then each written path that differs from the target only in case or
  Unicode form (NFKC, case-folded) is `lstat`ed beside it, and the same device and inode at
  that moment is the same file. That loose name only picks which files to ask about; the disk
  still decides, and a pair it doesn't pick is still caught wherever numbers last. Not holding
  the first twin open until its twin comes: a whole twinned folder runs into the open-file
  limit. Not reading the folder listing: a resumed restore would list a folder per existing
  file.

## Consequences

- The first row's bytes survive; every folded-away later row is named, with exit 1 — silent
  last-wins is gone, on every folding the volume itself performs (case, normalization, and
  anything a future filesystem invents).
- The detection also fires for a file a concurrent writer creates at the destination during the
  run, if it aliases a file this run wrote; an unrelated new file is skipped, never replaced,
  unless `--overwrite` ([0116](0116-restore-rechecks-its-target.md)'s amendment).
- `RestoreResult` gains `collided`; the renderer lists it before `missing` so the
  unexplained-absence alarm stays last on screen.
- Restoring the same snapshot *twice* into one output is unaffected: the second run skips
  existing files (or overwrites them wholesale under `--overwrite`), and neither path
  enters the collision branch because nothing this run wrote aliases them.
