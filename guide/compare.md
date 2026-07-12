# Reading a compare report

`s3cab compare` shows what changed between two snapshots, from an older one
(`--since`) to a newer one (`--until`). With no options it compares the latest
snapshot against the one taken just before it.

- `--until <snapshot>` — the newer side (default: the latest snapshot)
- `--since <snapshot>` — the older side (default: the snapshot immediately
  before `--until`; when `--until` is the oldest snapshot there is nothing
  older, so the report simply lists everything as added)

Snapshot names are as `s3cab list` prints them; the `.tsv`/`.tsv.zst` filename
extension may be included or left off. Naming a snapshot that doesn't exist is
an error — a typo never silently becomes an empty snapshot (which would have
read as "everything added" or "everything deleted").

The report is grouped into sections, one per kind of change, each headed with a
count; empty sections are left out. A closing line totals every category and the
bytes that changed. (`s3cab snapshot` prints the same report after taking a
snapshot, showing what changed since the previous one.)

```console
> s3cab compare photos --since 2026-11-11T0830
photos: ~/Pictures  2026-11-11T0830 → 2026-11-12T0915

Added (2)
  2025/new.jpg
  brand-logo.png  (duplicate of logo.png)

Renamed (1)
  notes.txt → diary.txt

Moved (1)
  2024/IMG_001.jpg → 2024/sorted/IMG_001.jpg

Modified (1)
  report.pdf

Deleted (1)
  old notes.txt

2 added, 1 renamed, 1 moved, 1 modified, 1 deleted · 5.3 MB changed
```

The header names the set and, after it, the common parent directory the listed
paths are shortened against (`~` is your home directory). For the machine-readable
form — the same report as a JSON structure with absolute paths — pass `--json`
(see [output formats](output.md)).

A first snapshot has nothing to compare against, so instead of listing your whole
tree as "added" it collapses to a one-line count: `First snapshot: 1,234 files
(4.2 GB)`.

## The sections

Files are compared by their **content** (SHA-256 hash), never by timestamps —
touching a file without changing it does not show up.

| Section    | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `Added`    | a path that wasn't in the older snapshot                 |
| `Renamed`  | content that moved to a new name in the same directory   |
| `Moved`    | content that moved to a different directory              |
| `Modified` | the same path with different content                     |
| `Deleted`  | a path that is gone from the newer snapshot              |
| `Errors`   | a path the newer snapshot couldn't read (e.g. no access) |

`Renamed` and `Moved` are the same underlying event — content that left one path
and reappeared at another — split apart because they read differently to a
person; both are shown as `old → new`.

### `(duplicate of …)` notes on added files

`brand-logo.png  (duplicate of logo.png)` means the added file's content is
identical to a file that already existed — a copy, not new data. When every file
that previously held that content was itself moved, the note points at the
moved-to location instead, so a copy is never mistaken for brand-new content.

## Why a "rotated" file shows as modified, not moved

After `mv app.log app.log.1` plus a fresh `app.log` — or, more commonly,
copying `report.docx` to `report backup.docx` and then editing the original —
the report reads: `app.log` modified, and `app.log.1` added
`(duplicate of app.log)`.

From two snapshots alone, "copied then edited" and "renamed away then
recreated" are indistinguishable. s3cab reports only what it can verify: the
file at that path changed, and a new file holds what it used to contain. It
never guesses that a move happened — a path is only reported as moved when it
is actually gone from the newer snapshot. (Git's rename detection draws the
same line.)

## A directory added to or removed from the set

A compare is between two snapshots, and each snapshot records the set's directories at the
time it was taken. If you change the set's directories — by editing its `dirs.txt` — between
two snapshots, that change shows up in the report as files **added** or **deleted**:

- **remove a directory** from `dirs.txt`, and every file under it appears under `Deleted` in
  the next comparison — not because the files were deleted from disk, but because they are no
  longer in the set's scope;
- **add a directory**, and its files appear under `Added`.

This is expected: the report faithfully shows the difference between the two snapshots, and the
set genuinely covered different directories in each. If a comparison shows a surprising wave of
deletions, check whether the set's directories changed between the two snapshots (`s3cab list
<set>` shows the current directories). Restoring either snapshot still recovers exactly what
that snapshot contained.

## Files that couldn't be read

A file the snapshot couldn't hash (for example, permission denied) is recorded
in the snapshot file as an `#ERROR` row carrying the error message, and reported
under the `Errors` section. It is **not** mistaken for `Deleted` — the file is
still on disk, just unreadable — nor dropped from the report. Each entry is the
path followed by the reason in parentheses; the same reason is also kept in the
snapshot file itself and printed in the snapshot run's output.

```console
Errors (1)
  secret/vault.kdbx  (EACCES: permission denied)
```
