# The snapshot file: five columns, typed rows, one fact per row

**Status:** accepted & implemented (proposed 2026-10-11). Partly supersedes
[0082](0082-snapshot-end-trailer.md) (the trailer's shape and its `COMPLETE`/`PARTIAL` status),
[0072](0072-timestamps-utc-in-files-local-in-names.md)'s `#SNAPSHOT` line (the instant and zone it
records stand) and [0092](0092-recover-the-interrupted-work-file.md)'s "costs a gracefully parked
file nothing". Extends [0004](0004-tsv-snapshot-manifests.md). Links are
[0099](0099-links-recorded-never-followed.md), the tab/CR/LF rule
[0100](0100-tab-cr-lf-refused-or-spelled-out.md), what a reader accepts
[0101](0101-valid-and-invalid-files.md), the deletion record
[0102](0102-deletion-record-takes-the-snapshot-layout.md).

## Context

The four-column grammar grew one marker row at a time: `#SNAPSHOT` repurposed the columns (0072),
`#END` gained a status and an instant (0082), `#EXCLUDED` and `#SKIPPED` carried an entry-type
column. Each `#` row's columns mean something different, not every metadata row obeys the
four-field grammar, and a file found on its own says neither what it is nor where it is explained.

The aims of the new layout: it reads well in Notepad, and Excel's AutoFilter, sorting and `SUM`
all work on it. Pre-1.0, nothing existing constrains it: not old snapshots, not the clean-room
golden set or its restorers.

## Decision

| Col | Heading | Width | File row | Other rows |
| --- | --- | --- | --- | --- |
| 1 | `#S3CAB` | 6 | `object` | the row's type |
| 2 | | 64 | the hash | the property (`#S3CAB`, `#SET`, `#SNAPSHOT`), a per-path row's wide text (a pattern, an error, a link target), or a `#deleted` row's hash |
| 3 | `size` | 12, right-aligned | size in bytes | a `#deleted` row's size; otherwise blank |
| 4 | `time` | 24 | mtime | an instant, where the row has one |
| 5 | | ragged | the path | the path, or the property's value |

```
#S3CAB                 size          time                      https://s3cab.plantegral.com/guide/format
#S3CAB     VERSION                                           0.14.0
#S3CAB     HOME                                              C:\Users\allen\.s3cab\
#SET       NAME                                              onedrive
#SET       BUCKET                                            s3://my-backups
#SET       DIR                                               D:\OneDrive\
#SET       EXCLUDE                                           ~$*
#SNAPSHOT  NAME                                              2026-10-08T1656
#SNAPSHOT  BY                                                allen@DESKTOP-7Q2K
#SNAPSHOT  START                   2026-10-08T15:56:00.000Z  Europe/London
#excluded  ~$*                                               D:\OneDrive\~$budget.xlsx
#error     EPERM: operation not permitted, …                 D:\OneDrive\locked.docx
link       ..\2026\img.jpg                                   D:\OneDrive\Photos\latest.jpg
object     9f86d0…    15463758036  2026-08-27T19:11:12.000Z  D:\OneDrive\backup\…\pack-5a31….pack
#SNAPSHOT  FILES                                             281785
#SNAPSHOT  SIZE                                              1234567890123 (1.1 TiB)
#S3CAB     END                     2026-10-08T17:42:10.123Z
```

### The heading row

- **Row 1 is a fixed heading row**, so AutoFilter's dropdowns have names. Its first string,
  `#S3CAB`, is the first thing in the file and says what the file is. Only `size` and `time` are
  named: columns 2 and 5 hold different things on different rows, so column 2 stays blank.
  Measured: blank headings still get a dropdown and filter like named ones; AutoFilter always
  takes row 1 as its heading, so without this row the first property row would play it, showing
  through every filter and never sorting. Data › Sort guesses there is no heading and sorts this
  row in with the rest, unless "My data has headers" is ticked.
- **Its last column is the format spec's URL**, the same in every s3cab file, so a file found on
  its own says where it is explained. Unversioned: after 1.0 the format only changes additively,
  so the current spec describes every older file, and `#S3CAB VERSION` says which release wrote
  it. It freezes the URL into every stored file, so keeping the domain and not renaming
  `guide/format.md` (CLAUDE.md) now protect data, not just binaries. Excel imports it as text,
  not a hyperlink.

