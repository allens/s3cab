# Getting files back

Recovering files is what the backup is _for_. `s3cab restore` covers three jobs, from the
everyday one to the rare backstop:

- **one file you deleted by accident** — name it, get it back;
- **an older version** of a file you still have — add `--snapshot`;
- **everything**, onto a working or a replacement machine — the disaster-recovery case, with
  `--all`.

```console windows
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20260612T0915).
```

```console posix
> s3cab restore --set photos /home/me/Pictures/beach.jpg
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20260612T0915).
```

Restore always reads from the **cloud**, never a local snapshot: a local snapshot records
only hashes, and the file _contents_ live solely in the bucket's `objects/` store. That is
why there is no `--remote` flag — there is nothing else it could mean.

The set is **required** — `s3cab restore --set photos …`, never a bare `s3cab restore`, even
if you only have one set. Every other command defaults to your only set; restore deliberately
doesn't: a command that writes into your folders shouldn't guess which backup to write from.
It's a flag, `--set`, rather than the first word after `restore`, because those words are the
paths you want back.

## Choosing what to restore

You always say what you want back: paths, a list of them, or `--all` (`-a`) for everything.

```console windows
# One file
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg

# A whole directory (everything under it)
> s3cab restore --set photos C:\Users\me\Photos\2024

# Several at once
> s3cab restore --set photos C:\Users\me\Photos\2024 C:\Users\me\Photos\beach.jpg

# The paths listed in a file, one per line
> s3cab restore --set photos --from-file paths.txt

# Everything in the snapshot
> s3cab restore --set photos --all
```

```console posix
# One file
> s3cab restore --set photos /home/me/Pictures/beach.jpg

# A whole directory (everything under it)
> s3cab restore --set photos /home/me/Pictures/2024

# Several at once
> s3cab restore --set photos /home/me/Pictures/2024 /home/me/Pictures/beach.jpg

# The paths listed in a file, one per line
> s3cab restore --set photos --from-file paths.txt

# Everything in the snapshot
> s3cab restore --set photos --all
```

Restoring everything is the rarest restore and the largest, and most providers charge for
downloads, so it takes `--all` rather than happening because a path was left off. A restore
that names nothing stops and lists the set's backed-up directories, the likeliest paths to
copy.

`--from-file` reads the same format as a set's `dirs.txt` — one path per line, `#` for a
comment — so a set's own list works as it is, and so does an edited copy of it. `-` reads the
list from a pipe instead. Its paths count the same as paths typed after `restore`, and the two
can be used together; `--all` can't be combined with either.

Three rules worth knowing:

- **Filters are the absolute paths the snapshot stored**, not patterns and not paths relative
  to anything. The reliable way to write one is to copy it out of `s3cab list <set>` or
  `s3cab tree <set>`.
- **A filter matches that path, or anything beneath it** — on a directory boundary. So
  `…\Photos` selects `…\Photos\beach.jpg` but **not** `…\PhotosArchive\x.jpg`; a trailing
  separator makes no difference.
- **Case is judged by the path, not by the computer doing the restore** — a Windows path (a
  drive letter, or a network share like `\\nas\photos`) matches case-insensitively and with
  either `\` or `/`, even when you restore it on Linux with `--output`. A Linux or macOS path
  is case-sensitive everywhere.

If nothing matches, restore stops rather than silently doing nothing:

```console windows
> s3cab restore --set photos C:\Users\me\Photos\nope.jpg
Contacting the cloud…
ERROR: No files in snapshot '20260612T0915' matched:
  C:\Users\me\Photos\nope.jpg

Find how the backup spells a file, and which snapshots hold it:
  s3cab find <pattern> --set photos
```

```console posix
> s3cab restore --set photos /home/me/Pictures/nope.jpg
Contacting the cloud…
ERROR: No files in snapshot '20260612T0915' matched:
  /home/me/Pictures/nope.jpg

Find how the backup spells a file, and which snapshots hold it:
  s3cab find <pattern> --set photos
