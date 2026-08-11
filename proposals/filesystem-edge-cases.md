# Filesystem edge cases

Epic: what the walk does when the local filesystem isn't a plain local filesystem — cloud-sync
placeholders, reparse points, encrypted mounts, and the classification calls that decide whether
a subtree is descended, skipped or read. Distinct from
[performance.md](performance.md) (speed and memory on trees that *are* ordinary) and from
[engine-robustness.md](engine-robustness.md), which is the S3/remote side.

The entry below was measured on 2026-08-11 against a real OneDrive install (`D:\OneDrive`, vault
unlocked for the test). It came out of the same investigation as the online-only-files problem —
now built and settled in [ADR-0081](../docs/adr/0081-online-only-files-skipped.md) — but is
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
