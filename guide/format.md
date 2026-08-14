# The s3cab format spec — repository & snapshot files

s3cab's core promise is **no lock-in**: everything it stores — in your bucket and on your
machine — is plain, self-evident files you can read and act on without s3cab. In principle
you could recover everything with no documentation at all, just by looking at what's there.
This page writes the format down anyway, for two reasons: it makes recovery *much* easier,
and it keeps the project honest — a human-readable mirror of the true format that the code
must always match.

Everything on this page is a **commitment**, not an implementation detail. If a future
s3cab needs to change any of it, that is a breaking format change, treated accordingly.

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
  be invisible), records which machine created it, and mirrors the set's
  `dirs.txt`/`exclude.txt` so a fresh machine can adopt it
  (`s3cab reattach <set>`). The set's local `env` file is **never** uploaded — it
  can hold credentials.
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
`deletions/<timestamp>.tsv` (the same minute-precision local timestamp as snapshot names —
and, like a snapshot, a record is never overwritten; a same-minute second run is an error).
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

Rules for a reader: skip every `#` line; the first field of a row is the deleted object's
hash (its old key under `objects/`), the rest of the line the path that referenced it; the
file's timestamp name is *when*. The **write ordering is a commitment**: a record is always
written *before* its objects are deleted, so a crash mid-delete can never leave a missing
object the records don't explain. s3cab's own tools honour the record everywhere — `verify`
reports recorded hashes as expected (not damage, exit 0), `restore` skips them gracefully
with their date, and `backup` knows not to trust an older snapshot's word that the content
is still stored.

### What is deliberately not stored

- **No client-side encryption.** Encrypted objects would be exactly the opaque blobs the
  no-lock-in promise forbids, and encryption breaks content-addressed dedup. The answer is
  server-side encryption (s3cab already requests it on AWS), bucket access policy, and
  provider trust.
- **Paths containing a tab or a newline.** Both would break the row grammar, and the
  format has no escaping by design — that plainness is the point. Such names are legal
  only on Linux and macOS (Windows forbids them outright) and are almost always a script
  bug rather than a choice. A file with one is **not backed up**: the run stops and names
  it, so you can rename it, or exclude it with a pattern like `odd*name.jpg` and run
  again.
- **Regular files only.** Snapshots record file content, size, and modification time —
  no symlinks or junctions, no hardlink identity, no empty directories, no permissions or
  ACLs. s3cab backs up *data* (documents, photos, video); it is not a system backup tool.

## Snapshot files

A snapshot is a point-in-time record of every file in a backup set: a plain-text,
tab-separated (TSV) table, zstd-compressed on disk and in the bucket (`.tsv.zst` —
decompress with any zstd tool). Every line has four tab-separated fields; the leading
fields are width-padded with spaces so the raw file reads as columns (trim whitespace when
parsing). Lines whose first field starts with `#` are metadata, not file rows.

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
- **`size`** — bytes (right-aligned).
- **`mtime`** — the file's modification time, ISO-8601 with milliseconds, UTC.
- **`path`** — absolute, in the OS's native style, last on the line so the fixed-width
  columns stay aligned.

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
the file rows can simply skip every `#` line.

The last line of every snapshot is the trailer `#END`, which today carries no further
fields. It exists to make truncation detectable: zstd happily decompresses a cut-short file
to a byte *prefix* of the original, which would otherwise read as a valid, smaller
snapshot. A snapshot without the `#END` trailer is damaged goods — treat it as truncated,
not as complete. (A reader that only wants the file rows can still skip every `#` line;
checking for the trailer first is what tells it the rows it read are all of them.)

Match the marker and **ignore anything after it** on that line: no truncation can add
fields — a cut only ever removes bytes — so a trailer carrying extra columns is not damage,
and tolerating them leaves room to add a column later without breaking readers already
written against this spec.

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
```

Two temporary files can appear in `snapshots/` while s3cab is working. Both start with a
dot, neither is ever uploaded, and both are safe to delete when nothing is running:

- `.snapshot.tsv.zst` — the snapshot being written right now. It becomes the finished
  snapshot when the run completes. One left behind means a run was killed part-way; s3cab
  says so, and names it, the next time you snapshot that set.
- `.snapshot.lookup.tsv.zst` — the file hashes from a snapshot you stopped with Ctrl+C,
  kept so the next run doesn't have to work them out again. It is read as a lookup only —
  every hash in it is re-checked against the file's current size and modification time
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
