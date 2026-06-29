# No lock-in is a hard constraint

**Status:** accepted

If s3cab disappeared tomorrow, a competent person must be able to recover their data by
hand — or write a replacement in an afternoon. Snapshot files and the object store use
plain, self-evident formats; recoverability is a designed-in, first-class feature.

_(Foundational design principle #2 — the single most important one; the others serve it.)_

## Why

This is the project's reason to exist: a backup you cannot recover without the original tool
is a trap. Transparency of **format** (this ADR) and transparency of **code**
([0006](0006-minimal-code.md)) together mean nothing about the project is a black box.

## Consequences

This is a **hard constraint, not a preference.** Reject any feature that meaningfully harms
hand-recoverability, even when it saves space or time. It is exactly why file-level-only
dedup ([0001](0001-file-level-content-addressable-dedup.md)) is chosen over block packing,
why snapshots are plain TSV ([0004](0004-tsv-snapshot-manifests.md)), and why hashes are
human-readable hex. When a decision is unclear, decide in favour of this.
