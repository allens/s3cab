# Getting files back

Recovering files is what the backup is _for_. `s3cab restore` covers three jobs, from the
everyday one to the rare backstop:

- **one file you deleted by accident** — name it, get it back;
- **an older version** of a file you still have — add `--snapshot`;
- **everything**, onto a working or a replacement machine — the disaster-recovery case.

```console
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg
Restored 1 file from 'photos' (snapshot 2026-06-12T0915).
```

Restore always reads from the **cloud**, never a local snapshot: a local snapshot records
only hashes, and the file _contents_ live solely in the bucket's `objects/` store. That is
why there is no `--remote` flag — there is nothing else it could mean.

The set is **required** — `s3cab restore --set photos …`, never a bare `s3cab restore`, even
if you only have one set. Every other command defaults to your only set; restore deliberately
doesn't ([ADR-0040](https://github.com/allens/s3cab/blob/main/docs/adr/0040-restore-requires-set-name.md)):
a destructive-adjacent command shouldn't guess its target. It is named by `--set` because the
paths are what you list — a command's bulk operand takes the positionals, and its addressing
moves to a flag ([ADR-0062](https://github.com/allens/s3cab/blob/main/docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)).

## Choosing what to restore

With no paths, restore writes back **everything** in the snapshot. Any paths you pass filter
that down:

```console
# One file
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg

# A whole directory (everything under it)
> s3cab restore --set photos C:\Users\me\Photos\2024

# Several at once
> s3cab restore --set photos C:\Users\me\Photos\2024 C:\Users\me\Photos\beach.jpg
```

Three rules worth knowing:

- **Filters are the absolute paths the snapshot stored**, not patterns and not paths relative
  to anything. The reliable way to write one is to copy it out of `s3cab list <set>` or
  `s3cab tree <set>`.
- **A filter matches that path, or anything beneath it** — on a directory boundary. So
  `…\Photos` selects `…\Photos\beach.jpg` but **not** `…\PhotosArchive\x.jpg`; a trailing
  separator makes no difference.
- **Case follows the platform** — matching is case-insensitive on Windows, case-sensitive
  elsewhere, exactly like [exclude rules](exclude.md).

If nothing matches, restore stops rather than silently doing nothing:

```console
> s3cab restore --set photos C:\Users\me\Photos\nope.jpg
No files in snapshot '2026-06-12T0915' matched: C:\Users\me\Photos\nope.jpg
```

## Choosing which version

By default you get the **latest** snapshot. To pull an earlier version of a file, name an
older snapshot with `--snapshot` (`-s`) — the names are what `s3cab list <set> --remote`
prints:

```console
> s3cab restore --set photos C:\Users\me\Photos\report.pdf --snapshot 2026-05-01T0800
Restored 1 file from 'photos' (snapshot 2026-05-01T0800).
```

This is the case a sync service can't help with once its short version history has expired.
Note the file on disk still exists, so you'll need `--overwrite` to actually replace it (see
below) — or use `--output` to put the old copy somewhere else and compare the two first,
which is usually the safer move.

A snapshot name that doesn't exist is an error listing the real ones, so a typo can never
quietly restore the wrong thing:

```console
> s3cab restore --set photos --snapshot 2026-05-01
Snapshot '2026-05-01' not found for set 'photos'.
Available snapshots (newest first):
  2026-06-12T0915
  2026-05-01T0800
```

## Existing files are never touched

By default restore **skips any file that already exists** and tells you which:

```console
> s3cab restore --set photos
Restored 2 files from 'photos' (snapshot 2026-06-12T0915).

Skipped 1 existing file (rerun with --overwrite to replace):
  C:\Users\me\Photos\report.pdf
```

This is the behaviour that makes restore safe to reach for. Your accidental deletion comes
back; everything you've worked on since stays exactly as it is. A full `s3cab restore --set photos`
after deleting one directory does the obvious right thing — it refills the gap and leaves the
rest alone.

Pass `--overwrite` when you genuinely want the backup's copy to win:

```console
> s3cab restore --set photos C:\Users\me\Photos\report.pdf --overwrite
```

The skipped list is never truncated — each entry is a file you asked for and didn't get, so
restore names them all.

## Restoring somewhere else

`--output <dir>` (`-o`) re-roots the restore under a directory you choose instead of writing
to the original locations. Each backed-up directory lands under its own name:

```console
> s3cab restore --set photos --output D:\recovered
```

A set covering `C:\Users\me\Photos` restores to `D:\recovered\Photos\…`. It's shallow and
readable — you get the backed-up directory's _name_, not a rebuilt `D:\recovered\C\Users\me\…`
chain.

Reach for it when:

- **the original paths don't fit this machine** — a different drive layout, or another OS
  entirely. This is the only mode that accepts paths that aren't absolute on the current
  system; a plain restore of a Windows snapshot on Linux refuses up front rather than
  scattering files named `C:\Users\…` into your working directory, and points you here.
- **you want to inspect before replacing** — recover an old version alongside the current
  one and diff them, instead of `--overwrite`.

One case it can't handle: two backed-up directories with the **same name** (say `C:\a\Photos`
and `D:\b\Photos`) would both want `<output>\Photos`. Restore rejects that up front rather
than merging them — restore them one at a time with a path filter, or to their original
locations.

## Restoring onto a fresh machine

A replacement machine knows nothing about your sets, so attach it to the existing backup
first, then restore:

```console
> s3cab reattach photos --bucket my-backups
> s3cab restore --set photos
```

`reattach` pulls the set's _configuration and snapshot history_ down — not the files. It's
`restore` that brings the content back. (See [Status](../README.md#status) for the split.)

## What restore guarantees

- **Integrity is checked, always.** Every downloaded object's SHA-256 must match the hash the
  snapshot recorded, or the restore fails — the file that lands is the file that was backed
  up, byte for byte.
- **Modification times come back.** Each restored file is stamped with the mtime the snapshot
  recorded, so a later `snapshot` sees it as unchanged rather than as new work.
- **Duplicated content downloads once.** Content shared by several paths — a file you'd
  copied, or a directory you'd moved — is fetched once and copied locally to the rest.
- **Everything referenced is there.** A snapshot only ever reaches the bucket _after_ every
  object it references, so any snapshot you can see is complete and restorable. That
  invariant is part of the [format spec](format.md).

Progress prints to stderr (`Restoring 250/1240...`), so it stays out of piped or redirected
output. For the machine-readable result, add `--json` — see [output formats](output.md).

## If there's nothing to restore

```console
> s3cab restore --set photos
No backups for set 'photos'. Back one up with: s3cab backup photos
```

A set that exists locally but has never been backed up has nothing in the cloud to recover
from. `s3cab status photos` shows what a backup would upload.
