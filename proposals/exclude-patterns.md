# Exclude-pattern ergonomics

Epic: make the exclude matcher more capable and more legible to users.

- **`tree --excluded`: exclusion discoverability** (user, 2026-08-08 — *"a user might want to
  review once in a while what is really going on"*). **Top of this list**: it is the one
  exclude-pattern question a user cannot answer at all today. There is no way to see what the
  patterns are dropping short of decompressing a snapshot by hand — and even that only works by
  accident, because `#EXCLUDED` rows are written but **ignored on read**
  ([`snapshot-file.mjs`](../src/lib/snapshot-file.mjs)), so `compare` can never surface them
  either. This is also why [ADR-0078](../docs/adr/0078-backup-run-report.md) heads its closing
  block `Couldn't be backed up` rather than "Not backed up": excluded files are the category a
  backup deliberately cannot report on.
  _The data is already computed and thrown away._ `walkDirs` returns `{files, excluded, skipped}`
  with the **matching pattern** on every excluded record, and
  [`tree.mjs`](../src/commands/tree.mjs) is two lines that keep `.files` and discard the rest —
  while its own doc calls it "the diagnostic answer to *exactly what is in this set*". The
  inverse question belongs to the same command. Computing it live rather than from a snapshot is
  the better design, not a shortcut: you can edit `exclude.txt` and immediately re-run to check
  the effect, which reading a snapshot can never do. (This supersedes the older note here that
  said to surface the `#EXCLUDED` snapshot lines — the walk is the cheaper and more useful
  source.)
  _Not free, despite the size:_ a new user-facing flag needs help text, an output shape, and a
  [`cli-design`](../.claude/skills/cli-design/) pass — including whether the pattern is shown
  per path, and how this sits beside `tree --explain <path>` below (they are plausibly one
  feature: "what is excluded" and "why is *this* excluded").
- **Negation** (`!important.log`) to re-include under an excluded dir.
- **A `tree --explain <path>`** that says *which pattern* excluded a file — the per-path half of
  `tree --excluded` above; settle them together.
- **An optional global `~/.s3cab/exclude.txt`** for `Thumbs.db`/`desktop.ini`-class junk.
- **Bare `**` (no trailing `/`) degenerates** — the matcher only rewrites `**/`; a lone `**`
  becomes two `[^/]+` runs, i.e. "2+ chars in one segment". Either reject the pattern with a
  clear error or define it.
