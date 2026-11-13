# Restore trusts nothing in its target from one file to the next

**Status:** accepted & implemented (2026-11-05), amended 2026-11-13: every restore, not only
`--output`, leaves alone a file that arrives at a destination. Extends
[0109](0109-restore-output-keeps-the-full-path.md) and
[0086](0086-restore-collision-filesystem-equivalence.md)'s filesystem-answers stance.

## Context

Something other than the restore can write in `--output`: a link left there before the run, a
sync client, a person, or another account on a shared folder. Three things went wrong when it
did, measured on NTFS and ext4, all on the `--output`/`extract` path. An in-place restore writes
to the snapshot's absolute paths by design ([0071](0071-snapshot-paths-absolute-native.md)) and
has no boundary to keep.

- **The temp sibling's name is predictable, and a link there was written through.** The bytes
  landed wherever it pointed, and the rename moved the link to the destination.
- **The folder-link check was remembered for the run.** A folder swapped for a link after its
  first file sent every later file under it elsewhere, reported `restored`, exit 0.
- **A dedup copy trusted the file it landed earlier.** A file changed before the copy was copied
  as changed, reported `restored`, exit 0.

## Decision

**What is at the temp's name is removed, never followed, and the temp is created exclusively
(`wx`).** The name stays derived from the destination's, so a retry clears its own leftover. A
folder there can't be removed this way, so it is reported `blocked`. Removal comes first, not on
`EEXIST`, because NTFS's `CREATE_NEW` goes through a link whose target doesn't exist and creates
the target. That costs each written file one failed `rm`: 0.16 ms on NTFS, 0.21 ms on ext4.

**Every write checks each folder between `--output` and its file afresh.** A row that writes
nothing keeps the run's remembered answers, where a stale one can only misreport it. Fresh, each
write costs 0.21 ms on NTFS and 0.013 ms on ext4, 6 folders deep.

**A dedup copy goes through `writeFileAtomic`'s digest check.** A copy that fails on its
source's account — it no longer hashes to the row's hash, or is gone, unreadable or no longer a
regular file — isn't an object fault: the path is fetched instead, its report and exit are
whatever the fetch earns, and no later path goes back to that file. What became of it is its
changer's business, and nothing is said about it. The source's failures are the copy's answer
(`false`), not a throw: the source is opened and checked on its own, and of the pipeline's
errors only a `read` is its (the temp's `open` is the destination's), where whether the source
still exists was a guess. `writeFileAtomic` is the one writer left, so `copyFile` is gone, and so
is the split between handling the temp and writing to it.

## Cost of checking copies

Only rows that share content pay, and at the rate every download already pays, so a copy stays
cheaper than fetching. Measured against `copyFile` (best of 3, one machine; absolute times vary
by disk, the ratios are the point):

| Copied | NTFS | ext4 |
| --- | --- | --- |
| 4 KB | 0.98 → 1.82 ms | 0.35 → 1.33 ms |
| 4 MB | 3.3 → 31.7 ms | 2.9 → 17.3 ms |
| 1 GB | 0.72 → 8.2 s | 0.41 → 4.3 s |

The source is read in chunks of its own size up to 1 MiB, not `createReadStream`'s 64 KiB
default: at 64 KiB the same 1 GB copy took 12.6 s on NTFS and 6.6 s on ext4. On a faster disk
the 1 MiB copy of 1 GB takes 3.1 s against 3.0 s for hashing the bytes alone, so the hash is the
floor. A plain 1 MiB read costs a 4 KB file 0.5 ms more than a 64 KiB one (a stream allocates
each read in full), which is why the chunk is capped at the file's size. `copyFile` could also
have been a clone on a filesystem that offers one (APFS, btrfs, XFS, ReFS); a clone can't say
what it read either.

## Considered options

- **Compare a stat fingerprint (size, mtime, ctime) before `copyFile`.** About one `lstat`, but
  a guess where the hash is an answer, and it adds a record kept from landing to copy, against
  a check that removes code. Rejected on the result.
