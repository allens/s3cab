# Filesystem edge cases

Epic: what the walk does when the local filesystem isn't a plain local filesystem — cloud-sync
placeholders, reparse points, encrypted mounts, and the classification calls that decide whether
a subtree is descended, skipped or read. Distinct from
[performance.md](performance.md) (speed and memory on trees that *are* ordinary) and from
[engine-robustness.md](engine-robustness.md), which is the S3/remote side.

The entry below was measured on 2026-08-11 against a real OneDrive install (`D:\OneDrive`, vault
unlocked for the test). It came out of the same investigation as the online-only-files problem —
now settled in [ADR-0095](../docs/adr/0095-online-only-files-read-like-any-other.md) — but is
independent of it: different mechanism, different code, different fix.

- **An unlocked OneDrive Personal Vault is skipped — correctly, but by coincidence.** Confirmed
  end-to-end with the real `walkDirs`, vault unlocked (74 items inside: 33 directories, 41 files),
  scoped by excluding the 29 sibling top-level directories so the vault was the walk's only
  descent candidate. Result: `Skipped 1 item that can't be backed up: 1 Symbolic Link`, one record
  `fileType=Symbolic Link reason=Unsupported file type path=D:\OneDrive\Personal Vault`, and
  **zero files kept from inside the vault**. The only vault-related thing backed up is
  `Personal Vault.lnk` (1,482 bytes, a shortcut holding a target path, no vault content), present
  in both lock states. **The behaviour is right; what follows is about how little of that is
  deliberate.**
  - **`resolveFileType`'s two paths disagree about the vault.** The `Dirent` reports it a symbolic
    link, `lstat` reports it a **directory** (`attrs=0x180412`, `LinkType=Junction`, target
    `Volume{…}\VaultData`). Only the dirent answer is used — `resolveFileType` falls back to
    `lstat` solely when the dirent says `UNKNOWN` — so the walk calls it `Symbolic Link` and never
    descends. **Correct today, but resting on which of two disagreeing sources is consulted
    first:** on a filesystem that doesn't classify dirents (the NFS/FUSE case `resolveFileType`
    exists for), the fallback would call it a directory and walk straight into an unlocked vault.
    Nothing about the skip knows it is a vault, or that it is sensitive — it is skipped because a
    junction happens to be an unsupported type. Worth a deliberate decision, and a test, rather
    than leaving it to that ordering.
  - **The skip message is the weak part, and the fixable one.** A vault holding 74 items reports
    as `1 Symbolic Link`, and learning *which* path means decompressing the snapshot. Grouping by
    type is right for a thousand sockets and wrong here — this is the skip a user most needs
    named. Worth reading against [ADR-0078](../docs/adr/0078-backup-run-report.md), which already
    argues a run should let the user answer "what *was* that symlink?".
  - **Naming the vault as a set member directory fails rather than walking it.** `lstatSync`/
    `statSync` both report a directory and `readdirSync` lists it fine, but **`realpathSync.native`
    throws `ENOENT`**: the junction targets a volume GUID with no ordinary mount point, so
    `GetFinalPathNameByHandle` cannot resolve it. (Node's JS `realpathSync` disagrees — it returns
    the path unchanged. Only the `.native` variant, the one CLAUDE.md mandates and both capture
    points use, fails.) So the vault cannot be adopted as a set root at all, which is the safe
    outcome. A locked vault has no such path, so `setup` rejects it for real; the misleading
    message below was reachable only with the vault open.
    - **Both messages fixed 2026-08-11 — the refusal itself is unchanged.** `setup`'s
      `resolveDirectories` mapped the `ENOENT` to `Directory not found: <path>`, the one thing
      that is definitely untrue of a folder you can list, and `walkDirs`' `realpathSync.native(dir)`
      had no `try`/`catch` at all, so a set that somehow carried the path failed with a raw
      `ENOENT` and no ADR-0030 shaping. Both now `stat` the path to see which of three different
      things that `ENOENT` means — nothing there, a non-directory, or a real directory the OS
      won't canonicalize — and say the true one. Neither is vault-specific: any path the OS won't
      canonicalize lands there.
  - **There is also no way to opt _in_ — an open question, not something being designed here.**
    Someone who wants the vault backed up — plausibly their most valuable data, and the copy
    Microsoft doesn't hold — cannot. They are now told that truthfully rather than
    `Directory not found:`, but the answer is still no. Whether that is worth solving is a
    separate decision.
  - A name-based exclude pattern is not the answer either — "Personal Vault" is localized (French
    Windows: *Coffre-fort personnel*), so such a pattern would silently protect nothing on a
    non-English install while looking like it did.
