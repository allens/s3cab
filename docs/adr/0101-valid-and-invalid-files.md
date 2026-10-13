# Valid and invalid files: refuse the file, refuse one path, or ignore the row

**Status:** accepted & implemented (proposed 2026-10-11); partly superseded by
[0103](0103-row-marks-and-unrecorded-links.md): the type names, and an unknown `@` or `#` type is
skipped while any other refuses the file; and by [0106](0106-a-lone-dot-ends-every-file.md): a
valid file ends with a lone `.` line where it ended with `END`. Supersedes
[0082](0082-snapshot-end-trailer.md) point 3 (content after the trailer is parsed normally) and
s3cab's last-wins reading of a repeated path. The rules once scattered through
[guide/format.md](../../guide/format.md) ("at most once", the restorer's `..` bullet, "ignore
anything after `#END`") are one section there, "Valid and invalid files". Applies to the layouts of
[0098](0098-snapshot-row-layout.md) and [0102](0102-deletion-record-takes-the-snapshot-layout.md).

## Decision

### A valid file

A valid file is what s3cab writes: UTF-8 with LF endings, the heading row first and `#S3CAB END`
last; only lowercase types this version knows; every per-path row's path absolute, with no `.` or
`..` segment and no tab, CR or LF, under a `#SET DIR`; each path in at most one per-path row,
whatever its type; and each `object` row's hash 64 lowercase hex, its size decimal, its time the
24-character form.

### Refuse the whole file

When it isn't UTF-8, doesn't start with the heading row, doesn't end with `END`, or holds an
unknown lowercase type: each means the file isn't what it claims, or comes from a newer s3cab, and
restoring part of it would pass for a full restore. **Rows after an `END` refuse the file**, where
0082 parsed them: an `END` that isn't last no longer proves the file whole.

### Refuse one path, restore the rest, exit nonzero

For a malformed `object` or `link` row, a `..` segment, a path under no `DIR`, or a path in two
`object` or `link` rows, where **both rows are refused so no reader guesses**.

- A `#` row repeating a content row's path makes the file invalid but changes nothing a reader
  restores, since only one row carries content, so a reader that skips `#` rows never parses them
  for this.
- This is the spec's "restore everything you can, then report", which already governs a missing
  object; rows are independent lines, so one can't damage its neighbours.
- Elsewhere a refused path is one with no row: `backup` re-hashes it, `compare` lists it as
  unreadable, as for `#error`, and `verify` reports damage.

### A malformed `#deleted` row is refused, and its record is distrusted

The row is refused, so its object counts as not deleted, and its absence is reported as
unexplained damage with a nonzero exit. The safe direction: a damaged deletion record can never
make missing content look intentional.

**If any deletion record file is invalid or has a refused row, `backup` drops its trusted
baseline and falls back to the store LIST, and `cleanup` refuses to compact**, as its
unreadable-snapshot interlock already does. `backup` subtracts record hashes from a trusted
baseline ([0090](0090-deletion-record-format-compaction.md)), so a lost row would let it trust a
baseline that vouches for deleted content; compaction writes only the rows it parsed into a fresh
index and then deletes the original, so a refused row would be lost for good.

### Ignore

An unknown `#` type or sub-type, and a people-only row that's wrong (`FILES` against the row
count).

### What a reader promises, even for an invalid file

It never writes outside the destination, never writes bytes that don't hash to the row, never
chooses between conflicting rows, and never lets a partial restore pass for a full one. What it
can't promise is that a valid but edited file is true: a hash changed to another stored object
restores the wrong content faithfully.

**Whole-file integrity is gzip's CRC-32 and length check**, which a snapshot's decompression
verifies; the uncompressed deletion record has only its `END`. Not the store's ETag: it is a
content hash only for single-part uploads to AWS, which is why `matchRemoteSnapshot` compares
bytes.

## Consequences

s3cab's reader changes: a row with an empty field refuses its path, not the file; a repeated path
refuses both rows, not last-wins; and the hash, size and time are checked, where before a
63-digit hash was accepted and failed later.

`cleanup` aborts, dry run included, on a snapshot with a refused row: the row references nothing,
so content only it names would look orphaned and be deleted. This is the unreadable-snapshot
interlock again, for one path instead of a whole file. It refuses to act on an invalid deletion
record at all, not only to compact it.
