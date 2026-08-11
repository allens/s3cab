# Exclusion review is computed from the walk, not read from a snapshot

**Status:** accepted

`s3cab tree --excluded` lists what a set's exclude patterns are dropping, each entry paired with
the pattern that dropped it. It is **computed from a live walk of the set's directories**, in the
same pass that `tree` already runs — never from the `#EXCLUDED` rows of a stored snapshot.

It is **one flag, not two.** There is no `tree --explain <path>` ("why is *this* file excluded?"):
carrying the pattern on every row makes that question a `grep` over this output, and the two are
the same question asked at two zoom levels.

## Why

Before this, "what are my patterns dropping?" was the one exclude-pattern question a user could
not answer at all. A snapshot does record the answer — `writeSnapshot` emits an `#EXCLUDED` row per
match ([0028](0028-snapshot-writer-owns-the-grammar.md)) — but
[`snapshot-file.mjs`](../../src/lib/snapshot-file.mjs) **ignores those rows on read**, so nothing
downstream can surface them; `compare` never sees them, and the only way through was decompressing
a snapshot by hand. It is also why [0078](0078-backup-run-report.md) heads its closing block
`Couldn't be backed up` rather than "Not backed up" — excluded files are the category a backup run
deliberately cannot report on.

Reading those rows back would have been the obvious fix and is the **worse** design. A snapshot
records what the patterns did *at the time it was taken*; the question a user is actually asking is
what the patterns do **now**. Computing from the walk means you can edit `exclude.txt` and re-run
to see the effect immediately — an edit-and-check loop a stored snapshot can never offer, however
it is read. The data is free: `walkDirs` already returns `{ files, excluded, skipped }` with the
matching pattern on every excluded record, and `tree` was two lines that kept `.files` and threw the
rest away. So the live source is both cheaper and strictly more useful, and the `#EXCLUDED` rows
stay what they are — a record inside a statement of record, for hand recovery.

The **shape** follows from [0010](0010-cli-output-conventions.md) / [0043](0043-human-first-output.md):

- **stdout is the data** — one record per line, `<path>` TAB `<pattern>`, so the stream stays
  greppable and redirectable, and `cut -f1` yields the same shape as a plain `s3cab tree`. A tab is
  the separator for the reason snapshots use one ([0004](0004-tsv-snapshot-manifests.md)): no
  quoting, no escaping, one `cut`.
- **stderr is the review** — a count per pattern, biggest first. This is what answers *"review once
  in a while what is really going on"* on a tree that drops tens of thousands of files: a dozen
  lines of pattern → count, not forty thousand paths. It mirrors the walk's existing by-type
  `Skipped …` notice rather than inventing a second idiom, and it survives a redirect (the list
  goes to the file, the tally stays on screen).
- `--json` gets the records as objects (`{ path, pattern }`), never the joined line.

## Consequences

- The volume question is smaller than it looks: the walk does not descend into an excluded
  directory, so `node_modules` is **one** record standing for everything beneath it, not thirty
  thousand. The tally says so in a parenthetical, but only when a directory is actually among the
  entries.
- `tree` now has a two-shaped result (`string[]` or `ExcludedEntry[]`) behind one registry
  `render`, which is why `renderTree` exists beside `renderLines` instead of `tree` pre-joining the
  columns itself — a machine consumer of a two-field record should get two fields.
- The empty case is announced on stderr, naming the set's `exclude.txt`. An empty result renders to
  the empty string (the honest answer for a pipe, [0043](0043-human-first-output.md)), which at a
  terminal would otherwise read as a broken run.
- If a `--explain <path>` is ever wanted anyway, note what makes it more than a filter: a path that
  is *not* excluded still needs an answer, and a path **under** an excluded directory has no record
  of its own — the walk never reached it — so it would have to be matched against the pruned
  parent rather than looked up.
