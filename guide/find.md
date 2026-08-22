# Finding a file in your backups

`s3cab find` answers "which snapshots hold this file, and what did it hash to".
It reads the snapshots already on this computer — no network, no S3 calls — and
searches **every set attached here** unless `--set` narrows it to one.

```console
> s3cab find aws-keys.txt
# s3cab find · 1 pattern · 1 file · 1 object
# searched myset → s3://my-backups (943 snapshots) — local history
#
# C:\Users\me\secretsdir\aws-keys.txt
#   892 bytes   modified 2019-03-28 14:02Z
#   myset  2019-03-28T0812 … 2026-08-14T0930   (943 snapshots)
#   ⚠ also backs 3 other paths — deleting this removes all of them
5e21ab7fc0b1e83d276af59104cc7e2b8d3610fa94e7b25c0d81f36ae9b40c93
```

Everything except the hashes is a `#` comment, so the output redirects to a file
and can be edited down to the hashes you want:

```console
> s3cab find secretsdir/ > hashes.txt
```

`s3cab find` only *reads*. Nothing it prints changes a backup.

## What a pattern matches

The rules are POSIX `find`'s, not [exclude](exclude.md)'s — a file you are
hunting for could be anywhere, whereas an exclude pattern is pruning a known
subtree.

| Pattern           | Matches                                                     |
| ----------------- | ----------------------------------------------------------- |
| `aws-keys.txt`    | that **file name**, in any directory, in any set             |
| `*.mov`           | every `.mov` file, anywhere                                  |
| `Documents/tax`   | that **path fragment**, at any depth, segments aligned       |
| `secretsdir/`     | everything **beneath** a `secretsdir` directory, at any depth |

The rule behind the table: **no separator in the pattern and it matches the file
name only; put a separator in and it matches the whole path**, floating (so it
still matches at any depth, but `Documents/tax` will not match
`Documents/old/tax`). A **trailing** separator searches beneath a directory.
Write `/` between directories; on Windows `\` works too.

The glob tokens are the same ones [exclude patterns](exclude.md#globbing) use:

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments                        |
| `**`   | anything at all, across segments                   |
| `?`    | exactly one character                              |

**`*` means one or more, not zero or more** — one token grammar serves both
commands, and this is where it differs from POSIX `find`. So `*secret1` matches
`copy-secret1` but **not** `secret1` itself. Give both patterns when you want
both; `find` takes as many as you like:

```console
> s3cab find secret1 '*secret1'
```

Case is judged by the path being searched, not by the computer doing the
searching: a Windows path in a snapshot matches case-insensitively even when you
run `find` on Linux.

## Reading the output

The header counts what was searched and what came back. **Files** are paths;
**objects** are distinct contents — one path that changed over the years holds
several objects, one per version.

Under each path, one line per object: its size and when it was last modified,
then which snapshots hold it. A file that sat unchanged for five years is one
line with a span, not 900 identical ones:

```
#   myset  2019-03-28T0812 … 2026-08-14T0930   (943 snapshots)
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
`compare`, `list` and `restore`, has no `--remote`: there would be nothing extra
to fetch. If a set is backed up from a second computer, run `find` there too (or
reattach it here) to see that machine's snapshots.

For the machine-readable form, pass `--json` (see [output
formats](output.md)) — the same spans, with full hashes and absolute paths.