- **A random temp name.** Unpredictable, but a dead run's leftovers would pile up forever, and
  an exclusive create is needed regardless.
- **`COPYFILE_EXCL`.** Answers `EPERM`, not `EEXIST`, for a folder or directory link on NTFS.
- **No remembered answers at all.** One line simpler, but a re-run skipping every file does
  nothing else: 20,000 files 6 folders deep go from 0.7 s to 4.8 s on NTFS (0.06 s to 0.31 s on
  ext4).

## Consequences

- **Not closed: a swap during the one file being written.** The check runs before the download,
  so a swap during it still carries that one file out, and on a video set that is minutes. Every
  later file is `blocked`, exit 1. Another walk just before the rename would shrink the gap to
  microseconds, at the price of a parameter through `getObject` and `writeFileAtomic`. Nothing
  closes it outright: Node has no `openat` or `renameat`, so a path is always resolved again at
  the rename. On NTFS the same goes for a link planted between the temp's removal and its
  creation.
- A copy no longer starts with its source's time, so restore's stand-in `utimes` for a time the
  disk won't hold is gone: such a file simply keeps the time it was written.
- Fixtures that restore through a dedup copy need real digests, not labels.

## Amendment (2026-11-13): nothing that arrives at a destination is replaced

### Context

Restore looked at every destination once, before the first download, and never again. A file
that something else put at a destination later, before its turn or while its content
downloaded, was replaced by the rename and reported `restored`, exit 0, with no `--overwrite`.
That is the in-place restore as much as `--output`: a sync client or a person writes in the
user's own folders too.

### Decision

- **Each file's destination is looked at on its own turn**, before its content is fetched or
  copied. A folder there is `blocked`, a file this run wrote under another name is `collided`
  ([0086](0086-restore-collision-filesystem-equivalence.md)), and anything else is `skipped`
  unless `--overwrite`. `planRestore`, which decided this for every file before the first
  download, is gone.
- **Without `--overwrite`, a file lands by hard link, not by rename.** The filesystem refuses a
  hard link over anything at all (a file, a folder, any kind of link) with `EEXIST`, measured on
  NTFS and ext4, so nothing can arrive between a check and the landing. What is there is judged
  as above: a file is `skipped`, exit 0, as if it had been there first. The fetched copy is
  discarded.
- **A filesystem without hard links** (FAT and exFAT by their documentation, not measured)
  fails the link some other way. Then the destination is looked at once more and the temp
  renamed. Every failure but `EEXIST` takes that path, so no list of "no hard links" errors is
  kept: a name the filesystem refuses fails the link as it fails the rename (`ENOENT` on NTFS,
  `ENAMETOOLONG` on ext4, measured), and the rename throws what restore already reads.
- `--overwrite` and snapshot downloads keep the plain rename.

### Cost

A hard link and the temp's removal cost each written file about 1.2 ms more than a rename on
NTFS, 0.4 ms on ext4 (2,000 files, one machine). Looking on each file's turn is the `lstat` the
plan made. Whether a file at a destination is one this run wrote takes `realpathSync.native`,
0.15 ms a file on NTFS (three times the `lstat`) and 0.013 ms on ext4, so it is asked only of a
file the size of one this run wrote: a restore that skips most of a tree doesn't pay it for each
file it skips.

### Considered options

- **Look again just before the rename, everywhere.** Microseconds stay open, for one `lstat` a
  written file. Kept only where there are no hard links.
- **Look only before each download**, as for folder links above. A file that arrives during its
  own download is still replaced, and on a video set that is minutes.
- **Report a file that arrives mid-run as a fault of its own**, exit 1. It would say that
  something else writes in the same place at the same time, but it is one more list in the
  restore result for a file in the state of one that was there first.
- **Keep `planRestore` for the two refusals** (no destination, a `:` in a Windows name), which
  need no disk. A plan that makes one decision of four puts the other three somewhere else.

### Consequences

- A process that stops between the link and the temp's removal, or a removal that fails because
  another program holds the temp open, leaves the temp as a second name for the landed file. A
  later run skips that file, so it doesn't remove the temp.
