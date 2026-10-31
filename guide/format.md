# The s3cab format spec — repository & snapshot files

This is the spec of 2026-10-30.

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

## Reading the text: five rules that hold everywhere

These come first because they govern **every** snapshot and deletion record. Get them right
and nothing else below needs special handling. (A set's `.info` file has
[a simpler rule of its own](#who-holds-a-set).)

- **UTF-8, no BOM**, always, whatever machine wrote the file. A path is stored as its UTF-8
  bytes even on Windows, where the operating system itself holds names as UTF-16. Decode
  strictly: a decode error means the file is damaged, not that some other encoding is worth
  trying. A BOM someone's editor added is the one exception a reader may forgive, and s3cab
  does: it reads past one at the start of a file.
- **Every file in the format ends its lines with LF** (`\n`), never CRLF, and the last line
  is terminated like the rest. Split on LF *exactly*: a legal filename can hold other
  characters that some line splitters break on, which cuts a path in half and never says
  why. A file with CRLF endings is refused whole: its heading row's last field then ends
  in a CR, and so does its `.`.
- **Nothing is quoted or escaped** — that plainness is the whole point. It is what makes a
  naive `split("\t")` safe, and it is why no field in a snapshot holds a real tab, LF or CR
  (a path with one is [refused at backup time](#what-is-deliberately-not-stored), and
  anywhere else [they are spelled out](#no-row-holds-a-tab-or-a-line-ending)). Every other
  character, control characters included, is fair game in a path.
- **Trim the leading fields; never trim the last.** The leading fields are padded with
  spaces so the raw file reads as columns, and are trimmed at both ends. The trim removes
  exactly these, JavaScript's `trim()` set:
  - tab, LF, VT, FF and CR (U+0009 to U+000D);
  - the spaces U+0020, U+00A0, U+1680, U+2000 to U+200A, U+202F, U+205F and U+3000,
    which are Unicode's category Zs;
  - U+2028, U+2029 and the byte-order mark U+FEFF.

  Nothing else, so not U+0085. The last field — a path, or a property's value —
  is never padded, and must be taken **verbatim**: everything after the fourth tab, to the
  end of the line. On Linux and macOS a filename may legitimately begin or end with a space,
  and a parser that strips every field restores `" notes.txt "` as `"notes.txt"` — the wrong
  file, with nothing reported.
- **Every line is five fields, split at its first four tabs.** So a fifth tab is part of
  the last field, never the start of a sixth, and a line with fewer reads the missing ones
  as empty. A file row with a tab in its path is [refused](#valid-and-invalid-files), and
  an `@` row with fewer than five fields has no value: a `@SET DIR` without one, or with an
  empty one, is no directory.

## The remote repository (the keystone)

One S3 bucket is one **repository** — the layout is fixed by convention, never an arbitrary
prefix, so anything (s3cab, another tool, or you by hand) can find everything:

```
s3://my-backup-bucket/
  objects/<sha256>                  # every backed-up file, stored once, named by content hash
  snapshots/<set>/<name>.tsv.gz     # each backup set's snapshot files
  snapshots/<set>.info              # which machine holds the set
  objects.deleted-<n>.tsv           # deliberate-deletion records (only if `delete` has run)
  locks/<kind>-<instant>            # one per running upload or delete (only while one runs)
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
  local timestamp (`20260612T0915.tsv.gz`). Only a key directly in that folder, named
  exactly that way, is a snapshot, for every purpose: one in a folder below it is not, so
  it names the latest for no reader and protects no object from a clean-up. A snapshot is uploaded **byte for byte**, with
  no conversion on the way. Whether a tool keeps a local copy too is its own choice; s3cab
  does, writing it first and uploading that file, so the two are identical.
- **A set's name** is one or more of the ASCII letters `a` to `z` and digits, with single
  hyphens between them: `my-photos`, never `-photos`, `my--photos` or `Photos`. With no
  dot in a name, `<set>.info` can't be mistaken for a set, nor collide with a set's folder
  in a bucket copied to disk. Listing a bucket's sets, s3cab counts every folder or `.info`
  named with those characters alone, hyphens anywhere, and ignores any other.
- **`snapshots/<set>.info`** records which machine [holds the set](#who-holds-a-set): the
  one that backs it up.
- **`objects.deleted-<n>.tsv`** — the format's only root-level keys — are its
  [deletion records](#the-deletion-record): small plain-text files marking content as
  *deliberately* removed. A repository where `delete` has never run simply has none.
- **`locks/`** holds one small file per upload or delete that is running right now, so the
  two kinds never overlap: [locks](#locks). A reader ignores the folder.
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

One rule follows for **any** tool that deletes from a repository: while a backup is running,
what it has uploaded, or found already stored and skipped, looks exactly like an orphan, so
uploads and deletes take turns — [locks](#locks).

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
- Both instants are UTC, in the same form as a snapshot row's `mtime`, cut down to the
  millisecond like `START`. They are only ever compared as text, never read as times.

Read it line by line: UTF-8, split on LF, strip one trailing CR, split each line at its
first `=` with the rest as the value, and skip a line with no `=` and keys you don't know.
A value may hold `=` or `#`. Where a key is repeated, the last one counts. s3cab reads any
bytes that aren't UTF-8 as U+FFFD, so a value holding them matches nothing it wrote.

The rules for writers:

- **Claiming a new set** is a conditional PUT of `<set>.info`, made only while
  `snapshots/<set>/` holds no snapshot: no key directly there named like one. A set with snapshots
  and no `.info` already exists. Claim whenever you like before the first snapshot's
  upload. s3cab claims when a set is set up, so a `.info` with no snapshots is a set not
  yet backed up, or whose first backup stopped.
- **Publishing a snapshot** checks the holder immediately before the snapshot's upload:
  read `<set>.info`, and refuse unless its `OWNER` and `CLAIMED` each match, as text, the
  pair you wrote when you claimed. Never work the pair out again: a renamed machine would
  lock its own holder out. With no `.info` there, refuse too: the set has no holder until
  one takes it over. Where you keep the pair is your tool's choice; s3cab keeps it per set,
  and forgets it once it stops matching, since it never can again.
- **Taking a set over** rewrites `OWNER` and `CLAIMED`, and keeps `CREATED`, or sets it to
  the new `CLAIMED` when it is missing or empty. s3cab rewrites it with a plain PUT, not a
  conditional one. A set with no `.info` is taken over by creating one with a conditional
  PUT, `CREATED` equal to `CLAIMED`.
- **Reading needs no `.info`**: nothing a restore needs is in it.

Three gaps are known, and left open:

- A takeover landing between the check and the upload lets the old holder publish one more
  snapshot. S3 can't make one key's upload conditional on another's.
- For the same reason, a snapshot uploaded between a new claim's check that
  `snapshots/<set>/` holds no snapshot and its PUT leaves a `.info` claiming a set that already has
  history, its `CREATED` later than its first snapshot.
- The pair is a token, so it travels with copied state: a machine cloned after the claim,
  or a home folder restored onto a new machine. Both copies pass the check.

This is a rule for tools that follow this spec, not a lock: anyone holding the bucket's
write keys can ignore it.

### Locks

If your tool only reads a repository, skip this section: reading takes no lock, and a reader
ignores every key under `locks/`.

An **upload** (a backup, or any tool storing objects) and a **delete** (a clean-up, or any
tool removing objects) never run at the same time. Under objects first, snapshot last, what
an upload has stored, or found already stored and skipped, is referenced by nothing until its
snapshot lands, so a delete running beside it would take that content for an orphan. Each
kind of run holds a lock in the bucket while it runs, and refuses to go ahead while the other
kind's lock is there.

- A lock is a key `locks/<kind>-<instant>`: the kind, `upload` or `delete`, then the instant
  the run started, UTC to the millisecond in ISO 8601's basic form —
  `locks/upload-20261027T140205.123Z`. The key without `locks/` is the lock's **id**.
- Its content is `KEY=value` lines, read as [`.info`](#who-holds-a-set) is:
  - `COMMAND`, what is running.
  - `SET`, the set it is for, when it is for one.
  - `BY`, `user@machine`.
  - `OS`, a name for the operating system whose process table holds the pid. s3cab writes
    Node's `process.platform`, such as `win32` or `linux`.
  - `PIDNS`, on Linux only, the target of `/proc/self/ns/pid`, such as `pid:[4026531836]`: which
    of the machine's process tables holds the pid.
  - `PID`, the process.
  - `STARTED`, the instant again in the 24-character form `.info` uses.
- `BY`, `OS`, `PIDNS` and `PID` together say whose process holds the lock. The rest is for
  people and messages.
- `OS` and `PIDNS` are compared for equality only, never parsed. They are there because one
  machine name can cover several process tables: WSL reports the Windows machine's name, and
  often its user, and each WSL distro and each container has a process table of its own.
- Two uploads may run together, and so may two deletes: an upload refuses only on a `delete-`
  lock, a delete only on an `upload-` lock.
- **Write first, look second.** A run writes its own lock *before* it lists `locks/`, and
  before anything that decides what to skip or delete. Two runs that start together then each
  see the other's lock, so at worst both refuse. A run that looked first could see nothing
  while the other's lock was on its way, and both would carry on.
- Write a lock with a no-overwrite PUT (`If-None-Match: *`). On a 412, read the key back: your
  own bytes mean your own write, retried after a lost response, and the lock is yours. Anything
  else means another run took that instant, so take a fresh one and write again.
- Remove the lock when the run ends, success or failure, but not while the run's requests may
  still be in flight. A hard stop — a crash, a lost machine, a killed process — leaves one.
- A lock never expires. Its age says nothing about whether its run is alive: a first backup
  runs for hours. What does is its process.
- A run whose `BY`, `OS` and `PIDNS` are the lock's own may remove the lock once its process
  (its `PID`) is gone. A `PIDNS` absent on both sides matches.
- A lock whose `OS` or `PIDNS` differs, or whose `OS` is absent, is never judged.
- Any other leftover is removed by a person who knows the run is dead; in s3cab, `unlock`.
- Like `.info`, these are rules for tools that follow the spec, not enforcement: anyone
  holding the bucket's write keys can ignore them.

How s3cab waits for a running backup instead of refusing is its own business:
[looking after a backup](maintenance.md#locks-backups-and-clean-ups-take-turns).

### The deletion record

`s3cab delete` removes content from the whole backed-up history by its hash — and because
snapshots are immutable, it does so **without touching a single snapshot file**: it deletes
the backing objects and writes a **deletion record** at the bucket root:
`objects.deleted-1.tsv`, then `-2`, and so on. A record is never overwritten: each run
takes the index after the highest in use, and the next one up if another run got there
first, so two runs — even at the same moment — simply land on different numbers. The index
tells two *files* apart and makes no claim about time: gaps in the sequence are normal (see
compaction below), and *when* and *who* live inside the rows. `<n>` is a whole number from 1
up, in decimal digits with no leading zero, and a key spelled any other way, such as
`objects.deleted-01.tsv`, is not a record.

**Read every `objects.deleted-<n>.tsv` key, and treat them as one set.** Nothing depends on
which file a row sits in: when two rows list the same hash, s3cab takes the newest. For a
snapshot, a hash is deliberately gone only when a row lists it with an instant later than
the snapshot's `@SNAPSHOT START`, compared as text:
- the object was in the bucket when that snapshot was uploaded, so an older row doesn't
  explain the miss, and the miss is damage;
- the two instants come from two machines' clocks, so a clock that puts a real deletion
  before the backup makes it read as damage, the safe side;
- a snapshot with no `START` has nothing to compare, and its miss is damage too;
- a `START` that isn't a real instant in the 24-character form counts as none;
- s3cab's `verify` asks this of every snapshot that references the hash.

The record is what lets any tool — s3cab or a future reader of the bare files — tell
*deliberately gone* from *corrupted*: an object a snapshot references but the store lacks is
**expected** if a record lists its hash after the snapshot started, and an integrity fault
otherwise. A record
carries **no paths** — whoever meets the absence is already holding a snapshot with the
path in front of them; what the record adds is that the absence is deliberate, when, and by
whom.

A record is plain, uncompressed text in a snapshot's [five columns](#the-columns): the same
heading row, `@S3CAB SPEC` and `@CLIENT` rows first, then one `#deleted` row per deleted
object, and [the `.` line](#the-last-line) last:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    SPEC                                                        2026-10-30
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
`user@machine`. The last is for people and isn't checked: it may be empty, or missing
with the tab before it. Skip every other `@` or `#` row. A record holds no `-` rows, and one makes it
invalid, like any type starting with neither `@` nor `#`. The `.` says the file is whole, as
it does for a snapshot, and [valid and invalid files](#valid-and-invalid-files) covers a
record that isn't. A record has no `@SET` or `@SNAPSHOT` rows: it belongs to the bucket, not
to one set or one backup run.

**Records are compacted, not kept forever.** `s3cab cleanup` merges every record file into
one fresh file (at the next free index) and drops rows whose hash **no snapshot anywhere
references** — once nothing references a hash, nothing can ever ask why it is absent, so
the row has no reader left. The merge is written *before* the absorbed files are deleted,
so the bucket at any moment holds every live row at least once; a row duplicated across two
files is harmless. This is why when and who live in the rows: filenames don't survive
compaction.

A reader that lists the records and then fetches them can still miss a row: a file
compacted between the two is gone, and the merge holding its rows came after the list.
What that costs s3cab:

- A restore running beside a compaction can report a deliberately deleted file as damage.
  That is the safe direction: a missed row never makes missing content look intentional.
- `backup` and `status` count a record that has gone as
  [invalid](#valid-and-invalid-files), so they don't let an earlier snapshot vouch for
  what is stored. A missed row would otherwise let them do that for content deliberately
  deleted.
- `cleanup` refuses to delete or compact anything, and says to re-run once the other
  cleanup has finished.

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

A reader still decompresses what it is given, not what was promised:

- **Several gzip streams, one after another, are one text**, decompressed in turn and
  joined, as `gunzip` does. Two snapshots joined that way then read as rows after the `.`,
  and are refused whole; a reader that stops after the first stream restores the older one
  and reports nothing.
- **A zero byte after a stream ends the file**: it and everything after it are ignored, as
  Node's gunzip does for s3cab.
- **Any other byte after a stream that doesn't start another** makes the file damaged.
- **Any gzip error** makes the file damaged, the CRC-32 and length check at its very end
  included, even when the text before it looks whole.

The [five reading rules](#reading-the-text-five-rules-that-hold-everywhere) apply here in
full — encoding, LF splitting, no escaping, never trimming the last field, and five fields
to a line. This section adds only what is specific to snapshots.

Every line but [the last](#the-last-line) has the same five columns, and the first says what
kind of row it is. The file
says where it came from before it lists anything, so it is self-describing even found alone
in a bucket:

```
@S3CAB    FORMAT                      size  time                      https://s3cab.plantegral.com/guide/format
@S3CAB    SPEC                                                        2026-10-30
@CLIENT   NAME                                                        s3cab
@CLIENT   VERSION                                                     0.14.0
@CLIENT   HOME                                                        C:\Users\me\.s3cab\
@CLIENT   EXCLUDE                                                     *.tmp
@SET      NAME                                                        photos
@SET      BUCKET                                                      s3://my-backup-bucket
@SET      DIR                                                         C:\Users\me\Photos\
@SET      DIR                                                         D:\Pics\
@SNAPSHOT NAME                                                        20260612T0915
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
- **size** — bytes, in decimal: one or more of the ASCII digits `0` to `9`, with no sign,
  no separator and no limit. A leading zero is allowed. This column holds file sizes and
  nothing else, so its sum is the backup's total. It is the size the file had when its
  modification time was read, just before its content was hashed.
- **mtime** — the file's modification time as exactly `YYYY-MM-DDTHH:MM:SS.sssZ`: 24
  characters, always three fractional digits, always a literal trailing `Z`. Never a
  `+00:00` offset, never a comma for the decimal point, never a different digit count. And
  always a real instant: a day the proleptic Gregorian calendar has, hours `00` to `23`,
  seconds `00` to `59`. That calendar's year `0000` is a leap year, and its October 1582
  has all 31 days, whatever a date library says.
  Many date parsers turn 30 February into 2 March, or hour 24 into the next day, without a
  word.
- **path** — absolute, in the OS's native style, last on the line so the padded columns
  stay aligned and so it can hold spaces without ambiguity.

The columns are separated by tabs, so the file parses as clean TSV in a script.

**The first row is the heading row**, the same in every snapshot and deletion record. Its
five fields, padding aside, are exactly:

| `@S3CAB` | `FORMAT` | `size` | `time` | `https://s3cab.plantegral.com/guide/format` |
| --- | --- | --- | --- | --- |

The first four are trimmed, like every leading field. The last is the address verbatim,
like every last field, so a heading with a fifth tab or a trailing space isn't one.

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
exact duration is `FINISH` minus `START`. Column 2 is trimmed on reading like every leading
field, so a value written there loses any spaces at either end.

The canonical form of the heading row, a file row and a `@SET DIR` row, written out as JSON
strings so every tab and space shows:

```
"@S3CAB\tFORMAT                                                          \t        size\ttime                    \thttps://s3cab.plantegral.com/guide/format\n"
"-\t3b8e4c2d9a7f6e5b1c0d8a9b7e6f5c4d3b2a1908f7e6d5c4b3a21807f6e5c0a1\t     4915200\t2025-06-01T12:00:00.000Z\t/home/me/Photos/beach.jpg\n"
"@SET\tDIR                                                             \t            \t                        \t/home/me/Photos/\n"
```

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
  backup, so both leave the size and time columns blank, even where the writer knew them;
  the row says why. Any `#error` row makes s3cab's `backup` and `snapshot` exit 1, after
  the snapshot is written and, by `backup`, uploaded.
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
An `@` row's property, its second field, is trimmed and compared the same way, so
`@SET dir` is a property no reader knows, and is skipped.

### Links

**A symbolic link or junction is never followed, and its target is never backed up through
it** — a link can lead anywhere, including somewhere you never chose to back up. A link
gets a row only where the table below gives it one. Those are the only links: a volume
mount point is a junction to Windows, so it is one too, and other Windows reparse points,
such as OneDrive's online-only files, are ordinary files and directories.

| Link | Row |
| --- | --- |
| Into the backup | none; the target is recorded where it lies, saved or `#excluded` |
| Out of the backup, or somewhere this computer can't resolve | `#error`, the link's own path, with the target named in the message as the link holds it (relative, if it is), and the backup exits nonzero |
| Broken, or to a pipe, socket or device | none |
| Left out on purpose | `#excluded`, like any excluded entry |

A link to a file or directory leads **into the backup** when the place it finally resolves
to, through any further links, is a member directory or lies inside one, and **out of the
backup** otherwise. Compare the [real path](#paths) of each, spelled as the filesystem
reports it, by whole segments, exactly. Both are real paths, so where the disk ignores
case they already agree; in a case-sensitive Windows folder, `Photos` and `photos` are two
folders, and a link to the one beside a member directory named as the other leads out. A
writer's own working folder inside a member directory, such as s3cab's `.s3cab`, counts as
out: nothing in it gets a row, so its target would be recorded nowhere.

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
| `@SET ENDPOINT` | optional: the S3 endpoint the writer used, when it isn't AWS's default, as the URL it was given (`https://<account>.r2.cloudflarestorage.com`); an endpoint is how a provider other than AWS is named, where a bucket name alone doesn't say where it is |
| `@SET DIR` | a member directory, one row each, always ending in a separator |
| `@SNAPSHOT NAME` | the snapshot's name |
| `@SNAPSHOT BY` | who took it, as `user@machine` |
| `@SNAPSHOT START` | the instant the run started, before any member directory was walked (column 4), and the time zone the name was minted in |
| `@SNAPSHOT FILES` | the number of file rows |
| `@SNAPSHOT SIZE` | the sum of the size column, then a [readable form](#canonical-form) in parentheses |
| `@SNAPSHOT FINISH` | the instant the last file's row was written, before the snapshot is uploaded (column 4), and how long the run took to get there (`9s`, `12m 21s`, `3h 04m`) |

Any other `@CLIENT` row belongs to the tool `@CLIENT NAME` names, and only that tool gives it
a meaning; s3cab's are in its [README](../README.md#how-it-works) and
[backing up](backup.md#what-a-set-backs-up). A file has exactly one `@S3CAB SPEC`, one
`@CLIENT NAME` and one `@CLIENT VERSION`.

`user@machine`, in `BY`, a `#deleted` row and a set's `OWNER`, is for people: s3cab
writes the login name and the computer's name as the operating system gives them (Node's
`os.userInfo().username` and `os.hostname()`), and another tool writes whatever names its
user and machine best. No reader takes it apart, and `OWNER` is only ever compared with
what the same tool wrote.

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
[repository layout](#the-remote-repository-the-keystone), so it isn't recorded. `@SET NAME`
and `@SNAPSHOT NAME` say the same for people, and s3cab never reads them back: the key
decides which set and snapshot a file is, and nothing checks that they agree.

An entry that vanishes between being listed and its type being known gets no row either,
since there is nothing left to record. A file that vanishes after that, before it is read,
gets an `#error` row, since it was there to back up. A directory that can't be listed,
because it vanished, can't be entered, or for any other reason, stops the backup, and no
snapshot is written.

### No row holds a tab or a line ending

No field in a snapshot holds a real tab, CR or LF, and each field either refuses them or
spells them out:

- **Refused:** a file row's path. s3cab stops the backup rather than write one
  ([above](#what-is-deliberately-not-stored)). A `␉` in this field is only a character of
  the name, and restores as itself.
- **Spelled out, everywhere else:** as the Unicode Control Pictures `␉` (U+2409), `␍`
  (U+240D) and `␊` (U+240A). In practice that is an error message, a property's value,
  `@SET DIR` included, or the path in an `#excluded` row (excluding a file is how it gets
  past the refusal) or an `#error` row. Reading them as the characters they stand for is
  only for showing a value to people: s3cab never does, and matches a `@SET DIR` exactly as
  written. A directory with a tab in its name holds no file a backup can record, so turning
  its `␉` back could match no file row anyway.

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

A real path on Linux or macOS starts with exactly one `/`. Write it that way, never with
two: a reader takes a path starting with two separators for a Windows share.

**A Windows path** is told by its first characters alone, whatever machine reads it:

- a drive letter, upper or lower case, then `:`, then `\` or `/` (`C:\`, `c:/`);
- or any two separators, `\` or `/` (`\\server\share`, `//server/share`, and `\\?\C:\` too).

Every other path is a POSIX path. Its root is the two separators for a share, the letter,
colon and separator for a drive, and `/` for POSIX.

That is a promise about what s3cab *writes*. Reading is more forgiving, because these files
are yours to edit: on Windows paths, where two spellings name one file, `@SET DIR` rows are
matched against paths case-insensitively. Both are lowercased by Unicode's full default
case mapping, Final_Sigma included, as JavaScript's `toLowerCase()` does, and never
normalized — so a `DIR` row hand-edited into another case still holds its file rows. Every
other path is matched exactly, since a case-sensitive
filesystem really can hold both `Photos` and `photos`, and so can a Windows directory set to
be case-sensitive.

**Every other comparison of two paths is exact**: code point for code point, as strings,
with no case folding, no normalization and no separator unified. That covers the check that
a path is in only one row and the check that one path runs through another. Both compare
file rows with each other, and a `@SET DIR` takes part in neither: a file row whose path
runs through a `DIR` with no file row under it breaks nothing. On Windows,
`C:\P\a.txt`, `C:/P/a.txt` and `c:\P\a.txt` are three paths to these checks, though they
name one file: s3cab never writes more than one of them, and a hand-edited file that holds
several meets the destination's rules instead (see [reading](#reading)). So do `C:\P\a` and
`C:/P/a/b.txt`: the first row in the file restores, and the other is reported as a
collision or as in the way, exit 1. After an exact prefix, though, any separator of the
path's kind counts: `C:\P\a` runs through `C:\P\a/c.txt`, and both rows are refused. A POSIX
path's only separator is `/`.

**How a `@SET DIR` matches a path**, since a file row under none is refused. Compare **whole path segments, never a string prefix** — `…\trees\edge` must not
claim `…\trees\edgeX\file.txt`. Decide first whether the `DIR` is a
[Windows path](#paths), from the row as written; then ignore the separators it ends with,
and split both the directory and the path into segments: a valid path has no empty
segment, so a `DIR` with a doubled separator anywhere after its root matches nothing, and
every path under it is refused. Nor does a `DIR` that isn't an absolute path match
anything, nor a share `DIR` with no server or no share name (`\\`, `\\server\`), and one
holding a NUL holds no valid file row, since none may hold one. The root is
compared like the segments, so `c:\` and `C:/` are one root, and `\\nas\photos\` and
`//NAS/photos/` one share. Which separators count depends on the path, not the machine
reading it: a Windows path splits on `/` *and* `\`, any other on `/` alone, since there a
`\` is an ordinary character in a filename — so a Windows snapshot reads correctly on a
POSIX machine, and the reverse. A `DIR` matches only paths of its own kind, Windows or POSIX, so
a POSIX `/` holds no `\\server\share` path. A path under no `DIR` at all belongs to no
member directory, so its row is [refused](#valid-and-invalid-files) rather than guessed at;
only a hand-edited snapshot can hold one.

**Where a restored file lands is the tool's decision, not the format's.** Nothing in a
snapshot says where the bytes must go back, and a restorer is free to choose — restoring to
the recorded paths, to a chosen directory, or anywhere else. What s3cab itself does is
written down here for one reason only: so that *"does my restore agree with s3cab's?"* is a
question with an answer, rather than something you can settle only by running the tool and
looking. Restoring to a chosen directory, it writes each file at its whole path under
`<output>`, the root turned into a folder and the segments joined with the destination's
separator. So a row for `C:\Users\me\Photos\2024\beach.jpg` lands at
`<output>\C\Users\me\Photos\2024\beach.jpg`. Where a file lands depends on its own path
alone, not on the `@SET DIR` it is under or on the other rows restored. In detail:

- The root's folder:
  - a drive's is its letter, upper case however the row spells it, so `d:\a.txt` lands at
    `<output>\D\a.txt`;
  - a share's is `UNC`, as Windows' own long-path form spells it, so `\\nas\photos\a.jpg`
    lands at `<output>\UNC\nas\photos\a.jpg`;
  - `/` has none, so `/home/me/a.jpg` lands at `<output>/home/me/a.jpg`.
- Every other segment keeps the file row's spelling, the member directory's parents
  included.
- Folders are made only as files land in them, so a member directory with no files restored
  leaves no folder at all, and a restore that writes nothing makes no `<output>` either. A
  file that fails, missing or withheld or refused, leaves none of the folders made for it.
- A file already at a destination before the restore began is left alone and reported as
  skipped, unless the restore was asked to overwrite; a skip alone leaves the exit status 0.
  A destination this restore has already written is another matter: two rows landing on one
  file is a collision, so the first row restores, and each later one is reported, exit 1.
  Something in the way is reported, exit 1:
  - a folder where a file should land;
  - a file where one of its folders should be;
  - a link, or a Windows junction, where one of its folders inside `<output>` should be, since
    writing through it would land the file wherever it points.

  A link at the file's own name is a file already there. Nothing else already in `<output>`
  is touched.

**None of this binds you.** A different layout is a different tool making a different
decision, not a misreading of the format.

**A stored `mtime` is rounded to the nearest millisecond**, a tie to the later one, which is
coarser than some filesystems keep — NTFS records 100-nanosecond ticks, ext4 nanoseconds.
Two consequences to build against. A restore reproduces the *stored* value **to the
millisecond**, so a restored tree compares clean against the snapshot it came from and
re-backing it up re-uploads nothing — and compare at that resolution, not finer: below the
millisecond two restores can disagree without either being wrong. Compare times **rounded**
to the nearest millisecond, not truncated: a restore that lands a little below the stored
instant still holds it. But a restored file can also sit up to half a millisecond either
side of a *surviving original*, which any mtime-sensitive tool will report as a difference.
A disk that keeps coarser times, such as FAT or exFAT, can't hold the millisecond at all:
there the restored time is rounded to what the disk keeps.

### The last line

**The last line of every snapshot and deletion record is exactly `.`, and it means the file
is complete.** A file without it was cut short, whatever the cause, so one check catches
every kind. It is a terminator, not a row: the one line without five fields, and whose first
field isn't a type. It is the whole line, byte for byte: a line whose first field trims to
`.` but holds anything more, such as `. ` or `.` and a tab, is neither the `.` nor a row, and
refuses the file. Like every line it ends with LF, so a `.` without its LF doesn't count:
the file was cut there. Nothing follows it, not even a blank line or a second `.`. gzip does
notice a cut-short file, but only at the end: `gunzip -c` and Python's `gzip` module both
hand over every line they can decompress *before* reporting
the cut, so a reader that processes rows as they arrive has already seen a byte *prefix* of
the original, which would otherwise read as a valid, smaller snapshot. And gzip can't notice
a snapshot whose text was cut before it was compressed: that is complete gzip, and only the
`.` catches it. A snapshot without the `.` is damaged goods — treat it as truncated, not as
complete. Concretely: **don't restore from it**. The rows that
survive a cut are a valid-looking prefix, so restoring them produces a tree that looks
finished and silently isn't; refuse the snapshot, say why, and let the reader reach for an
intact one. Refusing it is a failed restore, so **exit nonzero**, as for any other. (A
reader that only wants the file rows can still skip every other line; checking for the `.`
first is what tells it the rows it read are all of them.)

The line before it, in a snapshot, is `@SNAPSHOT FINISH`. Its instant is when the last
file's row was written, and s3cab itself doesn't read it back. It's there for you, with the run's duration
beside it. Read the instant as an upper bound: the column holds milliseconds and the clock is
finer, so the figure is rounded **up** — everything in the file was written at or before the
moment it names, never after. Two snapshots of an unchanged set, taken on the same machine by
the same s3cab, therefore differ in `@SNAPSHOT NAME`, `START` and `FINISH`, and nowhere else.
A deletion record has no finish instant: each `#deleted` row has its own.

Two smaller legalities, so a reader knows they weren't forgotten. A snapshot's **name** is
always `YYYYMMDDTHHMM` — local wall-clock time to the minute, in ISO 8601's basic form —
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

- UTF-8 with LF endings, the heading row first, the `.` last, and no blank line;
- only types this version knows, other than `@` and `#` ones;
- every per-path row's path absolute, with no tab, CR or LF, and a file row's with no NUL
  (U+0000) either, which no filesystem allows in a name;
- every segment of a file row's path past its root (`/`, `C:\`, or a share's `\\`) a name:
  not empty, so no trailing or doubled separator, and not `.` or `..`. A `#` row naming a
  directory ends its path with [one separator](#row-types), and a reader doesn't check a
  `#` row's segments;
- every file row's path strictly inside a `@SET DIR`: under one, and never equal to any
  `DIR` by [the matching rules](#paths), a nested one included. A `#` row's path is under
  one, or may be a nested `DIR` itself: the `#excluded` row of a member directory left out
  of an outer one's walk;
- no file row's path running through another's as a folder, paths compared exactly:
  `/home/me/a` and `/home/me/a/b.txt` can't both be files, since a restore can't make `a`
  both;
- each path in at most one per-path row, whatever its type, paths compared exactly;
- exactly one `@S3CAB SPEC`, one `@CLIENT NAME` and one `@CLIENT VERSION`;
- each file row's hash 64 lowercase hex characters, its size decimal, its time a real
  instant in the 24-character form, and the same for a `#deleted` row.

A reader meets files that aren't, since these are text files anyone can edit, and does one
of three things:

- **Refuse the whole file** when it isn't UTF-8, doesn't start with the heading row, doesn't
  end with the `.`, has anything after it, or holds a blank line or an unknown type starting
  with neither `@` nor `#`. Each means the file isn't what it claims, was cut short, or comes
  from a newer s3cab, and restoring part of it would pass for a full restore. A deletion
  record is the exception: it is distrusted instead (below), and its well-formed rows still
  count.
- **Refuse one path, restore the rest, and exit nonzero** for a malformed file row, or a
  file row whose path breaks one of the path rules above. Where a rule is about two file rows
  (one path in both, or one running through the other), **both rows are refused, so no
  reader guesses**: a first-wins and a last-wins reader would restore different bytes from
  one file, and neither would report anything wrong. Every file row takes part in the check
  for one path in two rows, a malformed one included, so a malformed twin refuses its
  well-formed sibling too. Check one path running through
  another last, among the rows every other check let through: a row refused for any other
  reason blocks nothing, since it lands nowhere. A `..` segment matters most, since a
  hand-added one would walk a naive restorer out of its output directory. A `@SET DIR` row isn't checked for
  one, and needn't be: a file row under it holds its segments, so a `DIR` with a `.` or `..`
  refuses every row beneath it. A `#` row repeating a file row's path also makes the file
  invalid, but changes nothing a restore writes: the file row still restores, so a reader
  that skips `#` rows needn't
  check for it. This is the same ["restore everything you can, then report"](#reading) that
  governs a missing object: a bad row costs its own path, or the two paths in conflict, and
  nothing else.
- **Ignore** an unknown `@` or `#` type or property, and a people-only row that's wrong, such as
  `FILES` disagreeing with the row count, or an `@S3CAB SPEC`, `@CLIENT NAME` or
  `@CLIENT VERSION` row missing or repeated. s3cab doesn't count an `@` or `#` row's fields:
  it reads the columns it needs by position, and the last as the rest of the line.

Outside a restore, s3cab reads a refused path as one with no row: `backup` hashes the file
again, `compare` lists it as unreadable, as it does for an `#error` row, and `verify` reports
it as damage. `cleanup` won't run at all while a snapshot has one, since content only that row
names would look unused and be deleted.

**A deletion record is judged the same way, and distrusted while it's invalid.** A malformed
`#deleted` row is refused, so its object counts as not deleted, and its absence is reported
as unexplained damage with a nonzero exit. That is the safe direction: a damaged record can
never make missing content look intentional. The well-formed rows of an invalid record
still explain an absence, even in one with no heading row or no `.`; a first line that
isn't the heading row is read as a row. Decode each line on its own: an LF byte is never
part of another character, so a line that isn't UTF-8 is one wrong line, wherever the bad
bytes sit, and the lines around it still read. A record listed but gone by the time it is
read is invalid too, and explains nothing.

While any record file is invalid, `backup` and `status` check
what the bucket actually holds rather than trust an earlier snapshot's word, and `cleanup`
refuses to delete or compact anything, since compacting would rewrite only the rows it
could read and lose the rest for good.

**What a reader promises, even for an invalid file:** it never writes outside the
destination, never writes bytes that don't hash to the row, never chooses between
conflicting rows, and never lets a partial restore pass for a full one. Two spellings of
one file aren't conflicting rows to the format: they meet the destination's rules, which
[report](#paths) every row but the first. What it can't
promise is that a valid but edited file is true: a hash changed to another stored object
restores the wrong content, faithfully.

Whole-file integrity is gzip's CRC-32 and length check, which decompressing a snapshot
verifies; the uncompressed deletion record has only its `.`. The store's ETag is no
substitute: it is a content hash only for single-part uploads to AWS.

## Recovering by hand (no s3cab)

1. List `snapshots/<set>/` in the bucket and download the snapshot you want.
2. Decompress it: `gunzip 20260612T0915.tsv.gz`. Windows has no `gunzip`, but
   PowerShell needs nothing installed, since .NET's `GZipStream` is built in:
   ```powershell
   $f = Resolve-Path 20260612T0915.tsv.gz
   $gz = [IO.Compression.GZipStream]::new([IO.File]::OpenRead($f), [IO.Compression.CompressionMode]::Decompress)
   $out = [IO.File]::Create(($f -replace "\.gz$", "")); $gz.CopyTo($out); $out.Close(); $gz.Close()
   ```
   Then check that the `.tsv`'s last line is `.`, which is all that proves the rows are all
   there: `GZipStream` can stop short [without a word](#reading).
3. Open the `.tsv` — a text editor or a spreadsheet — and find your file's row, one of those
   starting `-`.
4. Download `objects/<its-hash>` from the bucket. That is your file, byte for byte; the row
   tells you its original path and modification time.

To try it on a real bucket first, take the challenge:
[the day s3cab disappeared](https://s3cab.plantegral.com/challenge).

Or write a replacement tool in an afternoon — that is the point.

## Writing your own tool

Each checklist below is everything a tool doing that job has to get right; the sections
above explain every item. The hints after each are what tends to go wrong in practice.

### Reading

For a restorer, or anything else that reads the files.

- Ignore every key under a `.`-prefixed top-level folder, every key under `locks/`, and every
  `snapshots/<set>.info`: nothing a restore needs is in any of them, and reading takes no lock.
- Read every snapshot and deletion record by the [five reading rules](#reading-the-text-five-rules-that-hold-everywhere):
  strict UTF-8, split on LF alone, no escaping, the leading fields trimmed, and the last
  taken verbatim after the fourth tab.
- Decompress a snapshot as gzip, [every stream in turn](#snapshot-files). A zero byte after
  a stream ends the file. Any other byte there that doesn't start a stream, or any gzip
  error, makes the file damaged.
- Asked for a set's latest snapshot, s3cab takes the key directly under
  `snapshots/<set>/` whose [name](#the-last-line) sorts last:
  - It ignores any key not named exactly `YYYYMMDDTHHMM.tsv.gz`, digits in those places
    and nothing more.
  - It doesn't check that the digits make a date, so a hand-placed `20261345T9999.tsv.gz`
    counts, and sorts by its text like any other.
  - It ignores any key in a folder below, such as
    `snapshots/<set>/old/20990101T0000.tsv.gz`.
  - It doesn't fall back to an earlier one when that one is refused.
  - Neither the upload time nor `START` decides.
- Take a row's type from its first field, and an `@` row's property from its second, each
  trimmed and compared case-sensitively.
- Check every snapshot and deletion record as [valid and invalid files](#valid-and-invalid-files)
  sets out: refuse the whole file, refuse one path and carry on, or ignore the row. A file
  whose first line isn't the [heading row](#the-columns), all five fields, or whose last line
  isn't the `.`, is refused whole.
- Check that each file row falls inside a `@SET DIR`, [matched by whole segments](#paths).
  On a [Windows path](#paths), ignore case by the mapping given there. Where it lands is
  your tool's decision.
- Write each name as the name it is, the folders above the member directory included. On
  Windows, a POSIX name holding `\` would be split
  into folders, and one holding `:` written to a hidden stream of the file named before
  it, both without an error. s3cab refuses such a row before anything is written, exit 1.
- Fetch each file row's content from `objects/<hash>`, an empty file's
  `e3b0c442…b855` like any other, and check that what you downloaded
  hashes to that key. The hash decides: s3cab never compares the size column with the
  download.
- When a fetch misses, and only then, look the hash up in every `objects.deleted-<n>.tsv`
  read as one set. A hash a record lists, in a row dated after the snapshot's `START`, was
  [deliberately deleted](#the-deletion-record); any other miss is damage, and so is a
  download that doesn't hash to its key, which s3cab doesn't fetch again for any later row
  naming that hash. A miss is a 404 whose S3 error code is `NoSuchKey`, or `NotFound`,
  which some providers send. A HEAD's 404 has no body, so no code, and libraries name it
  themselves: `NotFound` in the AWS JavaScript SDK, `'404'` in botocore. s3cab fetches with
  GET, and stops the whole restore on any other failure:
  - a 404 `NoSuchBucket`, which says nothing about the file;
  - a 403, which S3 also answers for a missing key when the caller may not list the
    bucket, and the records can't tell that from a permissions fault;
  - a request that still fails after its retries;
  - any failure listing the deletion records, and any but a miss reading one.
- Retry a request before giving up on a dropped connection or a 5xx, which is also how S3
  throttles (`503 SlowDown`): neither says anything about the file. Each wait is random,
  under a ceiling that doubles every time. s3cab retries:
  - a dropped connection for two minutes from the first failure, the ceiling starting at
    0.5 seconds and stopping at 2. A connection is dropped when it is reset, refused or
    broken, the host or network can't be reached, the name won't resolve, connecting
    takes 10 seconds, or a connection goes 30 seconds without a byte either way;
  - a 5xx up to three attempts in all, as the AWS SDK does: the ceiling starts at
    0.1 seconds, or 0.5 when throttled, and stops at 20.
- Restore everything you can, then report. Skip a deliberately deleted file and say so, with
  its date; that alone isn't damage, and s3cab exits 0 when deliberate deletions are all
  that's missing. Report damage, carry on with the rest, and exit nonzero at the end: a recovery
  tool that stops dead at file 3 of 400 is materially worse than one that recovers 397 and
  names the three.
- Tell a destination that was there before the restore from one this restore wrote. The
  first is skipped, unless asked to overwrite, and a skip alone exits 0. The second is two
  rows landing on one file, however differently their paths are spelled: the first row
  restores, and each later one is reported, exit 1. s3cab checks the destination first,
  and fetches nothing for a row it skips.
- Set each restored file's modification time to the stored one, [to the
  millisecond](#paths). s3cab sets its access time to the same instant.
- Read each time back:
  - one off by less than 2 seconds is the disk's own rounding (FAT, exFAT, HFS+): say how
    many files it touched, exit 0;
  - one off by more, or one the destination can't hold at all, is reported with the time
    the file has, exit 1, and the file is kept.
- Never write outside your destination, and never let a partial restore pass for a full one.

**What trips people up:**

- **Line splitters.** Python's `str.splitlines()` breaks on `\v`, `\f`, `\x1c`, `\x1d`,
  `\x1e`, U+0085, U+2028 and U+2029 as well as LF, and other languages' "split on any line
  break" helpers do much the same. Any of them can occur in a legal filename. Swift goes
  the other way: a `Character` holds `\r\n` as one, so splitting a `String` on `"\n"`
  leaves a CRLF file as one long line. Split the bytes on LF instead.
- **Strings that compare by meaning.** Swift's `String` equality and hashing treat the two
  spellings of `café` as one, so a set or dictionary keyed on paths merges two rows NTFS
  keeps apart, and the check that a path is in only one row misfires. Compare paths as bytes.
- **The heading row's column 4.** It holds the word `time`, not an instant, so a reader that
  checks column 4 of every `@` row as an instant refuses every file at its first line.
- **Trimming in Python.** `str.strip()` isn't quite the trim for the leading fields: it also
  removes `\x1c` to `\x1f` and U+0085, and keeps a byte-order mark.
- **gzip.** `gunzip -c` and Python's `gzip` module hand over every line they can decompress
  before reporting a cut-short file, which is why the `.` matters. Python's `gzip.decompress`
  also joins several gzip streams into one without a word, and so does s3cab's own reader;
  bytes after the stream that aren't gzip make it refuse the file. .NET's `GZipStream`
  never reports a file cut short. Missing only its 8-byte trailer, the file decompresses
  whole; cut deeper, it hands back what it could decompress, which .NET Framework sometimes
  makes nothing at all. .NET Framework, the one Windows PowerShell runs on, also stops after
  the first stream, where .NET 10 joins them. Neither says where a stream ended, so neither
  can find the next one or bytes after the last: to meet the rules above, read the gzip
  framing yourself and inflate with `DeflateStream` or your own. A `DeflateStream` fed a
  stream that returns one byte per `Read` stops exactly where the compressed data ends, so
  the trailer is the next eight bytes. .NET Framework's `GZipStream` does throw
  `InvalidDataException` on a bad CRC, the one check it makes. zlib's `gzread` passes a
  file that isn't gzip through as plain text, and ignores bytes after the last stream: check
  the magic bytes yourself, and drive `inflate` to see the end. Apple's Compression
  framework reads raw DEFLATE, not the gzip wrapper around it; the system's zlib reads gzip.
- **Driving zlib's `inflate`.** A cut stream ends in `Z_BUF_ERROR` with `avail_in` at 0,
  and a bad CRC in `Z_DATA_ERROR`, "incorrect data check". After `Z_STREAM_END`, whatever
  `avail_in` still holds is the next stream, and `inflateReset` starts it.
- **Fields in C.** `strtok` takes two tabs in a row as one, so a blank column vanishes and
  every later field shifts left: split with `strsep` or `memchr`. `isspace` isn't the trim
  set, and `strtoull` accepts leading spaces and a sign, so `-1` reads as
  18446744073709551615: check that a size is all digits first. Check a field's length in
  bytes for a NUL before making a C string of it, and test the trimmed type, not `line[0]`.
  A fifth tab in a file row is a tab in its path, which refuses the row.
- **Strings in Swift and .NET.** Swift's `String(decoding:as:)` puts U+FFFD in place of
  bytes that aren't UTF-8, without a word; `String(validating:as:)` returns nil instead.
  `Int("+12")` is 12. .NET's `StartsWith(string)`, `IndexOf(string)` and `CompareTo`
  compare by the current culture, not code point by code point: pass
  `StringComparison.Ordinal`. .NET's `Trim()` removes U+0085 and keeps U+FEFF, the reverse
  of the trim here. In a .NET regex, `$` also matches before a final `\n`, and `\d` any
  Unicode digit: use `\z` and `[0-9]`. The C# compiler takes a literal U+2028 or U+2029 in
  source as a line end, so write the trim set with escapes, not the characters.
- **Case mapping.** C has no Unicode case mapping: `towlower` maps one character at a time,
  by the locale, and glibc's maps only ASCII under `"C"`, so call
  `setlocale(LC_CTYPE, "C.UTF-8")` first. .NET's `ToLowerInvariant` and Swift's
  `lowercased()` skip Final_Sigma, so
  `ΟΔΟΣ` becomes `οδοσ` where JavaScript's `toLowerCase()` gives `οδος`, and two readers put
  a file under different `DIR`s. JavaScript looks past a `.` or an apostrophe for a letter
  after the `Σ`, so `ΟΔΟΣ.txt` becomes `οδοσ.txt` in both; they differ where none follows,
  as at the end of a name or before a digit, space, `-` or `_`. .NET also
  leaves `İ` (U+0130) as it is, where JavaScript gives `i` and U+0307. ICU's
  `u_strToLower` with the root locale matches JavaScript; Windows' own `icu.dll` exports it,
  for P/Invoke with the locale `""`. In Swift, Foundation's `lowercased(with: nil)` matches
  it too.
- **Times in C.** `mktime` reads its fields as local time; `timegm` reads them as UTC. C's
  `/` truncates toward zero, so split a time before 1970 into seconds and milliseconds with
  floor division.
- **Times in .NET.** `DateTime` starts at the year 1, so it can't hold a row from the year
  0000, which the 24-character form allows. Check the instant by hand, and keep it as a
  count of milliseconds until you know it fits.
- **Windows paths: go through `\\?\`.** Prefixed with `\\?\`, an absolute path is taken
  exactly as written, reserved names such as `CON` and `aux.txt` included. Without it,
  Windows drops a trailing space or dot from a name, so a file restored as `notes.` lands as
  `notes` with no error, and a path past 260 characters (`MAX_PATH`) fails. Re-rooting under
  an output directory makes a deep tree deeper. Even through `\\?\`, NTFS refuses a name
  holding `"`, `*`, `<`, `>`, `?`, `|` or a control character such as VT or FF. Keep the
  prefix through the whole path: .NET's `Path.GetFullPath` drops a trailing space even from
  a `\\?\` path, and a share is written `\\?\UNC\server\share`.
- **`\\?\` in a .NET Framework program built with bare `csc`.** It runs with the old path
  handling, which throws on `\\?\` and on a path past 260 characters. Add
  `[assembly: TargetFramework(".NETFramework,Version=v4.8")]` to the entry assembly's
  source, or set
  `Switch.System.IO.UseLegacyPathHandling=false` and `Switch.System.IO.BlockLongPaths=false`
  in the program's `.config` file.
- **Setting a modification time.** A fraction like `.674` has no exact representation in a
  floating-point count of seconds, which is how some platforms take a timestamp, so a
  restored file can land up to about a hundred nanoseconds off its row. s3cab's own restore
  does, where the filesystem keeps nanoseconds; setting the time through a nanosecond
  interface is exact. A time the destination can't hold fails without an error: APFS keeps
  nothing past April 2262, so setting a year-2300 time succeeds and stores 2262, and under
  WSL a Windows drive (`/mnt/c`) drops the fraction of a second, so `.674` lands as `.000`.
  Read the time back before hashing the file, since under `relatime` the read moves its
  access time, and tell rounding from a time not kept: FAT keeps 2-second steps,
  exFAT 10 milliseconds, HFS+ whole seconds. On Windows s3cab can't check a time
  before 1970 or after 2106, since Node reads those back wrong there, though NTFS holds them.
  NTFS can't hold a time before 1601 at all: Windows refuses an earlier one, and takes
  1601-01-01 itself, a FILETIME of 0, as "leave the time alone", so a file copied from
  another keeps that one's time. s3cab leaves such a file at the time of the restore, and
  reports it the same way, exit 1.
- **Hand-edited snapshots.** They are text, and this page tells people they can edit them. A
  restorer that trusts every row will one day follow a hand-added `..` out of its output
  directory and overwrite whatever it lands on.
- **Writing the restored files.** POSIX `rename` replaces an existing file without a word:
  to keep one that was there before, use `renameat2` with `RENAME_NOREPLACE` on Linux, or
  `link` then `unlink`. Linux's `O_TMPFILE` lets a download be hashed before it has a name
  at all, and `linkat` with `AT_EMPTY_PATH` gives it one, unprivileged on Linux 6.17; it
  needs a directory that already exists. `mkdir -p` and `rename` both follow a link at a
  folder position, so check each folder between the output folder and the file with
  `lstat`, which doesn't follow it; `stat` does. `openat` with `O_DIRECTORY | O_NOFOLLOW`
  fails on a link with `ENOTDIR`, so `lstat` first to say what is in the way. To
  tell a file that was there before from one this restore wrote, under any spelling, keep
  each written file's identity, its device and inode or Windows' file ID (from
  `GetFileInformationByHandle`: the volume serial number and the file index); s3cab keeps
  its real path. Without one, .NET's `File.Exists` answers for a case twin, so the second
  row reads as a file already there and is skipped, with exit 0.
- **The destination's limits.** Linux allows 255 bytes in a name, not 255 characters, so a
  long name from Windows can fail there. ext4 keeps times from 1901 to 2446 and clamps the
  rest without a word, the year 0000 to 1901-12-13T20:45:52Z and 9999 to
  2446-05-10T22:38:55Z; APFS keeps a time before 1970 exactly.
- **Files in .NET.** `ReadLine` and `ReadAllLines` take a lone CR as a line end, so a CRLF
  file is never refused: decode strictly and split on `\n`. A dropped connection and a name
  NTFS refuses both arrive as `IOException`, so tell them apart by the step that failed.
  Through `\\?\`, `File.Exists` answers `false` for a name holding `"`, `*`, `<`, `>`, `?` or
  `|`, so a check for something in the way passes and creating the file fails. `File.Move`
  refuses to overwrite where `File.Copy` and `WriteAllBytes` don't. Set
  `Console.OutputEncoding` to UTF-8 before printing a path.
- **Files in Swift on macOS.** Use the raw-byte POSIX calls, not `FileManager` or `URL`,
  which normalize names. `renamex_np` with `RENAME_EXCL` renames without replacing; set a
  time with `futimens`, and read it back from `st_mtimespec`. `/tmp` and the user's folders
  are on case-insensitive APFS. zlib comes in through a bridging header, and
  `inflateInit2(&strm, 15 + 16)` reads gzip. libcurl's `curl_easy_setopt` takes a variable
  argument list, which Swift can't call, so wrap it in static inline C functions in the
  bridging header.
- **Decoding by the HTTP client.** `requests`, and libcurl with `CURLOPT_ACCEPT_ENCODING`
  set, hand back decoded bytes when a store sends `Content-Encoding`, and the hash check
  then withholds a good object. Send no `Accept-Encoding`, and set libcurl's
  `CURLOPT_HTTP_CONTENT_DECODING` to 0.
- **Listing a folder.** ListObjectsV2 with the delimiter `/` and the folder as its prefix
  lists exactly the keys directly in it, as the latest-snapshot rule needs.
- **Restoring on another operating system, or where case is ignored.** A snapshot can hold
  two paths differing only in case, from Linux or from a Windows directory set to be
  case-sensitive, and a Linux one can hold characters Windows forbids. The twins collide in
  an ordinary Windows or macOS directory, and the characters NTFS refuses (above) fail on
  Windows. Some names Windows misreads instead, which the checklist covers: `\` is a
  separator to it, so `a\..\x` climbs out of the output directory like a hand-added `..`.
  The format records what was there; what to do on
  arrival is your tool's choice, worth stating, and so is whether a download that doesn't
  hash to its key is still worth writing, clearly flagged, or better withheld. s3cab's:
  - of paths the destination holds as one file, by letter case or by macOS's Unicode
    normalization, the first row restores and each later one is reported, exit 1;
  - a file where the destination already has a folder of that name in another case, or
    the reverse, is in the way, and reported the same way;
  - a name the destination won't create is reported, exit 1, and the rest restore;
  - a download that doesn't hash to its key is withheld.
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
    the later) in the 24-character form, and its absolute path. Take the size and the time
    from one check of the file, just before hashing it. s3cab gives a file whose read
    returns a different number of bytes an `#error` row instead. A file that changes while
    it is hashed is otherwise caught [on upload](#uploading), but only if it is sent:
    content already stored isn't checked again, so its row keeps the size and time of the
    check against the stored bytes;
  - `#excluded` for an entry you left out on purpose, with whatever says why in column 2,
    such as the pattern that matched, or nothing. Your tool's own working folders need no
    row;
  - `#error` for an entry whose type couldn't be determined, a file that couldn't be read
    or had vanished by then, a file whose modification time the 24-character form can't
    hold (before the year 0000 or past 9999, after rounding to the millisecond), and a
    [link](#links) leading out of the backup or somewhere this computer can't resolve;
  - no row for a directory you walk, since its files' paths carry it, any other link, a
    pipe, socket or device, or an entry that vanished between being listed and its type
    being known.
- End a directory's path with a separator, and a link's when its target is a directory.
  Spell every path with the casing the filesystem reports, and a Windows drive letter in
  uppercase.
- Stop without writing a snapshot, and say why, when:
  - a member directory doesn't exist, or isn't a directory;
  - a file you would give a `-` row has a tab, CR or LF in its path;
  - an entry's name has no UTF-8 form, whatever kind of entry it is;
  - a directory can't be listed, one that vanished after its parent listed it included;
  - the same file turns up under two member directories, because one is inside the other,
    or both are the same directory;
  - a member directory's real path, on Windows, has no drive letter and no share: on a
    volume mounted only under a folder, or with no mount point at all
    (`\\?\Volume{GUID}\…`). No path a reader accepts can name it.

  If your tool can leave entries out, that is the way past most of these: leaving out the
  name, or the inner directory from the outer one's walk, which then gets the `#excluded`
  row any entry left out does. Past a missing member directory, one named twice, or one
  with no drive letter, the way is to change the set; for the last, back up a folder with
  an ordinary path. A run that stops exits nonzero; s3cab's exits 1.
- In an `#excluded` or `#error` row, where a name with a tab, CR or LF can still appear,
  write those characters as `␉` (U+2409), `␍` (U+240D) or `␊` (U+240A).
- Start with the heading row, then the [whole-snapshot rows](#the-whole-snapshot-rows):
  - one `@S3CAB SPEC` with the date at the top of this page;
  - one `@CLIENT NAME` and one `@CLIENT VERSION` naming your tool;
  - `@SET NAME`, and a `@SET DIR` for each member directory, its real path ending in a
    separator. Without them a reader refuses every file row, since none is under a `DIR`;
  - `@SNAPSHOT NAME`, `BY` and `START`.

  Give each path at most one per-path row. End with `@SNAPSHOT FILES`, `SIZE` and `FINISH`,
  its instant rounded up, then the `.`.
- Five tab-separated fields on every line but the `.`, UTF-8 with no BOM, LF endings, one gzip
  stream.
- Name the file `YYYYMMDDTHHMM.tsv.gz` from the run's start in local time. Refuse a second
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

  Python's `os.path.abspath` drops the dot or space too; `os.path.normpath` keeps it. For a
  directory on a volume with no drive letter, `GetFinalPathNameByHandle` reports *not
  found*, and Python's `os.path.realpath` then hands back the path as typed unless given
  `strict=True`. A machine with long paths enabled system-wide hides the 260-character
  failure, so test on one without.
- **Links on Windows.** Python's `os.walk(top, followlinks=False)` still descends into a
  junction, recording what lies beyond it as if it were inside the member directory, and
  `os.path.islink()` is `False` for a junction (`os.path.isjunction()` catches it). A broken
  link doesn't fail the way it does elsewhere: a missing target raises winerror 2, a link
  through a file winerror 3 (both `FileNotFoundError`), and a loop `EINVAL` with winerror
  1921, not `ELOOP`. Node reports these as `ENOENT` and `ELOOP`. Python's `os.readlink`
  returns an absolute link's target with the `\\?\` its substitute name starts with, where
  Node returns `C:\…`: write it without the prefix, as s3cab's message does. A junction's
  `st_reparse_tag` is `0xA0000003`. Reading a OneDrive online-only file downloads it.
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
- **Time zones.** Python's `zoneinfo` can't name the local IANA zone, but on Linux and
  macOS the path `os.path.realpath("/etc/localtime")` returns ends in it, and `TZ` may hold
  it. On Windows Python has no zone data without the `tzdata` package, though
  `time.localtime()` mints a snapshot's name without it: only the zone's name needs more.
  `START`'s zone is written for people, so write the best name you have. On Windows 10
  1903 and later, `ctypes` can ask `icu.dll`'s `ucal_getDefaultTimeZone` for it
  (`Europe/London`); the registry has only Windows' own name (`GMT Standard Time`).
- **Rounding a modification time.** A floating-point count of seconds can't hold every
  NTFS tick, so rounding it to the millisecond can put a near-tie on the wrong side. Round
  the integer nanosecond count, and not with Python's `round()`, which takes a tie to the
  even side. Python's `datetime` holds only the years 1 to 9999, so stay in nanoseconds
  (`st_mtime_ns`) until the time is known to fit. Its `strftime("%Y")` doesn't pad a year
  under 1000 to four digits, and on Windows `datetime.fromtimestamp` raises for a time
  before 1970.
- **Walking a tree in Python.** `os.walk` skips a directory it can't list without a word
  unless given `onerror`, and yields nothing at all for a top that doesn't exist, so a
  mistyped member directory makes an empty snapshot. Opening a FIFO to hash it blocks:
  check the type first, as `os.scandir`'s `is_file(follow_symlinks=False)` does, or open
  with `O_NONBLOCK | O_NOFOLLOW`. A `DirEntry`'s `stat()` is the directory's cached data,
  so take the size and time from `fstat` on the handle you hash. A name Python can't
  encode raises `UnicodeEncodeError`, a `ValueError`, not an `OSError`. On Windows, a file
  another program holds open without sharing raises `PermissionError` with winerror 32, the
  same exception as a permissions fault. `os.path.realpath(strict=True)` needs Python 3.10,
  and `os.path.isjunction()` 3.12.
- **On macOS.** APFS refuses a name that isn't valid UTF-8. Where listing a directory's
  parent is refused, `fcntl` with `F_GETPATH` on the open directory gives its name as the
  disk spells it, and so does `getattrlist` with `ATTR_CMN_NAME`, which needs only search
  permission.
- **On Windows.** PowerShell compares strings without regard to case, in `-eq`,
  `-contains` and a hashtable's keys, so two names differing only in case merge.
  `Get-ChildItem` without `-Force` skips hidden and system files, and so does .NET's
  `EnumerationOptions` left at its defaults.
- **From a shell.** Build each row's path by joining names onto the `@SET DIR` string
  itself, so every path starts exactly as its `DIR` does. GNU `find -printf %T@` prints a
  time before 1970 that falls between whole seconds a second too early (`-1.25` for
  `-0.75`); `stat -c %.Y` prints it right. Command substitution drops trailing newlines, so
  `$(printf '\n')` is empty. `while read f` strips spaces at either end of a name and
  takes `\` as an escape: use `find -print0` with `while IFS= read -r -d '' f`.

### Uploading

- Write an [upload lock](#locks) before anything that decides what to skip — before listing
  `objects/`, reading an earlier snapshot, or sending a conditional PUT — then list `locks/`.
  On any `delete-` lock, remove your own and refuse. Write first, look second: two runs that
  start together must each see the other.
- A lock with your own `BY`, `OS` and `PIDNS` whose process is gone is a dead run's: remove
  it. Any other lock is alive until a person says otherwise.
- Remove the lock when the upload ends, success or failure, once no request is in flight.
  Report one you couldn't remove, with its id, so a person can.
- Upload every object a snapshot names, the empty file's `e3b0c442…b855` included, before
  the snapshot itself: [objects first, snapshot last](#the-invariant-objects-first-snapshot-last).
- Store each object at `objects/<hash>`, holding exactly the bytes that hash to its key.
  - Just before sending a file, check its size and modification time against its row, at
    the row's resolution: the size exactly, and the time rounded to the millisecond as the
    row holds it. If either changed, don't send it.
  - Hash the bytes as you send them: a file can change after the check, and a change while
    it was being hashed leaves a row whose hash no whole version of the file ever had.
  - Compare that hash with the key. A checksum your S3 library works out from the bytes it
    sends proves only that they arrived as sent.
  - If they don't match, leave nothing stored under that key. Compare before the upload
    completes, as s3cab does: it holds back the last part until the hash matches, and
    aborts a multipart upload when it doesn't. Deleting the object afterwards leaves it
    under the key if your tool stops in between.

  Either way, don't upload the snapshot, which names an object the repository doesn't hold.
  Content several paths share is sent once, from any one of them. s3cab takes the first in
  the snapshot, and a change there stops the snapshot's upload even while another path
  still holds the content.
- Count an object as already stored only on the bucket's word:
  - listed under `objects/`;
  - or found by a HEAD of its key, which costs a request per object where one LIST page
    covers a thousand; s3cab lists;
  - or a conditional PUT to its key refused with 412;
  - or named by an earlier snapshot of the set that is still in the bucket, byte for byte
    the copy you hold, while every deletion record is [valid](#valid-and-invalid-files). A
    hash a record lists counts only if a HEAD of its key finds it there.

  Never on an older snapshot's word alone, and never by downloading the object to check.
  Wrong bytes at a key are damage, for a check of the whole repository to find.
- Store every key in a storage class that a plain GET reads at once. An archive class that
  needs a restore request first makes every download fail. s3cab stores in S3 Glacier
  Instant Retrieval on AWS, and leaves the class to the provider elsewhere.
- Store no `Content-Encoding` and no `x-amz-meta-*` metadata, for objects and snapshots
  alike. A downloader that honours `Content-Encoding: gzip` hands back a snapshot's
  decompressed text instead of the stored file. No other header matters to a reader. s3cab
  sets no `Content-Type`, so the store keeps its own default; asks AWS, and no other
  provider, for server-side encryption with S3's own keys (`AES256`); and makes every
  object and snapshot PUT conditional, with `If-None-Match: *`, unless asked to overwrite
  one object (`s3cab upload <file> --force`).
- Never upload a snapshot a reader would [refuse whole](#valid-and-invalid-files): one that
  isn't UTF-8 once decompressed, doesn't start with the heading row, doesn't end with the
  `.`, has anything after it, or holds a blank line or an unknown type starting with neither
  `@` nor `#`.
- Upload a snapshot whose rows a reader refuses one path at a time like any other, with no
  object for those rows. Its other rows still restore, and the reader reports the rest.
- Upload a snapshot byte for byte to `snapshots/<set>/<name>.tsv.gz`, where `<set>` is the
  set it belongs to, [named](#the-remote-repository-the-keystone) with `a` to `z` and
  digits and single hyphens between them, and `<name>` is its file name without `.tsv.gz`. Never upload over an
  existing one. One already there with the same bytes is already uploaded, and s3cab
  exits 0; one with different bytes is a conflict, refused.
- Claim a new set by creating [`snapshots/<set>.info`](#who-holds-a-set) with a conditional
  PUT, only while `snapshots/<set>/` holds no snapshot, and refuse the name otherwise. Write its
  `OWNER`, `CLAIMED` and `CREATED` lines in UTF-8 with no BOM, each ending in LF, and keep
  the `OWNER` and `CLAIMED` you wrote, wherever your tool keeps its own state.
- Immediately before uploading a snapshot, read `snapshots/<set>.info`, and refuse unless
  its `OWNER` and `CLAIMED` match, as text, the pair you kept. Refuse when it is gone, too.
- Take a set over only when asked: rewrite `OWNER` and `CLAIMED`, and keep `CREATED`, or
  set it to the new `CLAIMED` when it is missing or empty. With no `.info`, create one with
  a conditional PUT.
- Write nothing outside the layout and your own `.<name>/` folder.

**What trips people up:**

- **Line endings.** Python's text mode writes `.info` with CRLF on Windows.
- **Windows paths: go through `\\?\`.** An uploader opens every recorded path, so the
  [writer's trap](#writing-a-snapshot) applies here too: a trailing space or dot, or a path
  past 260 characters, finds the wrong file or none.
- **Checking bytes before they're visible.** A plain PUT is visible the moment it returns, so
  deleting wrong bytes afterwards leaves them stored if the uploader dies in between. S3
  checks them itself when you send `x-amz-checksum-sha256`, which takes the base64 of the
  binary digest, not the hex key: a mismatch stores nothing. In boto3, pass the key's
  digest as `ChecksumSHA256`. `ChecksumAlgorithm="SHA256"` instead hashes the bytes being
  sent, which checks only that they arrived as sent. In its default legacy retry mode,
  botocore retries a `BadDigest` refusal, five attempts in all, 1.34 and 1.43 alike, so a
  file that changed is sent five times before the error;
  `Config(retries={"mode": "standard"})` sends it once, and still retries a 5xx and a
  dropped connection. `head_object` with `ChecksumMode="ENABLED"` shows the stored
  `ChecksumSHA256`, and whether it is `FULL_OBJECT` or a composite ending `-<parts>`: one
  request confirms S3 checked the bytes.
- **Hashing what boto3 sends.** botocore reads a `put_object` body more than once (two and
  seven passes were measured), so a wrapper that hashes as it reads must start its digest
  again on `seek(0)`. With `ChecksumSHA256` supplied the body goes plain, and the last pass
  is what goes over the wire.
- **Multipart checksums.** S3 takes a single PUT of up to 5 GiB; s3cab sends a file of
  16 MiB or more in 16 MiB parts, and HEADs its key first, so as not to send a body the
  conditional PUT would refuse. A multipart object's stored SHA-256 is a checksum of its
  parts' checksums, not the file's hash, so it can't be compared with the key. Check the
  bytes before they're visible instead:
  - send each part with its own `x-amz-checksum-sha256`, which S3 checks;
  - hash the whole file from those same bytes;
  - send `CompleteMultipartUpload` only if that hash equals the key, and abort the upload
    otherwise, which leaves nothing stored.
- **Not overwriting.** `If-None-Match: *` makes a PUT refuse an existing key with 412, and
  can't be raced the way HEAD then PUT can. boto3 1.34, the version Ubuntu 24.04 packages,
  has no `IfNoneMatch` parameter: add the header in a `before-call` event handler for
  `PutObject` and `CompleteMultipartUpload`.
- **Content type.** Python's `mimetypes` reports a `.tsv.gz` file's encoding as `gzip`, and a
  tool that passes that on sets the header the checklist rules out.
- **`Content-Encoding: aws-chunked`.** boto3 1.36 and later send it on every upload by
  default, as a transfer encoding, and AWS doesn't store it. Other S3-compatible stores are
  untested. Supplying `ChecksumSHA256` yourself makes boto3 send a plain body instead.
- **Printing a path in Python on Windows.** Before Python 3.15, redirected output is encoded
  in the locale's code page, and a path like `café.txt` spelled with a combining accent raises
  `UnicodeEncodeError` between the objects and the snapshot. Run with `-X utf8`, or call
  `sys.stdout.reconfigure(encoding="utf-8")` first.

### Deleting

- Write a [deletion record](#the-deletion-record) before deleting any object it lists, as
  `objects.deleted-<n>.tsv` under an index not already in use, never over an existing record.
- Give it the heading row, one `@S3CAB SPEC`, `@CLIENT NAME` and `@CLIENT VERSION` each, a
  `#deleted` row per object (hash, size, the UTC instant, and `user@machine`), and the `.`
  last.
- Write a [delete lock](#locks) before deleting anything, then list `locks/`. On any `upload-`
  lock, remove your own and refuse, or wait and write it again later. Write first, look second:
  two runs that start together must each see the other.
- Once the lock is held, read every snapshot that landed since the plan was made, by key, and
  take its objects off the plan. A snapshot is named for its start and can land hours later,
  so compare keys, never names or times.
- Remove the lock when the run ends, success or failure, once no delete request is in flight.
  Report one you couldn't remove, with its id, so a person can.
- To compact records, write the merged record before deleting the files it absorbs, and drop
  only rows whose hash no snapshot references.
