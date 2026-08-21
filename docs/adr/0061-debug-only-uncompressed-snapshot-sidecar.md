# The uncompressed snapshot sidecar stays debug-only

**Status:** accepted

The `.snapshot.tsv` sidecar written beside the real snapshot (now in the engine,
[src/lib/snapshot.mjs](../../src/lib/snapshot.mjs), since the fused-pipeline extraction —
[0069](0069-fused-snapshot-upload-pipeline.md)) is gated on `S3CAB_DEBUG` and
**stays that way**. It is not promoted to an always-on transparency feature.

## Why

The recurring suggestion is that always writing one uncompressed snapshot would serve the
no-lock-in pillar ([0002](0002-no-lock-in-hard-constraint.md)) — a human could read their
manifest with no tooling at all.

**That pillar is already satisfied without it.** Snapshots are stored as `.tsv.zst`: standard
zstd, decompressible by any `zstd -d`, with the grammar written down in
[guide/format.md](../../guide/format.md) so a hand-recoverer needs nothing from us. The
sidecar would buy a marginal convenience, not a capability.

Against that, an always-on version costs a second artifact per snapshot forever — bytes, a
second write per run, and a second thing whose relationship to the real snapshot has to be
explained and kept honest. That is cost for no gain, which [0006](0006-minimal-code.md) tells
us not to pay.

So the ~7-line debug-gated block stays exactly as-is: useful when you are iterating on the
snapshot grammar and want to eyeball rows, invisible otherwise.

## Notes

- The same `S3CAB_DEBUG` flag also relaxes the same-minute overwrite guard in
  `snapshot-file.mjs` — re-running within a minute while debugging is otherwise maddening.
  Both are debug-ergonomics, not features.
- This was carried for a long time in CLAUDE.md's "Known gaps" as a *settled, don't
  re-litigate* note. It moved here in 2026-07-18's backlog grooming: it is a decision with
  reasoning, which is what the ADR log is for, and it is not something every session needs in
  context.
