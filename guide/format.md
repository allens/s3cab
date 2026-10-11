# The s3cab format spec — repository & snapshot files

s3cab's core promise is **no lock-in**: everything it stores — in your bucket and on your
machine — is plain, self-evident files you can read and act on without s3cab. In principle
you could recover everything with no documentation at all, just by looking at what's there.
This page writes the format down anyway, for two reasons: it makes recovery *much* easier,
and it keeps the project honest — a human-readable mirror of the true format that the code
must always match.

Everything on this page is a **commitment**, not an implementation detail. If a future
s3cab needs to change any of it, that is a breaking format change, treated accordingly.
One exception, flagged again where it arises: a snapshot may gain new `#` row types and
properties, and a reader skips the ones it doesn't know. What is committed is that skipping
every `#` row leaves exactly what a restore could write.

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
  on LF *exactly*. Don't reach for a "split on any line break" helper: Python's
  `str.splitlines()` and its equivalents also break on `\v`, `\f` and U+0085, every one of
  which can occur in a legal filename, so such a parser cuts a path in half and never says
  why. **`exclude.txt` is the one exception, and in the other direction**: it is *yours*, so
  s3cab stores and mirrors it byte-for-byte as you wrote it — a Windows editor's CRLF, or a
  missing final newline, travels into the bucket intact. Harmless, because its lines (and
  `dirs.txt`'s) are trimmed when read.
- **Nothing is quoted or escaped** — that plainness is the whole point. It is what makes a
  naive `split("\t")` safe, and it is why no field in a snapshot holds a real tab, LF or CR
  (a path with one is [refused at backup time](#what-is-deliberately-not-stored), and
  anywhere else [they are spelled out](#no-row-holds-a-tab-or-a-line-ending)). Every other
  character, control characters included, is fair game in a path.
- **Trim the leading fields; never trim the last.** The leading fields are padded with
  spaces so the raw file reads as columns. The last field — a path, or a property's value —
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

A record is a plain, uncompressed TSV: the deleted object's hash, its size, a timestamp,
and text at the ragged end — here *who* ran the delete, as `user@machine`:

```
#DELETED		2026-08-22T11:04:55.120Z	These objects were removed on purpose. Absence here is not damage.
a3f9c21e…60d	1204	2026-08-14T09:31:07.412Z	allen@DESKTOP
5e21ab7f…c93	892	2026-08-19T22:10:41.006Z	allen@LAPTOP
#END
```

Rules for a reader: a line is a row only if its first tab-separated field is **64 lowercase
hex characters** — the deleted object's hash, its old key under `objects/`. The second field is
the object's stored size in bytes, the third the UTC instant the delete ran, and everything
after the third tab is who ran it. Skip every other line: the `#DELETED` header's third
column repeats the record's instant and its last column is prose for a human, and the
trailer is a bare `#END`, which says the file is whole the way `#S3CAB END` does for a
snapshot. It carries no status columns because a record lands in one atomic PUT — a partial
record cannot exist. Record rows are **not** column-padded the way a snapshot's are.

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
  A file with one is **not backed up**, and neither is a link whose name or target has one:
  the run stops and names it, so you can rename it, or exclude it with a pattern like
  `odd*name.jpg` and run again. Every other character — including control characters that
  are *not* those three — is stored as-is.
- **File content, not the filesystem around it.** Snapshots record each file's content,
  size, and modification time, and each link as itself — not what a link leads to, no
  hardlink identity, no empty directories, no permissions or ACLs. Pipes, sockets and
  devices get no row at all. s3cab backs up *data* (documents, photos, video); it is not a
  system backup tool.

## Snapshot files

A snapshot is a point-in-time record of every file in a backup set: a plain-text,
tab-separated (TSV) table, gzip-compressed on disk and in the bucket (`.tsv.gz` —
decompress with any gzip tool: `gunzip`, or the gzip support built into every mainstream
language). How hard it is compressed is s3cab's choice and may change; what is promised is
plain, single-stream gzip.

The [four reading rules](#reading-the-text-four-rules-that-hold-everywhere) apply here in
full — encoding, LF splitting, no escaping, and never trimming the last field. This section
adds only what is specific to snapshots.

Every line has the same five columns, and the first says what kind of row it is. The file
says where it came from before it lists anything, so it is self-describing even found alone
in a bucket:

```
#S3CAB                                size  time                      https://s3cab.plantegral.com/guide/format
#S3CAB    VERSION                                                     0.14.0
#S3CAB    HOME                                                        C:\Users\me\.s3cab\
#SET      NAME                                                        photos
#SET      BUCKET                                                      s3://my-backup-bucket
#SET      DIR                                                         C:\Users\me\Photos\
#SET      DIR                                                         D:\Pics\
#SET      EXCLUDE                                                     *.tmp
#SNAPSHOT NAME                                                        2026-06-12T0915
#SNAPSHOT BY                                                          me@DESKTOP
#SNAPSHOT START                             2026-06-12T08:15:32.123Z  Europe/London
#excluded *.tmp                                                       C:\Users\me\Photos\upload.tmp
#error    EPERM: operation …                                          D:\Pics\locked.jpg
link      2025\beach.jpg                                              C:\Users\me\Photos\latest.jpg
object    3b8e…c0a1                4915200  2025-06-01T12:00:00.000Z  C:\Users\me\Photos\2025\beach.jpg
object    e3b0…b855                      0  2024-01-01T00:00:00.000Z  D:\Pics\empty.txt
#SNAPSHOT FILES                                                       2
#SNAPSHOT SIZE                                                        4915200 (4.9MB)
#S3CAB    END                               2026-06-12T08:15:40.871Z
```

That example collapses the padding to stay readable; [the real widths](#the-columns) are
below.

### The columns

| Col | Width | An `object` row | Other rows |
| --- | --- | --- | --- |
| 1 | 6 | `object` | the row's type |
| 2 | 64 | the hash | the property (`#S3CAB`, `#SET`, `#SNAPSHOT`), or a per-path row's text: the pattern, the error, the link's target |
| 3 | 12, right-aligned | the size in bytes | blank |
| 4 | 24 | the modification time | an instant, where the row has one |
| 5 | ragged | the path | the path, or the property's value |

For an `object` row:

- **hash** — the SHA-256 of the file's contents, lowercase hex: both the file's identity
  and its key under `objects/`. Two paths with the same content are two `object` rows naming
  one object, which is what deduplication means.
- **size** — bytes, in decimal. This column holds file sizes and nothing else, so its sum is
  the backup's total.
- **mtime** — the file's modification time as exactly `YYYY-MM-DDTHH:MM:SS.sssZ`: 24
  characters, always three fractional digits, always a literal trailing `Z`. Never a
  `+00:00` offset, never a comma for the decimal point, never a different digit count.
- **path** — absolute, in the OS's native style, last on the line so the padded columns
  stay aligned and so it can hold spaces without ambiguity.

Each column is space-padded to its width, and the columns are separated by tabs, so the
file reads as a table in an editor and parses as clean TSV in a script. Column 1 is exactly
as wide as `object`, so an `object` row has no padding at all. A value longer than its
column simply overflows it — `#SNAPSHOT` and `#excluded` are wider than 6, and an error
message can be wider than 64 — so these are *minimum* widths, not a fixed-width record
layout. The last column is never padded. A parser that trims the first four fields can
ignore all of this; anyone writing a snapshot, building a golden test, or matching a line
against a literal needs the real bytes.

**The first row is a heading**, the same in every snapshot: `#S3CAB`, then the names of
the size and time columns, then the address of this page, so a file found on its own says
where it is explained. Spreadsheets are why it names the columns: Excel's AutoFilter takes
row 1 as its headings.

### Row types

A lowercase type is something a restore could act on; a `#` type is not.

| Type | Column 2 | Column 4 | Last column |
| --- | --- | --- | --- |
| `object` | the hash | the modification time | the file's path |
| `link` | the link's target, as the link holds it | | the link's path |
| `#excluded` | the exclude pattern that matched | | the path |
| `#error` | the operating system's message | | the path |
| `#S3CAB`, `#SET`, `#SNAPSHOT` | the property | the instant, if it has one | the value |

- **`object`** is a file, and the only row with content to fetch.
- **`link`** is a symbolic link or junction, recorded as itself and **never followed** — a
  link can lead anywhere, including somewhere you never chose to back up. Its target is
  written as the link holds it, relative or absolute. s3cab's own restore doesn't recreate
  links ([a restorer may](#if-you-are-writing-a-restorer)).
- **`#excluded`** is an entry an exclude pattern matched, and **`#error`** one s3cab couldn't
  check or read. Neither is in the backup; the row says why.

**A path ending with a separator is a folder** (`C:\Users\me\Photos\cache\`): an excluded
folder, a link whose target is a folder, a member directory. A link whose target is missing
has no separator, since nothing says what it was.

**A reader skips a `#` type or property it doesn't know, and refuses a lowercase type it
doesn't know.** An unknown `#` row is information a newer s3cab added; an unknown lowercase
row is content a restore would miss, so reading on would pass off part of a backup as all
of it. The test, concretely: take the first tab-separated field and trim it, and compare it
case-sensitively — `#SET` and `#set` are different types, though a spreadsheet's sort and
filter ignore case.

### The whole-snapshot rows

`#S3CAB` is the file and the software that wrote it, `#SET` the set's configuration, and
`#SNAPSHOT` this run. Each row is one fact, and records it as this run saw it, so a value
can go stale later without the row being wrong.

| Row | What it records |
| --- | --- |
| `#S3CAB VERSION` | the s3cab release that wrote the file |
| `#S3CAB HOME` | the [s3cab home](#the-local-side-s3cab) on that machine |
| `#SET NAME` | the set's name |
| `#SET BUCKET` | the bucket, as `s3://<bucket>` |
| `#SET ENDPOINT` | the S3 endpoint, only for a provider other than AWS, where a bucket name alone doesn't say where it is |
| `#SET DIR` | a member directory, one row each |
| `#SET EXCLUDE` | an exclude pattern in force for this run, one row each, including any that matched nothing |
| `#SNAPSHOT NAME` | the snapshot's name |
| `#SNAPSHOT BY` | who took it, as `user@machine` |
| `#SNAPSHOT START` | the instant the run started (column 4), and the time zone the name was minted in |
| `#SNAPSHOT FILES` | the number of `object` rows |
| `#SNAPSHOT SIZE` | the sum of the size column, then a readable form in parentheses |
| `#S3CAB END` | the instant the file was finished (column 4) |

`START` carries the zone because snapshot names are local wall-clock time, so the zone is
what makes one resolvable to an instant: `0915` in London in June is `08:15Z`. Naming the
zone (`Europe/London`) rather than just its offset says *where*, which explains a
daylight-saving shift rather than merely recording one.

`FILES` and `SIZE` are exact, so each checks something: `FILES` against the count of
`object` rows, `SIZE` against the sum of the size column. Its readable form also keeps the
cell text, since a spreadsheet shows a bare 13-digit number as `1.23E+12`. s3cab doesn't
read either back: a hand edit can change them, so a mismatch isn't damage.

s3cab writes the rows in this order: the heading; the `#S3CAB`, `#SET` and `#SNAPSHOT`
rows above; every `#excluded`, `#error` and `link` row, so the answer to "why wasn't this
backed up?" is near the top; one `object` row per file (with an `#error` in among them for
a file that failed while being read); then `FILES`, `SIZE` and `END`. A reader goes by each
row's type, not its position — except for `END`, below.

The set's directory and this snapshot's local path follow from `HOME` and the names, and
its key in the bucket from `BUCKET` and the
[repository layout](#the-remote-repository-the-keystone), so none of them is recorded. The `exclude.txt` in the bucket is only the latest; the `EXCLUDE` rows say which
patterns applied to this run.

One omission is silent by design: a directory named `.s3cab` is never walked and gets no
row — it is s3cab's own, and a member directory containing one would otherwise back up the
tool's working files. An entry that vanishes between being listed and being checked gets no
row either, since there is nothing left to record; a folder that can't be listed stops the
backup.

### No row holds a tab or a line ending

No field in a snapshot holds a real tab, CR or LF, and each field either refuses them or
spells them out:

- **Refused:** an `object` row's path, and a link's path and target. s3cab stops the backup
  rather than write one ([above](#what-is-deliberately-not-stored)). A `␉` in these fields is
  only a character of the name, and restores as itself.
- **Spelled out, everywhere else:** as the Unicode Control Pictures `␉` (U+2409), `␍`
  (U+240D) and `␊` (U+240A), which a reader may read as the characters they stand for. In
  practice that is an `#excluded` path, since excluding a file is how it gets past the
  refusal, or an error message.

So every line has exactly five fields. One thing still trips a parser that counts them
after trimming the line: `#S3CAB END`'s last field is empty, so stripping trailing
whitespace leaves four.

### Paths

**A path appears at most once in a snapshot.** s3cab never writes a repeat, and a reader
may treat one as a malformed file. The commitment matters because there is no safe way to
guess: a first-wins reader and a last-wins reader would restore *different bytes* from the
same snapshot, neither of them reporting anything wrong. s3cab's own reader doesn't reject
a hand-damaged file that does — it takes the **last** row for a path; a stricter reader is
free to reject the duplicate instead.

**Paths are written with the casing the filesystem itself reports** — the spelling you see
in File Explorer or Finder, not the spelling anything was typed in. If a folder is on disk
as `Photos` and the set's `dirs.txt` names it `PHOTOS`, the snapshot says `Photos`. The one
exception is a **Windows drive letter, which is always uppercase**: a drive letter isn't a
name on disk, it's an alias the operating system assigns to a volume, and Windows keeps no
canonical case for it. So `C:` is what you get, whichever way you wrote it.

That is a promise about what s3cab *writes*. Reading is more forgiving, because these files
are yours to edit: on Windows paths (a drive letter, or a network share starting `\\` or
`//`), where two spellings name one file, `#SET DIR` rows are matched against paths
case-insensitively — so hand-editing a snapshot's `DIR` rows, or a set's `dirs.txt`, won't
stop `restore --output` finding where a file belongs. Every other path is matched exactly,
since a case-sensitive filesystem really can hold both `Photos` and `photos`.

**How a `#SET DIR` matches a path**, since anything re-rooting a tree depends on getting
this right. Compare **whole path segments, never a string prefix** — `…\trees\edge` must not
claim `…\trees\edgeX\file.txt`. Split both the directory and the path into segments and drop
empty ones, which is what makes the trailing separator, or a doubled one, harmless. Which
separators count depends on the path, not the machine reading it: a Windows path splits on
`/` *and* `\`, any other on `/` alone, since there a `\` is an ordinary character in a
filename — so a Windows snapshot reads correctly on a POSIX machine, and the reverse. Where
several directories match, the **longest wins**, so a member directory nested inside another
takes precedence over its parent. A path under no `DIR` at all has nowhere to land: s3cab
reports it rather than guessing, and a hand-edited snapshot is the only way to produce one.

**Where a restored file lands is the tool's decision, not the format's.** Nothing in a
snapshot says where the bytes must go back, and a restorer is free to choose — restoring to
the recorded paths, to a chosen directory, or anywhere else. What s3cab itself does is
written down here for one reason only: so that *"does my restore agree with s3cab's?"* is a
question with an answer, rather than something you can settle only by running the tool and
looking. Restoring to a chosen directory, it writes each file to
`<output>/<name of the DIR that matched>/<the rest of the path below that DIR>`. So under a
`#SET DIR` of `C:\Users\me\Photos\`, a row for `C:\Users\me\Photos\2024\beach.jpg` lands at
`<output>\Photos\2024\beach.jpg` — the member directory's *name*, not a rebuilt
`C\Users\me\…` chain. Two `DIR` rows whose names collide (`C:\a\Photos\` and
`D:\b\Photos\`) both want the same destination directory; s3cab refuses that snapshot rather
than merging them. **None of this binds you.** A different layout is a different tool making
a different decision, not a misreading of the format.

**A stored `mtime` is rounded to the nearest millisecond**, which is coarser than some
filesystems keep — NTFS records 100-nanosecond ticks, ext4 nanoseconds. Two consequences to
build against. A restore reproduces the *stored* value **to the millisecond**, so a restored
tree compares clean against the snapshot it came from and re-backing it up re-uploads
nothing — and compare at that resolution, not finer. A fraction of a second like `.674` has
no exact representation in a floating-point count of seconds, which is how some platforms
hand a timestamp to the operating system, so a restored file can land tens of nanoseconds off
the row's value. s3cab's own restore does, where the filesystem keeps nanoseconds; it is
exact on NTFS, where the error falls below one tick, and a restorer that sets the time
through a nanosecond interface is exact everywhere. Below the millisecond the two can
disagree without either being wrong. But a restored file can also sit up to half a
millisecond either side of a *surviving original*, which any mtime-sensitive tool will report
as a difference.

### The last line: `#S3CAB END`

**`#S3CAB END` is the last line of every snapshot, and it means the file is complete.** A
file without it was cut short, whatever the cause, so one check catches every kind. gzip
does notice a cut-short file, but only at the end: `gunzip -c` and Python's `gzip` module
both hand over every line they can decompress *before* reporting the cut, so a reader that
processes rows as they arrive has already seen a byte *prefix* of the original, which would
otherwise read as a valid, smaller snapshot. A snapshot without `END` is damaged goods —
treat it as truncated, not as complete. Concretely: **don't restore from it**. The rows that
survive a cut are a valid-looking prefix, so restoring them produces a tree that looks
finished and silently isn't; refuse the snapshot, say why, and let the reader reach for an
intact one. (A reader that only wants the `object` rows can still skip every `#` line;
checking for `END` first is what tells it the rows it read are all of them.)

Its instant is when the file was finished — for a snapshot, when the run finished. s3cab
itself doesn't read it back. It's there for you: with `START`'s instant, it's the only
record of how long the run took. Read it as an upper bound: the column holds milliseconds
and the clock is finer, so the figure is rounded **up** — everything in the file was written
at or before the moment it names, never after. Two snapshots of an unchanged set, taken on
the same machine by the same s3cab, therefore differ in `#SNAPSHOT NAME`, `START` and
`#S3CAB END`, and nowhere else.

Two smaller legalities, so a reader knows they weren't forgotten. A snapshot's **name** is
always `YYYY-MM-DDTHHMM` — local wall-clock time to the minute, with the colon dropped —
and the file is that name plus `.tsv.gz`. And a snapshot with **no `object` rows at all** is
perfectly legal: an empty backup set, not a damaged file.

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
  my-backup-bucket.yaml  # a CloudFormation template `s3cab aws` wrote, named per bucket
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
(`client.pem`/`client.key` — the private keys never leave this directory), and an `env`
file holding the three `S3CAB_RA_*_ARN` values plus `AWS_REGION`, captured from the deployed
CloudFormation stack by `s3cab aws --roles-anywhere --save`. It is machine identity, not set
config — leave it out of any backup you share.

Two temporary files can appear in `snapshots/` while s3cab is working. Both start with a
dot, neither is ever uploaded, and both are safe to delete when nothing is running. Neither
ends with `#S3CAB END`, so neither can pass for a finished snapshot; s3cab reads each only
for its file hashes, and drops its last line unread, since nothing vouches that the line is
whole. That costs one file hashed again.

- `.snapshot.tsv.gz` — the snapshot being written right now. It becomes the finished
  snapshot when the run completes. One left behind means a run was killed part-way; s3cab
  says so, and names it, the next time you snapshot that set. Its last line stops wherever
  the kill landed — so once you know nothing is running, `--resume` carries on from the rows
  before it instead of reading all those files again.
- `.snapshot.lookup.tsv.gz` — the file hashes from a snapshot you stopped with Ctrl+C,
  kept so the next run doesn't have to work them out again. Structurally it is a snapshot
  that stops after its last `object` row, with no `FILES`, `SIZE` or `END`. Every hash in it
  is re-checked against the file's current size and modification time before being trusted,
  and it is deleted as soon as a snapshot completes.

Editing a set *is* editing these files; deleting the directory deletes the set. In both
`dirs.txt` and `exclude.txt`, blank lines are ignored and a line starting with `#` is a
comment — so a directory or pattern can be commented out rather than deleted. Note the
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
3. Open the `.tsv` — a text editor or a spreadsheet — and find your file's `object` row.
4. Download `objects/<its-hash>` from the bucket. That is your file, byte for byte; the row
   tells you its original path and modification time.

Or write a replacement tool in an afternoon — that is the point.

### If you are writing a restorer

Everything above tells you how to read the format. These are the things that only turn up
once you try to restore from it.

- **Restore everything you can, then report.** A missing object that a [deletion
  record](#the-deletion-record) explains is *expected*: skip it, say so with the record's
  date, and finish successfully. A missing object that nothing explains is an integrity
  fault: report it, **carry on with the rest**, and exit nonzero at the end. A recovery tool
  that stops dead at file 3 of 400 is materially worse than one that recovers 397 and tells
  you which three it couldn't — so the graceful path is not a nicety, it is the requirement.
- **Hash what you download, and treat a mismatch like unexplained damage.** The key *is* the
  content's SHA-256, so verifying costs one hash per file and catches the worst failure a
  restorer can have: an object whose bytes were corrupted in the bucket restores under a
  clean exit, and nothing ever looks wrong again. A download that doesn't hash to its key is
  an integrity fault exactly like a missing object nothing explains — report it, carry on
  with the rest, exit nonzero. Whether the mismatched bytes are still worth writing (clearly
  flagged) or better withheld is a choice your tool makes and states.
- **Refuse `.` and `..` path segments.** Snapshots are editable text, and this spec tells
  people so — a hand-added row whose path holds a `..` segment would walk a naive restorer
  out of its output directory and overwrite whatever it lands on. s3cab never writes such a
  path (walked paths are resolved), so one in a snapshot is malformed: refuse the row and
  report it.
- **On Windows, go through the `\\?\` prefix.** Snapshot paths are absolute, so re-rooting
  them under an output directory makes an already-deep tree deeper, and the 260-character
  `MAX_PATH` limit arrives sooner than you would guess. It fails loudly rather than
  corrupting anything, but it *will* happen on a real tree.
- **Restoring across operating systems is your tool's problem, not the format's.** A
  snapshot taken on Linux may hold two paths differing only in case, or characters NTFS
  forbids outright; both collide or fail on a Windows target. The format records what was
  there faithfully — deciding what to do on arrival is a choice your tool has to make and
  should state.
- **Recreating links is your choice too.** A `link` row records the target as the link held
  it and, by its trailing separator, whether it led to a folder — enough to recreate it. On
  Windows, pick a symlink or a junction; the row doesn't say which it was.
- **Keep `objects/` in a storage class you can actually GET.** Step 4 assumes a plain
  download works. A bucket lifecycle rule that archives `objects/` to a cold tier breaks that
  for every tool including s3cab, turning recovery into a restore-from-archive wait — worth
  knowing before you set one, not after.

And one thing that is deliberately **out of scope**: *where* a restored file lands — back at
its original path, or re-rooted under an output directory — is a decision for the tool, not
the format. The snapshot records the original absolute path; what you do with it is yours.
