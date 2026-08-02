# The walk materializes the full file set up front; it is not streamed into hashing

**Status:** accepted

`walkSet(set) → { files, excluded }` in [`src/lib/walk.mjs`](../../src/lib/walk.mjs) walks every
member directory to completion and returns the **whole** kept-file list as a materialized array,
which `snapshot` then feeds into the hashing pipeline. The walk is deliberately **eager**: it is
not refactored into a streaming `walk → hash` pipeline that starts hashing before the walk
finishes.

## Why

The three stages of a snapshot/backup cost wildly different amounts:

- **Walk** — `readdirSync` rips through tens of thousands of directory entries in well under a
  second. It does no per-file I/O beyond the `Dirent` already in hand — bar one `lstat` for
  an entry whose type the filesystem didn't report (`resolveFileType` in
  [`walk.mjs`](../../src/lib/walk.mjs); zero calls on NTFS, APFS, ext4, btrfs and modern XFS,
  and only on NFS/FUSE mounts does it amount to a per-file cost).
- **Hash** — each kept file pays a full SHA-256 read of its contents.
- **Upload** — each *changed* file pays an S3 PUT (network round-trip, seconds at scale).

The walk is cheaper than hashing by orders of magnitude, and cheaper than upload by more still.
So overlapping the walk with hashing — the only thing streaming would buy — saves a fraction of
a second against stages that run for minutes. There is no bottleneck there to relieve.

Slurping the full set up front is a **feature, not a cost**:

- You get the complete, validated work set before spending a single expensive SHA-256 or PUT —
  including the cross-directory overlap/duplicate check ([`walk.mjs`](../../src/lib/walk.mjs),
  which detects one member directory nested under another). Surprises surface at walk time, not
  mid-hash.
- Progress reporting has a **real denominator** ("hashing 1,234 of 50,000") from the first file.
  A streaming walk would have to either drop the denominator or add a redundant two-phase count
  pass to recover it — paying twice to walk in order to save the one walk.

The memory saved by streaming is trivial — a path list plus the overlap-check `Set` is tens of
MB for a hundred-thousand-file tree, on a machine backing up a multi-GB archive. Trading the
up-front work set and the progress denominator for that is a bad deal.

## Consequences

- The walk stays eager; the write side (`writeSnapshot`, which accepts `files` as an
  (async) iterable per [0028](0028-snapshot-writer-owns-the-grammar.md)) is already
  streaming-*capable*, so this decision is purely about the walk not being made lazy.
- This is recorded because it has surfaced as a "Stream the walk instead of slurping"
  performance idea more than once across sessions; pinning it here is the cheapest way to stop
  re-litigating it. An `/improve` or perf pass should treat eager walking as intentional, not an
  oversight — the genuinely open hot-path perf item is **parallel hashing** (a small in-flight
  `prop()` pool), which attacks the stage that actually dominates. See
  [proposals/performance.md](../../proposals/performance.md).
