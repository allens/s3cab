# Finding a file in your backups

`s3cab find` answers "which snapshots hold this file, and what did it hash to".
It reads the snapshots already on this computer — no network, no S3 calls — and
searches **every set attached here** unless `--set` narrows it to one.

```console windows
> s3cab find diary.txt
# s3cab find · 1 pattern · 1 file · 2 objects
# searched photos → s3://my-backups (8 snapshots) — local history
#
# C:\Users\me\Photos\diary.txt
#   2,400 bytes (2.4kB)   modified 2026-04-30 21:10Z
#   photos  20260501T0800 … 20260814T0930   (5 snapshots)
ef372cd1d64f8d5a76f026995450dca917ce03848ea33f732046817ca70da304
#   2,100 bytes (2.1kB)   modified 2025-10-28 19:30Z
#   photos  20251111T0830 … 20251112T0915   (2 snapshots)
#   ⚠ also backs 1 other path — deleting this removes both
0623bf340e23b059b80094b792e9c4ad4e3e33a5fc239833a2cc3dbeed404c1f
```

```console posix
> s3cab find diary.txt
# s3cab find · 1 pattern · 1 file · 2 objects
# searched photos → s3://my-backups (8 snapshots) — local history
#
# /home/me/Photos/diary.txt
#   2,400 bytes (2.4kB)   modified 2026-04-30 21:10Z
#   photos  20260501T0800 … 20260814T0930   (5 snapshots)
ef372cd1d64f8d5a76f026995450dca917ce03848ea33f732046817ca70da304
#   2,100 bytes (2.1kB)   modified 2025-10-28 19:30Z
#   photos  20251111T0830 … 20251112T0915   (2 snapshots)
#   ⚠ also backs 1 other path — deleting this removes both
0623bf340e23b059b80094b792e9c4ad4e3e33a5fc239833a2cc3dbeed404c1f
```

Everything except the hashes is a `#` comment, so the output redirects to a file
and can be edited down to the hashes you want:

```console
> s3cab find raw-footage/ > footage.txt
```

`s3cab find` only *reads*. Nothing it prints changes a backup.

That file is the input the destructive half of the pair takes: review it, cut
anything you want to keep, then hand it to
[`s3cab delete --from-file`](maintenance.md#deleting-files-from-every-backup-delete)
to remove that content from every backup for good. `find` is where the searching
and the deciding happen — `delete` takes only exact hashes, never a pattern.

## What a pattern matches

The rules are POSIX `find`'s, not [exclude](exclude.md)'s — a file you are
hunting for could be anywhere, whereas an exclude pattern is pruning a known
subtree.

| Pattern            | Matches                                                        |
| ------------------ | -------------------------------------------------------------- |
| `diary.txt`        | that **file name**, in any directory, in any set               |
| `*.mov`            | every `.mov` file, anywhere                                    |
| `2024/IMG_001.jpg` | that **path fragment**, at any depth, segments aligned         |
| `raw-footage/`     | everything **beneath** a `raw-footage` directory, at any depth |

The rule behind the table: **no separator in the pattern and it matches the file
name only; put a separator in and it matches the whole path**, floating (so it
still matches at any depth, but `2024/IMG_001.jpg` will not match
`2024/sorted/IMG_001.jpg`). A **trailing** separator searches beneath a directory.
Write `/` between directories; on Windows `\` works too.

The glob tokens are the same ones [exclude patterns](exclude.md#globbing) use:

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments, at the start or after a `/` |
| `**`   | anything at all, across segments                   |
| `?`    | exactly one character                              |

On Linux and macOS, `\` makes the next character match only itself, as in an
exclude pattern: `'what\?.txt'` finds only `what?.txt`, and `'back\\slash'` a
name holding a backslash. A `\` escapes a `\`, `*`, `?`, `#` or space; before
any other character it escapes nothing, and `find` stops. Quote the pattern so
the shell passes the `\` along.

**`*` means one or more, not zero or more** — one token grammar serves both
commands, and this is where it differs from POSIX `find`. So `*logo.png` matches
`brand-logo.png` but **not** `logo.png` itself. Give both patterns when you want
both; `find` takes as many as you like:

```console
> s3cab find logo.png '*logo.png'
```

Case never matters: `photos/` also finds `Photos/`, on every system. Nor does
how an accented letter is stored — as one character, or as a letter and an
accent mark, as a Mac often stores it. A search that missed would leave the file
in your backups, while an extra match only shows in the list you pick from.

To check a pattern before you trust it, try it against example paths in the
[pattern playground](https://s3cab.plantegral.com/pattern-playground).

## Reading the output

The header counts what was searched and what came back. **Files** are paths;
**objects** are distinct contents — one path that changed over the years holds
several objects, one per version.

Under each path, one line per object: its size and when it was last modified,
then which snapshots hold it. A file that sat unchanged for months is one line
with a span, not one per snapshot:

```
#   photos  20260501T0800 … 20260814T0930   (5 snapshots)
```

The span covers **consecutive** snapshots holding that exact content. If the
file changed and later changed back, you get one line per run. `--all` prints
every snapshot name individually instead of collapsing them.

Then the hash — the object's SHA-256, the same identity the store uses — on a
line of its own.

### `⚠ also backs N other paths`

The same contents stored under other names. s3cab stores each distinct content
**once** ([the storage format](format.md)), so one object can back a file, its
backup copy, and the copy on the other machine in the same set. The warning
exists because that object is one thing: anything done to it reaches every path
listed.

### `⚠ results span N buckets`

Each set writes to one bucket, named on the `# searched` line. If the matches
came from sets in different buckets, the hashes below are not all addressable in
the same place — worth knowing before feeding the file anywhere.

### `⚠ N snapshots could not be read`

A damaged snapshot file is named and skipped, and the search carries on through
the rest. It is called out because the file you are looking for might have been
in the one that wouldn't open — `s3cab verify <bucket>` says what is wrong with
it.

## Why only local snapshots

`s3cab reattach` pulls a set's **entire** snapshot history down when you attach
it, so what is on disk is what is in the bucket. That is why `find`, like
`compare` and `restore`, has no `--remote`: there would be nothing extra
to fetch. If a set is backed up from another computer, `s3cab reattach <set>`
here pulls the snapshots it has taken since.

For the machine-readable form, pass `--json` (see [output
formats](output.md)) — the same spans, with full hashes and absolute paths.
