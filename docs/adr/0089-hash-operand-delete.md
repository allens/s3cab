# `delete` takes content hashes, fed by `find`; no scope narrower than everywhere

**Status:** accepted (settled 2026-08-22 in a grilling session; built the same day).
Supersedes [0063](0063-forget-snapshots-delete-paths.md)'s rationale for the `delete` verb
(its verb table stands) and most of [0064](0064-path-scoped-delete-deletion-record.md) (its
confirmation tier, record-first ordering and destructive-command pattern stand). The record
format this operand forces is [0090](0090-deletion-record-format-compaction.md); the `find`
half of the split is [0088](0088-find-matches-like-posix-find.md). Reasoned under clig.dev
(the `cli-design` skill) and [0012](0012-consumer-vocabulary-naming.md).

## Context

The operation's purpose is unchanged since [0063](0063-forget-snapshots-delete-paths.md):
**remove all remnants of a file from the repository** — the uploaded secret key is the
classic case. [0064](0064-path-scoped-delete-deletion-record.md) built it path-scoped:
named paths resolved within the sets attached on this machine, any outside reference
*protecting* an object, `--everywhere` as the content-scoped override.

Living with it exposed the two facts that settle this ADR together:

- **No mode narrower than `--everywhere` is wanted.** In practice the override is the only
  mode anyone reaches for — the point of deleting a secret or a mistake is that it goes
  *everywhere*. The protection scan, and the participating-set machinery behind it, guard a
  mode nobody uses.
- **But "everywhere by path" is not safe.** A name-match decides which *content* gets
  destroyed bucket-wide, so one over-matching pattern nukes bytes nobody ever looked at,
  irreversibly, for everyone. **An irreversible bucket-wide delete must not take a fuzzy
  operand.**

## Decision

Split the fuzzy step from the destructive step. `find`
([0088](0088-find-matches-like-posix-find.md)) is the read-only search where a mistake costs
nothing; `delete` takes the **exact identity of the thing it destroys**:

```
s3cab delete --bucket <bucket> <hash>... [--from-file <file>] [-n|--dry-run] [-f|--force]
```

- **Hashes, positional or `--from-file`. No piping** — a pipe is not cross-platform, and it
  means nobody read the rows. `--from-file` takes `find`'s output (or anything with hashes
  in column one): the destructive command operating on a file a human has reviewed and
  edited down. Comments and blank lines are garnish a lenient parse skips; **anything else
  in the operands is a loud error naming the offender** — never a guess. That is also the
  stale-muscle-memory protection: an old-style path operand or a `delete <snapshot>` habit
  is not 64 hex characters and fails before any S3 traffic, pointed at `find`.
- **Preflight `HeadObject` per hash**, before anything is deleted. Hashes the bucket does
  not hold are **reported and skipped, not fatal** — a hash pasted from the wrong bucket, a
  stale `find` file, or something already deleted. The `ContentLength` that comes back
  fills the record's size column and gives the summary a real figure, and the preflight is
  the second catch for a hash list spanning two buckets (`find` warns at the other end).
- **Hard refusal on the empty-file hash** (`e3b0c442…b855`): it backs every zero-byte file
  in the repository, so deleting it is never what anyone means. The general dedup hazard
  needs no special case — `find` prints the path count per object, and the size column
  makes the pathological ones obvious in the reviewed file.
- **Confirmation unchanged from [0064](0064-path-scoped-delete-deletion-record.md)**: acts
  by default, `-n`/`--dry-run` previews, type the bucket name to confirm, non-interactive
  runs refuse without `--force`, and the record is written **before** any object is
  deleted. The operand got safer; the consequence did not. The preview *file* is gone —
  the reviewed operand list is its replacement.

Dangling pointers are the accepted consequence, as they always were: snapshots in any set,
on any machine, may list content that is deliberately gone. The deletion record
([0090](0090-deletion-record-format-compaction.md)) is what tells every reader the absence
is deliberate.

## Naming

**`delete` keeps the verb**, working differently. POSIX pairs `find` with `-delete`, and
s3cab borrows `find`'s matching semantics wholesale (0088), so taking the search rules but
not the verb would leave the coherence on the table; [0012](0012-consumer-vocabulary-naming.md)
says the plainest word wins, and CONTEXT.md's Delete entry already reads `_Avoid_: purge,
expunge, remove`.

`purge` was the working name through the design session and is the defensible runner-up — a
distinct word for a distinctly severe operation. What decided against it: the safety
argument does not discriminate. Stale muscle memory fails loudly under *both* spellings (a
path is not a hash; under `purge`, the old command would not exist), so neither can lose
data — and severity is carried by the bucket-name confirmation, not the verb. `destroy` is
the strongest signal but is Terraform's word for tearing down infrastructure, ambiguous
about whether the *bucket* goes.

## Consequences

- `commands/delete.mjs` and `lib/delete.mjs` are rewritten; the participating-set
  protection machinery (the scan, the preview file, `--everywhere`) is deleted with them.
- Pre-1.0, the old `deletions/<timestamp>.tsv` files get **no reader** — the shape is
  deleted outright, not branched on (CLAUDE.md's no-compatibility-code rule).
- `guide/maintenance.md`'s delete section becomes the find → review → delete workflow;
  `guide/find.md` gains the hand-off; CONTEXT.md's **Delete** entry is rewritten in place.
- The consumer semantics of 0064 — `verify`'s expected/unexplained partition, `restore`'s
  graceful dated skip, `backup`'s baseline subtraction, `cleanup`'s interlock subtraction —
  are unchanged in meaning and restated against the new record in
  [0090](0090-deletion-record-format-compaction.md).
