# Exclude-pattern ergonomics

Epic: make the exclude matcher more capable and more legible to users.

- **Negation** (`!important.log`) to re-include under an excluded dir.
- **An optional global `~/.s3cab/exclude.txt`** for `Thumbs.db`/`desktop.ini`-class junk.
- **Review the syntax against `.gitignore` and shell globs.** Two rules surprise someone
  coming from them: `**` inside a name (`photos**`) crosses directories, where they treat it
  as one `*`; and `*` needs at least one character, where theirs can match nothing. Keep
  them, or align (a `src/` change)? Until decided, [guide/exclude.md](../guide/exclude.md)
  names both.

  Start from what a user wants and reasonably expects of a pattern in practice, not from edge
  cases. The corners the clean rooms raised, for that review to settle or leave alone:
  - runs of three or more stars (`***`), and `**` beside other text (`a**/b`);
  - a pattern that is empty once its leading slashes go (`/`, `//`), and `.` or `..` as a
    segment;
  - `\` as a separator on Windows but a literal character elsewhere, though `reattach`
    carries one `exclude.txt` between them;
  - whether `#excluded` and `@CLIENT EXCLUDE` record the pattern as written or normalised;
  - case: simple case folding, so the Turkish `ı` and `İ` match only themselves, where
    Python's `re.IGNORECASE` pairs them with `i`.
