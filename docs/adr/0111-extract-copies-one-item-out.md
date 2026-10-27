# `extract` copies one file or folder out, by its own name

**Status:** accepted & implemented (2026-10-26). Beside
[0109](0109-restore-output-keeps-the-full-path.md), which it leaves as it is.

## Context

`restore` puts files back where they were, or at their full path under `--output`
([0109](0109-restore-output-keeps-the-full-path.md)). That suits rebuilding a machine, but the
everyday "give me last month's `report.pdf` to look at" lands at
`<dir>\C\Users\me\Documents\report.pdf`. Giving `restore` a second layout for this was
considered and rejected in 0109: `--output` would lay files out differently depending on how
they were named. Copying one item out to a place of the user's choosing is a different job, so
it gets its own command.

## Decision

```
s3cab extract --set <set> [--snapshot <name>] <path> [--output <folder>] [--name <name>] [--overwrite]
```

- **One `<path>` per run**, a file or a folder, as backed up and matched as `restore` matches
  it. Several items take several runs; a second path, or one that isn't a full path, is a
  usage error.
- **`--output` is the folder to put it in**, the current folder by default. It means what it
  means for `restore`: where, never what it's called.
- **The item keeps its own last name**, a drive root its letter, unless `--name` gives one.
  Inside a folder, everything keeps its own name. A name with a separator, `.` or `..` is
  refused, and so is a missing one: `/` has no name, so it needs `--name`.
- **An existing `<output>/<name>` is refused before the snapshot is read**, unlike `restore`'s
  skip-and-list. There, existing files are the gaps a restore fills; here, skipping would hand
  the user the old file as if it were the extracted one. With the current folder as the
  default, the clash is usually the live file itself. The message offers `--name`, then another
  `--output`, then `--overwrite` last, each as a command that keeps the rest of the user's line.
- **Everything else is `restore`'s**: `--overwrite` writes over each file the backup holds, so
  a folder already there keeps any others (not cleared first: `extract` deletes nothing); a
  file it can't produce is reported while the rest carry on; the report and the exit codes are
  the same; and any snapshot extracts on any machine, as `restore --output` does.

**s3cab never invents a name.** Renaming on a clash (`Photos 2`) was rejected, as in 0109: the
numbers say nothing about which copy is which.

## Consequences

- `restore`'s write loop moves from `src/commands/restore.mjs` into `src/lib/restore.mjs`
  (`restoreTargets`), with choosing the snapshot and selecting its paths, so both commands
  share it.
- [guide/restore.md](../../guide/restore.md) gains a section, and the README's command table a
  row. The `extract` entry in `proposals/misc.md` goes.
