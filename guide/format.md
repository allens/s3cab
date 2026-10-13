# The s3cab format spec — repository & snapshot files

s3cab's core promise is **no lock-in**: everything it stores — in your bucket and on your
machine — is plain, self-evident files you can read and act on without s3cab. In principle
you could recover everything with no documentation at all, just by looking at what's there.
This page writes the format down anyway, for two reasons: it makes recovery *much* easier,
and it keeps the project honest — a human-readable mirror of the true format that the code
must always match.

Every rule and recommendation on this page is a **commitment**, not an implementation
detail. If a future s3cab needs to change any of it, that is a breaking format change,
treated accordingly.
One exception, flagged again where it arises: a snapshot may gain new `@` and `#` row types
and properties, and a reader skips the ones it doesn't know. What is committed is that
skipping every `#` row leaves exactly what a restore reads: the properties and the files.

## Rules, recommendations and hints

The page holds three kinds of thing, for anyone writing their own tool against it:

- **Rules.** Break one and another tool misreads your files or loses data. Every rule is in
  one of the checklists under [writing your own tool](#writing-your-own-tool): reading,
  writing a snapshot, uploading and deleting. The rest of the page explains them.
- **Recommendations.** How s3cab lays a snapshot or deletion record out, so it reads as a
  table in an editor and works in a spreadsheet: its [canonical form](#canonical-form).
  Another writer should match it; no reader depends on it.
- **Hints.** What trips people up when they meet these files from a particular language or
  operating system. Never a requirement, and listed beside each checklist.

So a snapshot or deletion record is **valid** when it meets the rules, which is all any
reader needs, and **canonical** when it is also laid out exactly as s3cab would lay it out.

## Reading the text: four rules that hold everywhere

These come first because they govern **every** text file in the format — snapshots,
deletion records, `dirs.txt`, `exclude.txt`, `info`. Get them right and nothing else below
needs special handling.

- **UTF-8, no BOM**, always, whatever machine wrote the file. A path is stored as its UTF-8
  bytes even on Windows, where the operating system itself holds names as UTF-16. Decode
  strictly: a decode error means the file is damaged, not that some other encoding is worth
  trying.
- **Every file s3cab generates ends its lines with LF** (`\n`), never CRLF, and the last
  line is terminated like the rest — snapshots, deletion records, `dirs.txt`, `info`. Split
  on LF *exactly*: a legal filename can hold other characters that some line splitters break
  on, which cuts a path in half and never says why. **`exclude.txt` is the one exception, and in the other direction**: it is *yours*, so
  s3cab stores and mirrors it byte-for-byte as you wrote it — a Windows editor's CRLF, or a
  missing final newline, travels into the bucket intact. Harmless, because its lines (and
  `dirs.txt`'s) are trimmed when read: of tab, VT, FF, CR, LF, every Unicode space
  (category Zs), U+2028, U+2029 and a byte-order mark, but not U+0085.
- **Nothing is quoted or escaped** — that plainness is the whole point. It is what makes a
  naive `split("\t")` safe, and it is why no field in a snapshot holds a real tab, LF or CR
  (a path with one is [refused at backup time](#what-is-deliberately-not-stored), and
  anywhere else [they are spelled out](#no-row-holds-a-tab-or-a-line-ending)). Every other
  character, control characters included, is fair game in a path.
- **Trim the leading fields; never trim the last.** The leading fields are padded with
  spaces so the raw file reads as columns, and are trimmed of the same characters as
  `exclude.txt`'s lines. The last field — a path, or a property's value —
  is never padded, and must be taken **verbatim** from the final tab to the end of the line.
  On Linux and macOS a filename may legitimately begin or end with a space, and a parser that
  strips every field restores `" notes.txt "` as `"notes.txt"` — the wrong file, with nothing
  reported.

## The remote repository (the keystone)

One S3 bucket is one **repository** — the layout is fixed by convention, never an arbitrary
prefix, so anything (s3cab, another tool, or you by hand) can find everything:

```
s3://my-backup-bucket/
  objects/<sha256>                  # every backed-up file, stored once, named by content hash
  snapshots/<set>/<name>.tsv.gz     # each backup set's snapshot files
  sets/<set>/                       # each set's config + ownership marker
    info                            # owner (user@machine) + created date (the name-claim marker)
    dirs.txt                        # the set's member directories, one per line
    exclude.txt                     # the set's exclude patterns (if it has any)
  objects.deleted-<n>.tsv           # deliberate-deletion records (only if `delete` has run)
```

- **`objects/`** is the content-addressed store: one object per unique file content, keyed
  by the lowercase-hex SHA-256 of its bytes. Identical content — under any name, from any
  set or machine — is stored exactly once, bucket-wide. Objects carry **no metadata**: an
  object is *content*, and the same bytes may be a dozen different files, so there is no one
  name, date or owner to record. **The snapshot is the index** — it is what maps a name to a
  hash. Keep one: given only `objects/`, you have your data but no way to tell what any of it
  was. (This is why snapshots are immutable and never overwritten.)
- **`snapshots/<set>/`** holds one backup set's snapshot files, named by a minute-precision
  local timestamp (`2026-06-12T0915.tsv.gz`). A remote snapshot file is **byte-identical**
  to its local counterpart — uploaded as-is, one format everywhere.
- **`sets/<set>/`** marks the set's existence (a set with no snapshots yet would otherwise
  be invisible), records which machine holds it, and carries the set's
  `dirs.txt`/`exclude.txt` so a fresh machine can adopt it
  (`s3cab reattach <set>`). `exclude.txt` is a verbatim byte copy; `dirs.txt` is the
  **parsed** directory list, one per line — comments and blank lines in your local file
  aren't carried up. The set's local `env` file is **never** uploaded — it
  can hold credentials. `info` is two `KEY=value` lines, in this order:

  ```
  OWNER=allen@DESKTOP
  CREATED=2026-06-12T08:15:32.123Z
  ```

  `OWNER` is the user and machine the set is attached to, as `user@machine` — stamped at
  creation and re-stamped by `s3cab reattach`, so it names the current holder, not
  necessarily the creator; `CREATED` is a UTC instant in the same form as a snapshot row's
  `mtime`, and is preserved across reattaches.
- **`objects.deleted-<n>.tsv`** — the repository's only root-level keys — are its
  [deletion records](#the-deletion-record): small plain-text files marking content as
  *deliberately* removed. A repository where `delete` has never run simply has none.

### The invariant: objects first, snapshot last

**A snapshot's presence under `snapshots/` guarantees every object it references is already
present under `objects/`.** s3cab uploads all missing objects first and the snapshot file
last, so any snapshot you find in a bucket — however the backup run that wrote it ended —
is complete and restorable. A crash mid-backup leaves only *orphan* objects (uploaded but
referenced by no snapshot), which are harmless: they cost only storage and the retried
backup reuses them.

Two rules follow for **any** tool that deletes from a repository:

- **never delete an object younger than a generous grace window** (s3cab's rule: 7 days) —
  under objects-first, an in-flight backup's fresh uploads are indistinguishable from
  orphans;
- **don't clean up while a backup is running.**

### Snapshots are immutable

A snapshot, once written, is never overwritten or modified — locally or remotely. A second
snapshot of the same set in the same minute is an error, not an overwrite, so an accidental
double-run can never destroy history.

### The deletion record

`s3cab delete` removes content from the whole backed-up history by its hash — and because
snapshots are immutable, it does so **without touching a single snapshot file**: it deletes
the backing objects and writes a **deletion record** at the bucket root:
`objects.deleted-1.tsv`, then `-2`, and so on. A record is never overwritten: each run
takes the lowest index not already in use, so two runs — even at the same moment — simply
land on different numbers. The index tells two *files* apart and makes no claim about
time: gaps in the sequence are normal (see compaction below), and *when* and *who* live
inside the rows.

**Read every `objects.deleted-<n>.tsv` key, and treat them as one set.** A hash is
deliberately gone if *any* record row lists it. Nothing depends on which file a row sits
in: when two rows list the same hash, the only thing at stake is cosmetic — which date to
show for it — and s3cab shows the newest row's.

The record is what lets any tool — s3cab or a future reader of the bare files — tell
*deliberately gone* from *corrupted*: an object a snapshot references but the store lacks is
**expected** if a record lists its hash, and an integrity fault if none does. A record
carries **no paths** — whoever meets the absence is already holding a snapshot with the
path in front of them; what the record adds is that the absence is deliberate, when, and by
whom.

A record is plain, uncompressed text in a snapshot's [five columns](#the-columns): the same
heading row and `@S3CAB` rows first, then one `#deleted` row per deleted object, and
`@S3CAB END` last:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    VERSION                                                     0.14.0
@S3CAB    HOME                                                        C:\Users\me\.s3cab\
#deleted  a3f9…c60d                   1204  2026-08-14T09:31:07.412Z  me@DESKTOP
#deleted  5e21…ac93                    892  2026-08-19T22:10:41.006Z  me@LAPTOP
@S3CAB    END                               2026-10-10T09:12:00.000Z
```

That example lines up and narrows the columns the way the [snapshot example](#snapshot-files)
does.

Rules for a reader: each `#deleted` row is one deleted object. Its second field is the
object's hash — 64 lowercase hex characters, its old key under `objects/` — the third its
stored size in bytes, the fourth the UTC instant the delete ran, and the last who ran it, as
`user@machine`. Skip every other `@` or `#` row. `@S3CAB END` says the file is whole, as it does for
a snapshot, and [valid and invalid files](#valid-and-invalid-files) covers a record that
isn't. A record has no `@SET` or `@SNAPSHOT` rows: it belongs to the bucket, not to one
set or one backup run.

**Records are compacted, not kept forever.** `s3cab cleanup` merges every record file into
one fresh file (at the next free index) and drops rows whose hash **no snapshot anywhere
references** — once nothing references a hash, nothing can ever ask why it is absent, so
the row has no reader left. The merge is written *before* the absorbed files are deleted,
so a reader at any moment sees every live row at least once; a row duplicated across two
files is harmless. This is why when and who live in the rows: filenames don't survive
compaction.

**Presence always wins.** A record explains an object's *absence*; it does not forbid its
return. If a hash turns up in `objects/` again — content deleted, then later backed up
afresh — then the file is restorable and should be restored. Consult the records only when
a fetch actually misses. A reader that treats records as authoritative skips restorable
files indefinitely, and reports success while doing it.

The **write ordering is a commitment**: a record is always written *before* its objects are
deleted, so a crash mid-delete can never leave a missing object the records don't explain.
s3cab's own tools honour the record everywhere — `verify`
reports recorded hashes as expected (not damage, exit 0), `restore` skips them gracefully
with their deletion date, and `backup` knows not to trust an older snapshot's word that the
content is still stored.

### What is deliberately not stored

- **No client-side encryption.** Encrypted objects would be exactly the opaque blobs the
  no-lock-in promise forbids, and encryption breaks content-addressed dedup. The answer is
  server-side encryption (s3cab already requests it on AWS), bucket access policy, and
  provider trust.
- **Paths containing a tab, a line feed, or a carriage return.** All three would break the
  row grammar, and the format has no escaping by design — that plainness is the point. (A
  bare CR counts: plenty of line-splitters treat it as a line ending, so allowing one would
  hand different readers different answers.) Such names are legal only on Linux and macOS
  (Windows forbids them outright) and are almost always a script bug rather than a choice.
  A file with one is **not backed up**: the run stops and names it, so you can rename it, or
  exclude it with a pattern like `odd*name.jpg` and run again. Every other character —
  including control characters that are *not* those three — is stored as-is.
- **Names that aren't valid Unicode**, so have no UTF-8 form: a lone surrogate on Windows,
  bytes that aren't UTF-8 on Linux. The file is UTF-8, so such a name can't be written into
  it faithfully, and it is refused the same way: the run stops and names it, and a pattern
  gets past it. Patterns see the name, and its `#excluded` row records it, with U+FFFD (�)
  standing in for each part that doesn't decode, so `*` matches there. U+FFFD is Unicode's
  own replacement character, which Python, Node and most other decoders already put in
  place of bytes that don't decode.
- **File content, not the filesystem around it.** Snapshots record each file's content,
  size, and modification time — [no links](#links), no hardlink identity, no empty
  directories, no permissions or ACLs. Pipes, sockets and devices get no row at all. s3cab
  backs up *data* (documents, photos, video); it is not a system backup tool.

## Snapshot files

A snapshot is a point-in-time record of every file in a backup set: a plain-text,
tab-separated (TSV) table, gzip-compressed on disk and in the bucket (`.tsv.gz` —
decompress with any gzip tool: `gunzip`, or the gzip support built into every mainstream
language). How hard it is compressed is s3cab's choice and may change; what is promised is
plain, single-stream gzip. So compare two snapshots decompressed, never as `.gz` bytes.

The [four reading rules](#reading-the-text-four-rules-that-hold-everywhere) apply here in
full — encoding, LF splitting, no escaping, and never trimming the last field. This section
adds only what is specific to snapshots.

Every line has the same five columns, and the first says what kind of row it is. The file
says where it came from before it lists anything, so it is self-describing even found alone
in a bucket:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    VERSION                                                     0.14.0
@S3CAB    HOME                                                        C:\Users\me\.s3cab\
@SET      NAME                                                        photos
@SET      BUCKET                                                      s3://my-backup-bucket
@SET      DIR                                                         C:\Users\me\Photos\
@SET      DIR                                                         D:\Pics\
@SET      EXCLUDE                                                     *.tmp
@SNAPSHOT NAME                                                        2026-06-12T0915
@SNAPSHOT BY                                                          me@DESKTOP
@SNAPSHOT START                             2026-06-12T08:15:32.123Z  Europe/London
#excluded *.tmp                                                       C:\Users\me\Photos\upload.tmp
#error    EPERM: operation …                                          D:\Pics\locked.jpg
#error    link to a folder …                                          C:\Users\me\Photos\Shared\
-         3b8e…c0a1                4915200  2025-06-01T12:00:00.000Z  C:\Users\me\Photos\2025\beach.jpg
-         e3b0…b855                      0  2024-01-01T00:00:00.000Z  D:\Pics\empty.txt
@SNAPSHOT FILES                                                       2
@SNAPSHOT SIZE                                                        4915200 (4.9MB)
@S3CAB    END                               2026-06-12T08:15:40.871Z
```

That example lines up the first column and narrows the others to stay readable;
[the real widths](#the-columns) are below.

### The columns

| Col | Width | A file row | Other rows |
| --- | --- | --- | --- |
| 1 | unpadded | `-` | the row's type |
| 2 | 64 | the hash | the property (`FORMAT`, `VERSION`, `DIR`…), a per-path row's text (the pattern, the error), or a `#deleted` row's hash |
| 3 | 12, right-aligned | the size in bytes | a `#deleted` row's size; otherwise blank |
| 4 | 24 | the modification time | an instant, where the row has one |
| 5 | ragged | the path | the path, or the property's value |

For a file row:

- **hash** — the SHA-256 of the file's contents, lowercase hex: both the file's identity
  and its key under `objects/`. Two paths with the same content are two file rows naming
  one object, which is what deduplication means.
- **size** — bytes, in decimal. This column holds file sizes and nothing else, so its sum is
  the backup's total.
- **mtime** — the file's modification time as exactly `YYYY-MM-DDTHH:MM:SS.sssZ`: 24
  characters, always three fractional digits, always a literal trailing `Z`. Never a
  `+00:00` offset, never a comma for the decimal point, never a different digit count.
- **path** — absolute, in the OS's native style, last on the line so the padded columns
  stay aligned and so it can hold spaces without ambiguity.

The columns are separated by tabs, so the file parses as clean TSV in a script.

**The first row is the heading row**, the same in every snapshot and deletion record. Its
five fields, padding aside, are exactly:

| `@S3CAB` | `FORMAT` | `size` | `time` | `https://s3cab.plantegral.com/guide/format` |
| --- | --- | --- | --- | --- |

It names the size and time columns because Excel's AutoFilter takes row 1 as its headings,
and ends with the address of this page, so a file found on its own says where it is
explained.

### Canonical form

s3cab lays every row out the same way, so the file reads as a table in an editor and works in
a spreadsheet. The layout is computed from the row's fields, so each row has exactly one
canonical line:

- **Column 1 is never padded**, so a spreadsheet keeps a file row's type as exactly `-` and
  `=COUNTIF(A:A,"-")` counts them.
- **Columns 2 to 4 are padded with spaces**, blank ones included: column 2 on the right to
  64 characters, column 3 on the left to 12, column 4 on the right to 24. A character here
  is a Unicode code point, so `🎉*.txt` is six.
- **These are minimum widths.** A longer value, such as a long error message, overflows its
  column and is never cut.
- **The last column is never padded.**
- **`@SNAPSHOT SIZE`'s readable form** follows the exact number in parentheses. Under 1000
  bytes it is the whole number and `B` (`0B`, `999B`). Otherwise it is one decimal place,
  rounded half up, in the smallest of kB, MB, GB, TB and PB that keeps it under 1000.0, or
  in PB however large: 999,949 bytes is `999.9kB`, 999,950 is `1.0MB`. Units are powers of
  1000, with no thousands separator.

**Some values are written for people, and are free text**, outside the canonical form: an
`#error` row's wording, `VERSION`, `HOME`, `BY` and `START`'s zone. No reader depends on
them.

### Row types

A row's first character says what it is: `@` a property of the whole file, `-` a file, and
`#` a path a restore doesn't act on.

| Type | Column 2 | Column 4 | Last column |
| --- | --- | --- | --- |
| `-` | the hash | the modification time | the file's path |
| `#excluded` | the exclude pattern that matched | | the path |
| `#error` | the message | | the path |
| `@S3CAB`, `@SET`, `@SNAPSHOT` | the property | the instant, if it has one | the value |

- **`-`** is a file, and the only row with content to fetch.
- **`#excluded`** is an entry an exclude pattern matched, and **`#error`** one s3cab couldn't
  check or read, or a [link](#links) leading out of the backup. Neither is in the backup; the
  row says why. Any `#error` row makes `backup` and `snapshot` exit 1, after the snapshot is
  written.

A tool that drops `#` lines as comments keeps exactly what a restore reads: the properties
and the files.

**A path ending with a separator is a directory** (`C:\Users\me\Photos\cache\`):

- a member directory;
- an excluded directory;
- a link whose target is a directory, in its `#excluded` or `#error` row.

A broken link, or one whose target couldn't be checked, ends without one.

**A reader skips an `@` or `#` type, or a property, that it doesn't know, and refuses a file
holding any other type it doesn't know.** An unknown `@` or `#` row is something a newer
s3cab added that a restore needn't act on; an unknown row of any other kind may be content
a restore would miss, so reading on would pass off part of a backup as all of it. The test,
concretely: take the first tab-separated field and trim it, and compare it case-sensitively
— `@SET` and `@set` are different types, though a spreadsheet's sort and filter ignore case.

### Links

**A symbolic link or junction is never followed and never recorded** — a link can lead
anywhere, including somewhere you never chose to back up. Those are the only links: other
Windows reparse points, such as OneDrive's online-only files, are ordinary files and
directories.

| Link | Row |
| --- | --- |
| Into the backup | none; the target is recorded where it lies, saved or `#excluded` |
| Out of the backup, or somewhere this computer can't resolve | `#error`, the link's own path with the target named in the message, and the backup exits nonzero |
| Broken, or to a pipe, socket or device | none |
| Matched by an exclude pattern | `#excluded`, like any excluded entry |

A link to a file or directory leads **into the backup** when the place it finally resolves
to, through any further links, is a member directory or lies inside one, and **out of the
backup** otherwise.

A link out of the backup is an error because its content may look saved and isn't — a
directory link can hide a whole tree. Add the target's directory to the set, or exclude the link.
The snapshot is still written, as for any `#error`.

A link is **broken** when nothing exists where it points: the target is missing, a path
through it treats a file as a directory, or links lead round in a circle. Anything else that
stops it being followed, such as a share that doesn't answer or a directory you can't read, is
somewhere this computer can't resolve. As a test, following a broken link fails as:

- not found, not a directory, or too many links (`ENOENT`, `ENOTDIR`, `ELOOP`);
- on Windows, winerror 2 or 3 (not found) or 1921 (a loop).

Any other failure is somewhere this computer can't resolve: on Windows, winerror 53 (a host
that doesn't answer) or 67 (no such share), say, though Python raises `FileNotFoundError`
for those too.

The one link that is followed is a **member directory itself**: you named it in `dirs.txt`,
so it is walked, and recorded in `@SET DIR` as its [real path](#paths).

### The whole-snapshot rows

`@S3CAB` is the file and the software that wrote it, `@SET` the set's configuration, and
`@SNAPSHOT` this run. Each row is one fact, and records it as this run saw it, so a value
can go stale later without the row being wrong.

| Row | What it records |
| --- | --- |
| `@S3CAB VERSION` | the s3cab release that wrote the file; s3cab doesn't read it back |
| `@S3CAB HOME` | the [s3cab home](#the-local-side-s3cab) on that machine |
| `@SET NAME` | the set's name |
| `@SET BUCKET` | the bucket, as `s3://<bucket>`; every set has one (`S3CAB_BUCKET`) |
| `@SET ENDPOINT` | the S3 endpoint, whenever the set has one (`AWS_ENDPOINT_URL_S3`, else `AWS_ENDPOINT_URL`); an endpoint is how a set names a provider other than AWS, where a bucket name alone doesn't say where it is |
| `@SET DIR` | a member directory, one row each, always ending in a separator |
| `@SET EXCLUDE` | an exclude pattern in force for this run, one row each, including any that matched nothing |
| `@SNAPSHOT NAME` | the snapshot's name |
| `@SNAPSHOT BY` | who took it, as `user@machine` |
| `@SNAPSHOT START` | the instant the run started (column 4), and the time zone the name was minted in |
| `@SNAPSHOT FILES` | the number of file rows |
| `@SNAPSHOT SIZE` | the sum of the size column, then a [readable form](#canonical-form) in parentheses |
| `@S3CAB END` | the instant the file was finished (column 4) |

`START` carries the zone because snapshot names are local wall-clock time, so the zone is
what makes one resolvable to an instant: `0915` in London in June is `08:15Z`. Naming the
zone (`Europe/London`) rather than just its offset says *where*, which explains a
daylight-saving shift rather than merely recording one. The instant and the name come from
one clock reading, each cut down to its precision rather than rounded, so they can't fall in
different minutes.

`FILES` and `SIZE` are exact, so each checks something: `FILES` against the count of
file rows, `SIZE` against the sum of the size column. Its readable form also keeps the
cell text, since a spreadsheet shows a bare 13-digit number as `1.23E+12`. s3cab doesn't
read either back: a hand edit can change them, so a mismatch isn't damage.

s3cab writes the rows in this order: the heading; the `@S3CAB`, `@SET` and `@SNAPSHOT`
rows above; every `#excluded` and `#error` row, so the answer to "why wasn't this backed
up?" is near the top; one `-` row per file (with an `#error` in among them for
a file that failed while being read); then `FILES`, `SIZE` and `END`. A reader goes by each
row's type, not its position — except for `END`, below. Within a block, rows come in the
order the directories were listed, which differs between filesystems, so compare two snapshots
as sets of rows, not line by line.

The set's directory and this snapshot's local path follow from `HOME` and the names, and
its key in the bucket from `BUCKET` and the
[repository layout](#the-remote-repository-the-keystone), so none of them is recorded. The `exclude.txt` in the bucket is only the latest; the `EXCLUDE` rows say which
patterns applied to this run.

One directory is left out by design: a directory named `.s3cab`, all lowercase even on Windows,
is never walked — it is s3cab's own, and a member directory containing one would otherwise
back up the tool's working files.

- It gets no row, unless an exclude pattern matches it; then it is `#excluded` like any
  other directory.
- Only a directory is skipped. A file or a link named `.s3cab` is treated like any other.

An entry that vanishes between being listed and being checked gets no row either, since
there is nothing left to record; a directory that can't be listed stops the backup.

### No row holds a tab or a line ending

No field in a snapshot holds a real tab, CR or LF, and each field either refuses them or
spells them out:

- **Refused:** a file row's path. s3cab stops the backup rather than write one
  ([above](#what-is-deliberately-not-stored)). A `␉` in this field is only a character of
  the name, and restores as itself.
- **Spelled out, everywhere else:** as the Unicode Control Pictures `␉` (U+2409), `␍`
  (U+240D) and `␊` (U+240A), which a reader may read as the characters they stand for. In
  practice that is an error message, or the path in an `#excluded` row (excluding a file is
  how it gets past the refusal) or an `#error` row.

So every line has exactly five fields.

### Paths

**Paths are written with the casing the filesystem itself reports** — the spelling you see
in File Explorer or Finder, not the spelling anything was typed in. If a directory is on disk
as `Photos` and the set's `dirs.txt` names it `PHOTOS`, the snapshot says `Photos`. The one
exception is a **Windows drive letter, which is always uppercase**: a drive letter isn't a
name on disk, it's an alias the operating system assigns to a volume, and Windows keeps no
canonical case for it. So `C:` is what you get, whichever way you wrote it.

**A member directory is recorded as its real path**, however `dirs.txt` spells it. Every
part of the path is resolved, not just the last:

- a symbolic link or junction anywhere along it, to its target;
- a drive made with `subst`, to the directory it stands for;
- a mapped network drive, to the share's own path (`\\server\share\…`);
- a Windows short name such as `PROGRA~1`, to the full name (`Program Files`);
- each name's case, to the case on disk.

In Python, `os.path.realpath(path, strict=True)` returns the same path.

That is a promise about what s3cab *writes*. Reading is more forgiving, because these files
are yours to edit: on Windows paths (a drive letter, or a network share starting `\\` or
`//`), where two spellings name one file, `@SET DIR` rows are matched against paths
case-insensitively — so hand-editing a snapshot's `DIR` rows, or a set's `dirs.txt`, won't
stop `restore --output` finding where a file belongs. Every other path is matched exactly,
since a case-sensitive filesystem really can hold both `Photos` and `photos`.

**How a `@SET DIR` matches a path**, since anything re-rooting a tree depends on getting
this right. Compare **whole path segments, never a string prefix** — `…\trees\edge` must not
claim `…\trees\edgeX\file.txt`. Split both the directory and the path into segments and drop
empty ones, which is what makes the trailing separator, or a doubled one, harmless. Which
separators count depends on the path, not the machine reading it: a Windows path splits on
`/` *and* `\`, any other on `/` alone, since there a `\` is an ordinary character in a
filename — so a Windows snapshot reads correctly on a POSIX machine, and the reverse. Where
several directories match, the **longest wins**, so a member directory nested inside another
takes precedence over its parent. A path under no `DIR` at all has nowhere to land, so its
row is [refused](#valid-and-invalid-files) rather than guessed at; only a hand-edited
snapshot can hold one.

**Where a restored file lands is the tool's decision, not the format's.** Nothing in a
snapshot says where the bytes must go back, and a restorer is free to choose — restoring to
the recorded paths, to a chosen directory, or anywhere else. What s3cab itself does is
written down here for one reason only: so that *"does my restore agree with s3cab's?"* is a
question with an answer, rather than something you can settle only by running the tool and
looking. Restoring to a chosen directory, it writes each file to
`<output>/<name of the DIR that matched>/<the rest of the path below that DIR>`. So under a
`@SET DIR` of `C:\Users\me\Photos\`, a row for `C:\Users\me\Photos\2024\beach.jpg` lands at
`<output>\Photos\2024\beach.jpg` — the member directory's *name*, not a rebuilt
`C\Users\me\…` chain. Two `DIR` rows whose names collide (`C:\a\Photos\` and
`D:\b\Photos\`) both want the same destination directory; s3cab refuses that snapshot rather
than merging them. **None of this binds you.** A different layout is a different tool making
a different decision, not a misreading of the format.

**A stored `mtime` is rounded to the nearest millisecond**, a tie to the later one, which is
coarser than some filesystems keep — NTFS records 100-nanosecond ticks, ext4 nanoseconds.
Two consequences to build against. A restore reproduces the *stored* value **to the millisecond**, so a restored
tree compares clean against the snapshot it came from and re-backing it up re-uploads
nothing — and compare at that resolution, not finer: below the millisecond two restores can
disagree without either being wrong. But a restored file can also sit up to half a
millisecond either side of a *surviving original*, which any mtime-sensitive tool will report
as a difference.

### The last line: `@S3CAB END`

**`@S3CAB END` is the last line of every snapshot, and it means the file is complete.** A
file without it was cut short, whatever the cause, so one check catches every kind. gzip
does notice a cut-short file, but only at the end: `gunzip -c` and Python's `gzip` module
both hand over every line they can decompress *before* reporting the cut, so a reader that
processes rows as they arrive has already seen a byte *prefix* of the original, which would
otherwise read as a valid, smaller snapshot. A snapshot without `END` is damaged goods —
treat it as truncated, not as complete. Concretely: **don't restore from it**. The rows that
survive a cut are a valid-looking prefix, so restoring them produces a tree that looks
finished and silently isn't; refuse the snapshot, say why, and let the reader reach for an
intact one. (A reader that only wants the file rows can still skip every other line;
checking for `END` first is what tells it the rows it read are all of them.)

Its instant is when the file was finished — for a snapshot, when the run finished. s3cab
itself doesn't read it back. It's there for you: with `START`'s instant, it's the only
record of how long the run took. Read it as an upper bound: the column holds milliseconds
and the clock is finer, so the figure is rounded **up** — everything in the file was written
at or before the moment it names, never after. Two snapshots of an unchanged set, taken on
the same machine by the same s3cab, therefore differ in `@SNAPSHOT NAME`, `START` and
`@S3CAB END`, and nowhere else.

Two smaller legalities, so a reader knows they weren't forgotten. A snapshot's **name** is
always `YYYY-MM-DDTHHMM` — local wall-clock time to the minute, with the colon dropped —
and the file is that name plus `.tsv.gz`. Names sort in time order except when the clock
goes back (the end of daylight saving, or a move to another zone): a later snapshot can then
sort before an earlier one, and s3cab, which takes the last name as the latest, warns when
it writes one. `START` holds the true order. And a snapshot with **no file rows at all** is
perfectly legal: an empty backup set, not a damaged file.

### Valid and invalid files

A valid file is what s3cab writes, and that goes for a [deletion record](#the-deletion-record)
as much as a snapshot:

- UTF-8 with LF endings, the heading row first and `@S3CAB END` last;
- only types this version knows, other than `@` and `#` ones;
- every per-path row's path absolute, with no `.` or `..` segment and no tab, CR or LF, under
  a `@SET DIR`;
- each path in at most one per-path row, whatever its type;
- each file row's hash 64 lowercase hex characters, its size decimal, its time the
  24-character form, and the same for a `#deleted` row.

A reader meets files that aren't, since these are text files anyone can edit, and does one
of three things:

- **Refuse the whole file** when it isn't UTF-8, doesn't start with the heading row, doesn't
  end with `END`, has rows after `END`, or holds an unknown type starting with neither `@`
  nor `#`. Each means the file isn't what it claims, was cut short, or comes from a newer
  s3cab, and restoring part of it would pass for a full restore.
- **Refuse one path, restore the rest, and exit nonzero** for a malformed file row, a path
  that isn't absolute, a `.` or `..` segment, a path under no `@SET DIR`, or a path in two
  file rows. **Both of those rows are refused, so no reader guesses**: a first-wins and a
  last-wins reader would restore different bytes from one file, and neither would report
  anything wrong. A `..` segment matters most, since a hand-added one would walk a naive
  restorer out of its output directory. A `#` row repeating a file row's path also makes
  the file invalid, but changes nothing a restore writes, so a reader that skips `#` rows
  needn't check for it. This is the same
  ["restore everything you can, then report"](#reading) that governs a
  missing object: rows are independent lines, so one can't damage its neighbours.
- **Ignore** an unknown `@` or `#` type or property, and a people-only row that's wrong, such as
  `FILES` disagreeing with the row count.

Outside a restore, s3cab reads a refused path as one with no row: `backup` hashes the file
again, `compare` lists it as unreadable, as it does for an `#error` row, and `verify` reports
it as damage. `cleanup` won't run at all while a snapshot has one, since content only that row
names would look unused and be deleted.

**A deletion record is judged the same way, and distrusted while it's invalid.** A malformed
`#deleted` row is refused, so its object counts as not deleted, and its absence is reported
as unexplained damage with a nonzero exit. That is the safe direction: a damaged record can
never make missing content look intentional. While any record file is invalid, `backup` and
`status` check what the bucket actually holds rather than trust an earlier snapshot's word,
and `cleanup` refuses to run, since compacting would rewrite only the rows it could read and
lose the rest for good.

**What a reader promises, even for an invalid file:** it never writes outside the
destination, never writes bytes that don't hash to the row, never chooses between
conflicting rows, and never lets a partial restore pass for a full one. What it can't
promise is that a valid but edited file is true: a hash changed to another stored object
restores the wrong content, faithfully.

Whole-file integrity is gzip's CRC-32 and length check, which decompressing a snapshot
verifies; the uncompressed deletion record has only its `END`. The store's ETag is no
substitute: it is a content hash only for single-part uploads to AWS.

## The local side (`~/.s3cab/`)

The local layout is a user surface, not a hidden implementation detail — **the files are
the API**, and some of them you are expected to edit directly in a text editor:

```
~/.s3cab/
  sets/
    photos/
      dirs.txt           # member directories, one absolute path per line — yours to edit
      env                # S3CAB_BUCKET=… + any per-set auth overrides — yours to edit
      exclude.txt        # optional exclude patterns — yours to edit
      snapshots/
        2026-06-12T0915.tsv.gz    # same format as the bucket's copy, byte for byte
  roles-anywhere/        # only if the keyless identity is set up — see below
  my-backup-bucket-bucket.yaml  # CloudFormation templates `s3cab aws` wrote: the bucket,
  my-backup-bucket-user.yaml    #   and an identity (or my-backup-bucket-<fingerprint>.yaml)
```

`~/.s3cab` is the default home; setting the **`S3CAB_HOME`** environment variable relocates
the whole tree (every path s3cab prints follows it). Two variables in a set's `env` are
s3cab's own rather than standard `AWS_*` ones: `S3CAB_BUCKET` (the set's bucket) and, for a
set in Roles Anywhere mode, the marker `S3CAB_RA=1` — a pointer to the machine identity
below, never credential material itself.

A third is optional: `S3CAB_CHECK_CHANGE_TIME=1` makes s3cab check a file's *change time*,
as well as its size and modification time, before it decides the file is unchanged. When to
set it, and when not to, is in [backing up](backup.md#the-change-time-check).

`roles-anywhere/` holds the machine's keyless identity, shared by every set in that mode:
the self-signed CA (`ca.pem`/`ca.key`), the client certificate and its signing key
(`client.pem`/`client.key` — the private keys never leave this directory), and one
`<bucket>.env` file per bucket, holding the three `S3CAB_RA_*_ARN` values, `AWS_REGION` and
`S3CAB_RA_STACK` (the stack they came from), captured from the deployed CloudFormation stack
by `s3cab aws --roles-anywhere --save`. A set in Roles Anywhere mode signs in with the file
named for its bucket. It is machine identity, not set config — leave it out of any backup
you share.

Two temporary files can appear in `snapshots/` while s3cab is working. Both start with a
dot, neither is ever uploaded, and both are safe to delete when nothing is running. Neither
ends with `@S3CAB END`, so neither can pass for a finished snapshot; s3cab reads each only
for its file hashes, and drops its last line unread, since nothing vouches that the line is
whole. That costs one file hashed again.

- `.snapshot.tsv.gz` — the snapshot being written right now. It becomes the finished
  snapshot when the run completes. One left behind means a run was killed part-way; s3cab
  says so, and names it, the next time you snapshot that set. Its last line stops wherever
  the kill landed — so once you know nothing is running, `--resume` carries on from the rows
  before it instead of reading all those files again.
- `.snapshot.lookup.tsv.gz` — the file hashes from a snapshot you stopped with Ctrl+C,
  kept so the next run doesn't have to work them out again. Structurally it is a snapshot
  that stops after its last file row, with no `FILES`, `SIZE` or `END`. Every hash in it
  is re-checked against the file's current size and modification time before being trusted,
  and it is deleted as soon as a snapshot completes.

Editing a set *is* editing these files; deleting the directory deletes the set. In both
`dirs.txt` and `exclude.txt`, blank lines are ignored and a line starting with `#` is a
comment — so a directory or pattern can be commented out rather than deleted. Member
directories mustn't overlap: a file reached from two of them stops the backup, unless an
exclude pattern keeps the inner directory out of the outer one's walk. Note the
deliberate asymmetry of weight: the **bucket is the keystone**. Everything local except
`env` is recoverable *from* the remote — `reattach` pulls `dirs.txt`/`exclude.txt`
back down and syncs the snapshot history — whereas nothing can rebuild a lost remote.
(Exclude patterns are covered in the [exclude guide](exclude.md).)

## Recovering by hand (no s3cab)

1. List `snapshots/<set>/` in the bucket and download the snapshot you want.
2. Decompress it: `gunzip 2026-06-12T0915.tsv.gz`. Windows has no `gunzip`, but
   PowerShell needs nothing installed, since .NET's `GZipStream` is built in:
   ```powershell
   $f = Resolve-Path 2026-06-12T0915.tsv.gz
   $gz = [IO.Compression.GZipStream]::new([IO.File]::OpenRead($f), [IO.Compression.CompressionMode]::Decompress)
   $out = [IO.File]::Create(($f -replace "\.gz$", "")); $gz.CopyTo($out); $out.Close(); $gz.Close()
   ```
3. Open the `.tsv` — a text editor or a spreadsheet — and find your file's row, one of those
   starting `-`.
4. Download `objects/<its-hash>` from the bucket. That is your file, byte for byte; the row
   tells you its original path and modification time.

Or write a replacement tool in an afternoon — that is the point.

## Writing your own tool

Each checklist below is everything a tool doing that job has to get right; the sections
above explain every item. The hints after each are what tends to go wrong in practice.

### Reading

For a restorer, or anything else that reads the files.

- Read every text file by the [four reading rules](#reading-the-text-four-rules-that-hold-everywhere):
  strict UTF-8, split on LF alone, nothing unescaped, the leading fields trimmed and the last
  taken verbatim.
- Decompress a snapshot as gzip.
- Take a row's type from its first field, trimmed, compared case-sensitively.
- Check every snapshot and deletion record as [valid and invalid files](#valid-and-invalid-files)
  sets out: refuse the whole file, refuse one path and carry on, or ignore the row. A file
  whose first line isn't the [heading row](#the-columns), all five fields, or whose last line
  isn't `@S3CAB END`, is refused whole.
- Place each file row under the `@SET DIR` it falls in, [matched by whole segments, the
  longest winning](#paths). Where it lands from there is your tool's decision.
- Fetch each file row's content from `objects/<hash>`, and check that what you downloaded
  hashes to that key.
- When a fetch misses, and only then, look the hash up in every `objects.deleted-<n>.tsv`
  read as one set. A hash a record lists was [deliberately deleted](#the-deletion-record);
  any other miss is damage, and so is a download that doesn't hash to its key.
- Restore everything you can, then report. Skip a deliberately deleted file and say so, with
  its date. Report damage, carry on with the rest, and exit nonzero at the end: a recovery
  tool that stops dead at file 3 of 400 is materially worse than one that recovers 397 and
  names the three.
- Set each restored file's modification time to the stored one, [to the
  millisecond](#paths).
- Never write outside your destination, and never let a partial restore pass for a full one.

**What trips people up:**

- **Line splitters.** Python's `str.splitlines()` breaks on `\v`, `\f`, `\x1c`, `\x1d`,
  `\x1e`, U+0085, U+2028 and U+2029 as well as LF, and other languages' "split on any line
  break" helpers do much the same. Any of them can occur in a legal filename.
- **Trimming the whole line.** `@S3CAB END`'s last field is empty, so stripping trailing
  whitespace from the line leaves four fields.
- **The heading row's column 4.** It holds the word `time`, not an instant, so a reader that
  checks column 4 of every `@` row as an instant refuses every file at its first line.
- **gzip.** `gunzip -c` and Python's `gzip` module hand over every line they can decompress
  before reporting a cut-short file, which is why `END` matters. Python's `gzip.decompress`
  also joins several gzip streams into one without a word.
- **Windows paths: go through `\\?\`.** Prefixed with `\\?\`, an absolute path is taken
  exactly as written. Without it, Windows drops a trailing space or dot from a name, so a
  file restored as `notes.` lands as `notes` with no error, and a path past 260 characters
  (`MAX_PATH`) fails. Re-rooting under an output directory makes a deep tree deeper.
- **Setting a modification time.** A fraction like `.674` has no exact representation in a
  floating-point count of seconds, which is how some platforms take a timestamp, so a
  restored file can land tens of nanoseconds off its row. s3cab's own restore does, where the
  filesystem keeps nanoseconds; setting the time through a nanosecond interface is exact.
- **Hand-edited snapshots.** They are text, and this page tells people they can edit them. A
  restorer that trusts every row will one day follow a hand-added `..` out of its output
  directory and overwrite whatever it lands on.
- **Restoring on another operating system.** A Linux snapshot can hold two paths differing
  only in case, or characters Windows forbids, and both collide or fail on Windows. The
  format records what was there; what to do on arrival is your tool's choice, worth stating.
  So is whether a download that doesn't hash to its key is still worth writing, clearly
  flagged, or better withheld.
- **Storage class.** A bucket lifecycle rule that moves `objects/` to an archive tier breaks
  a plain download for every tool, s3cab included.

### Writing a snapshot

- Read the set's `dirs.txt` and `exclude.txt` as [the local side](#the-local-side-s3cab)
  describes: blank and `#` lines ignored, each line trimmed. A directory named in
  `dirs.txt` that is itself a link is followed, since you named it, and recorded as its
  [real path](#paths). Links found inside it are not.
- Walk every member directory without following a link, and apply the patterns as the
  [exclude guide](exclude.md) defines them. Then skip a directory named `.s3cab` in
  lowercase that no pattern matched: it gets no row. Hidden and system files are ordinary
  files.
- On Windows and macOS, patterns ignore case using Unicode's simple case folding, one
  character for one: `ẞ` matches `ß` but not `ss`, and the Turkish `ı` and `İ` match only
  themselves. That holds even on a drive or in a directory set up to be case-sensitive.
  Everywhere else they always pay attention to case, even on a drive that doesn't. On macOS
  an accented letter also matches however it is stored: both sides are compared in NFC. `?`
  and `*` count code points.
- Write a row per entry:
  - a [file row](#the-columns) for each file: the SHA-256 of its content in lowercase hex,
    its size in bytes, its modification time rounded to the nearest millisecond (a tie to
    the later) in the 24-character form, and its absolute path;
  - `#excluded`, with the pattern, for an entry a pattern matched;
  - `#error` for an entry whose type couldn't be determined, a file that couldn't be read,
    and a [link](#links) leading
    out of the backup or somewhere this computer can't resolve;
  - no row for any other link, a pipe, socket or device, or an entry that vanished between
    being listed and being checked.
- End a directory's path with a separator, and a link's when its target is a directory.
  Spell every path with the casing the filesystem reports, and a Windows drive letter in
  uppercase.
- Stop without writing a snapshot, and say why, when:
  - a name holds a tab, CR or LF;
  - a name has no UTF-8 form;
  - a directory can't be listed;
  - the same file turns up under two member directories, because one is inside the other.
    An exclude pattern that leaves the inner directory out of the outer one's walk avoids
    this.
- In an `#excluded` or `#error` row, where a name with a tab, CR or LF can still appear,
  write those characters as `␉` (U+2409), `␍` (U+240D) or `␊` (U+240A).
- Start with the heading row, then the [whole-snapshot rows](#the-whole-snapshot-rows); give
  each path at most one per-path row; end with `@S3CAB END`, its instant rounded up.
- Five tab-separated fields on every line, UTF-8 with no BOM, LF endings, one gzip stream.
- Name the file `YYYY-MM-DDTHHMM.tsv.gz` from the run's start in local time. Refuse a second
  snapshot of the set in the same minute, and never overwrite one.

Lay the rows out in [canonical form](#canonical-form) too, so the file reads as a table.

**What trips people up:**

- **Windows paths: go through `\\?\`.** Opened by its plain path, a file named `notes ` or
  `notes.` is looked up as `notes`:
  - with no `notes` beside it, it isn't found, and nor is anything past 260 characters. A
    writer that takes "not found" for an entry that vanished leaves the file out of the
    backup without a word, and exits 0;
  - with a `notes` beside it, that file's bytes are read instead: a wrong hash under the
    right name, with no error at all.

  Python's `os.path.abspath` drops the dot or space too; `os.path.normpath` keeps it.
- **Links on Windows.** Python's `os.walk(top, followlinks=False)` still descends into a
  junction, recording what lies beyond it as if it were inside the member directory, and
  `os.path.islink()` is `False` for a junction (`os.path.isjunction()` catches it). A broken
  link doesn't fail the way it does elsewhere: a missing target raises winerror 2, a link
  through a file winerror 3 (both `FileNotFoundError`), and a loop `EINVAL` with winerror
  1921, not `ELOOP`. Node reports these as `ENOENT` and `ELOOP`. Reading a OneDrive
  online-only file downloads it.
- **Decoding a name with no UTF-8 form.** Python and Node give the same U+FFFDs: in Python,
  `name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")` on Windows and
  `os.fsencode(name).decode("utf-8", "replace")` on Linux. A lone surrogate on Windows
  becomes three U+FFFD, which matters to a `?` in a pattern.
- **Two spellings of one name.** NTFS can hold `café.txt` spelled with one accented character
  and with a letter plus a combining accent side by side, as two files. Never normalize a
  name: the two rows would collapse into one path.
- **Not overwriting a snapshot.** Python's `os.rename` refuses an existing target on Windows
  but silently replaces it on Linux and macOS. There, link the new name and remove the old
  one instead.
- **The gzip header.** Python's `gzip.open` writes the file's name and the current time into
  the header, so a snapshot written under a temporary name carries that name. Use
  `gzip.GzipFile(filename="", mtime=0, fileobj=…)`.
- **Trimming in Python.** `str.strip()` is the wrong trim for `dirs.txt` and `exclude.txt`:
  it removes `\x1c` to `\x1f` and U+0085, which stay, and keeps a byte-order mark, which
  goes.
- **Line endings and encoding.** Python's text mode on Windows writes CRLF, and before
  Python 3.15 encodes as the locale's code page, often cp1252, which fails on a name like
  `🎉.txt`. Write bytes, or open the file with `newline="\n"` and `encoding="utf-8"`.
- **Case in patterns isn't Windows' own comparison, or quite Python's.**
  - Windows keeps the Kelvin sign and `k`, `ẞ` and `ß`, and `ς` and `σ` apart; patterns
    match each to its partner.
  - Python's `re.IGNORECASE` also matches `i` and `I` with the Turkish `ı` and `İ`, which
    patterns don't. Keep those four literal: write `i` or `I` as `(?-i:[iI])`, and `ı` or
    `İ` as `(?-i:ı)` or `(?-i:İ)`. The rest of `re.IGNORECASE` matches the way patterns do.
  - `str.casefold()` goes further still: `straße` matches `strasse`.
- **Time zones.** Python's standard library can't name the local IANA zone, and on Windows
  has no zone data without the `tzdata` package. `START`'s zone is written for people, so
  write the best name you have.
- **Rounding a modification time.** A floating-point count of seconds can't hold every
  NTFS tick, so rounding it to the millisecond can put a near-tie on the wrong side. Round
  the integer nanosecond count.

### Uploading

- Upload every object a snapshot names before the snapshot itself:
  [objects first, snapshot last](#the-invariant-objects-first-snapshot-last).
- Store each object at `objects/<hash>`, holding exactly the bytes that hash to its key.
  Hash the bytes as you send them: a file can change after the snapshot recorded it. If they
  don't match, leave nothing stored under that key, and don't upload the snapshot, which
  names an object the repository doesn't hold.
- Upload a snapshot byte for byte to `snapshots/<set>/<name>.tsv.gz`, never over an existing
  one, and never one without `@S3CAB END`.
- Write [`sets/<set>/`](#the-remote-repository-the-keystone): `info` as `OWNER=user@machine`
  then `CREATED=` an instant; `dirs.txt` as the parsed list, one directory per line, LF
  endings; `exclude.txt`, if the set has one, as a byte copy. Never upload the set's `env`.

**What trips people up:**

- **Line endings.** Python's text mode writes `dirs.txt` with CRLF on Windows.

### Deleting

- Write a [deletion record](#the-deletion-record) before deleting any object it lists, as
  `objects.deleted-<n>.tsv` under an index not already in use, never over an existing record.
- Give it the heading row, a `#deleted` row per object (hash, size, the UTC instant, and
  `user@machine`), and `@S3CAB END` last.
- Never delete an object younger than a generous grace window (s3cab's is 7 days), and don't
  clean up while a backup is running.
- To compact records, write the merged record before deleting the files it absorbs, and drop
  only rows whose hash no snapshot references.
