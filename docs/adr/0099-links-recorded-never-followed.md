# Every link gets a `link` row, is never followed, and is warned about if it leads out of the backup

**Status:** accepted & implemented (proposed 2026-10-11); mostly superseded by
[0103](0103-row-marks-and-unrecorded-links.md): links are no longer recorded, and one leading out
of the backup is an `#error`, not a warning; "never followed", the `stat`-before-`realpath` check
and the profile junctions stand. Partly supersedes
[0070](0070-snapshot-restore-fidelity.md) (its `#SKIPPED` recording; "a symlink is never
followed" stands) and the skipped parts of [0078](0078-backup-run-report.md) (§3, and the
`Skipped` count in §4's `Couldn't be backed up` block). The `link` row's layout is
[0098](0098-snapshot-row-layout.md); refusing a tab, CR or LF in a link is
[0100](0100-tab-cr-lf-refused-or-spelled-out.md).

## Context

`#SKIPPED` records an event (what was left out, and why) but not the link's target, so it can't
say what the link was. Grouped by type, it also hid the one skip a user most needed named:
measured 2026-08-11, an unlocked OneDrive Personal Vault holding 74 items reported as
`1 Symbolic Link`, and naming the path meant decompressing the snapshot.

## Decision

`#SKIPPED` goes. A `link` row records the link itself, its target as written.

| Entry | Recorded |
| --- | --- |
| Link to a file or folder | `link` only, never followed; warned about if its target is outside every member directory |
| Link that is broken, loops, or leads to a pipe, socket or device | `link` only, no warning |
| Link to a link | judged by where the chain ends |
| FIFO, socket, device | no row |
| Entry that vanished between listing and checking | no row |
| Entry that couldn't be checked for any other reason | `#error` |

- **Never followed, because a link can lead anywhere**: a drive root, a share, the Personal
  Vault, or arbitrary files the user never chose to back up. A folder link can also loop, and on
  Windows the profile's compatibility junctions refuse listing: measured 2026-10-09,
  `readdirSync` on `Application Data`, `Local Settings` and `Documents\My Pictures` throws
  `EPERM` while their targets list fine. Content the user wants is backed up by adding its folder
  to the set. **A member directory that is itself a link is resolved and walked**, as now.
- **A `link` row's path takes a trailing separator when its target is a folder**, which the
  walk's `stat` already knows; a broken link takes none. Junction or symlink isn't recorded: a
  restorer that recreates links on Windows chooses, and the spec says so. A link is never
  followed, so no path has two rows.
- **A link that leads out of the backup is a warning, not an error.** At the end of the walk, one
  loud warning lists each link whose target is a file or folder outside every member directory,
  or can't be resolved, one per line with its target, and the run still succeeds. An `#error` is
  too harsh for a link saved faithfully as itself, but silence is wrong too: a folder link can
  hide a whole tree. The warning's fix is adding the target's folder to the set.
  - A link whose target is inside a member directory isn't listed: its target is saved under its
    real path, and adding it would fail as overlapping directories.
  - A broken link, a loop and a link to `/dev/null` lose nothing, so they stay quiet.
  - The Personal Vault is named in the warning by its path.
- **Exclude patterns apply to links.** An excluded link becomes an `#excluded` row, like any
  excluded entry, with no warning. A pattern ending in `/` matches a link whose target is a
  folder, so `My Music/` silences one; a broken link has no target, so only a pattern without `/`
  matches it. Not git's rule, where `foo/` never matches a link: the spec names the difference.
- **Restore doesn't recreate links yet.** That is a future feature, and the spec allows for it: a
  `link` row records the target and, by its trailing separator, whether it is a folder.

### The check

It runs once per link, so the cost is negligible. `stat` (which follows the link) tells a missing
target from a present one and says whether it ends at a file or folder, then
`realpathSync.native`, then the containment test in restore's `pathMatcher`, which `normalize`s
both sides (case folded for a Windows-shaped path) and joins on `/`. The walk handles one member
directory at a time, so it needs the whole member list passed in.

**`stat` must come before `realpath`.** Measured 2026-10-09: `realpathSync.native` throws
`ENOENT` both for a junction whose target is missing (`Documents\My Music` on a machine with no
`Music` folder) and for the unlocked Personal Vault, whose target exists but can't be
canonicalized. Reading every `ENOENT` as "missing" drops the vault silently, which is the case
this change exists to catch.

**A target inside a member directory but excluded there counts as inside**: that is a target the
user chose not to back up, and the one case that would lose real content, git-annex with `.git`
excluded, isn't worth the patterns run on every target.

### Windows profile junctions

Node sees junctions as symlinks, and every profile has the same compatibility set: 10 at the
profile root (`Application Data`, `Cookies`, `Start Menu`, …) and `My Music`, `My Pictures`,
`My Videos` in `Documents`. The ten all point inside the profile, so a profile backup warns about
none. A `Documents`-only set lists the three `My …` ones when their targets exist, which is
correct: those folders aren't backed up.

## Considered and rejected

- **Following file links.** It doubled a non-link restore for every link into the backup, and put
  two rows at one path.
- **Adding the profile junctions to the starter `exclude.txt`.** A pattern can't say "only if
  it's a link", so `Cookies/` or `Templates/` would silently drop a real folder of that name at
  the top of a member directory.

## Consequences

- The `#SKIPPED` reader branch and writer go, as do `compareSnapshots`' skipped reconciliation
  and the skipped sections and counts in `render.mjs`, `snapshot` and `backup`. `compare` reads
  `link` rows so a link isn't reported deleted.
- The no-row case [PR #388](https://github.com/allens/s3cab/pull/388) added for a skipped name
  with a line break goes too: a link's path and target are refused like any path (0100).
- [guide/format.md](../../guide/format.md) loses the `#SKIPPED` line type, so the clean-room
  golden set is reseeded, and the clean-room fixtures' dangling-symlink, line-break and FIFO gaps
  change shape.
