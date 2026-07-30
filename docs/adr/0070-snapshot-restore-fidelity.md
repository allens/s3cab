# Snapshots record content, size and mtime — regular files only

**Status:** accepted. Makes deliberate what [guide/format.md](../../guide/format.md) already
described, so the *why* is of record. Follows from
[0001](0001-file-level-content-addressable-dedup.md) (content-addressable dedup) and
[0002](0002-no-lock-in-hard-constraint.md) (no lock-in).

## Context

A snapshot row is the only place s3cab can record anything *about* a file: the object store is
content-addressed, so `objects/<sha256>` is bytes and nothing else — the same content may be a
dozen different files under a dozen names, which is exactly why objects carry no metadata. What
the snapshot records is therefore the hard ceiling on what `restore` can put back.

That ceiling was described in the format spec but never decided on the record, and it is the
kind of thing that is cheap to settle while the format is young and expensive once snapshots
are in the wild.

## Decision

A snapshot records, per file: **content hash, size, and modification time** — and covers
**regular files only**.

Deliberately not recorded: symlinks and junctions, hardlink identity, empty directories,
permissions, ownership, ACLs, and Windows file attributes. Non-regular entries are recorded as
`#SKIPPED` rows by the walk rather than silently dropped.

## Why

- **s3cab backs up _data_, not systems.** Documents, photos, video. It is not a system backup
  tool and does not aim to reconstitute a bootable machine, which is what the omitted metadata
  exists to serve.
- **A content-addressed store has nothing to hang the metadata on.** Permissions and empty
  directories are properties of a *path*, not of *content*, so the only possible home is the
  snapshot row — and each new column is a permanent widening of the recovery contract.
- **The omitted attributes don't round-trip across platforms anyway.** POSIX modes and Windows
  ACLs are different models; encoding either into the row would bake one OS into a format whose
  whole point is being readable and restorable anywhere
  ([0002](0002-no-lock-in-hard-constraint.md)).
- **Restore's job stays small and total:** put the right bytes at the right path with the right
  mtime. mtime is recorded because the change detection is mtime-based
  ([0045](0045-change-detection-local-baseline-list-fallback.md)) and because a restored file
  claiming today's date would misrepresent it.

## Considered and rejected

- **Empty directories.** The one arguable gap: a photo archive plausibly holds a folder kept for
  structure, and restore loses it. Recording them needs a new metadata row type and a
  create-empty-dirs pass in restore, for a case that carries no data. Rejected on the user's own
  framing — getting the *files* back is what the tool is for
  ([0006](0006-minimal-code.md)).

## Consequences

- **Restore never recreates an empty directory.** Directories are created implicitly, as parents
  of restored files.
- **Hardlinked files restore as independent copies.** The bytes are right and dedup means they
  cost one object; the link identity is not preserved.
- **Restored files take the restoring user's default permissions**, not the originals'.
- **A symlink is never followed or stored**, so a backup can't loop or silently swallow a target
  outside the set — it is recorded as `#SKIPPED` and the walk moves on.
- This is a **user-facing promise**, so it lives in [guide/format.md](../../guide/format.md)
  under "What is deliberately not stored"; this ADR holds the reasoning.
