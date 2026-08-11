# A previously unreadable file is an annotated addition

**Status:** accepted — settled 2026-08-11, implemented the same day. Applies
[0043](0043-human-first-output.md)'s human-first rendering to the one case where the honest
category and the obvious reading of it disagree; the case gets routine if
[0069](0069-fused-snapshot-upload-pipeline.md)'s open "report a drifted file as an `#ERROR` row"
follow-up is ever taken, which is why it was settled first.

## Context

A file the walk can't hash is recorded as an `#ERROR` row: it is in the snapshot file, in
`Snapshot.errors`, in **neither** `entries` nor any manifest, and no object was stored for it.
`compare` handled that one-directionally — it pulled the *newer* snapshot's errored paths back out
of `deleted`, so a file that becomes locked never reads as deleted, but never looked at the
*older* snapshot's errors at all.

So (user, 2026-07-29): X.doc is locked when snapshot 1 is taken and hashes fine in snapshot 2, and
`compare 1 2` calls it **added** — a file that sat there the whole time. Against a since-side
`#ERROR` row a path falls into one of four states, and two were wrong:

| in `since` | in `until` | reported as |
| --- | --- | --- |
| `#ERROR` | an entry | **`added`** — the reported defect |
| `#ERROR` | `#ERROR` | `errors`, from the newer side — correct |
| `#ERROR` | `#SKIPPED` | `skipped`, same — correct |
| `#ERROR` | absent | **nothing at all** |

A third fault sat beside them, worse in kind than a mislabel: a since-errored path was eligible as
a **move destination**, so an X.doc whose content also lived at a path deleted in snapshot 2
printed `Y.doc → X.doc` — a rename that never happened, invented for a file that never moved.

This is not obviously a bug, which is why it was a decision rather than a fix. In snapshot terms
the file *is* new: it is in no earlier manifest and was never stored, so "added" tracks
new-to-the-backup rather than new-on-disk. What it cannot be is `modified` — with no hash on the
older side there is nothing to say the bytes changed.

## Decision

1. **It stays in `added`, and the line is annotated.** `AddedEntry` carries `wasUnreadable`, and
   the renderer writes `X.doc  (was unreadable in 2026-11-11T0830)`. The older snapshot is
   *named*, not called "last time": `compare` takes an arbitrary `--since`, and the header already
   shows that name.

   The category is right because **the content really did enter the store on this run** — an
   `#ERROR` row means nothing was PUT, so the next run PUTs it. Pulling the file out of `added`
   would leave a report saying "2 added · 1.1 MB changed" above a run that stored three objects,
   which is precisely the divergence [0078](0078-backup-run-report.md) and `backup`'s comment on
   its own `compare` call refuse to accept ("a report reading 425 added above a command that then
   lists 424 is a trust bug in the one place this design asks for trust").

   The annotation is right because the wrong inference from a bare `added` — *this file is new* —
   is the same shape as the one `(duplicate of …)` already exists to correct (*this content is
   new*), and it is corrected the same way. Both notes share one parenthetical when both apply.

2. **Nothing is reported for a file that was unreadable and is then gone.** The backup never held
   that path and still doesn't, so nothing about it changed. `deleted` is the only category that
   could take it, and it would claim a loss that never happened, at a size of zero. The error was
   reported on the run where it happened; the loop closes by the line not appearing again.

3. **A since-errored path can never be a move destination.** It was *there*, just unreadable, so
   nothing can have moved to it however the content pairs up. It falls through to the copy branch
   instead — annotated as a duplicate of wherever that content also lives, with the vanished
   path's deletion left standing, both of which are verifiable from the data.

4. **`compare`'s pre-parsed `since` form carries `errors` as a required field.** The fast path
   `snapshot`/`backup` use to avoid re-parsing the baseline handed over `entries` only; it now
   hands over both halves, from a parse `readBaseline` was already doing and discarding. Required
   rather than optional because an omitted-by-accident field silently reinstates the bug.

## Consequences

- `AddedEntry.wasUnreadable` is always present, `false` for an ordinary addition — the
  `duplicates: []` precedent, and self-describing for `--json` (still not a stability contract
  pre-1.0, [0043](0043-human-first-output.md)).
- `SnapshotBaseline` gains `previousErrors`, always a Map and empty when there is no previous
  snapshot, so a caller holding a baseline holds both of its halves.
- The scenario is rare today (a locked file that frees up) and would become routine under
  [0069](0069-fused-snapshot-upload-pipeline.md)'s `#ERROR`-on-drift follow-up, where an
  autosaving document flips between errored and recorded on most runs. That is a reason the
  annotation earns its place rather than an argument against it: the flip would otherwise show up
  as a file being "added" over and over.
- Not taken: a `Now readable` section of its own. It reads coherently — the inverse of an `Errors`
  line, a diagnostic rather than a disk change — but costs a section, a summary term and a
  `--json` key to say what one parenthetical says, and puts the run's own byte count at risk of
  disagreeing with what it stored. Revisit only if the annotation is measured to be noise in
  `Added`.
