# The s3cab format spec — repository & snapshot files

s3cab's core promise is **no lock-in**: everything it stores — in your bucket and on your
machine — is plain, self-evident files you can read and act on without s3cab. In principle
you could recover everything with no documentation at all, just by looking at what's there.
This page writes the format down anyway, for two reasons: it makes recovery *much* easier,
and it keeps the project honest — a human-readable mirror of the true format that the code
must always match.

Everything on this page is a **commitment**, not an implementation detail. If a future
s3cab needs to change any of it, that is a breaking format change, treated accordingly.
One exception, flagged again where it arises: the *text inside* `#` comment lines is
human context and may change freely. What is committed is that skipping those lines
leaves exactly the data.

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
  naive `split("\t")` safe, and it is why a path can never contain a tab, LF or CR (all
  three are [refused at backup time](#what-is-deliberately-not-stored)). Every other
  character, control characters included, is fair game in a path.
- **Trim the leading fields; never trim the path.** The leading fields are padded with
  spaces so the raw file reads as columns. The path is always last, is never padded, and
  must be taken **verbatim** from the final tab to the end of the line. On Linux and macOS
  a filename may legitimately begin or end with a space, and a parser that strips every
  field restores `" notes.txt "` as `"notes.txt"` — the wrong file, with nothing reported.

## The remote repository (the keystone)

One S3 bucket is one **repository** — the layout is fixed by convention, never an arbitrary
prefix, so anything (s3cab, another tool, or you by hand) can find everything:

```
s3://my-backup-bucket/
  objects/<sha256>                  # every backed-up file, stored once, named by content hash
  snapshots/<set>/<name>.tsv.zst    # each backup set's snapshot files
  sets/<set>/                       # each set's config + ownership marker
    info                            # owner machine + created date (the name-claim marker)
    dirs.txt                        # the set's member directories, one per line
    exclude.txt                     # the set's exclude patterns (if it has any)
  deletions/<timestamp>.tsv         # deliberate-deletion records (only if `delete` has run)
```

- **`objects/`** is the content-addressed store: one object per unique file content, keyed
  by the lowercase-hex SHA-256 of its bytes. Identical content — under any name, from any
  set or machine — is stored exactly once, bucket-wide. Objects carry **no metadata**: an
  object is *content*, and the same bytes may be a dozen different files, so there is no one
  name, date or owner to record. **The snapshot is the index** — it is what maps a name to a
  hash. Keep one: given only `objects/`, you have your data but no way to tell what any of it
  was. (This is why snapshots are immutable and never overwritten.)
- **`snapshots/<set>/`** holds one backup set's snapshot files, named by a minute-precision
  local timestamp (`2026-06-12T0915.tsv.zst`). A remote snapshot file is **byte-identical**
  to its local counterpart — uploaded as-is, one format everywhere.
- **`sets/<set>/`** marks the set's existence (a set with no snapshots yet would otherwise
  be invisible), records which machine holds it, and carries the set's
  `dirs.txt`/`exclude.txt` so a fresh machine can adopt it
  (`s3cab reattach <set>`). `exclude.txt` is a verbatim byte copy; `dirs.txt` is the
  **parsed** directory list, one per line — comments and blank lines in your local file
  aren't carried up. The set's local `env` file is **never** uploaded — it
  can hold credentials. `info` is two `KEY=value` lines, in this order:

  ```
  OWNER=DESKTOP
  CREATED=2026-06-12T08:15:32.123Z
  ```

  `OWNER` is the raw hostname of the machine the set is attached to — stamped at creation
  and re-stamped by `s3cab reattach`, so it names the current holder, not necessarily the
  creator; `CREATED` is a UTC instant in the same form as a snapshot row's `mtime`, and is
  preserved across reattaches.
- **`deletions/`** holds the repository's [deletion records](#the-deletion-record) — one
  small plain-text file per `s3cab delete` run, marking content as *deliberately* removed.
  A repository where `delete` has never run simply has no `deletions/` keys.

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

`s3cab delete` removes named paths' content from the whole backed-up history — and because
snapshots are immutable, it does so **without touching a single snapshot file**: it deletes
the backing objects and writes a **deletion record**, one per run, at
`deletions/<timestamp>.tsv` (the same minute-precision local timestamp as snapshot names).
A record is never overwritten. Unlike a snapshot, though, a second run in the same minute is
not an error: it takes the next free name — `2026-06-12T0915-2.tsv`, then `-3` — because two
deletes are two real events and both have to be recorded. So in `<timestamp>[-<n>].tsv` the
suffix **starts at 2**, and `-1` never appears: the unsuffixed name *is* the first record of
its minute. The suffix tells two *files* apart and is not a time component — same-minute
records carry the same timestamp, because that is what they have.

**Read every file under `deletions/`, and treat them as one set.** Nothing depends on their
order: a hash is deliberately gone if *any* record lists it, so a reader never has to
sequence records within a minute and shouldn't reach into the `#` block for a way to. The
only thing order decides is cosmetic — if two records list the same hash, which date you show
for it, and s3cab shows the newest by filename. And when there *is* a date to show, it is the
record's **filename** timestamp; that is what s3cab prints beside a file it skips for this
reason.

The record is what lets any tool — s3cab or a future reader of the bare files — tell
*deliberately gone* from *corrupted*: an object a snapshot references but the store lacks is
**expected** if a record lists its hash, and an integrity fault if none does.

A record is a plain, uncompressed TSV: `#` comment lines carry the context (when, which
bucket, who ran it, which sets were in scope, the paths that were asked for, totals), then
one tab-separated `hash → path` row for **every reference the deleted objects had**:

```
# s3cab delete — content deliberately removed from this repository
# generated:  2026-07-19T13:22:04.881Z  (2026-07-19T1422 Europe/London)
# bucket:     my-backup-bucket
# by:         me@DESKTOP
# sets:       photos
# scope:      the sets above only
# paths:      C:\Users\me\Photos\raw-footage
#
# 312 files, holding 48.1GB across 297 stored objects.
#
# hash\tpath
3b8e…c0a1	C:\Users\me\Photos\raw-footage\clip-001.mov
```

Rules for a reader: skip every `#` line; a row is `hash<TAB>path` — the deleted object's
hash (its old key under `objects/`), then the path that referenced it; the file's timestamp
name is *when*. Record rows are **not** column-padded the way a snapshot's are, and the `#`
block is prose for a human — its wording and the fields it lists will change, so read the
rows and never parse the header.

**Presence always wins.** A record explains an object's *absence*; it is not a tombstone. If
a hash turns up in `objects/` again — content deleted, then later backed up afresh, which
returns the object while the record stays forever — then the file is restorable and should
be restored. Consult the records only when a fetch actually misses. A reader that treats
records as authoritative skips restorable files indefinitely, and reports success while
doing it.

The **write ordering is a commitment**: a record is always written *before* its objects are
deleted, so a crash mid-delete can never leave a missing object the records don't explain.
s3cab's own tools honour the record everywhere — `verify`
reports recorded hashes as expected (not damage, exit 0), `restore` skips them gracefully
with their date, and `backup` knows not to trust an older snapshot's word that the content
is still stored.

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
  A file with one is **not backed up**: the run stops and names it, so you can rename it,
  or exclude it with a pattern like `odd*name.jpg` and run again. Every other character
  — including control characters that are *not* those three — is stored as-is.
- **Regular files only.** Snapshots record file content, size, and modification time —
  no symlinks or junctions, no hardlink identity, no empty directories, no permissions or
  ACLs. s3cab backs up *data* (documents, photos, video); it is not a system backup tool.

## Snapshot files

A snapshot is a point-in-time record of every file in a backup set: a plain-text,
tab-separated (TSV) table, zstd-compressed on disk and in the bucket (`.tsv.zst` —
decompress with any zstd tool). Lines whose first field starts with `#` are metadata, not
file rows — **check for that before checking anything structural**, because the four-field
grammar below describes file rows only, and the metadata lines do not all obey it.

The [four reading rules](#reading-the-text-four-rules-that-hold-everywhere) apply here in
full — encoding, LF splitting, no escaping, and never trimming the path. This section adds
only what is specific to snapshots.

The file opens with a header naming the set and its member directories, so it is
self-describing even found alone in a bucket; then one row per file:

```
#SNAPSHOT	photos	2026-06-12T08:15:32.123Z	2026-06-12T0915 Europe/London
#DIR			C:\Users\me\Photos
#DIR			D:\Pics
3b8e…c0a1	4915200	2026-06-01T12:00:00.000Z	C:\Users\me\Photos\beach.jpg
```

- **`hash`** — the SHA-256 of the file's contents, lowercase hex: both the file's identity
  and its key under `objects/`.
- **`size`** — bytes, in decimal (right-aligned).
- **`mtime`** — the file's modification time as exactly `YYYY-MM-DDTHH:MM:SS.sssZ`: 24
  characters, always three fractional digits, always a literal trailing `Z`. Never a
  `+00:00` offset, never a comma for the decimal point, never a different digit count.
- **`path`** — absolute, in the OS's native style, last on the line so the padded columns
  stay aligned and so it can hold spaces without ambiguity.

**A path appears at most once in a snapshot.** s3cab never writes a repeat, and a reader
may treat one as a malformed file. The commitment matters because there is no safe way to
guess: a first-wins reader and a last-wins reader would restore *different bytes* from the
same snapshot, neither of them reporting anything wrong.

**Paths are written with the casing the filesystem itself reports** — the spelling you see
in File Explorer or Finder, not the spelling anything was typed in. If a folder is on disk
as `Photos` and the set's `dirs.txt` names it `PHOTOS`, the snapshot says `Photos`. The one
exception is a **Windows drive letter, which is always uppercase**: a drive letter isn't a
name on disk, it's an alias the operating system assigns to a volume, and Windows keeps no
canonical case for it. So `C:` is what you get, whichever way you wrote it.

That is a promise about what s3cab *writes*. Reading is more forgiving, because these files
are yours to edit: on Windows paths, where two spellings name one file, `#DIR` headers are
matched against paths case-insensitively — so hand-editing a snapshot's headers, or a set's
`dirs.txt`, won't stop `restore --output` finding where a file belongs. Paths without a
drive letter are matched exactly, since a case-sensitive filesystem really can hold both
`Photos` and `photos`.

**How a `#DIR` matches a path**, since anything re-rooting a tree depends on getting this
right. Compare **whole path segments, never a string prefix** — `…\trees\edge` must not
claim `…\trees\edgeX\file.txt`. Split both the header and the path on `/` *and* `\` and drop
empty segments, which is what makes a trailing separator or a doubled one harmless, and what
lets a Windows snapshot be read on a POSIX machine and the reverse. Where several headers
match, the **longest wins**, so a member directory nested inside another takes precedence
over its parent. A path under no header at all has nowhere to land: s3cab reports it rather
than guessing, and a hand-edited snapshot is the only way to produce one.

**Where a restored file lands is the tool's decision, not the format's.** Nothing in a
snapshot says where the bytes must go back, and a restorer is free to choose — restoring to
the recorded paths, to a chosen directory, or anywhere else. What s3cab itself does is
written down here for one reason only: so that *"does my restore agree with s3cab's?"* is a
question with an answer, rather than something you can settle only by running the tool and
looking. Restoring to a chosen directory, it writes each file to
`<output>/<basename of the #DIR that matched>/<the rest of the path below that #DIR>`. So
under a `#DIR` header naming `C:\Users\me\Photos`, a row for
`C:\Users\me\Photos\2024\beach.jpg` lands at
`<output>\Photos\2024\beach.jpg` — the member directory's *name*, not a rebuilt
`C\Users\me\…` chain. Two `#DIR` headers whose basenames collide (`C:\a\Photos` and
`D:\b\Photos`) both want the same destination directory; s3cab refuses that snapshot rather
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

**The columns are space-padded, and the example above collapses that padding to stay
readable.** In a real file the first field is padded to 64 characters (so `#SNAPSHOT` is
followed by 55 spaces), the second is right-aligned in 10, and the third is padded to 24. A
value longer than its column simply overflows it — a 14-digit size makes that one row's
second field 14 wide — so these are *minimum* widths, not a fixed-width record layout. The
path, being last, is never padded. Any parser that trims the leading fields can ignore all
of this; anyone writing a snapshot, building a golden test, or matching a line against
`#SNAPSHOT\t` needs the real bytes.

After its marker, the `#SNAPSHOT` line carries three fields: the **set** name, the **instant the
snapshot started** (UTC, the same form as `mtime`, so it lines up in the same column), and
the snapshot's **own name followed by the time zone that name was minted in**. Snapshot
names are local wall-clock time, so the zone is what makes one resolvable to an instant —
and naming the zone (`Europe/London`) rather than just its offset says *where*, which
explains a daylight-saving shift rather than merely recording one.

Besides `#SNAPSHOT`/`#DIR`, a snapshot may carry `#EXCLUDED` (matched an exclude pattern),
`#SKIPPED` (present but not stored — an unsupported type such as a symlink, or a file whose
contents are [online only](compare.md#files-stored-online-not-on-this-computer)), and `#ERROR`
(a file that could not be read)
metadata rows recording what the snapshot does *not* include and why. A reader wanting only
the file rows can simply skip every `#` line. (One omission is silent by design: a directory
named `.s3cab` is never walked and gets no row — it is s3cab's own, and a member directory
containing one would otherwise back up the tool's working files.)

What those rows carry, for anyone reading a snapshot by hand:

| Row | Column 2 | Column 3 | Column 4 |
| --- | --- | --- | --- |
| `#SNAPSHOT` | the set name | the instant the snapshot started | `<name> <zone>` |
| `#DIR` | *(blank)* | *(blank)* | a member directory |
| `#EXCLUDED` | the entry's type | the exclude pattern that matched | the path |
| `#SKIPPED` | the entry's type | why it was skipped | the path |
| `#ERROR` | *(blank)* | the operating system's error text | the path |
| `#END` | `COMPLETE` or `PARTIAL` | the instant the last row was written | *(blank)* |

Those payloads are **context, not commitment**: new metadata kinds may appear and existing
ones may change what they carry. The guarantee is the one above — skip every `#` line and
what remains is exactly the file rows. Two details matter before writing a parser, and both
are why the `#` test has to come first. `#ERROR`'s third column is a raw operating-system
message and `#EXCLUDED`'s is a pattern copied from your `exclude.txt`, so neither carries a
path's promise of being tab-free and either may push its line past four fields; and `#END`
ends on an empty fourth column, so a reader trimming trailing whitespace sees three fields
rather than four. Neither troubles a reader that tests for `#` before counting fields, and
both break one that counts first.

The last line of every snapshot is the trailer `#END`. It exists to make truncation
detectable: zstd happily decompresses a cut-short file to a byte *prefix* of the original,
which would otherwise read as a valid, smaller snapshot. A snapshot without the `#END`
trailer is damaged goods — treat it as truncated, not as complete. (A reader that only
wants the file rows can still skip every `#` line; checking for the trailer first is what
tells it the rows it read are all of them.)

Its two columns say how the run ended, and they answer different questions. The trailer
being **there** means s3cab ended the file deliberately, so the last row is whole — a
killed process leaves no trailer at all. The **status** then says whether the rows are all
of them: `COMPLETE` for a finished snapshot, `PARTIAL` for the hashes a run stopped with
Ctrl+C left behind (the `.snapshot.lookup.tsv.zst` file described below — the only file
s3cab writes `PARTIAL` into). The **instant** is when the last row was written, in the same
UTC form and the same column as `#SNAPSHOT`'s, so the two line up under each other. It is
recorded because `#SNAPSHOT`'s instant is stamped *before* the run reads anything, and
s3cab needs to know when the reading finished. Read it as an upper bound: the column holds
milliseconds and the clock is finer, so the figure is rounded **up** — everything in the
file was written at or before the moment it names, never after. Two snapshots of an
unchanged folder therefore differ in this one line, and nowhere else.

Match the marker and **ignore anything after it** on that line: no truncation can add
fields — a cut only ever removes bytes — so a trailer carrying extra columns is not damage,
and tolerating them leaves room to add a column later without breaking readers already
written against this spec. (That room has been used once already: the trailer was a bare
`#END` before the two columns above.) The test, concretely, is the one every other marker
gets: take the **first tab-separated field and trim it**, and the line is the trailer when
that equals `#END`. So a bare `#END` and `#END<TAB>2026-06-12` are both trailers, and
`#ENDX` is not one.

Three smaller legalities, so a reader knows they weren't forgotten. A snapshot's **name** is
always `YYYY-MM-DDTHHMM` — local wall-clock time to the minute, with the colon dropped —
and the file is that name plus `.tsv.zst`. A snapshot holding a header, a trailer and
**no file rows at all** is perfectly legal: an empty backup set, not a damaged file. And
s3cab never writes the same path twice in one snapshot, but its own reader doesn't reject a
hand-damaged file that does — it silently takes the **last** row for a path; a stricter
reader is free to reject the duplicate instead.

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
        2026-06-12T0915.tsv.zst    # same format as the bucket's copy, byte for byte
  roles-anywhere/        # only if the keyless identity is set up — see below
  my-backup-bucket.yaml  # a CloudFormation template `s3cab aws` wrote, named per bucket
```

`~/.s3cab` is the default home; setting the **`S3CAB_HOME`** environment variable relocates
the whole tree (every path s3cab prints follows it). Two variables in a set's `env` are
s3cab's own rather than standard `AWS_*` ones: `S3CAB_BUCKET` (the set's bucket) and, for a
set in Roles Anywhere mode, the marker `S3CAB_RA=1` — a pointer to the machine identity
below, never credential material itself.

A third is optional, and s3cab tells you about it only if your set is one that needs it:
`S3CAB_SKIP_CHANGE_TIME_CHECK=1`. Before reusing a stored hash, s3cab checks the file's *change
time* as well as its size and modification time, so that a file rewritten to exactly its old
size with its old modification time put back afterwards is still noticed. On a folder your
cloud client syncs, reading a file can move its change time all by itself, and then every
backup re-reads the whole set for nothing. This line turns that check off for one set —
s3cab prints it, with the cost spelled out, when it measures the problem happening.

`roles-anywhere/` holds the machine's keyless identity, shared by every set in that mode:
the self-signed CA (`ca.pem`/`ca.key`), the client certificate and its signing key
(`client.pem`/`client.key` — the private keys never leave this directory), and an `env`
file holding the three `S3CAB_RA_*_ARN` values plus `AWS_REGION`, captured from the deployed
CloudFormation stack by `s3cab aws --roles-anywhere --save`. It is machine identity, not set
config — leave it out of any backup you share.

Two temporary files can appear in `snapshots/` while s3cab is working. Both start with a
dot, neither is ever uploaded, and both are safe to delete when nothing is running:

- `.snapshot.tsv.zst` — the snapshot being written right now. It becomes the finished
  snapshot when the run completes. One left behind means a run was killed part-way; s3cab
  says so, and names it, the next time you snapshot that set.
- `.snapshot.lookup.tsv.zst` — the file hashes from a snapshot you stopped with Ctrl+C,
  kept so the next run doesn't have to work them out again. Structurally it is a snapshot
  like any other, closed with a `PARTIAL` trailer that says so. It is read as a lookup only
  — every hash in it is re-checked against the file's current size and modification time
  before being trusted — and it is deleted as soon as a snapshot completes.

Editing a set *is* editing these files; deleting the directory deletes the set. In both
`dirs.txt` and `exclude.txt`, blank lines are ignored and a line starting with `#` is a
comment — so a directory or pattern can be commented out rather than deleted. Note the
deliberate asymmetry of weight: the **bucket is the keystone**. Everything local except
`env` is recoverable *from* the remote — `reattach` pulls `dirs.txt`/`exclude.txt`
back down and syncs the snapshot history — whereas nothing can rebuild a lost remote.
(Exclude patterns are covered in the [exclude guide](exclude.md).)

## Recovering by hand (no s3cab)

1. List `snapshots/<set>/` in the bucket and download the snapshot you want.
2. Decompress it: `zstd -d 2026-06-12T0915.tsv.zst`.
3. Open the `.tsv` — a text editor or a spreadsheet — and find your file's row.
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
- **On Windows, go through the `\\?\` prefix.** Snapshot paths are absolute, so re-rooting
  them under an output directory makes an already-deep tree deeper, and the 260-character
  `MAX_PATH` limit arrives sooner than you would guess. It fails loudly rather than
  corrupting anything, but it *will* happen on a real tree.
- **Restoring across operating systems is your tool's problem, not the format's.** A
  snapshot taken on Linux may hold two paths differing only in case, or characters NTFS
  forbids outright; both collide or fail on a Windows target. The format records what was
  there faithfully — deciding what to do on arrival is a choice your tool has to make and
  should state.
- **Keep `objects/` in a storage class you can actually GET.** Step 4 assumes a plain
  download works. A bucket lifecycle rule that archives `objects/` to a cold tier breaks that
  for every tool including s3cab, turning recovery into a restore-from-archive wait — worth
  knowing before you set one, not after.

And one thing that is deliberately **out of scope**: *where* a restored file lands — back at
its original path, or re-rooted under an output directory — is a decision for the tool, not
the format. The snapshot records the original absolute path; what you do with it is yours.
