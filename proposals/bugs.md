# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

_No known bugs currently open._

<sub>Last cleared 2026-07-17: the snapshot→upload staleness corruption (a file changing on
disk between its snapshot and its upload, PUT under the wrong hash) was fixed by aborting the
backup on first detected drift — `uploadSnapshot` re-checks each planned file's size/mtime
against the snapshot and refuses rather than store mismatched bytes, so no snapshot is ever
published referencing an object it couldn't store correctly.</sub>
