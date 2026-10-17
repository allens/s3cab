# The s3cab format spec — repository & snapshot files

This is the spec of 2026-10-14.

s3cab's core promise is **no lock-in**: everything it stores in your bucket is plain,
self-evident files you can read and act on without s3cab. In principle you could recover
everything with no documentation at all, just by looking at what's there. This page writes
the format down anyway, for two reasons: it makes recovery *much* easier, and it keeps the
project honest — a human-readable mirror of the true format that the code must always match.

The page covers the repository and nothing else: what any tool needs to read a backup, or
to write one another tool can read. s3cab's own files — its home on your machine, a set's
directory list and exclude patterns — are s3cab's, and documented with it: the
[README](../README.md#how-it-works), [backing up](backup.md) and the
[exclude rules](exclude.md).

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

These come first because they govern **every** snapshot and deletion record. Get them right
and nothing else below needs special handling. (A set's `.info` file has
[a simpler rule of its own](#who-holds-a-set).)

- **UTF-8, no BOM**, always, whatever machine wrote the file. A path is stored as its UTF-8
  bytes even on Windows, where the operating system itself holds names as UTF-16. Decode
  strictly: a decode error means the file is damaged, not that some other encoding is worth
  trying.
- **Every file in the format ends its lines with LF** (`\n`), never CRLF, and the last line
  is terminated like the rest. Split on LF *exactly*: a legal filename can hold other
  characters that some line splitters break on, which cuts a path in half and never says
  why.
- **Nothing is quoted or escaped** — that plainness is the whole point. It is what makes a
  naive `split("\t")` safe, and it is why no field in a snapshot holds a real tab, LF or CR
  (a path with one is [refused at backup time](#what-is-deliberately-not-stored), and
  anywhere else [they are spelled out](#no-row-holds-a-tab-or-a-line-ending)). Every other
  character, control characters included, is fair game in a path.
- **Trim the leading fields; never trim the last.** The leading fields are padded with
  spaces so the raw file reads as columns, and are trimmed of tab, VT, FF, CR, LF, every
  Unicode space (category Zs), U+2028, U+2029 and a byte-order mark, but not U+0085. The
  last field — a path, or a property's value —
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
  snapshots/<set>.info              # which machine holds the set
  objects.deleted-<n>.tsv           # deliberate-deletion records (only if `delete` has run)
  .<name>/                          # a client's own folder (s3cab's is .s3cab/)
```

- **`objects/`** is the content-addressed store: one object per unique file content, keyed
  by the lowercase-hex SHA-256 of its bytes. Identical content — under any name, from any
  set or machine — is stored exactly once, bucket-wide. Objects carry **no metadata**: an
  object is *content*, and the same bytes may be a dozen different files, so there is no one
  name, date or owner to record. **The snapshot is the index** — it is what maps a name to a
  hash. Keep one: given only `objects/`, you have your data but no way to tell what any of it
  was. (This is why snapshots are immutable and never overwritten.)
- **`snapshots/<set>/`** holds one backup set's snapshot files, named by a minute-precision
  local timestamp (`2026-06-12T0915.tsv.gz`). A snapshot is uploaded **byte for byte**, with
  no conversion on the way. Whether a tool keeps a local copy too is its own choice; s3cab
  does, and the two are identical.
- **A set's name** is lowercase letters, digits and hyphens. With no dot in a name,
  `<set>.info` can't be mistaken for a set, nor collide with a set's folder in a bucket
  copied to disk.
- **`snapshots/<set>.info`** records which machine [holds the set](#who-holds-a-set): the
  one that backs it up.
- **`objects.deleted-<n>.tsv`** — the format's only root-level keys — are its
  [deletion records](#the-deletion-record): small plain-text files marking content as
  *deliberately* removed. A repository where `delete` has never run simply has none.
- **A top-level folder named `.<name>`** belongs to the client called `<name>`, which keeps
  its own files there: s3cab's is `.s3cab/`, described in its
  [README](../README.md#cloud-repositories). Nothing a restore needs lives in one. A reader
  ignores every key under a `.` prefix; a writer touches only the layout above and its own
  folder. There is no registry of names.

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

### Who holds a set

One machine at a time backs a set up: its **holder**. Two machines backing up one set would
interleave their trees, so the latest snapshot could be either machine's. The set's
`snapshots/<set>.info` names the holder, one `KEY=value` line each:

```
OWNER=allen@DESKTOP
CLAIMED=2026-10-14T08:15:32.000Z
CREATED=2026-06-12T08:15:32.000Z
```

- `OWNER` is the holder, as `user@machine`.
- `CLAIMED` is when the holder claimed the set or took it over.
- `CREATED` is when the set was first claimed. It never changes.
- Both instants are UTC, in the same form as a snapshot row's `mtime`.

Read it line by line: UTF-8, split on LF, strip one trailing CR, split each line at its
first `=` with the rest as the value, and skip a line with no `=` and keys you don't know.
A value may hold `=` or `#`.

The rules for writers:

- **Claiming a new set** is a conditional PUT of `<set>.info`, made only while
  `snapshots/<set>/` is empty. A set with snapshots and no `.info` already exists. Claim
  whenever you like before the first snapshot's upload. s3cab claims when a set is set up,
  so a `.info` with no snapshots is a set not yet backed up, or whose first backup stopped.
- **Publishing a snapshot** checks the holder immediately before the snapshot's upload:
  read `<set>.info`, and refuse unless its `OWNER` and `CLAIMED` each match, as text, the
  pair you wrote when you claimed. Never work the pair out again: a renamed machine would
  lock its own holder out.
- **Taking a set over** rewrites `OWNER` and `CLAIMED` and keeps `CREATED`. A set with no
  `.info` is taken over by creating one with a conditional PUT, `CREATED` equal to
  `CLAIMED`.
- **Reading needs no `.info`**: nothing a restore needs is in it.

Three gaps are known, and left open:

- A takeover landing between the check and the upload lets the old holder publish one more
  snapshot. S3 can't make one key's upload conditional on another's.
- For the same reason, a snapshot uploaded between a new claim's check that
  `snapshots/<set>/` is empty and its PUT leaves a `.info` claiming a set that already has
  history, its `CREATED` later than its first snapshot.
- The pair is a token, so it travels with copied state: a machine cloned after the claim,
  or a home folder restored onto a new machine. Both copies pass the check.

This is a rule for tools that follow this spec, not a lock: anyone holding the bucket's
write keys can ignore it.

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
heading row, `@S3CAB SPEC` and `@CLIENT` rows first, then one `#deleted` row per deleted
object, and [the `.` line](#the-last-line) last:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    SPEC                                                        2026-10-14
@CLIENT   NAME                                                        s3cab
@CLIENT   VERSION                                                     0.14.0
@CLIENT   HOME                                                        C:\Users\me\.s3cab\
#deleted  a3f9…c60d                   1204  2026-08-14T09:31:07.412Z  me@DESKTOP
#deleted  5e21…ac93                    892  2026-08-19T22:10:41.006Z  me@LAPTOP
.
```

That example lines up and narrows the columns the way the [snapshot example](#snapshot-files)
does.

Rules for a reader: each `#deleted` row is one deleted object. Its second field is the
object's hash — 64 lowercase hex characters, its old key under `objects/` — the third its
stored size in bytes, the fourth the UTC instant the delete ran, and the last who ran it, as
`user@machine`. Skip every other `@` or `#` row. The `.` says the file is whole, as it does for
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
  leave it out and run again, if the tool offers a way (s3cab's is an
  [exclude pattern](exclude.md)). Every other character — including control characters
  that are *not* those three — is stored as-is.
- **Names that aren't valid Unicode**, so have no UTF-8 form: a lone surrogate on Windows,
  bytes that aren't UTF-8 on Linux. The file is UTF-8, so such a name can't be written into
  it faithfully, and it is refused the same way: the run stops and names it, and leaving it
  out gets past it. Its `#excluded` row then records it with U+FFFD (�) standing in for
  each part that doesn't decode. U+FFFD is Unicode's own replacement character, which
  Python, Node and most other decoders already put in place of bytes that don't decode.
- **File content, not the filesystem around it.** Snapshots record each file's content,
  size, and modification time — [no links](#links), no hardlink identity, no empty
  directories, no permissions or ACLs. Pipes, sockets and devices get no row at all. s3cab
  backs up *data* (documents, photos, video); it is not a system backup tool.

## Snapshot files

A snapshot is a point-in-time record of every file in a backup set: a plain-text,
tab-separated (TSV) table, gzip-compressed on disk and in the bucket (`.tsv.gz` —
decompress with any gzip tool: `gunzip`, or the gzip support built into every mainstream
language). How hard it is compressed is s3cab's choice and may change; what is promised is
plain, single-stream gzip. So to tell whether two snapshots record the same rows, compare
them decompressed: the same rows can compress to different bytes. One snapshot's copies are
another matter: an upload copies the file as it is, so a snapshot in the bucket matches its
local file byte for byte.

The [four reading rules](#reading-the-text-four-rules-that-hold-everywhere) apply here in
full — encoding, LF splitting, no escaping, and never trimming the last field. This section
adds only what is specific to snapshots.

Every line but [the last](#the-last-line) has the same five columns, and the first says what
kind of row it is. The file
says where it came from before it lists anything, so it is self-describing even found alone
in a bucket:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    SPEC                                                        2026-10-14
@CLIENT   NAME                                                        s3cab
@CLIENT   VERSION                                                     0.14.0
@CLIENT   HOME                                                        C:\Users\me\.s3cab\
@CLIENT   EXCLUDE                                                     *.tmp
@SET      NAME                                                        photos
@SET      BUCKET                                                      s3://my-backup-bucket
@SET      DIR                                                         C:\Users\me\Photos\
@SET      DIR                                                         D:\Pics\
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
@SNAPSHOT FINISH                            2026-06-12T08:15:40.871Z  9s
.
```

That example lines up the first column and narrows the others to stay readable;
[the real widths](#the-columns) are below.

### The columns

| Col | Width | A file row | Other rows |
| --- | --- | --- | --- |
| 1 | unpadded | `-` | the row's type |
| 2 | 64 | the hash | the property (`FORMAT`, `SPEC`, `DIR`…), a per-path row's text (why it was left out, the error), or a `#deleted` row's hash |
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

**Some values are written for people, and are free text**, outside the canonical form: the
wording of an `#error` row and an `#excluded` row, `@CLIENT VERSION` and every `@CLIENT` row
a tool adds, `BY`, `START`'s zone and `FINISH`'s duration. No reader depends on them. The
exact duration is `FINISH` minus `START`.

### Row types

A row's first character says what it is: `@` a property of the whole file, `-` a file, and
`#` a path a restore doesn't act on.

| Type | Column 2 | Column 4 | Last column |
| --- | --- | --- | --- |
| `-` | the hash | the modification time | the file's path |
| `#excluded` | why it was left out, such as the pattern that matched, or blank | | the path |
| `#error` | the message | | the path |
| `@S3CAB`, `@CLIENT`, `@SET`, `@SNAPSHOT` | the property | the instant, if it has one | the value |

- **`-`** is a file, and the only row with content to fetch.
- **`#excluded`** is an entry the writer left out on purpose, and **`#error`** one it
  couldn't check or read, or a [link](#links) leading out of the backup. Neither is in the
  backup; the row says why. Any `#error` row makes s3cab's `backup` and `snapshot` exit 1,
  after the snapshot is written.
- **Leaving entries out is optional**, and how a tool chooses them is its own business; s3cab
  uses [exclude patterns](exclude.md). Anything a writer leaves out on purpose gets an
  `#excluded` row, except its own working folders.

A tool that drops `#` lines as comments keeps exactly what a restore reads: the properties
and the files.

**A path ending with a separator is a directory** (`C:\Users\me\Photos\cache\`):

- a member directory;
- an excluded directory;
- a link whose target is a directory, in its `#excluded` or `#error` row.

A broken link, or one whose target couldn't be checked, ends without one.

**A reader skips an `@` or `#` type, or a property, that it doesn't know, and refuses a file
holding any other type it doesn't know.** An unknown `@` or `#` row is something a newer
format, or another tool, added that a restore needn't act on; an unknown row of any other
kind may be content a restore would miss, so reading on would pass off part of a backup as
all of it. The test,
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
| Left out on purpose | `#excluded`, like any excluded entry |

A link to a file or directory leads **into the backup** when the place it finally resolves
to, through any further links, is a member directory or lies inside one, and **out of the
backup** otherwise.

A link out of the backup is an error because its content may look saved and isn't — a
directory link can hide a whole tree. Add the target's directory to the set, or leave the link
out.
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

The one link that is followed is a **member directory itself**: you named it as one, so it is
walked, and recorded in `@SET DIR` as its [real path](#paths).

### The whole-snapshot rows

`@S3CAB` is the format, `@CLIENT` the tool that wrote the file, `@SET` the set, and
`@SNAPSHOT` this run. Each row is one fact, and records it as this run saw it, so a value
can go stale later without the row being wrong.

| Row | What it records |
| --- | --- |
| `@S3CAB SPEC` | the date of the spec the file follows, as `YYYY-MM-DD`: the date at the top of this page |
| `@CLIENT NAME` | the tool that wrote the file, in lowercase letters, digits and hyphens (`s3cab`) |
| `@CLIENT VERSION` | that tool's version, free text |
| `@SET NAME` | the set's name |
| `@SET BUCKET` | optional: the bucket the writer meant the snapshot for, as `s3://<bucket>` |
| `@SET ENDPOINT` | optional: the S3 endpoint the writer used, when it isn't AWS's default; an endpoint is how a provider other than AWS is named, where a bucket name alone doesn't say where it is |
| `@SET DIR` | a member directory, one row each, always ending in a separator |
| `@SNAPSHOT NAME` | the snapshot's name |
| `@SNAPSHOT BY` | who took it, as `user@machine` |
| `@SNAPSHOT START` | the instant the run started (column 4), and the time zone the name was minted in |
| `@SNAPSHOT FILES` | the number of file rows |
| `@SNAPSHOT SIZE` | the sum of the size column, then a [readable form](#canonical-form) in parentheses |
| `@SNAPSHOT FINISH` | the instant the run finished (column 4), and how long it took (`9s`, `12m 21s`, `3h 04m`) |

Any other `@CLIENT` row belongs to the tool `@CLIENT NAME` names, and only that tool gives it
a meaning; s3cab's are in its [README](../README.md#how-it-works) and
[backing up](backup.md#what-a-set-backs-up). A file has exactly one `@S3CAB SPEC`, one
`@CLIENT NAME` and one `@CLIENT VERSION`.

`SPEC` changes when the format does, never for a change of wording on this page. No reader
refuses a file over it: it says which spec to read the file against, and is there for
people, and for a reader's message when it refuses a file for some other reason. There is
no version number. An addition to the format needs none, since a reader skips what it
doesn't know, and a change that would break an older reader changes the heading row, which
every reader already matches exactly.

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

s3cab writes the rows in this order: the heading; `@S3CAB SPEC`; the `@CLIENT`, `@SET` and
`@SNAPSHOT` rows above; every `#excluded` and `#error` row, so the answer to "why wasn't
this backed up?" is near the top; one `-` row per file (with an `#error` in among them for
a file that failed while being read); then `FILES`, `SIZE` and `FINISH`, and the `.`. A
reader goes by each row's type, not its position — except for the `.`, [below](#the-last-line).
Within a block, rows come in the
order the directories were listed, which differs between filesystems, so compare two snapshots
as sets of rows, not line by line.

The snapshot's key in the bucket follows from the set's name, its own name and the
[repository layout](#the-remote-repository-the-keystone), so it isn't recorded.

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

So every line has exactly five fields, bar [the last](#the-last-line).

### Paths

**Paths are written with the casing the filesystem itself reports** — the spelling you see
in File Explorer or Finder, not the spelling anything was typed in. If a directory is on disk
as `Photos` and the set names it `PHOTOS`, the snapshot says `Photos`. The one
exception is a **Windows drive letter, which is always uppercase**: a drive letter isn't a
name on disk, it's an alias the operating system assigns to a volume, and Windows keeps no
canonical case for it. So `C:` is what you get, whichever way you wrote it.

**A member directory is recorded as its real path**, however the set spells it. Every
part of the path is resolved, not just the last:

- a symbolic link or junction anywhere along it, to its target;
- a drive made with `subst`, to the directory it stands for;
- a mapped network drive, to the share's own path (`\\server\share\…`);
- a Windows short name such as `PROGRA~1`, to the full name (`Program Files`);
- each name's case, to the case on disk.

In Python, `os.path.realpath(path, strict=True)` returns the same path, with two traps:

- **On Windows, only through `\\?\`.** Given a plain path, a name ending in a dot or a space
  resolves to the neighbour without one: `dotdir.` becomes `dotdir`, with no error, and the
  wrong tree is backed up. Pass it `\\?\` plus the absolute path made with
  `os.path.normpath` (not `abspath`, which drops the dot too), then strip the `\\?\` it
  hands back, or turn `\\?\UNC\` back into `\\`.
- **On macOS, and in a Linux directory that ignores case, it keeps the case as typed.** It
  never asks the directory how a name is spelled, so look each name up in its parent's
  listing instead.

That is a promise about what s3cab *writes*. Reading is more forgiving, because these files
are yours to edit: on Windows paths (a drive letter, or a network share starting `\\` or
`//`), where two spellings name one file, `@SET DIR` rows are matched against paths
case-insensitively — so hand-editing a snapshot's `DIR` rows won't stop `restore --output`
finding where a file belongs. Every other path is matched exactly, the check that a path is
in only one row included, since a case-sensitive filesystem really can hold both `Photos` and
`photos`, and so can a Windows directory set to be case-sensitive.

**How a `@SET DIR` matches a path**, since anything re-rooting a tree depends on getting
this right. Compare **whole path segments, never a string prefix** — `…\trees\edge` must not
claim `…\trees\edgeX\file.txt`. Ignore the separators a `DIR` ends with, then split both the
directory and the path into segments: a valid path has no empty segment, so a `DIR` with a
doubled separator anywhere after its root matches nothing, and every path under it is
refused. Which separators count depends on the path, not the machine reading it: a Windows
path splits on `/` *and* `\`, any other on `/` alone, since there a `\` is an ordinary
character in a filename — so a Windows snapshot reads correctly on a POSIX machine, and the
reverse. Where several directories match, the **longest wins**, so a member directory nested
inside another takes precedence over its parent. A path under no `DIR` at all has nowhere to
land, so its row is [refused](#valid-and-invalid-files) rather than guessed at; only a
hand-edited snapshot can hold one.

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
than merging them. The snapshot itself is valid, and restores to its recorded paths, so a
writer has nothing to refuse. **None of this binds you.** A different layout is a different tool making
a different decision, not a misreading of the format.

**A stored `mtime` is rounded to the nearest millisecond**, a tie to the later one, which is
coarser than some filesystems keep — NTFS records 100-nanosecond ticks, ext4 nanoseconds.
Two consequences to build against. A restore reproduces the *stored* value **to the millisecond**, so a restored
tree compares clean against the snapshot it came from and re-backing it up re-uploads
nothing — and compare at that resolution, not finer: below the millisecond two restores can
disagree without either being wrong. But a restored file can also sit up to half a
millisecond either side of a *surviving original*, which any mtime-sensitive tool will report
as a difference.

### The last line

**The last line of every snapshot and deletion record is exactly `.`, and it means the file
is complete.** A file without it was cut short, whatever the cause, so one check catches
every kind. It is a terminator, not a row: the one line without five fields, and whose first
field isn't a type. Like every line it ends with LF. gzip
does notice a cut-short file, but only at the end: `gunzip -c` and Python's `gzip` module
both hand over every line they can decompress *before* reporting the cut, so a reader that
processes rows as they arrive has already seen a byte *prefix* of the original, which would
otherwise read as a valid, smaller snapshot. A snapshot without the `.` is damaged goods —
treat it as truncated, not as complete. Concretely: **don't restore from it**. The rows that
survive a cut are a valid-looking prefix, so restoring them produces a tree that looks
finished and silently isn't; refuse the snapshot, say why, and let the reader reach for an
intact one. (A reader that only wants the file rows can still skip every other line;
checking for the `.` first is what tells it the rows it read are all of them.)

The line before it, in a snapshot, is `@SNAPSHOT FINISH`. Its instant is when the run
finished, and s3cab itself doesn't read it back. It's there for you, with the run's duration
beside it. Read the instant as an upper bound: the column holds milliseconds and the clock is
finer, so the figure is rounded **up** — everything in the file was written at or before the
moment it names, never after. Two snapshots of an unchanged set, taken on the same machine by
the same s3cab, therefore differ in `@SNAPSHOT NAME`, `START` and `FINISH`, and nowhere else.
A deletion record has no finish instant: each `#deleted` row has its own.

Two smaller legalities, so a reader knows they weren't forgotten. A snapshot's **name** is
always `YYYY-MM-DDTHHMM` — local wall-clock time to the minute, with the colon dropped —
and the file is that name plus `.tsv.gz`. Names sort in time order except when the clock
goes back (the end of daylight saving, or a move to another zone): a later snapshot can then
sort before an earlier one, and s3cab, which takes the last name as the latest, warns when
it writes one. `START` holds the true order. In the hour after the clocks go back, every
minute comes round twice, so a backup in a minute that already has a snapshot is refused as
a second snapshot in the same minute. And a snapshot with **no file rows at all** is
perfectly legal: an empty backup set, not a damaged file.

### Valid and invalid files

A valid file is what s3cab writes, and that goes for a [deletion record](#the-deletion-record)
as much as a snapshot:

- UTF-8 with LF endings, the heading row first and the `.` last;
- only types this version knows, other than `@` and `#` ones;
- every per-path row's path absolute, with no tab, CR or LF;
- every segment of a path past its root (`/`, `C:\`, or a share's `\\`) a name: not empty, so
  no trailing or doubled separator, and not `.` or `..`;
- every per-path row's path strictly inside a `@SET DIR`: under one, and never any `DIR`
  itself, a nested one included;
- no file row's path running through another's as a folder, paths compared exactly:
  `/home/me/a` and `/home/me/a/b.txt` can't both be files, since a restore can't make `a`
  both;
- each path in at most one per-path row, whatever its type, paths compared exactly;
- exactly one `@S3CAB SPEC`, one `@CLIENT NAME` and one `@CLIENT VERSION`;
- each file row's hash 64 lowercase hex characters, its size decimal, its time the
  24-character form, and the same for a `#deleted` row.

A reader meets files that aren't, since these are text files anyone can edit, and does one
of three things:

- **Refuse the whole file** when it isn't UTF-8, doesn't start with the heading row, doesn't
  end with the `.`, has rows after the `.`, or holds an unknown type starting with neither `@`
  nor `#`. Each means the file isn't what it claims, was cut short, or comes from a newer
  s3cab, and restoring part of it would pass for a full restore.
- **Refuse one path, restore the rest, and exit nonzero** for a malformed file row, or a
  file row whose path breaks one of the path rules above. Where a rule is about two file rows
  (one path in both, or one running through the other), **both rows are refused, so no
  reader guesses**: a first-wins and a last-wins reader would restore different bytes from
  one file, and neither would report anything wrong. A row refused for any other reason
  blocks nothing, since it lands nowhere. A `..` segment matters most, since a hand-added one
  would walk a naive restorer out of its output directory. A `#` row repeating a file row's
  path also makes the file invalid, but changes nothing a restore writes, so a reader that
  skips `#` rows needn't check for it. This is the same
  ["restore everything you can, then report"](#reading) that governs a missing object: a bad
  row costs its own path, or the two paths in conflict, and nothing else.
- **Ignore** an unknown `@` or `#` type or property, and a people-only row that's wrong, such as
  `FILES` disagreeing with the row count, or an `@S3CAB SPEC`, `@CLIENT NAME` or
  `@CLIENT VERSION` row missing or repeated.

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
verifies; the uncompressed deletion record has only its `.`. The store's ETag is no
substitute: it is a content hash only for single-part uploads to AWS.

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

- Ignore every key under a `.`-prefixed top-level folder, and every `snapshots/<set>.info`:
  nothing a restore needs is in either.
- Read every snapshot and deletion record by the [four reading rules](#reading-the-text-four-rules-that-hold-everywhere):
  strict UTF-8, split on LF alone, no escaping, the leading fields trimmed and the last
  taken verbatim.
- Decompress a snapshot as gzip.
- Take a row's type from its first field, trimmed, compared case-sensitively.
- Check every snapshot and deletion record as [valid and invalid files](#valid-and-invalid-files)
  sets out: refuse the whole file, refuse one path and carry on, or ignore the row. A file
  whose first line isn't the [heading row](#the-columns), all five fields, or whose last line
  isn't the `.`, is refused whole.
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
- **The heading row's column 4.** It holds the word `time`, not an instant, so a reader that
  checks column 4 of every `@` row as an instant refuses every file at its first line.
- **Trimming in Python.** `str.strip()` isn't quite the trim for the leading fields: it also
  removes `\x1c` to `\x1f` and U+0085, and keeps a byte-order mark.
- **gzip.** `gunzip -c` and Python's `gzip` module hand over every line they can decompress
  before reporting a cut-short file, which is why the `.` matters. Python's `gzip.decompress`
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
- **Restoring on another operating system, or where case is ignored.** A snapshot can hold
  two paths differing only in case, from Linux or from a Windows directory set to be
  case-sensitive, and a Linux one can hold characters Windows forbids. The twins collide in
  an ordinary Windows or macOS directory, and most of the characters fail on Windows. Some
  names Windows misreads instead: `\` is a separator to it, so `a\..\x` climbs out of the
  output directory like a hand-added `..`, and s3cab refuses such a name. The format
  records what was there; what to do on arrival is your tool's choice, worth stating.
  So is whether a download that doesn't hash to its key is still worth writing, clearly
  flagged, or better withheld.
- **Storage class.** A bucket lifecycle rule that moves `objects/` to an archive tier breaks
  a plain download for every tool, s3cab included.

### Writing a snapshot

- Walk every member directory without following a link. A member directory that is itself a
  link is followed, since it was named as one, and recorded as its [real path](#paths); links
  found inside it are not. Hidden and system files are ordinary files.
- Leave out what you choose to, if your tool offers that; nothing requires it.
- Write a row per entry:
  - a [file row](#the-columns) for each file: the SHA-256 of its content in lowercase hex,
    its size in bytes, its modification time rounded to the nearest millisecond (a tie to
    the later) in the 24-character form, and its absolute path;
  - `#excluded` for an entry you left out on purpose, with whatever says why in column 2,
    such as the pattern that matched, or nothing. Your tool's own working folders need no
    row;
  - `#error` for an entry whose type couldn't be determined, a file that couldn't be read,
    a file whose modification time the 24-character form can't hold (a year past 9999,
    which NTFS allows), and a [link](#links) leading
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

  If your tool can leave entries out, that is the way past each of these: leaving out the
  name, or the inner directory from the outer one's walk.
- In an `#excluded` or `#error` row, where a name with a tab, CR or LF can still appear,
  write those characters as `␉` (U+2409), `␍` (U+240D) or `␊` (U+240A).
- Start with the heading row, then the [whole-snapshot rows](#the-whole-snapshot-rows): one
  `@S3CAB SPEC` with the date at the top of this page, and one `@CLIENT NAME` and one
  `@CLIENT VERSION` naming your tool. Give each path at most one per-path row; end with
  `@SNAPSHOT FINISH`, its instant rounded up, then the `.`.
- Five tab-separated fields on every line but the `.`, UTF-8 with no BOM, LF endings, one gzip
  stream.
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
  becomes three U+FFFD.
- **Two spellings of one name.** NTFS can hold `café.txt` spelled with one accented character
  and with a letter plus a combining accent side by side, as two files. Never normalize a
  name: the two rows would collapse into one path.
- **Not overwriting a snapshot.** Python's `os.rename` refuses an existing target on Windows
  but silently replaces it on Linux and macOS. There, link the new name and remove the old
  one instead.
- **The gzip header.** Python's `gzip.open` writes the file's name and the current time into
  the header, so a snapshot written under a temporary name carries that name. Use
  `gzip.GzipFile(filename="", mtime=0, fileobj=…)`.
- **Line endings and encoding.** Python's text mode on Windows writes CRLF, and before
  Python 3.15 encodes as the locale's code page, often cp1252, which fails on a name like
  `🎉.txt`. Write bytes, or open the file with `newline="\n"` and `encoding="utf-8"`.
- **Time zones.** Python's standard library can't name the local IANA zone, and on Windows
  has no zone data without the `tzdata` package. `START`'s zone is written for people, so
  write the best name you have. On Windows 10 1903 and later, `ctypes` can ask `icu.dll`'s
  `ucal_getDefaultTimeZone` for it (`Europe/London`); the registry has only Windows' own
  name (`GMT Standard Time`).
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
- Count an object already at its key as stored, without downloading it to check. Wrong
  bytes there are damage, for a check of the whole repository to find.
- Store no `Content-Encoding` and no `x-amz-meta-*` metadata, for objects and snapshots
  alike. A downloader that honours `Content-Encoding: gzip` hands back a snapshot's
  decompressed text instead of the stored file.
- Never upload a snapshot a reader would [refuse whole](#valid-and-invalid-files): one that
  isn't UTF-8 once decompressed, doesn't start with the heading row, doesn't end with the
  `.`, has rows after the `.`, or holds an unknown type starting with neither `@` nor `#`.
- Upload a snapshot whose rows a reader refuses one path at a time like any other, with no
  object for those rows. Its other rows still restore, and the reader reports the rest.
- Upload a snapshot byte for byte to `snapshots/<set>/<name>.tsv.gz`, where `<set>` is the
  set it belongs to and `<name>` is its file name without `.tsv.gz`. Never upload over an
  existing one. One already there with the same bytes is already uploaded; one with
  different bytes is a conflict, refused.
- Claim a new set by creating [`snapshots/<set>.info`](#who-holds-a-set) with a conditional
  PUT, only while `snapshots/<set>/` is empty, and refuse the name otherwise. Write its
  `OWNER`, `CLAIMED` and `CREATED` lines with LF endings, and keep the `OWNER` and `CLAIMED`
  you wrote, wherever your tool keeps its own state.
- Immediately before uploading a snapshot, read `snapshots/<set>.info`, and refuse unless
  its `OWNER` and `CLAIMED` match, as text, the pair you kept.
- Take a set over only when asked: rewrite `OWNER` and `CLAIMED` and keep `CREATED`, or,
  with no `.info`, create one with a conditional PUT.
- Write nothing outside the layout and your own `.<name>/` folder.

**What trips people up:**

- **Line endings.** Python's text mode writes `.info` with CRLF on Windows.
- **Windows paths: go through `\\?\`.** An uploader opens every recorded path, so the
  [writer's trap](#writing-a-snapshot) applies here too: a trailing space or dot, or a path
  past 260 characters, finds the wrong file or none.
- **Checking bytes before they're visible.** A plain PUT is visible the moment it returns, so
  deleting wrong bytes afterwards leaves them stored if the uploader dies in between. S3
  checks them itself when you send `x-amz-checksum-sha256`, which takes the base64 of the
  binary digest, not the hex key: a mismatch stores nothing.
- **Multipart checksums.** A multipart object's stored SHA-256 is a checksum of its parts'
  checksums, not the file's hash, so it can't be compared with the key. Check the bytes
  before they're visible instead:
  - send each part with its own `x-amz-checksum-sha256`, which S3 checks;
  - hash the whole file from those same bytes;
  - send `CompleteMultipartUpload` only if that hash equals the key, and abort the upload
    otherwise, which leaves nothing stored.
- **Not overwriting.** `If-None-Match: *` makes a PUT refuse an existing key with 412, and
  can't be raced the way HEAD then PUT can.
- **Content type.** Python's `mimetypes` reports a `.tsv.gz` file's encoding as `gzip`, and a
  tool that passes that on sets the header the checklist rules out.
- **`Content-Encoding: aws-chunked`.** boto3 1.36 and later send it on every upload by
  default, as a transfer encoding, and AWS doesn't store it. Other S3-compatible stores are
  untested. Supplying `ChecksumSHA256` yourself makes boto3 send a plain body instead.
- **Printing a path in Python on Windows.** Before Python 3.15, redirected output is encoded
  in the locale's code page, and a path like `café.txt` spelled with a combining accent raises
  `UnicodeEncodeError` between the objects and the snapshot. Run with `-X utf8`.

### Deleting

- Write a [deletion record](#the-deletion-record) before deleting any object it lists, as
  `objects.deleted-<n>.tsv` under an index not already in use, never over an existing record.
- Give it the heading row, one `@S3CAB SPEC`, `@CLIENT NAME` and `@CLIENT VERSION` each, a
  `#deleted` row per object (hash, size, the UTC instant, and `user@machine`), and the `.`
  last.
- Never delete an object younger than a generous grace window (s3cab's is 7 days), and don't
  clean up while a backup is running.
- To compact records, write the merged record before deleting the files it absorbs, and drop
  only rows whose hash no snapshot references.
