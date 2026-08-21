# TSV snapshot files

**Status:** accepted

_(The term "manifest" was retired in favour of "snapshot file"; the filename is kept for stable links.)_

Snapshots are tab-separated values. Fixed-width fields first (`hash` → `size` → `mtime`),
the variable-length `path` **last**, so the left edge stays aligned and the ragged part is
pushed right. Hashes are lowercase hex. (The format spec is the user-facing
[guide/format.md](../../guide/format.md); [src/lib/snapshot-file.mjs](../../src/lib/snapshot-file.mjs)
implements it.)

_(Foundational design principle #4 — flows directly from [0002](0002-no-lock-in-hard-constraint.md).)_

## Why

- **Editor-readable** — fixed-width leading columns scan cleanly even unaligned.
- **Opens cleanly in Excel** (an "open enough" standard) → instant sort/filter/pivot over a
  backup snapshot file. (Caveat: don't let Excel re-save and mangle it.)
- **TSV > CSV > JSON** for this job: tabs almost never occur in real paths, so we avoid CSV's
  comma-quoting *and* JSON's escaping — notably JSON would force escaping every Windows
  backslash (`C:\\Users\\...`). Less escaping = more directly recoverable.

## Considered options

- **base64url hashes** (43 chars vs 64) — an abandoned space-saving experiment. Dropped: the
  gain is negligible once the snapshot file is zstd-compressed, and hex is more recognizable and
  hand-recoverable.

## Consequences

**Edge case, since closed**: a path containing a literal tab or newline would break a snapshot
file line. Resolved by [0073](0073-refuse-tab-newline-paths.md) — such paths are rejected.