```

If some paths match and others don't, it restores what matches, lists the rest in its report,
and exits 1. That includes a folder the snapshot is older than, which is what a set's own
folder list names when it's restored against an earlier snapshot.

## Choosing which version

By default you get the **latest** snapshot. To pull an earlier version of a file, name an
older snapshot with `--snapshot` (`-s`) — the names are what `s3cab list <set> --remote`
prints:

```console windows
> s3cab restore --set photos C:\Users\me\Photos\report.pdf --snapshot 20260501T0800
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20260501T0800).
```

```console posix
> s3cab restore --set photos /home/me/Pictures/report.pdf --snapshot 20260501T0800
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20260501T0800).
```

This is the case a sync service can't help with once its short version history has expired.
Note the file on disk still exists, so you'll need `--overwrite` to actually replace it (see
below) — or use `--output` to put the old copy somewhere else and compare the two first,
which is usually the safer move.

A snapshot name that doesn't exist is an error listing the real ones, so a typo can never
quietly restore the wrong thing:

```console
> s3cab restore --set photos --all --snapshot 2026-05-01
Contacting the cloud…
ERROR: Snapshot '2026-05-01' not found for set 'photos'.
Available snapshots (newest first):
  20260612T0915
  20260501T0800
```

## Existing files are never touched

By default restore **skips any file that already exists** and tells you which:

```console windows
> s3cab restore --set photos --all
Contacting the cloud…
Restored 2 files from 'photos' (snapshot 20260612T0915).

Skipped 1 existing file (rerun with --overwrite to replace):
  C:\Users\me\Photos\report.pdf
```

```console posix
> s3cab restore --set photos --all
Contacting the cloud…
Restored 2 files from 'photos' (snapshot 20260612T0915).

Skipped 1 existing file (rerun with --overwrite to replace):
  /home/me/Pictures/report.pdf
