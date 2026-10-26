# Filesystem edge cases

Epic: what the walk does when the local filesystem isn't a plain local filesystem — cloud-sync
placeholders, reparse points, encrypted mounts, and the classification calls that decide whether
a subtree is descended, skipped or read. Distinct from
[performance.md](performance.md) (speed and memory on trees that *are* ordinary) and from
[engine-robustness.md](engine-robustness.md), which is the S3/remote side.

How the walk treats a OneDrive Personal Vault is measured and recorded on `recordUninspectable` in
[src/lib/walk.mjs](../src/lib/walk.mjs), and excluding it is in
[guide/exclude.md](../guide/exclude.md). Two questions about it are still open.

- **A Personal Vault can't be opted _in_.** Someone who wants it backed up — plausibly their most
  valuable data, and the copy Microsoft doesn't hold — cannot. The walk can't read the link, and
  naming the vault as a member directory is refused: it is a junction onto a volume GUID with no
  mount point, which `stat` calls a directory and `readdir` lists, while `realpathSync.native`
  (`GetFinalPathNameByHandle`) answers `ENOENT` (measured), and `setup` says so truthfully.
  Whether that is worth solving is a separate decision.
- **Does a translated Windows change the vault's name on disk?** Explorer shows it as
  *Coffre-fort personnel* on French Windows. The guide says to exclude it by the name its error
  row shows, which is right either way, but only an English install has been measured.
- **Windows long paths** (`\\?\` prefix, >260 chars) and reserved device names (`CON`,
  `NUL`…) — a photo/video archive will eventually hit one. _(Moved here from
  [misc.md](misc.md) 2026-08-11 — same theme as the entry above.)_
