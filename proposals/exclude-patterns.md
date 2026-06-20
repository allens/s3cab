# Exclude-pattern ergonomics

Epic: make the exclude matcher more capable and more legible to users.

- **Negation** (`!important.log`) to re-include under an excluded dir.
- **A `tree --explain <path>`** that says *which pattern* excluded a file (the `#EXCLUDED`
  snapshot lines almost do this — surface it).
- **An optional global `~/.s3cab/exclude.txt`** for `Thumbs.db`/`desktop.ini`-class junk.
- **Bare `**` (no trailing `/`) degenerates** — the matcher only rewrites `**/`; a lone `**`
  becomes two `[^/]+` runs, i.e. "2+ chars in one segment". Either reject the pattern with a
  clear error or define it.
