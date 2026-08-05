# The walk does not `stat` the files it finds

**Status:** accepted

The walk ([`src/lib/walk.mjs`](../../src/lib/walk.mjs)) yields **paths**. It does not call
`lstat`/`stat` on the files it keeps, and must not be changed to — not to collect sizes, not to
collect mtimes, not to collect inode numbers. The one exception is `resolveFileType`'s fallback
for an entry whose type the filesystem didn't report in the directory listing
([0029](0029-eager-walk-not-streamed.md)), which fires per *unclassifiable* entry and on the
mainstream filesystems never fires at all.

## Why

The cost is real and lopsided. On a representative photo/video set the walk takes **~7s** as it
stands, and statting each file was put at **a minute or more** — Windows pays for every `lstat`
with a
`NtCreateFile`/query/close round trip through the whole filter-driver stack (Defender, sync
agents, EDR), where Linux pays a `statx` against a warm dentry cache and no handle at all. So a
change that is a nuisance on one platform is the dominant cost on another. (The irony: on
Windows the directory scan *already* returns size and mtime for every entry and libuv discards
them, while on Linux `getdents64` genuinely doesn't carry them. The platform where it is
expensive is the one where the data is in hand but unreachable from Node.)

That cost would buy less than it appears to, because **a snapshot run already pays one `lstat`
per kept file** — in `fileProps` ([`file-props.mjs`](../../src/lib/file-props.mjs)), which needs
size and mtime for the reuse check anyway. Statting in the walk therefore doesn't *add* a pass so
much as move one earlier, and only if the result is threaded through; done naively it is a second
`lstat` per file, and a `backup` (which already re-stats upload candidates in the drift guard,
`fileChange`) would reach three.

Each benefit that motivated the idea turned out to be served more cheaply, or not to be worth its
price:

- **A byte-accurate progress denominator.** Served for free by the previous snapshot, which the
  run has already read for its hash lookup and which records a size for every file it holds —
  see [0076](0076-one-progress-line-driven-by-a-clock.md) and `withProgress` in
  [`snapshot.mjs`](../../src/lib/snapshot.mjs). That covers every run but the first, at one Map
  lookup per file and no syscalls.
- **Work planning and adaptive concurrency** (the two file populations want opposite
  concurrency). Same source, same cost: the baseline's sizes.
- **Rename/move detection** via `(dev, ino)`, so a moved multi-GB video isn't re-hashed. This was
  the only benefit that genuinely *needed* the stat — and it doesn't pay. A rename today costs
  exactly one local re-hash and **nothing else**: the content hash is already in the store, so
  `uploadObjects` skips it, and it never even reaches the drift guard. Zero network, and a
  reorganisation is a rare one-shot event, after which the new paths are back in the lookup. That
  is a poor return on adding a column to the snapshot grammar
  ([0004](0004-tsv-snapshot-manifests.md)) and [guide/format.md](../../guide/format.md), the
  recovery contract — plus `{ bigint: true }` stats, since NTFS/ReFS file IDs can exceed 2^53.
- **Fail-fast on unreadable files** before any hashing. A narrower fix exists if it is ever
  wanted; it does not justify a per-file pass on its own.

Against that sits a correctness hazard that is worse than the cost. Today the gap between the
`lstat` and the hash read is microseconds. Statting in the walk stretches it to minutes or hours
on a large set, so a file that changes in between gets recorded with a **walk-time mtime and
hash-time content** — and because the reuse check is size + mtime, the *next* run reads it as
unchanged and never re-hashes it. Silent, persistent, and self-healing only if the file happens
to change again. For a backup tool that is the wrong trade at any price.

## Consequences

- `walkSet`/`walkDirs` keep returning paths. Anything wanting file metadata takes it from
  `fileProps` at hash time, or from the previous snapshot's entries, which are already in memory.
- **A tempting shortcut that is unsound here:** indexing the previous snapshot by `(size, mtime)`
  to detect renames needs no stat and no format change, but two files sharing a size and a
  millisecond mtime is entirely reachable (a `cp -p` batch, one archive extraction, any two empty
  files). In a content-addressed store a wrong hash means restoring the wrong bytes under a path.
  `(dev, ino)` is the only sound key, and that is the one needing the format change.
- Recorded because "make the walk `stat`" has the same recurring shape as the streaming idea
  [0029](0029-eager-walk-not-streamed.md) was written to stop re-litigating, and it arrives
  looking like an easy win. A perf pass should treat the stat-free walk as intentional. The open
  hot-path item remains **parallel hashing** ([proposals/performance.md](../../proposals/performance.md)),
  which attacks the stage that actually dominates.
- If a future need does justify it, the threading is the whole design problem: the size must
  reach `fileProps` without a second syscall, and the staleness above must be closed by
  re-statting the files actually being hashed (cheap — those are being read in full anyway).
