# File-level content-addressable dedup with SHA-256

**Status:** accepted

Deduplicate by the **SHA-256 of whole-file contents**: identical content under any name,
anywhere, is stored once. Dedup is deliberately **file-level only** — no sub-file/block
packing, no chunking, no delta encoding.

_(Foundational design principle #1.)_

## Why

The big wins (moved directories, duplicate files) come from file-level hashing alone, and the
largest files — video, photos — rarely change in place. SHA-256 is ubiquitous in every
runtime and CLI (`sha256sum`, `openssl`, `certutil`, Node's `crypto`), fast enough that I/O
not hashing is the bottleneck, and collision-resistant with an intact security margin.

## Considered options

- **Block/chunk packing or delta encoding** — rejected. It saves space (a one-byte change to
  a large file does cost a wholly new object here) but makes the stored format opaque and
  breaks easy hand-recovery. That cost is paid on purpose; see [0002](0002-no-lock-in-hard-constraint.md).
- **SHA-1** (what git historically uses) — rejected. Collision attacks against it are real,
  and in a content-addressable store a collision means **silent data loss**.

## Consequences

A one-byte edit to a huge file produces a brand-new object. Accepted: the space lost is
small against the recoverability and simplicity gained.
