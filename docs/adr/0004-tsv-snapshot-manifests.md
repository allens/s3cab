# TSV snapshot manifests

Snapshots are tab-separated values. Fixed-width fields first (`hash` → `size` → `mtime`),
the variable-length `path` **last**, so the left edge stays aligned and the ragged part is
pushed right. Hashes are lowercase hex. (Format spec lives at the top of
[src/lib/snapshot-file.mjs](../../src/lib/snapshot-file.mjs); README shows the user layout.)

_(Foundational design principle #4 — flows directly from [0002](0002-no-lock-in-hard-constraint.md).)_

## Why

- **Editor-readable** — fixed-width leading columns scan cleanly even unaligned.
- **Opens cleanly in Excel** (an "open enough" standard) → instant sort/filter/pivot over a
  backup manifest. (Caveat: don't let Excel re-save and mangle it.)
- **TSV > CSV > JSON** for this job: tabs almost never occur in real paths, so we avoid CSV's
  comma-quoting *and* JSON's escaping — notably JSON would force escaping every Windows
  backslash (`C:\\Users\\...`). Less escaping = more directly recoverable.

## Considered options

- **base64url hashes** (43 chars vs 64) — an abandoned space-saving experiment. Dropped: the
  gain is negligible once the manifest is zstd-compressed, and hex is more recognizable and
  hand-recoverable.

## Consequences

**Open edge case** (handle before release): a path containing a literal tab or newline would
break a manifest line. Needs a documented rule — reject / encode / comment. See the "Known
gaps" list in [CLAUDE.md](../../CLAUDE.md).
