# Exclude rules

Files and directories to skip are listed in a backup set's exclude file,
`~/.s3cab/sets/<set>/exclude.txt`, one glob pattern per line. Lines starting with
`#` are comments, even indented; blank lines are ignored. Each line is trimmed of
the whitespace around it, so a pattern can't start or end with a space.

A new set starts with a ready-made exclude file: it skips regenerable
dependency trees (`node_modules`), `.git` directories, and operating-system
noise (`.DS_Store`, `Thumbs.db`, the Windows drive-root system folders), and
carries a commented list of further suggestions (build output, `*.tmp`, …) you
can uncomment to taste. It's yours to edit — s3cab never rewrites it after
creation, so delete the `.git` pattern if you *do* want repositories backed up.

> For a quick reference in the terminal, run `s3cab help exclude` — it carries
> the same rules as this page, no browser needed.

## Files that change during a backup

s3cab backs up each file as it was when the backup started. If a file is still
being rewritten while the backup runs — a live database, say — s3cab stops and
names that file rather than store a half-written copy under the wrong
fingerprint. (A file another program has locked is different: s3cab can't read
it, so it is listed as an error and the backup carries on without it.) For a
one-off collision, just run the backup again. For something that changes
constantly, list it here so it's skipped from the start — a file that's always in flux isn't the kind of data
s3cab is built to hold (back up an export of it instead).

## Globbing

Patterns are matched against the **whole** path of each file or directory,
relative to **each** of the set's member directories (so one pattern applies the
same way to every directory in the set). So `*.log` matches only a `.log` file at
the top of a member directory; `**/*.log` matches one at any depth. A leading `/`
changes nothing. Write `/` between directories; on Windows `\` works too. A
_segment_ is one directory or file name (the text between two separators).

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments, at the start or after a `/` |
| `**`   | anything at all, across segments, or nothing       |
| `?`    | exactly one character, within a single segment     |

Every other character matches only itself: `[`, `]`, `{`, `}` and `!` mean nothing
special. And `*` needs at least one character, so `*.log` doesn't match a file
named just `.log`.

A directory is matched as its path with a `/` on the end, so only a pattern ending
in `/` or `**` can match one. A pattern ending in `/` matches a directory (and
everything inside it, since the walker doesn't descend into an excluded
directory), and `logs/**` matches the `logs` directory itself, since `**` can
match nothing. A link whose target is a folder is matched like a folder, as its
path with a `/` on the end (unlike git, where `foo/` never matches a link). A
broken link, or one whose target can't be reached, is matched like a file, so only
a pattern without the `/` matches it.

Names compare the way your operating system compares them by default: case
doesn't matter on Windows or macOS, and does on Linux. On macOS an accented letter
also matches however it is stored, as one character or as a letter and an accent
mark. When several patterns match, the first in the file is the one recorded as
leaving the path out.

A pattern can't contain a tab or a carriage return: s3cab stops and names it.
Write `*` in place of the character, which still matches it.

## Examples

- `Tests/**/*.js` — `.js` files anywhere under the `Tests` directory:
  `Tests/HelloWorld.js`, `Tests/UI/HelloWorld.js`, `Tests/UI/Feature1/HelloWorld.js`.
- `**/log.txt` — a file named `log.txt` in any directory, including the root:
  `log.txt`, `Tests/log.txt`, `Tests/UI/log.txt`.
- `**/node_modules/` — every `node_modules` directory, wherever it appears.
- `build/` — the top-level `build` directory only.
- `logs/**` — everything under the top-level `logs` directory, at any depth.

For a real-world example, see this repository's own
[.s3cab/exclude.txt](../.s3cab/exclude.txt).

## Seeing what a pattern actually drops

Patterns are easy to get subtly wrong, and a backup that quietly holds less than
you think is the worst way to find out. `tree --excluded` lists what the set's
patterns are leaving out, and which pattern left each one out:

```
s3cab tree --excluded
```

It reads your directories, not a stored backup, so you can edit `exclude.txt`
and run it again to check the effect straight away. A left-out directory appears
as a single line — s3cab doesn't look inside one — so that line stands for
everything it contains. Alongside the listing you get a count per pattern, which
is usually the quickest way to spot a pattern matching far more than you meant.

To find out why one particular file isn't being backed up, search that listing
for it — `s3cab tree --excluded | findstr beach.jpg` on Windows, or
`s3cab tree --excluded | grep beach.jpg` elsewhere. The plain `s3cab tree` is the
other half of the same question: everything that *would* be backed up.
