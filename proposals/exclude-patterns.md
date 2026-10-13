# Exclude-pattern ergonomics

Epic: make the exclude matcher more capable and more legible to users.

- **Negation** (`!important.log`) to re-include under an excluded dir.
- **An optional global `~/.s3cab/exclude.txt`** for `Thumbs.db`/`desktop.ini`-class junk.
- **Review the syntax against `.gitignore` and shell globs.** Two rules surprise someone
  coming from them: `**` inside a name (`photos**`) crosses directories, where they treat it
  as one `*`; and `*` needs at least one character, where theirs can match nothing. Keep
  them, or align (a `src/` change)? Until decided, [guide/exclude.md](../guide/exclude.md)
  names both.