- **Windows long paths** (`\\?\` prefix, >260 chars) and reserved device names (`CON`,
  `NUL`…) — a photo/video archive will eventually hit one. _(Moved here from
  [misc.md](misc.md) 2026-08-11 — same theme as the entry above.)_
- **Replace `#SKIPPED`: record every link in a `link` row, never follow one, and warn about a
  link that leads out of the backup.** Decided 2026-10-09: `#SKIPPED` goes. It records an event
  (what was left out, and why) but not the link's target, so it can't say what the link was. A
  `link` row records the link itself, its target as written; its layout is in
  [snapshot-format.md](snapshot-format.md). Links decided 2026-10-11, file and folder alike:

  | Entry | Proposed |
  | --- | --- |
  | Link to a file or folder | `link` only, never followed; warned about if its target is outside every member directory |
  | Link that is broken, loops, or leads to a pipe, socket or device | `link` only, no warning |
  | Link to a link | judged by where the chain ends |
  | FIFO, socket, device | no row |
  | Entry that vanished between listing and checking | no row |
  | Entry that couldn't be checked for any other reason | `#error` |

  - **Never followed, because a link can lead anywhere**: a drive root, a share, the Personal
    Vault, or arbitrary files the user never chose to back up. A folder link can also loop, and
    on Windows the profile's compatibility junctions refuse listing: measured 2026-10-09,
    `readdirSync` on `Application Data`, `Local Settings` and `Documents\My Pictures` throws
    `EPERM` while their targets list fine. Content the user wants is backed up by adding its
    folder to the set. A member directory that is itself a link is resolved and walked, as now.
    Rejected: following file links. It doubled a non-link restore for every link into the
    backup, and put two rows at one path.
  - **A link that leads out of the backup is a warning, not an error.** At the end of the walk,
    one loud warning lists each link whose target is a file or folder outside every member
    directory, or can't be resolved, one per line with its target, and the run still succeeds.
    An `#error` is too harsh for a link saved faithfully as itself, but silence is wrong too: a
    folder link can hide a whole tree, and a grouped `1 Symbolic Link` is how the vault above
    went unnoticed. The warning's fix is adding the target's folder to the set. A link whose
    target is inside a member directory isn't listed: its target is saved under its real path,
    and adding it would fail as overlapping directories. An exclude pattern drops the link's
    row and its warning. A broken link, a loop and a link to `/dev/null` lose nothing, so they
    stay quiet.
  - **Restore doesn't recreate links yet**; that is a future feature, and the spec allows for it:
    a `link` row records enough to make the link.
  - **The check** runs once per link, so the cost is negligible. `stat` (which follows the link)
    tells a missing target from a present one and says whether it ends at a file or folder,
    then `realpathSync.native`, then the containment test restore already uses
    (`hay === n || hay.startsWith(n + sep)` after `preparePath`). The walk handles one member
    directory at a time, so it needs the whole member list passed in. A target inside a member
    directory but excluded there counts as inside: that is a target the user chose not to back
    up, and the one case that would lose real content, git-annex with `.git` excluded, isn't
    worth the patterns run on every target.
  - **`stat` must come before `realpath`.** Measured 2026-10-09: `realpathSync.native` throws
    `ENOENT` both for a junction whose target is missing (`Documents\My Music` on a machine with
    no `Music` folder) and for the unlocked Personal Vault above, whose target exists but can't
    be canonicalized. Reading every `ENOENT` as "missing" drops the vault silently, which is the
    case this change exists to catch. In the warning the vault is named by path, which also
    answers that entry's complaint about the skip message.
  - **Windows profile junctions.** Node sees junctions as symlinks, and every profile has the
    same compatibility set: 10 at the profile root (`Application Data`, `Cookies`,
    `Start Menu`, …) and `My Music`, `My Pictures`, `My Videos` in `Documents`. The ten all point
    inside the profile, so a profile backup warns about none. A `Documents`-only set lists the
    three `My …` ones when their targets exist, which is correct: those folders aren't backed up.
    Rejected: adding them to the starter `exclude.txt`. A pattern can't say "only if it's a
    link", so `Cookies/` or `Templates/` would silently drop a real folder of that name at the
    top of a member directory.
  - **Exclude patterns must apply to links.** Today the walk tests them only against files and
    directories. A pattern ending in `/` matches a link whose target is a folder, so `My Music/`
    silences one; a broken link has no target, so only a pattern without `/` matches it. Not
    git's rule, where `foo/` never matches a link: the spec names the difference.
  - **What changes:** supersede [ADR-0070](../docs/adr/0070-snapshot-restore-fidelity.md)'s
    `#SKIPPED` recording (its "a symlink is never followed" stands), and the skipped parts of
    [ADR-0078](../docs/adr/0078-backup-run-report.md). Drop the `#SKIPPED` line type from
    [guide/format.md](../guide/format.md), which means reseeding the clean-room golden set.
    Remove the reader branch, the writer, `compareSnapshots`' skipped reconciliation, and the
    skipped sections and counts in `render.mjs`, `snapshot` and `backup`. The no-row case
    [PR #388](https://github.com/allens/s3cab/pull/388) added for a skipped name with a line
    break goes too: a link's path and target are refused like any path
    ([snapshot-format.md](snapshot-format.md)). In
    [cleanroom-fixtures.md](cleanroom-fixtures.md), the dangling-symlink, line-break and FIFO
    gaps change shape.
