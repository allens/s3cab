# `restore --output` keeps each file's full original path

**Status:** accepted & implemented (2026-10-26). Replaces `reroot`'s last-name layout and both
of its refusals; [0071](0071-snapshot-paths-absolute-native.md)'s decision (snapshot paths stay
absolute and OS-native) is untouched.

## Context

`restore --output <dir>` places each member directory under its last name: `C:\Users\me\Photos`
restores to `<dir>\Photos`, a drive root to its letter, `/` straight into `<dir>`. Two member
directories with the same last name (`C:\a\Photos`, `D:\b\Photos`) both want `<dir>\Photos`, so
restore refuses them, and refuses `/` beside any other member directory, before writing anything.
`setup` accepts such a set, so the user learns of it only when restoring. The case that meets
it is the rarest and worst-timed: everything restored onto a replacement machine whose layout
differs, where `--output` brings every member directory back into one folder.

The command-line backup tools users know keep the full path under the target, so this case can't
arise: restic (`/tmp/restore/home/user/work/foo`), borg (into the working directory), Duplicati
(drive letter included). Kopia avoids it by making each snapshot one folder.

## Decision

`--output <dir>` places each file at its full original path under `<dir>`, the root turned into
a folder:

- a drive path keeps its letter without the colon, upper case, since Windows reads `c:` and
  `C:` as one drive: `C:\Users\me\a.jpg` → `<dir>\C\Users\me\a.jpg`;
- a network share goes under `UNC`, as Windows' own long-path form does: `\\nas\photos\a.jpg` →
  `<dir>\UNC\nas\photos\a.jpg`. A drive folder is one letter, so the two can't collide;
- a device path lands where its plain form does: `\\?\C:\a.jpg` as `C:\a.jpg`;
- a POSIX path keeps its segments: `/home/me/a.jpg` → `<dir>/home/me/a.jpg`.

The rule is the same however the paths were named ([0110](0110-restore-takes-paths-a-list-or-all.md)).
Two different paths always land in two different places, and where a file lands depends on its
own path alone, not on what else the set holds or the run restores. Both refusals go. The output
is rebuilt with the restoring platform's separator, as now.

Files already in the way are handled as they are when restoring in place: an existing file is
skipped and listed, and `--overwrite` replaces it. `<dir>` need not be empty, so an interrupted
restore is finished by running it again.

## Considered options

- **Keep the last-name layout, and warn at `setup`.** Treats the symptom: `dirs.txt` can be
  edited without `setup`, and the restore still refuses on the day it is needed.
- **The last name for paths typed as arguments, the full path for a list or the whole set.**
  Each form fits its usual job (one file to look at, a machine to rebuild), but `--output` would
  lay files out differently depending on how they were named, which nothing on the command line
  shows. Copying one item out under a name the user picks is a different job from restoring.
- **Rename on a clash (`Photos`, `Photos 2`).** Time Machine's and File History's "keep both",
  but there the user sees the rename in a dialog. On a command line the numbers say nothing
  about which folder is which, and they depend on order.
- **Shortest unique tail** (`<dir>\a\Photos`, `<dir>\b\Photos`, the whole path only where
  needed). Short in the common case, but where one folder lands depends on the others in the
  restore, so adding a member directory moves it.
- **`<dir>` must be new or empty.** Stops two restores mixing in one folder, but the full path
  already keeps different sources apart, and it would refuse to finish an interrupted restore,
  the largest one most of all.

## Consequences

- **Deeper folders.** A one-directory set restores to `<dir>\C\Users\me\Photos`, not
  `<dir>\Photos`. On a replacement machine that shows where each folder came from, which is
  what moving it into place and editing `dirs.txt` need.
- **One file restored to compare it lands deep** (`<dir>\C\Users\me\Photos\report.pdf`).
  Restore can print where it put it; copying one item out to a place of the user's choosing is
  a separate decision, additive to this one.
- **A POSIX folder name holding `\` is refused on a Windows output**, wherever it is in the
  path: Windows would read it as a separator. Above the member directory that is new, since
  those folders used to be dropped, so a Linux set under `/home/u/we\ird/` restores with
  `--output` only off Windows.
- **Every path grows by `<dir>`'s length.** One already near Windows' 260-character limit can
  pass it, which some Windows programs still handle badly. Not measured.
- `reroot` (`src/lib/restore.mjs`) loses the last-name and drive-letter rules and both
  refusals; `--output`'s help line, [guide/restore.md](../../guide/restore.md)'s "Restoring
  somewhere else", [docs/design/backup.md](../design/backup.md)'s `restore` section, and the
  `proposals/bugs.md` entry on `setup` accepting same-name directories change or go.
