# Exclude rules

Files and directories to skip are listed in a backup set's exclude file,
`~/.s3cab/sets/<set>/exclude.txt`, one glob pattern per line. Lines starting with
`#` are comments, even indented; blank lines are ignored. Each line is trimmed of
the whitespace around it: tab, VT, FF, CR, LF, every Unicode space (category Zs),
U+2028, U+2029 and a byte-order mark, but not U+0085. So CRLF line endings, or a
missing newline at the end, are fine. To match a name that starts with `#` or a
space anyway, see **Names with special characters** below.

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

A pattern is matched against the **whole** path of a file or directory, relative
to **each** of the set's member directories, so one pattern applies the same way
to every directory in the set.

**Paths**

- `*.log` matches only a `.log` file at the top of a member directory; `**/*.log`
  matches one at any depth.
- Write `/` between directories; on Windows `\` works too.
- A leading `/`, or several, changes nothing, and repeated `/` count as one.
- A _segment_ is one directory or file name: the text between two separators.
- Only what is inside a member directory is matched, never the member directory
  itself.

**Tokens**

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments, at the start or after a `/` |
| `**`   | anything at all, across segments, or nothing       |
| `?`    | exactly one character, within a single segment     |

- Every other character matches only itself: `[`, `]`, `{`, `}` and `!` mean
  nothing special.
- `*` needs at least one character, so `*.log` doesn't match a file named just
  `.log`.
- `**` matches the same way wherever it stands, even inside a name (`a**b`).
- A "character" is one Unicode code point, so an accent stored as a separate mark
  counts as one more.
- If you know `.gitignore`, two things differ: there, `**` inside a name acts like
  a single `*` and stays within one directory, and `*` can match nothing at all.

**Names with special characters**

- On Linux and macOS, `\` makes the character after it match only itself: `\*`,
  `\?`, `\#`, `\ ` (a space), and `\\` for a backslash.
- So `what\?.txt` matches only `what?.txt`, and `notes\ ` the name `notes `.
  A `\` keeps the space after it at the end of a line. Other blank characters,
  such as a no-break space, escape the same way; a tab doesn't.
- A `\` before any other character, or at the end of a line, escapes nothing,
  and s3cab stops and names the pattern. An exclude file written on Windows,
  with `\` between directories, usually stops it this way; write `/` instead.
  A `\` there before a `*`, `?`, `#` or space is read as an escape, though, so
  `**\*.tmp` matches only a file named `*.tmp`.
- On Windows `\` separates directories, as everywhere else in Windows. No escape
  is needed there, since Windows programs can't give a name a `*` or `?`.
- On every system, a name starting with `#` or a space goes after a `\`: `\#notes`
  matches `#notes`, and `\ draft` matches ` draft`. On Windows this works because
  a separator at the start changes nothing.
- On Windows, a name that ends in a space, or holds a `*` or `?`, can't be matched
  on its own. Windows programs can't make such a name, so it only turns up on
  files from elsewhere, such as a network share.

**Directories and links**

- A directory is matched as its path with a `/` on the end, so only a pattern
  ending in `/` or `**` can match one.
- A pattern ending in `/` matches a directory and everything inside it, since the
  walker doesn't descend into an excluded directory.
- `logs/**` matches the `logs` directory itself, since `**` can match nothing.
- A link whose target is a folder is matched like a folder, as its path with a `/`
  on the end (unlike git, where `foo/` never matches a link).
- A broken link, or one whose target can't be reached, is matched like a file, so
  only a pattern without the `/` matches it.
- Anything s3cab can't read is listed as an error, unless a pattern leaves it out.
- The exception is a folder it can't list: that stops the backup, and no snapshot
  is written. A pattern leaves that out too.
- A pattern ending in `/` matches only what s3cab knows to be a folder. An entry it
  can't inspect (a link it can't read, or anything whose type it can't check) is
  matched like a file, so only a pattern without the `/` matches it.
- An unlocked OneDrive Personal Vault is such an entry: a link s3cab can't read.
  While locked it isn't there at all. So one pattern without the `/` leaves it
  out: its name exactly as its error row shows it, such as `Personal Vault`.

**Case, and other rules**

- Case doesn't matter on Windows or macOS, even on a drive or in a directory set
  up to be case-sensitive. Everywhere else it always matters, even on a drive that
  ignores it.
- Ignoring case goes one character for one (Unicode's simple case folding): `ẞ`
  matches `ß` but not `ss`, and the Turkish `ı` and `İ` match only themselves.
- On macOS an accented letter also matches however it is stored, as one character
  or as a letter and an accent mark: both sides are compared in the composed form
  (NFC).
- A name that isn't valid Unicode — a lone surrogate on Windows, bytes that aren't
  UTF-8 on Linux — is matched with U+FFFD (�) in place of each part that doesn't
  decode, so `*` matches there. A lone surrogate becomes three of them, which
  matters to a `?`.
- When several patterns match, the first in the file is the one recorded as
  leaving the path out.
- A pattern can't contain a tab or a carriage return: s3cab stops and names it.
  Write `*` in place of the character, which still matches it.
- A file whose name holds a tab, CR or LF, or isn't valid Unicode, stops the
  backup, which names it. Rename it, or leave it out with a pattern such as
  `odd*name.jpg`.

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

To try a pattern before you have a set, or against paths you only type out, the
docs site has an
[exclude-pattern playground](https://s3cab.plantegral.com/tools/exclude): the
same matcher, in your browser.
