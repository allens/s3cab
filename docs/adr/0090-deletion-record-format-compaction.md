# The deletion record: root-level indexed files, tombstone rows, compacted by `cleanup`

**Status:** accepted (settled 2026-08-22 in a grilling session; built the same day). The
record format for the hash-operand `delete` ([0089](0089-hash-operand-delete.md)).
Supersedes [0064](0064-path-scoped-delete-deletion-record.md)'s record shape (the
`deletions/` prefix, per-run timestamp names, `hash<TAB>path` rows, the `#` header block)
and all of [0087](0087-deletion-record-suffix-on-collision.md), whose conditional-PUT
walk-up survives as this ADR's slot allocator. The stored shape is documented in
[guide/format.md](../../guide/format.md) ([0002](0002-no-lock-in-hard-constraint.md):
recovery from the stored files alone).

## Context

[0064](0064-path-scoped-delete-deletion-record.md)'s record was a per-run audit artifact:
one `deletions/<timestamp>.tsv` per delete, `hash<TAB>path` rows for every reference the
deleted objects had, when/who in the filename and a `#` header block. The hash-operand
`delete` has no paths to write — the operand *is* the hash — which forced the question of
what the record is actually for, and the answer reshapes everything else.

## Decision

### A tombstone, not a ledger

The record's only job is to tell a reader that an absence is **deliberate** — someone
restoring a file hits a missing object and needs to know it was deleted on purpose, not
that the repository is damaged. That reader already has the path in front of them (they are
holding the snapshot), so **the record carries no paths**; after "this was deliberate", the
useful facts are *when* and *who*. This is also why it can be trimmed, and why s3cab does
not grow an audit trail: keeping a note of every temp file that ever got caught in a
backup, forever, is out of the tool's lane.

### Rows

`hash / size / instant / user@machine` — matching a snapshot row's column *types*
positionally (col1 hash-or-`#TAG`, col2 size, col3 timestamp, col4 the ragged textual end).
When and who live in the **rows**, not the filename, because compaction destroys filenames.

```
#DELETED		2026-08-22T11:04:55.120Z	These objects were removed on purpose. Absence here is not damage.
a3f9c21e8b04…60d	1204	2026-08-14T09:31:07.412Z	allen@DESKTOP
5e21ab7fc0b1…c93	892	2026-08-19T22:41:07.006Z	allen@LAPTOP
#END
```

**`#END` is bare, deliberately** — [guide/format.md](../../guide/format.md) already defines
the trailer as "first field, trimmed, equals `#END`", with a bare one valid. It carries no
`COMPLETE`/`PARTIAL`: a snapshot's trailer needs those because zstd decompresses a
cut-short file into a plausible smaller snapshot and because it is written incrementally to
local disk, whereas a record is uncompressed and
lands in one atomic PUT — `PARTIAL` cannot occur, and a status column with one possible
value implies a distinction that does not exist. Parsing stays lenient only in the
direction that never explains away an absence: a row counts only if its first field is 64
hex characters.

### Root-level, indexed, never overwritten

`objects.deleted-1.tsv`, `-2.tsv`, … at the bucket root. A run LISTs the prefix, takes the
next free index, conditional-PUTs (`IfNoneMatch: *`), and walks upward if it loses a race —
[0087](0087-deletion-record-suffix-on-collision.md)'s mechanism, retained purely as a slot
allocator with no timestamp pretending to be information. Holes in the sequence are never
reused. Safe beside `objects/`'s LIST because that prefix carries its trailing slash.
Blocking concurrent runs is **not** an option: that was 0064's original design, and 0087
reversed it after two people sharing a bucket hit it routinely and CI hit it for real.

### `cleanup` compacts and trims in one operation

Union every row across every record file (deduped by full tuple), **drop rows whose hash no
snapshot anywhere references**, write the merge to a *fresh* index, then delete the files
it absorbed. The steady state after any cleanup is a single file — or none, when nothing
referenced remains. Writing before deleting makes every crashed intermediate state correct,
since a duplicated row is still just "deliberately gone". Gated by `cleanup`'s existing
unreadable-snapshot interlock: an unreadable snapshot's references are unknown, and an
unknown reference must protect a row. Housekeeping, not reclamation — it needs no
confirmation of its own and runs on every acting path, but never on a dry run or behind a
declined prompt.

### Why trimming is safe — the load-bearing invariant

Every consumer reaches the record **through a snapshot that references the hash**:

- `verify` computes `referenced − stored`;
- `restore` is reading a snapshot when it hits the absence;
- `cleanup` subtracts record hashes from its missing-object interlock, which is built from
  the referenced union;
- `backup`'s `storedHashes` subtracts record hashes from a `--since` baseline **only while
  `matchRemoteSnapshot` confirms that baseline still exists remotely, byte-identical**
  ([0084](0084-snapshot-identity-byte-equality.md)) — which makes the baseline itself a
  live snapshot referencing its hashes.

So "no snapshot in the bucket references H" ⟹ nothing can ever ask about H ⟹ the row is
dead. The trim must key on *referenced* hashes, never on stored objects — a deleted
object's row exists precisely because the object is gone while references remain.

## Why not a single rolled-up `objects.deleted.tsv`

Nicer to look at, but rewriting one fixed key is a read-modify-write, and two overlapping
writers can lose rows — which is *not* safe-direction, because `backup` subtracts record
hashes from a trusted baseline: a lost row means it keeps trusting a baseline that vouches
for deleted content and publishes a snapshot referencing a missing object — silent
corruption, not a loud failure. Fixing that needs `If-Match` on PUT, the newest and least
universally implemented S3 conditional, and s3cab is S3-*compatible*, not S3-only
([0002](0002-no-lock-in-hard-constraint.md)). It is a two-line change on top of the indexed
scheme if `If-Match` ever proves universal across the providers we care about.

## Consequences

- `deletedOn` — the date `verify` and `restore` print with an expected-missing finding — is
  now the **row's instant** (newest wins for a hash recorded twice), no longer the record
  filename; displays show the calendar date.
- Concurrent delete-vs-compaction and compaction-vs-compaction are safe by construction:
  conditional PUT (no index is ever overwritten), write-before-delete (the merge lands
  before its sources go), and compaction never deletes a file it did not read.
- [guide/format.md](../../guide/format.md)'s layout tree gains its first root-level key and
  loses `deletions/`; the format needs no version bump — pre-1.0, the old shape simply
  ceases to exist, reader included.
