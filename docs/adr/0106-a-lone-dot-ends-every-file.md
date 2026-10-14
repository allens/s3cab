# A lone `.` ends every s3cab file; `@SNAPSHOT FINISH` takes the instant

**Status:** accepted & implemented (2026-10-14). Partly supersedes
[0082](0082-snapshot-end-trailer.md) (the trailer is the `.` line, not a row),
[0098](0098-snapshot-row-layout.md) (`@S3CAB END` goes; its instant moves to `@SNAPSHOT FINISH`),
[0101](0101-valid-and-invalid-files.md) (the last line a valid file ends with) and
[0102](0102-deletion-record-takes-the-snapshot-layout.md) (the record ends with the `.`, and has
no finish instant). What 0082 built the trailer for stands: completeness is a property of the
content, and a file without its last line is truncated.

## Context

`@S3CAB END`'s last field was empty, so it was the one line in an s3cab file ending in a tab. An
editor's trim-on-save deletes that tab, which leaves four fields, and a strict reader refuses the
file. Deletion records are plain text, so they are the files most likely to be hand-edited.

The row could also pass when torn: a write cut just after the word `END` still met `isEndLine`,
which compared the first two fields only.

Its instant has been kept for people only since [0094](0094-change-time-check-opt-in.md), so it
needn't sit on the line that proves completeness.

## Decision

1. **The last line of every s3cab file, snapshot and deletion record, is exactly `.`** with its
   LF. A file without it is truncated, and any row after it refuses the file (0101). It is a
   terminator, not a row: the one stated exception to "every line has five fields" and "the first
   field is the row's type".
2. **`@SNAPSHOT FINISH`** comes after `@SNAPSHOT SIZE` and immediately before the `.`. Column 4 is
   the instant the last row was written, rounded up to the millisecond as `END`'s was. Column 5 is
   the run's duration in the compact form `backup`'s closing report prints (`9s`, `12m 21s`,
   `3h 04m`).
3. **The duration is free text**, one of the values written for people beside `VERSION`, `HOME`,
   `BY` and `START`'s zone. The exact figure is `FINISH` minus `START`; no reader parses it.
4. **A deletion record has no finish instant**: its `#deleted` rows, then the `.`. Each row
   carries its own instant.

`.` is the established line terminator (SMTP, POP3, NNTP). It survives trimming and any
encoding, and it can't collide with a row, since every row starts with `-`, `@` or `#`. A
line is whole once its LF is written, the `.` included, so a reader trusts every line that has
one. The tolerant work-file read ([0092](0092-recover-the-interrupted-work-file.md)) now keeps a
parked file's last row, where 0098 dropped it; it drops only a final line with no LF.

A time zone in `FINISH` was considered and dropped: `START` has it.

## Consequences

- Trim-on-save leaves the `.` as it is, so a hand-edited deletion record stays valid. An editor
  that saves CRLF line endings still breaks the file, as before: lines end with LF alone.
- Every file written before this change is refused as truncated. Pre-1.0 policy: no
  compatibility reader. The clean-room restore bucket's golden set is reseeded after it lands.
