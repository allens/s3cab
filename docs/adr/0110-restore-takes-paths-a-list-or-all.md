# `restore` takes paths, a list, or `--all`

**Status:** proposed (2026-10-26). Extends [0040](0040-restore-requires-set-name.md)'s
reasoning from the set to the paths.

## Context

`restore` with no paths restores everything in the snapshot. That is its rarest job, the
replacement machine, and its largest: the whole set is downloaded, and most providers charge for
downloads. The everyday jobs, one lost file or an older version of one, always name a path.
So the shortest command is the biggest and least common one, and leaving off the path by
mistake starts it. [0040](0040-restore-requires-set-name.md) made `--set` required for `restore`
alone because restore is "the rarer, more carefully considered command": naming things costs
nothing in that moment. `git restore` refuses with no paths; restic and borg restore everything.

Between one path and everything there is no good form. Many specific paths don't fit on a
command line, and the list a user wants is usually one they already have or can make: a set's
`dirs.txt`, an edited copy of it when taking over another machine's set, or the output of a
command filtered with `grep`.

## Decision

`restore` takes paths, a list, or both together, as `delete` takes hashes; or `--all` alone:

- **paths as arguments**, one or more files or directories;
- **`--from-file <file>`**, one absolute path per line in `dirs.txt`'s format (`#` comments and
  blank lines ignored), so a set's `dirs.txt` feeds it unchanged. `-` reads the list from
  standard input, and an interactive terminal there gets the usage message, not a wait. Its paths
  are matched as typed paths are;
- **`--all`** (`-a`), the whole snapshot.

Without `--output` every form restores to the original places; with it, every form places files
by [0109](0109-restore-output-keeps-the-full-path.md)'s one rule.

- `s3cab restore --set photos` is a usage error. It lists the set's member directories, which
  are the likeliest paths to copy, and the three forms:

  ```
  s3cab restore --set photos <path>...
  s3cab restore --set photos --from-file <file>
  s3cab restore --set photos --all
  ```

- `--all` with a path or a list is a usage error: everything and these paths ask for different
  things.

**`--all`, not `--full`.** clig.dev lists `-a/--all` as a conventional flag, so it is the name a
user guesses, and `find`'s `--all` already means "don't narrow it down". "Full restore" is
backup vocabulary, but no common command-line tool spells it as a flag.

**`--from-file`, not rsync's `--files-from`.** `delete` already reads its list with
`--from-file`; one meaning gets one name. A bare `-` path argument for standard input was the
other option, but one flag then covers both the file and the pipe.

## Consequences

- The disaster-recovery commands gain `--all`: [guide/restore.md](../../guide/restore.md), the
  README, `restore`'s examples in `src/commands.mjs`, the hint `src/lib/walk.mjs` prints for a
  `dirs.txt` path that isn't absolute here (`restore --set … --output <folder>`), and the release
  workflow's smoke restore (`.github/workflows/release.yml`).
- The stdin path list in [proposals/misc.md](../../proposals/misc.md) is this decision's
  `--from-file -`, so that entry goes.
