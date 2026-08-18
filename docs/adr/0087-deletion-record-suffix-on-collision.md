# A same-minute deletion record takes the next free name, instead of refusing

**Status:** accepted (2026-08-18). Amends the naming bullet of
[0064](0064-path-scoped-delete-deletion-record.md); the rest of that ADR stands.

## Context

[ADR-0064](0064-path-scoped-delete-deletion-record.md) gave deletion records the snapshot-name
grammar — a minute-precision local timestamp — and handled the collision that invites the same
way a snapshot does: a conditional PUT (`IfNoneMatch: *`) refuses a same-minute second run
loudly, with "wait for the next minute" as the remedy. `S3CAB_DEBUG` dropped the condition so
tests could re-run inside a minute.

Two deletes finishing in one minute is not hypothetical. Two people sharing a bucket hit it,
and CI hit it for real on 2026-08-15 (run
[31852887331](https://github.com/allens/s3cab/actions/runs/31852887331)): two workflow runs
from a stack of back-to-back merges overlapped on the shared integration bucket and the second
one failed. The CI half was fixed by serializing that job, but the wall underneath is the
product's.

The inherited symmetry is what made it look settled. ADR-0064 chose the grammar so the format
spec would tell "one story for both timestamped artifacts", and took the refusal along with it
— but the refusal is not part of the naming decision, and the two artifacts do not want the
same answer.

## Decision

**A deletion record whose name is taken retries under `<name>-2`, `<name>-3`, … until one
lands.** The PUT stays conditional every time — the suffix disambiguates a *file*, it never
licenses an overwrite. Readers take every key under `deletions/` matching
`<timestamp>[-<n>].tsv`.

The `S3CAB_DEBUG` escape is **removed**. It existed only to work around this collision, and it
was the one path on which a record could be silently overwritten — the exact loss the
conditional PUT is there to prevent.

A bounded loop (100) backstops a `putText` that refuses for some reason other than the key
existing; it is not a contention limit. Exhausting it throws, having deleted nothing, because
the record is written first.

## Why not the same rule as snapshots

Because the collision protects something in one case and nothing in the other:

|                          | Snapshot manifest                        | Deletion record                          |
| ------------------------ | ---------------------------------------- | ---------------------------------------- |
| Is the name an identity? | Yes — users type it (`restore <set> <n>`) | No — read by nobody; the prefix is LISTed and unioned |
| What refusal buys        | An accidental double-run cannot destroy history ([guide/format.md](../../guide/format.md)) | Nothing — the second delete is a different real event |
| Cost of refusing         | A repeat run, correctly prevented        | A legitimate operation fails outright    |

A snapshot name is a promise to a person. A record name only has to be unique and to sort.

## Consequences

- Same-minute deletes both record. The wall, and the "wait a minute" remedy, are gone.
- `deletedOn` — the context `verify` and `restore` print with an expected-missing finding —
  can now read `2026-07-19T1422-2`. It names the record file, which is what it always did.
- Records stay orderable without parsing the suffix: each carries the full UTC instant in its
  `generated:` header. `readDeletionRecords` therefore keeps a plain lexical sort, which
  orders `-10` before `-2` — reachable only by a hash deleted, re-backed-up and re-deleted
  inside sixty seconds, and affecting only which same-minute name is displayed.
- **Second precision is still rejected**, as in ADR-0064: it would put a second timestamp
  shape in the spec and would not remove the need for a tie-break anyway.
- The **snapshot** same-minute race is untouched and remains open — same mechanism, opposite
  answer. What is wrong there is the *reporting*, not the refusal (see
  [0084](0084-snapshot-identity-byte-equality.md) for the identity half).