```

This is the behaviour that makes restore safe to reach for. Your accidental deletion comes
back; everything you've worked on since stays exactly as it is. A full
`s3cab restore --set photos --all` after deleting one directory does the obvious right thing
— it refills the gap and leaves the rest alone. It is also why an interrupted restore needs
nothing special: run the same command again, and it carries on past the files already back.

Pass `--overwrite` when you genuinely want the backup's copy to win:

```console windows
> s3cab restore --set photos C:\Users\me\Photos\report.pdf --overwrite
```

```console posix
> s3cab restore --set photos /home/me/Pictures/report.pdf --overwrite
```

The skipped list is never truncated — each entry is a file you asked for and didn't get, so
restore names them all.

## Restoring somewhere else

`--output <dir>` (`-o`) re-roots the restore under a directory you choose instead of writing
to the original locations. Each file lands at its full original path beneath it, its drive
turned into a folder:

```console
> s3cab restore --set photos --all --output D:\recovered
```

A set covering `C:\Users\me\Photos` restores to `D:\recovered\C\Users\me\Photos\…`. A network
share goes under `UNC`, so `\\nas\photos` restores to `D:\recovered\UNC\nas\photos\…`, and a
Linux or macOS path keeps its folders: `/home/me/Photos` restores to
`D:\recovered\home\me\Photos\…`. Two backed-up directories with the same name, like
`C:\a\Photos` and `D:\b\Photos`, land in two different places, and the folders show where each
came from — which is what you need to move them into place, or to edit the set's `dirs.txt`
on a machine laid out differently. The same goes for paths and a `--from-file` list: every file
lands at its full path, however you named it.

Files already under the directory are skipped like anywhere else, and `--overwrite` replaces
them, so the directory needn't be empty.

Reach for it when:

- **the original paths don't fit this machine** — a different drive layout, or another OS
  entirely. This is the only mode that accepts paths that aren't absolute on the current
  system; a plain restore of a Windows snapshot on Linux refuses up front rather than
  scattering files named `C:\Users\…` into your working directory, and points you here, as
  does a plain restore of a Linux or macOS snapshot on Windows.
- **you want to inspect before replacing** — recover an old version alongside the current
  one and diff them, instead of `--overwrite`. For one file or folder, `extract` (below) puts
  it right beside you instead of at its full path.

## Copying one item out

`s3cab extract` copies one file or folder out of a backup into a folder, under its own name,
rather than at its full path the way `restore --output` does. It's the command for "let me
look at last month's copy":

```console windows
> s3cab extract --set photos C:\Users\me\Photos\report.pdf --snapshot 20260501T0800
Contacting the cloud…
Extracted 1 file from 'photos' (snapshot 20260501T0800) to C:\Users\me\report.pdf.
```

```console posix
> s3cab extract --set photos /home/me/Pictures/report.pdf --snapshot 20260501T0800
Contacting the cloud…
Extracted 1 file from 'photos' (snapshot 20260501T0800) to /home/me/report.pdf.
```

- **One path per run**, a file or a folder, matched just as `restore` matches it. For several
  items, run it once for each.
- **It goes in the current folder**, or the one `--output` names. A folder keeps everything
  inside it under its own names.
- **It keeps its own name**, a drive root its letter, unless `--name` gives it another one.
  That is the way to put two `Photos` folders side by side.
- **It never replaces something by mistake.** If the name is already taken there, `extract`
  stops before reading the backup, and says how to go on: another name, another folder, or
  `--overwrite` to write over it. Into a folder already there, that writes over the files the
  backup holds and leaves any others. Usually what's there is the file you're working on,
  which is why it doesn't just skip it, as `restore` would: you would be handed your own file
  back as if it were the old copy.

Everything else is as for `restore`: the integrity check, the modification times, the report,
and the exit status. A backup made on another operating system extracts the same way.

## Restoring onto a fresh machine

A replacement machine knows nothing about your sets, so attach it to the existing backup
first, then restore:

```console
> s3cab reattach photos --bucket my-backups
> s3cab restore --set photos --all
```

`reattach` pulls the set's _snapshot history_ down — not the files. It's `restore` that brings
the content back. (See [Status](../README.md#status) for the split.)

The set is read-only here until you take it over, which makes this the machine that backs it
up:

```console
> s3cab takeover photos
```

That also brings back the set's directory list and exclude rules, and the old machine's
backups of it are refused from then on.

## What restore guarantees

- **Integrity is checked, always.** Every downloaded object's SHA-256 must match the hash the
  snapshot recorded, or nothing is written for that file — the file that lands is the file
  that was backed up, byte for byte.
- **Modification times come back.** Each restored file is stamped with the mtime the snapshot
  recorded, so a later `snapshot` sees it as unchanged rather than as new work. Each time is
  read back after it is set. A disk that keeps times more coarsely, such as a FAT or exFAT
  stick, rounds them, so restore says how many files came back up to 2 seconds off and still
  succeeds; a time further off is listed per file, and the run exits non-zero.
- **Duplicated content downloads once.** Content shared by several paths — a file you'd
  copied, or a directory you'd moved — is fetched once and copied locally to the rest.
- **Two names this disk can't tell apart restore as one — loudly.** A backup made on a
  case-sensitive system can hold both `file.txt` and `File.txt`, but Windows (and macOS, by
  default) treats those as the same file. The first is restored; each later one is listed as a
  collision and the run exits non-zero, never silently overwritten. To keep both, restore a
  colliding path into its own `--output` directory.
- **A name this disk refuses is listed, not fatal.** A backup made on Linux can hold names
  Windows refuses — a control character, or any of `: ? * | < > "` — and one made on Windows
  can hold a long name in a non-Latin script that is too long for Linux, which counts bytes.
  A Linux name holding `\` is listed the same way: Windows would read it as a folder
  separator, so s3cab refuses it rather than let it land somewhere else.
  Each such file is skipped and listed, with any invisible character spelled out (`\x0c` for a
  form feed); the rest of the restore carries on, and the run exits non-zero. To get them
  back, restore them with `--output` onto a disk that allows the names.
- **Something in the way is listed, not fatal.** When a file already on disk sits where one
  of a restored file's folders should be, or a folder sits where the file should be, that
  file is skipped and listed, the rest carries on, and the run exits non-zero. Move what's
  in the way and restore again, or restore into an empty `--output` directory.
- **Everything referenced should be there.** A snapshot only ever reaches the bucket _after_
  every object it references, so any snapshot you can see is complete and restorable. That
  invariant is part of the [format spec](format.md) — and if something has removed content
  from the bucket behind s3cab's back, the next section is what you'll see.

Progress prints to stderr (`Restoring 250/1,240…`), so it stays out of piped or redirected
output. For the machine-readable result, add `--json` — see [output formats](output.md).

## If some content is missing from the backup

Content can go missing from a bucket for reasons that have nothing to do with s3cab — a
lifecycle rule that expired objects, someone tidying the bucket by hand, a partly restored
bucket after an incident. When a file's content isn't there, restore **skips that file and
carries on with the rest**, then lists everything it couldn't produce:

```console windows
> s3cab restore --set photos --all
Contacting the cloud…
Restored 1,238 files from 'photos' (snapshot 20260612T0915).

