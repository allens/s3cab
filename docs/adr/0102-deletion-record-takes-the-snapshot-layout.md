# The deletion record takes the snapshot's layout: `#deleted` rows

**Status:** accepted & implemented (proposed 2026-10-11); partly superseded by
[0103](0103-row-marks-and-unrecorded-links.md): the property rows are `@S3CAB`. Partly supersedes
[0090](0090-deletion-record-format-compaction.md)'s Rows section. What 0090 decided about the
record's job stays: no paths, numbered files at the bucket root, uncompressed, compacted by
`cleanup`. The layout is [0098](0098-snapshot-row-layout.md); what a reader does with a malformed
row is [0101](0101-valid-and-invalid-files.md).

## Decision

The unpadded `hash / size / instant / user@machine` rows become `#deleted` rows in the five
columns, the deletion instant in the time column and `user@machine` last, the form
`#SNAPSHOT BY` uses. The file has the heading row, `#S3CAB VERSION` and `HOME`, and ends with
`#S3CAB END`.

```
#S3CAB                 size          time                      https://s3cab.plantegral.com/guide/format
#S3CAB     VERSION                                           0.14.0
#S3CAB     HOME                                              C:\Users\allen\.s3cab\
#deleted   a3f9c21e…60d         1204  2026-08-14T09:31:07.412Z  allen@DESKTOP
#deleted   5e21ab7f…c93          892  2026-08-19T22:10:41.006Z  allen@LAPTOP
#S3CAB     END                        2026-10-10T09:12:00.000Z
```

- **`#deleted`, lowercase with a `#`**: one object, and nothing restore can act on, like
  `#excluded` and `#error`. The type replaces 0090's test of a 64-hex first field as what makes a
  row count.
- **The `#DELETED` header goes.** Its instant repeats the rows', and its sentence ("absence here
  is not damage") is now said by every row's type; the spec says the rest.
- **No `#SET`, `#SNAPSHOT`, bucket or count rows.** A record belongs to the bucket, not a set or a
  run, and only means anything inside it. `#S3CAB END` already proves it whole, which matters
  because a lost row lets `backup` trust a baseline that vouches for deleted content.
- **`#deleted` is 8 characters, so it overflows column 1 on every row.** The rows still line up
  with one another; only the `#S3CAB` rows sit one tab stop left.
- **Read by the code:** the hash and the instant, which keeps the newest of repeated rows and is
  shown as a date. The size and `user@machine` are for people.

## Consequences

- 0090's bare `#END` and its "no `COMPLETE`/`PARTIAL`" reasoning are moot: every s3cab file now
  ends with `#S3CAB END`, and the status is gone everywhere (0098).
- The record shares the snapshot's padder, heading row and `END` writer, so the two layouts can't
  drift.
