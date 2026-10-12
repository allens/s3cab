# `@` properties, `-` files, `#` paths that don't restore; links are never recorded

**Status:** accepted (2026-10-12). Partly supersedes [0098](0098-snapshot-row-layout.md) (its
row types, the heading row's blank column 2, column 1's width and the reader rule), most of
[0099](0099-links-recorded-never-followed.md) (the `link` row, and the warning for a link leading
out of the backup; "never followed", the check and the profile junctions stand),
[0100](0100-tab-cr-lf-refused-or-spelled-out.md)'s refusal of a tab, CR or LF in a link's path and
target,
and the type names in [0101](0101-valid-and-invalid-files.md) and
[0102](0102-deletion-record-takes-the-snapshot-layout.md). The five columns, one fact per row and
`END` last stand.

## Context

A `link` row's target sat in column 2, where padding and the reader's trim lose a leading or
trailing space, and a target is a name that may have them. Quoting it would make spreadsheets
unquote it, and Excel then needs every inner `"` doubled. Recording links at all was borderline:
s3cab restores the files a user chose, and a link only says where content lives.

With `link` gone, `object` is the one content type, written on every file row. And `#` was doing
two jobs that now pull apart: it said "a restore doesn't act on this row", and it made the
property rows look like comments, though `restore --output` re-roots by `#SET DIR` and `#S3CAB
END` proves the file whole. `grep -v '^#'`, or any tool that drops comments, threw those away.

## Decision

### Links are never followed and never recorded

| Link | Recorded |
| --- | --- |
| Target inside a member directory | no row; the target is saved under its own path |
| Target a file or folder outside every member directory, or can't be resolved | `#error`, and `backup` exits 1 |
| Broken, loops, or leads to a pipe, socket or device | no row |
| Matched by an exclude pattern | `#excluded`, like any excluded entry |

- **File links and folder links take the same rule.** Following a file link doubled a non-link
  restore for every link into the backup (0099), and a link out of the backup is content the user
  may think is saved and isn't.
- **A link out of the backup is an error until the user decides**: add the target's folder to the
  set, or exclude the link. A folder link can hide a whole tree, the case that matters, and a
  warning that exits 0 is one a scheduled run never shows. The snapshot is still published, as for
  any `#error`. The `#error` message names the target; it is text for people, spelled out like any
  message (0100).
- **Many links to exclude is a matter for the exclude UX** (the proposed `exclude` command), not
  for the format.
- 0099's end-of-walk warning, the `link` row and its trailing-separator rule go. Restore never
  recreates links, which is 0070's "regular files only" again.

### Each row's first character says what it is

```
@S3CAB    FORMAT                                 size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    VERSION                                                                0.14.0
@SET      DIR                                                                    C:\Users\me\Photos\
@SNAPSHOT START                                        2026-06-12T08:15:32.123Z  Europe/London
#excluded *.tmp                                                                  C:\Users\me\Photos\upload.tmp
#error    EPERM: operation not permitted, …                                      D:\Pics\locked.jpg
#error    link to a folder outside the b…                                        C:\Users\me\Photos\Shared\
-         3b8e…c0a1                           4915200  2025-06-01T12:00:00.000Z  C:\Users\me\Photos\2025\beach.jpg
@SNAPSHOT FILES                                                                  1
@S3CAB    END                                          2026-06-12T08:15:40.871Z
```

- **`@` and a word in capitals: a property** of the whole file: `@S3CAB`, `@SET`, `@SNAPSHOT`,
  each with its sub-property in column 2 as before. Prior art: SAM's `@HD`/`@SQ` header lines
  above tab-separated data rows, and ARFF's `@ATTRIBUTE`.
- **`-`: a file**, the content a restore writes, as in `ls -l`. A symbol stands apart from the
  wordy rows around it without being learned.
- **`#` and a word in lowercase: a path a restore doesn't act on**: `#excluded`, `#error`, and
  the deletion record's `#deleted`. Not "for people only": `backup` and `compare` read `#error`,
  and `cleanup` reads `#deleted`. A tool that drops comments keeps exactly the properties and the
  files, which is a restore's view.
- **The heading row is `@S3CAB FORMAT`, with the spec's URL as its value**, so it reads as the
  property row it sits above, not as a row missing its sub-property. AutoFilter labels column B
  `FORMAT`; column A was already `#S3CAB` and E the URL, so row 1 was never true column names.
- **A reader skips an `@` or `#` type, or a sub-property, that it doesn't know, and refuses the
  file for any other type it doesn't know.** An unknown `@` or `#` row is something a newer s3cab
  added that a restore needn't act on; an unknown row of any other kind may be content a restore
  would miss. New properties and new not-restored rows stay additive after 1.0.
- **Column 1 is unpadded, as wide as `-`**, for 0098's reason: Excel keeps padding in the cell, so
  a padded `-` would defeat `=COUNTIF(A:A,"-")` on every file row. Rows of one type always line up
  with each other, since the columns after the type are padded; in Notepad (tab stops every 8),
  every type of up to 7 characters lines up with `-`, and `@SNAPSHOT`, `#excluded` and `#deleted`
  sit one tab stop right.

### Measured in three spreadsheets

Each type imports as text, padded or not, in Excel (Data › From Text defaults), LibreOffice Calc
(tab-separated, formula evaluation on and off) and Google Sheets (File › Import, "convert text to
numbers, dates, and formulas" ticked). Each run had a `=1+1` control that did become a formula, so
the imports were converting. Excel's ascending sort: `-`, then `#deleted`, `#error`, `#excluded`,
then `@S3CAB`, `@SET`, `@SNAPSHOT`.

**Traps when naming a type:** a `-` followed by a word is a formula in Excel (`-error` imports as
`=-error`, shown as `#NAME?`; LibreOffice and Sheets leave it as text); a lone digit imports as a
number; a type spelled like an Excel error value (`#N/A`, `#REF!`) imports as that error.

## Considered and rejected

- **Keeping `object`**: the same word on every file row, and the only content type left.
- **A blank type for files**: an absence is the easiest thing to lose to a trim or a hand edit.
- **`#` on file rows and bare property words**: file rows would read as comments, and `grep -v
  '^#'` or R's `read.table` would drop every file.
- **Bare words for properties** (`SET DIR`): readable, but every row kind then has a mark except
  one, and `@` reads as "an instruction", not a comment.
- **Single-character marks for not-restored rows** (`!`, `~`, `^`, `:`, `.`, `0`): `.` all but
  disappears beside `-`, `0` imports as a number, and none but `!` says what it means; the words
  need no learning.
- **`-error`, `-excluded`, `-deleted`**: formulas in Excel.
- **Padding column 1 to its longest type** (9): aligned in every editor, but 8 spaces in the cell
  of every file row.
- **Quoting a link's target**, a **sixth column** for it, or **a people-only `#link` row**: a
  recorded target is a field someone will read with a program one day, and the only reason to
  have it is a restore that recreates links, which s3cab doesn't do.
- **Four columns, with no type column**: the file row could be told by its hash, but an `#error`
  needs its type, its message in the wide column and its path, which takes all five.

## Consequences

- Every reader and writer of the row types changes: `snapshot-file.mjs`, the deletion record,
  `compare`, `render`, the walk (a link out of the backup becomes an `#error`; `compare` no longer
  reads links), [guide/format.md](../../guide/format.md) and [CONTEXT.md](../../CONTEXT.md).
- The clean-room harness and its fixtures change shape, and the golden set is reseeded.
- A set that holds a link to outside content starts exiting 1 on its first run under this
  version, and names each such link, until its folder is added or it's excluded.
