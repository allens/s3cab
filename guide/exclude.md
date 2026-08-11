# Exclude rules

Files and directories to skip are listed in a backup set's exclude file,
`~/.s3cab/sets/<set>/exclude.txt`, one glob pattern per line. Lines starting with
`#` are comments; blank lines are ignored.

A new set starts with a ready-made exclude file: it skips regenerable
dependency trees (`node_modules`) and operating-system noise (`.DS_Store`,
`Thumbs.db`, the Windows drive-root system folders), and carries a commented
list of common suggestions (`.git`, build output, `*.tmp`, …) you can uncomment
to taste. It's yours to edit — s3cab never rewrites it after creation.

> For a quick reference in the terminal, run `s3cab help exclude` — it carries
> the same rules as this page, no browser needed.

## Files that change during a backup

s3cab backs up each file as it was when the backup started. If a file is still
being rewritten while the backup runs — a live database, or a file another
program still has open — s3cab stops and names that file rather than store a
half-written copy under the wrong fingerprint. For a one-off collision, just run
the backup again. For something that changes constantly, list it here so it's
skipped from the start — a file that's always in flux isn't the kind of data
s3cab is built to hold (back up an export of it instead).

## Globbing

Patterns are matched against the path of each file or directory, relative to
**each** of the set's member directories (so one pattern applies the same way to
every directory in the set). Write `/` between directories; on Windows `\` works
too. A _segment_ is one directory or file name (the text between two separators).

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments                        |
| `**`   | anything at all, across segments                   |
| `?`    | exactly one character                              |

A pattern ending in `/` matches a directory (and everything inside it, since the
walker doesn't descend into an excluded directory).

Matching is case-insensitive on Windows and case-sensitive elsewhere.

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
