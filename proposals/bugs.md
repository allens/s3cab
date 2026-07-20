# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

<sub>Last cleared 2026-07-19: the HIGH baseline-trust hole (`backup` trusting a local
`--since` baseline whose remote snapshot a `forget` + `cleanup --delete` had since removed —
publishing a snapshot referencing a deleted object) was fixed by trusting the baseline **iff
it still exists remotely**: `uploadSnapshot` HEADs the baseline's remote snapshot before
believing it, and on a miss drops the baseline and LISTs the store as a first backup would.
The same check also covers a baseline snapshotted locally but never uploaded. The deletion
rework's interlock — subtracting deletion-record hashes from any trusted baseline — landed
with the path-scoped `delete`
([ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)).</sub>
