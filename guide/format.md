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
```

- **`objects/`** is the content-addressed store: one object per unique file content, keyed
  by the lowercase-hex SHA-256 of its bytes. Identical content — under any name, from any
  set or machine — is stored exactly once, bucket-wide.
- **`snapshots/<set>/`** holds one backup set's snapshot files, named by a minute-precision
  local timestamp (`2026-06-12T0915.tsv.zst`). A remote snapshot file is **byte-identical**
  to its local counterpart — uploaded as-is, one format everywhere.
- **`sets/<set>/`** marks the set's existence (a set with no snapshots yet would otherwise
  be invisible), records which machine created it, and mirrors the set's
  `dirs.txt`/`exclude.txt` so a fresh machine can adopt it
  (`s3cab reattach <set>`). The set's local `env` file is **never** uploaded — it
  can hold credentials.

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

### What is deliberately not stored

- **No client-side encryption.** Encrypted objects would be exactly the opaque blobs the
  no-lock-in promise forbids, and encryption breaks content-addressed dedup. The answer is
  server-side encryption (s3cab already requests it on AWS), bucket access policy, and
  provider trust.
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
#SNAPSHOT		2026-06-12T09:15	photos
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

Besides `#SNAPSHOT`/`#DIR`, a snapshot may carry `#EXCLUDED` (matched an exclude pattern),
`#SKIPPED` (unsupported type, e.g. a symlink), and `#ERROR` (a file that could not be read)
metadata rows recording what the snapshot does *not* include and why. A reader wanting only
the file rows can simply skip every `#` line.

## The local side (`~/.s3cab/`)

The local layout is a user surface, not a hidden implementation detail — **the files are
the API**, and some of them you are expected to edit directly in a text editor:

```
~/.s3cab/
  env                    # your defaults: AWS profile / region / endpoint
  sets/
    photos/
      dirs.txt           # member directories, one absolute path per line — yours to edit
      env                # S3CAB_BUCKET=… + any per-set auth overrides — yours to edit
      exclude.txt        # optional exclude patterns — yours to edit
      snapshots/
        2026-06-12T0915.tsv.zst    # same format as the bucket's copy, byte for byte
```

Editing a set *is* editing these files; deleting the directory deletes the set. Note the
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
