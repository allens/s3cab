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

The report is printed as JSON. (`s3cab snapshot` prints the same report after
taking a snapshot, showing what changed since the previous one.)

```json
{
  "added": [
    "2025\\new.jpg"
  ],
  "moved": [
    "2024\\IMG_001.jpg →→ 2024\\sorted\\IMG_001.jpg"
  ],
  "modified": [
    "diary.txt"
  ],
  "deleted": [
    "old notes.txt"
  ],
  "errors": []
}
```

Paths are relative to the compared directory. (In JSON, a Windows `\` path
separator is written doubled, as `\\`.)

## The five categories

Files are compared by their **content** (SHA-256 hash), never by timestamps —
touching a file without changing it does not show up.

| Category   | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `added`    | a path that wasn't in the older snapshot                 |
| `moved`    | content that left one path and reappeared at another     |
| `modified` | the same path with different content                     |
| `deleted`  | a path that is gone from the newer snapshot              |
| `errors`   | a path the newer snapshot couldn't read (e.g. no access) |

### `==` notes on added files

`new.txt == old.txt` means the new file's content is identical to what
`old.txt` held in the *older* snapshot — a copy, not new data. When every file
that previously held that content was itself moved, the note points at the
moved-to location instead, so a copy is never mistaken for brand-new content.

### One arrow or two

`a.txt → b.txt` is a rename within the same folder;
`dir1/a.txt →→ dir2/a.txt` moved across folders.

## Why a "rotated" file shows as modified, not moved

After `mv app.log app.log.1` plus a fresh `app.log` — or, more commonly,
copying `report.docx` to `report backup.docx` and then editing the original —
the report reads: `app.log` modified, `app.log.1` added `== app.log`.

From two snapshots alone, "copied then edited" and "renamed away then
recreated" are indistinguishable. s3cab reports only what it can verify: the
file at that path changed, and a new file holds what it used to contain. It
never guesses that a move happened — a path is only reported as moved when it
is actually gone from the newer snapshot. (Git's rename detection draws the
same line.)

## Files that couldn't be read

A file the snapshot couldn't hash (for example, permission denied) is recorded
in the snapshot file as an `#ERROR` row carrying the error message, and reported
under the `errors` category. It is **not** mistaken for `deleted` — the file is
still on disk, just unreadable — nor dropped from the report. Each entry is the
path followed by the reason in parentheses, `path (reason)`; the same reason is
also kept in the snapshot file itself and printed in the snapshot run's output.

```json
{
  "added": [],
  "moved": [],
  "modified": [],
  "deleted": [],
  "errors": [
    "secret\\vault.kdbx (EACCES: permission denied)"
  ]
}
```
