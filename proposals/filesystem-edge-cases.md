# Filesystem edge cases

Epic: what the walk does when the local filesystem isn't a plain local filesystem — cloud-sync
placeholders, reparse points, encrypted mounts, and the classification calls that decide whether
a subtree is descended, skipped or read. Distinct from
[performance.md](performance.md) (speed and memory on trees that *are* ordinary) and from
[engine-robustness.md](engine-robustness.md), which is the S3/remote side.

Both entries below were measured on 2026-08-11 against a real OneDrive install (`D:\OneDrive`,
vault unlocked for the test). They surfaced from one investigation but are independent: different
mechanism, different code, different fix.

- **A first backup of a cloud-sync tree silently hydrates every online-only file.** Windows
  Files On-Demand (OneDrive, and the same shape in Dropbox/Google Drive) leaves a *dehydrated
  placeholder*: full logical size, zero bytes on disk, contents fetched on first read. The walk
  keeps them and `fileProps` opens them to hash, so `backup` over a OneDrive folder downloads the
  entire cloud tree onto local disk — with no warning, no error, and no way to see it coming
  short of watching free space fall. On a drive smaller than the cloud account it fills the disk
  and the run dies mid-way on a hydration failure.
  - **Measured** against real OneDrive, one 262,144-byte file cycled through `attrib +U -P` and
    back. Hydrated `blocks=512` → dehydrated `blocks=0` → after a plain `readFileSync`
    `blocks=512` again, attributes `0x501620`
    (`RECALL_ON_DATA_ACCESS|OFFLINE|UNPINNED|REPARSE_POINT`) → `0x420`. The read took 174ms and
    reported nothing.
  - **Nothing in the walk catches it, by design of libuv's classifier.** Every synced OneDrive
    directory carries `FILE_ATTRIBUTE_REPARSE_POINT` (`0x80410`), but libuv discriminates on the
    reparse *tag*, not the attribute — cloud folders resolve to `Directory` and cloud files to
    `File`, from both `readdir` and `lstat`. So the skip path that catches symlinks never fires,
    which is correct (they *are* files) and is exactly why this is invisible.
  - **Steady state is already safe; this is first-run only.** `mtime` is byte-identical across
    hydrated → dehydrated → rehydrated (only `ctime` moves), and `fileProps` reuses a stored hash
    on matching `size` *and* `mtime` without opening the file. So the workaround works today: back
    up a chunk, free up space again, and the next run never re-reads it. Worth documenting
    regardless of whether the detection below gets built.
  - **Storage Sense is not a backstop.** Its cloud-content rule defaults to *Never*, it is
    scheduled/low-space housekeeping rather than backpressure, and its heuristic is "not opened
    for N days" — a backup has just opened everything, making the whole tree maximally ineligible
    for reclamation. It works against this case rather than for it.
  - **Proposed fix — detect and route through the existing skip channel**, so a first OneDrive
    backup prints `Skipped 48,213 items that can't be backed up: 48,213 Online-Only Files`
    instead of quietly pulling the tree. The `skipped` → `#SKIPPED` → stderr summary →
    `compare` Skipped list machinery already exists and this is the same kind of entry: present
    in the tree, not backed up, said out loud. Opt in with a flag when the cloud-only copy is the
    one you actually want off-vendor.
  - **Detection is one predicate on the `lstat` `fileProps` already takes** — no new syscall on
    the hot path: `size >= 4096 && blocks === 0`. **The size floor is load-bearing, not a fudge:**
    NTFS stores small files resident in the MFT with no allocated clusters, so a naive
    `blocks === 0` misclassifies every tiny file as a placeholder. Measured on this box:
    1/50/100/500 bytes all report `blocks=0`; 700 → 1, 900 → 8, 1500 → 8, 5000 → 16. 4KB clears
    the MFT-resident ceiling (~700 bytes) and sits below any download worth warning about — a
    sub-cluster placeholder costs nothing to hydrate, so there is no reason to catch it.
  - **Two things to settle before building.** The signal is not vendor-specific — a fully-sparse
    file and any other provider's placeholder look identical — which argues for naming it by what
    is observable rather than "OneDrive"; and `blocks` means something different on ext4/APFS, so
    the predicate wants a look on non-Windows before it is trusted there. The opt-in flag is CLI
    surface, so it goes through [cli-design](../.claude/skills/cli-design/) first.
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
  [misc.md](misc.md) 2026-08-11 — same theme as the two entries above.)_
