# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

- **HIGH — `backup` can publish a snapshot referencing an object `cleanup` already deleted,
  because its change-detection trusts local history that `delete` never updates.** Found
  2026-07-19 while discussing a path-scoped purge idea (`proposals/misc.md`).

  **Mechanism.** `backup`'s upload step is documented as a "single-owner model — local history
  is authoritative" ([src/lib/upload.mjs:29-31](../src/lib/upload.mjs)): with a `--since`
  baseline, `planUpload` decides what's "already stored" **purely from the local previous
  snapshot's hashes** ([src/lib/upload.mjs:47-71](../src/lib/upload.mjs)) — no live remote
  check. The conditional-PUT backstop only protects hashes that make it into the plan; a hash
  skipped via the baseline is never attempted, so the backstop never sees it. `delete`
  ([src/commands/delete.mjs](../src/commands/delete.mjs)) only touches remote snapshots — it
  never updates or removes the corresponding local snapshot file (`snapshots/<set>/` locally),
  by design ("Local snapshots need no command: the files are the API — delete the file").

  **Repro.** Back up a set (path P, hash H uploaded). `delete` that remote snapshot. Once past
  the grace window, `cleanup --delete` removes H from `objects/` (it's now a true orphan). The
  local snapshot file for the deleted remote snapshot is still on disk, untouched. Back up
  again with P unchanged (same size/mtime): `snapshot` reuses H from the stale local baseline
  without re-hashing; `backup` passes that same local snapshot as `--since`; `planUpload` sees H
  in the baseline and skips it. The new snapshot gets published referencing H, which no longer
  exists in `objects/` — exactly `verify`'s `missing` finding, self-inflicted by three shipped
  commands run in the obvious order on one machine, no purge feature required.

  **Direction matters, not just presence, of drift.** Local *ahead* of remote (a snapshot taken
  but not yet uploaded) is an already-designed-for, benign state (`list` vs `list --remote`
  already differ for exactly this reason). The dangerous direction is local *believing more is
  stored than actually is* — i.e., local history claiming an object exists when a remote
  deletion has since removed it. Any fix should close that direction specifically, without
  necessarily forcing local and remote into lockstep generally (which may not be achievable in
  a single-owner-with-occasional-remote-deletion model anyway).

  **Not yet explored:** whether `delete` should invalidate/touch the corresponding local
  snapshot file, whether `planUpload`'s baseline path needs a cheap live existence check
  (defeating the point of skipping the LIST), or something else. No fix designed yet — filed to
  capture the defect before it's lost in the purge-design discussion that surfaced it.

<sub>Last cleared 2026-07-17: the snapshot→upload staleness corruption (a file changing on
disk between its snapshot and its upload, PUT under the wrong hash) was fixed by aborting the
backup on first detected drift — `uploadSnapshot` re-checks each planned file's size/mtime
against the snapshot and refuses rather than store mismatched bytes, so no snapshot is ever
published referencing an object it couldn't store correctly.</sub>
