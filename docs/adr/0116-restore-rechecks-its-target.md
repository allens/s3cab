# Restore trusts nothing in its target from one file to the next

**Status:** accepted & implemented (2026-11-05). Extends [0109](0109-restore-output-keeps-the-full-path.md)
and [0086](0086-restore-collision-filesystem-equivalence.md)'s filesystem-answers stance.

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

**A dedup copy goes through `writeFileAtomic`'s digest check.** A source that no longer hashes
to the row's hash isn't an object fault: the path is fetched instead, and its report and exit
are whatever the fetch earns. What became of the first file is its changer's business, and
nothing is said about it. `writeFileAtomic` is the one writer left, so `copyFile` is gone, and
so is the split between handling the temp and writing to it.

## Cost of checking copies

Only rows that share content pay, and at the rate every download already pays, so a copy stays
cheaper than fetching. Measured against `copyFile` (best of 3):

| Copied | NTFS | ext4 |
| --- | --- | --- |
| 4 KB | 0.98 → 1.20 ms | 0.33 → 0.93 ms |
| 4 MB | 3.1 → 18.6 ms | 2.9 → 28.2 ms |
| 1 GB | 0.43 → 5.2 s | 0.41 → 7.6 s |

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