Could not restore 2 files — the backup no longer holds their contents:
  C:\Users\me\Photos\2019\hike.jpg
  C:\Users\me\Photos\2019\summit.jpg

The rest of the restore finished. To check the other backups in this bucket:
  s3cab verify my-backups
```

```console posix
> s3cab restore --set photos --all
Contacting the cloud…
Restored 1,238 files from 'photos' (snapshot 20260612T0915).

Could not restore 2 files — the backup no longer holds their contents:
  /home/me/Pictures/2019/hike.jpg
  /home/me/Pictures/2019/summit.jpg

The rest of the restore finished. To check the other backups in this bucket:
  s3cab verify my-backups
```

The run exits non-zero, so a scripted restore can't mistake this for a clean one — but the
1,238 files that _were_ recoverable are on disk. Stopping at the first casualty would be the
worse outcome in exactly the situation you most need the backup.

`s3cab verify <bucket>` is the follow-up: it checks every snapshot in the repository against
what's actually stored, so you learn whether two files or two thousand are affected. Note
that an older snapshot won't help if it recorded the _same_ content — identical content is
stored once ([format spec](format.md)) — but it will if the file changed since.

Content you removed yourself with `s3cab delete` is a different case: the bucket holds a
deletion record proving the gap is intended, so those files are listed under their own calm
heading (`Skipped … whose contents were deliberately deleted from the backups`), with the
deletion date beside each — and when they are the *only* gap, the run exits **0**: a scripted
restore shouldn't alarm on a decision its owner already made.

A file whose content is there but **damaged** — the bytes in the bucket no longer match what
was backed up — fails s3cab's integrity check. It gets the same treatment as a missing one:
nothing is written for it, the rest of the restore carries on, it is listed under
`Could not restore … the backup's copy of its contents is damaged`, and the run exits
non-zero. Writing the wrong bytes quietly is exactly what s3cab refuses to do.

`verify` checks that content is present and the right size without downloading it, so it
catches damage that changed a file's size but not damage that kept it — that only a restore
reveals. If an unchanged copy of a damaged file survives anywhere — another machine, a USB
stick — upload it again to repair the backup's copy:

```console windows
> s3cab upload photos --file D:\old-laptop\Photos\2019\hike.jpg --force
```

```console posix
> s3cab upload photos --file /mnt/old-laptop/Pictures/2019/hike.jpg --force
```

## If there's nothing to restore

```console
> s3cab restore --set photos --all
Contacting the cloud…
ERROR: No backups for set 'photos'.

Back one up with:
  s3cab backup photos
```

A set that exists locally but has never been backed up has nothing in the cloud to recover
from. `s3cab status photos` shows what a backup would upload.