### Row types

- **A lowercase type is something restore could act on; a `#` type is not.** `object` and `link`
  are the backup's content: a link is recorded as itself, though it has no object. `#excluded`
  and `#error` record paths that weren't saved, alongside `#SET` and `#SNAPSHOT`. So a reader that
  skips `#` lines is left with exactly what a restore could write.
- **Case says the scope: lowercase is one path from inside the walk, uppercase is the whole
  snapshot from outside it.** `object`, `link`, `#excluded` and `#error` against `#S3CAB`, `#SET`
  and `#SNAPSHOT`. Types are case-sensitive; Excel's sort and filter ignore case.
- **A type names what column 2 holds**: an `object` row's column 2 is the object's name, a `link`
  row's the link's target, an `#error` row's the message. Not `file`: every per-path row is about
  a file, so `file` would name column 5 instead. Not `sha256`: the hash is SHA-256 by design
  ([0001](0001-file-level-content-addressable-dedup.md)) and names the stored objects, so another
  algorithm would be a format change anyway; the spec says so once. Two paths with the same
  content are two `object` rows naming one object, which is what dedup means.
- **Each per-path row can name a file or a folder, and a folder's path ends with a separator**
  (`…\cache\`). That replaces the entry-type column `#EXCLUDED` and `#SKIPPED` carried.
- **A reader skips a `#` type or sub-type it doesn't know, and refuses a lowercase type it doesn't
  know.** An unknown `#` row is information a newer s3cab added; an unknown lowercase row is
  content a restore would miss. So a new property stays additive after 1.0, and new content is a
  format break that says so.

### Columns

- **Hash first**, because it is the primary key; then the fixed-width fields, and the path last as
  the ragged edge (0004). Size and time stay in that order: hash and size describe the stored
  object, time and path the file at that path.
- **Size holds file sizes only**, so `=SUM` over it is the backup's total. A total stored in that
  column would double it. 12 wide because the largest file in a real set has an 11-digit size (a
  14.4 GiB git pack).
- **Column 1 is 6 wide, the length of `object`**, so an object row carries no padding there, and
  its hash and mtime are exactly their widths too. Excel keeps padding in the cell, leading or
  trailing (measured: a type padded to 9 imports as `sha256   `, so `=COUNTIF(A:A,"sha256")` is
  0), and a padded column would put it on every object row. `#SNAPSHOT` and `#excluded` overflow
  instead, which pushes the rest of their row one tab stop right in Notepad: in a real set's
  snapshot, 37 rows (32 exclusions and the five `#SNAPSHOT` rows) beside 281,785 object rows.
- **Excel's ascending sort** puts `#…` before words: `#error`, `#excluded`, `#S3CAB`, `#SET`,
  `#SNAPSHOT`, `link`, `object`. Padded sizes import as numbers, and `SUM` is right.

### Whole-snapshot rows: one fact per row

A snapshot found on its own says where it came from. Column 2 is the property; the value goes in
the last column, an instant in the time column. Each records things as this run saw them, so a
value can go stale later without the row being wrong.

- **`#S3CAB`** is the file itself and the software that wrote it: `VERSION`, `HOME` (the s3cab
  home on that machine) and `END`. The set's directory and this snapshot's local path follow from
  `HOME` and the names, so neither is recorded.
- **`#SET`** is the set's configuration: `NAME`, `BUCKET`, `ENDPOINT` (only for a provider other
  than AWS, where a bucket name alone doesn't say where it is), `DIR` once per member directory,
  and `EXCLUDE` once per exclude pattern in force. The bucket's paths follow from `BUCKET` and the
  layout the spec fixes. The bucket's copy of `exclude.txt` is only the latest; these rows say
  which patterns applied to this run, including ones that matched nothing.
- **`#SNAPSHOT`** is the run: `NAME`, `BY`, `START`, `FILES`, `SIZE`. `BY` is `user@machine`.
  `START`'s last column is the time zone: the name is local wall-clock time, so the zone is what
  ties it to the instant (`1656` in London in October is `15:56Z`).
- **`FILES` and `SIZE` are exact**, so each checks something: `FILES` against the count of `object`
  rows, `SIZE` against `=SUM` of the size column. `SIZE` carries a readable form in parentheses,
  which also keeps it text: a bare 13-digit number shows as `1.23E+12` in a column of default
  width. They come just before `END`.

### `#S3CAB END` means the file is complete

**`#S3CAB END` is the last line of every s3cab file.** A file without it was cut short, whatever
the cause, so one check reads every kind. Its instant is when the file was finished, which for a
snapshot is when the run finished.

So the lookup file parked on Ctrl+C ([0067](0067-park-hashes-on-interrupt.md)) stops after its
last object row, with no `FILES`, `SIZE` or `END`, and the `COMPLETE`/`PARTIAL` status goes. That
file is only read back by 0092's tolerant read, which drops the last row, so a graceful stop now
costs one file re-hashed, as a killed run already does.

### Who reads each property

| Read by the code | What reads it |
| --- | --- |
| `object`: hash, size, time, path | restore, compare, backup's hash reuse and upload |
| `link`: target, path | compare, so a link isn't reported deleted; a future restore that recreates links |
| `#error`: message, path | compare ([0079](0079-previously-unreadable-file-is-an-annotated-addition.md)); backup's exclude suggestions |
| `#SET DIR` | `restore --output`, which re-roots by it |
| `#SNAPSHOT START`'s instant | compare's out-of-order warning; ignoring a stale parked lookup; the change-time check's boundary |
| the heading row, and `#S3CAB END` as the last line | the validity check (0101) |
| `#deleted`: hash, instant | verify, restore, backup, status, forget, cleanup (0102) |

**Read only by people:** `#S3CAB VERSION` and `HOME`, `#SET NAME` (deliberately not checked, see
`readParkedLookup`), `#SET BUCKET`/`ENDPOINT`/`EXCLUDE`, `#SNAPSHOT NAME` (the code takes the
filename), `BY`, `START`'s zone, `FILES` and `SIZE` (a hand edit can change either, so a mismatch
isn't damage), `#S3CAB END`'s instant, every `#excluded` row, and a `#deleted` row's size and
`user@machine`. A reader skips these the way it skips an unknown sub-type, so it needn't parse
them; promoting one to the code later is a feature change, not a format one.

### Who did something is always `user@machine`

`#SNAPSHOT BY` and a `#deleted` row's last column are `user@machine`, and the set's `info`
`OWNER` follows, where it was the bare hostname. The user belongs in `OWNER` because the
collision rule is "first person wins" ([0024](0024-set-name-is-the-whole-identity.md)), and
`OWNER` is advisory, so this doesn't put the user back into the set's identity. `reattach`
compares `OWNER` with `user@machine` too, so another user on the same machine now also counts as
a change of owner. The keys stay distinct: `OWNER` claimed the set, `BY` ran the snapshot. Not
split into two fields: a `#deleted` row has only its last column free.

### A folder that can't be listed stops the walk

It gets no `#error` row.

## Considered and rejected

- **The set's `info` marker in the snapshot.** `OWNER` is whoever claimed the set, not
  necessarily who ran, and both it and `CREATED` would cost a bucket read per run.
- **A versioned spec URL.** After 1.0 the format only changes additively, so the current spec
  describes every older file; `#S3CAB VERSION` already says which release wrote one.
- **Padding column 1 to its longest type.** Excel keeps the padding in the cell, on every object
  row (above).

## Consequences

- **Not built; a program could use these:** `#S3CAB VERSION`, to name the release that wrote a
  file the unknown-type rule refuses, so the error says what to upgrade to; `#excluded` rows, so
  `compare` reports a path a newly added pattern drops as excluded, not deleted, which reopens the
  choice `snapshot-file.mjs` records (only `tree --excluded` answers "what are my patterns
  dropping?") though it answers a different question; `#SET BUCKET`/`ENDPOINT`, to restore from a
  lone snapshot with no set configured, the most speculative of the three.
- **The clean-room golden set is reseeded** after [guide/format.md](../../guide/format.md) is
  rewritten, and the held Windows (C#) clean-room run follows it
  ([0096](0096-three-implementations-prove-the-format.md)).
- No reader for the four-column layout: pre-1.0, old snapshots are re-taken.
