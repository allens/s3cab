# A backslash escapes in patterns on Linux and macOS; Windows paths stay as written

**Status:** accepted & implemented (2026-10-31). Extends [0051](0051-native-separator-in-user-path-files.md)
and [0088](0088-find-matches-like-posix-find.md).

## Context

`backup` suggests an exclude line for a file that failed on this run and the last. The line is
the file's path relative to its member directory, and for some names it means something else
when `exclude.txt` reads it back:

- **`*` or `?`** is always a wildcard: `a?b` also excludes `axb`.
- **A leading `#`** makes the line a comment, so it excludes nothing.
- **A space at either end** is trimmed, so the line names another file.

s3cab backs all of these up: the walk refuses only a tab, CR, LF or invalid Unicode
([0073](0073-refuse-tab-newline-paths.md), [0100](0100-tab-cr-lf-refused-or-spelled-out.md)).
Linux allows every character in a name but `/` and NUL, and macOS every one but `/`. Windows
refuses `*`, `?` and control characters, and its usual programs strip a trailing space, so there
only a leading `#` or space can reach a pattern in everyday use.

The grammar has no escape. `find` shares its tokens (`globSource`), so it can't name these files
either, nor a Linux file with a literal backslash.

## Decision

**On Linux and macOS, `\` escapes the character after it, in `exclude.txt` and in `find`.**
`\*`, `\?`, `\#`, `\ ` and `\\` each match that one character. `\` isn't a separator there, and
it is the escape a shell user and a `.gitignore` user already know. An escaped space, or other
whitespace that isn't a control character, at the end of a line survives the trim: `notes\ `
names `notes `. A `\` before anything else, or at the end, escapes nothing and is refused: it is
how a Windows path reads there, and `**\Thumbs.db` would also match `myThumbs.db`. A member
directory's own path is matched as text, so a `\`, `*` or `?` in it matches only itself.

**On Windows, nothing changes.** `\` and `/` are both separators, and a pattern is a path as a
Windows user knows it (user, 2026-10-31). Nothing there needs an escape. Win32 refuses `*` and
`?` in a name, and a leading `#` or space is written after a leading separator, which already
changes nothing: `\#notes` names `#notes`, and `\ lead` names ` lead` (measured).

**`\#notes` and `\ lead` therefore work on every system**, as a separator on Windows and an
escape elsewhere. `backup`'s suggestion writes a leading `#` or space that way everywhere, and
on Linux and macOS escapes `*`, `?`, `\` and a trailing space. A name with no exact line gets
none, and the report lists it: on Windows a name ending in a space or holding `*` or `?` (a share
can hold them), and anywhere a name holding a control character, which no terminal shows as
written.

An exclude file is read by the rules of the system reading it: the crossing between systems is
the boundary [0051](0051-native-separator-in-user-path-files.md) left for later. One written on
Windows and read on Linux, `**\node_modules\` say, is refused with the same line in `/` offered.
A `\` before `*`, `?`, `#` or a space is an escape however it was written, so a file whose only
Windows line is `**\*.tmp` passes, and that line matches a literal `*`.

Comments stay `#`. `dirs.txt` is untouched: it takes no globs, and no absolute path starts with
`#`.

## Considered and rejected

- **`/` the only separator and `\` the escape everywhere, as `.gitignore` does** — one rule on
  every system, but a Windows user could no longer write `Outlook\archive.pst`.
- **A comment marker no name can hold** — `//` is a share path in `dirs.txt`, which reads lines
  the same way. A tab can't be seen: an editor that inserts spaces for Tab turns a comment into
  a pattern, and a terminal turns the tab in a copied suggestion into spaces.
- **No comments in `exclude.txt`** — the starter file loses its list of suggestions to uncomment,
  and a line can't say why it is there. It fixes only the leading `#`, which a leading
  separator already fixes.
