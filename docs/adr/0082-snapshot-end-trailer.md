# Snapshots close with an `#END` trailer, and a parse without one is damage

**Status:** accepted, amended once (2026-08-21). Extends
[0004](0004-tsv-snapshot-manifests.md)'s row grammar; the classification of the failure rides
[0074](0074-referenced-enumeration-vocabulary-module.md)'s unreadable-snapshot channel.

> **Amendment 1 (2026-08-21) — the trailer is no longer bare: `#END<TAB>status<TAB>instant`.**
> Point 4 below rejected an entry count and a checksum, and that reasoning stands: they are
> *integrity* payloads, and whole-file integrity is the object store's job. What the trailer now
> carries is neither — they are facts about the pass that wrote the file, and the trailer is the
> only line in it written *after* the rows:
>
> - **status** — `COMPLETE`, or `PARTIAL` for the parked-on-interrupt file
>   ([0067](0067-park-hashes-on-interrupt.md)). Presence and status answer different questions and
>   both are worth having: presence says the run ended in a *controlled* way (a torn write leaves
>   no trailer at all, so a reader can tell "you stopped it" from "the process died mid-row"),
>   status says whether the rows are all of them. A bare `#END` conflated the two — a parked file
>   was announced with the same marker a finished snapshot uses, which reads as "done".
> - **instant** — when the last row was written, in `#SNAPSHOT`'s own instant column so the two
>   line up. This is what [0085](0085-ctime-cross-check-on-hash-reuse.md) needed: a boundary later
>   than every read the pass made. The header's instant is minted at pass start and cannot serve.
>
> The [format spec](../../guide/format.md) had already reserved the right to add trailer columns,
> so this is the extension point being used rather than a break in the promise. A recovery reader
> that skips `#` lines is unaffected, as is the truncation guard: absence still throws.
>
> One consequence worth naming: **two snapshots of an unchanged tree are no longer byte-identical**
> — the trailer times itself. The fused pass's guarantee ([0069](0069-fused-snapshot-upload-pipeline.md))
> is that inserting the uploader changes nothing about the *rows*, and that is what its test now
> asserts.

## Context

The 1.0-format durability audit (2026-08-12) and the model-based suite (2026-08-14) converged on
the worst verdict available: **a truncated stored manifest parses as a *valid* snapshot, and
`verify` calls the store healthy.** Node's zstd decompressor is lenient about a cut-short stream —
it yields the byte *prefix* that decompressed cleanly and ends without error. A cut inside a data
block therefore parses as a valid smaller (or empty) snapshot; a cut in the frame's closing bytes
parses indistinguishable from the complete manifest. An empty parse references nothing, so `verify`
walked a destroyed snapshot's zero references and exited 0, while `restore --output` refused only
by accident (the truncation happened to eat the `#DIR` headers) and with a misleading reason.

Nothing in the grammar marked "this is all of it": the parser could not tell a destroyed manifest
from a small honest one, and no amount of hardening the zstd layer fixes that — completeness is a
property of the *content*, and only the content can state it.

## Decision

**Every snapshot ends with the trailer line `#END`, and a parse that reaches end-of-stream without
having seen it throws.**

1. **One writer, one reader.** `stringifySnapshot` emits the trailer as its final yield — it is the
   tail of every snapshot body, including the parked-on-interrupt file (a graceful stop ends the
   row stream early; the generator's own tail still runs), so no second writer needs to know the
   rule. `parseSnapshotStream` records having seen `#END` and asserts it after the last line.
2. **The failure is an `AssertionError` on purpose**, matching the malformed-line assert beside it:
   `isCorruptSnapshotError` already classifies both as snapshot *damage* rather than an operational
   S3 failure, so `verify` records an unreadable finding and exits 1, `cleanup`/`delete` refuse,
   and a network outage still aborts instead of masquerading as data loss. No new plumbing.
3. **Only absence is an error.** Content after an `#END` is parsed normally — a prefix cut can
   never produce that shape, so rejecting it would defend against nothing truncation can do, and a
   hand-assembled manifest (the no-lock-in story) stays easy to extend.
4. **The trailer is bare** — no entry count, no checksum. Truncation is the failure mode being
   closed, and a prefix cut either loses the trailer or tears a row (the four-field assert catches
   a torn row). Whole-file integrity against *arbitrary* corruption is S3's ETag and the object
   store's job, not the TSV's.

A recovery reader that skips every `#` line (the [format spec](../../guide/format.md)'s standing
promise) is unaffected; checking for the trailer first is what tells it the rows it read are all
of them. The spec documents the trailer as of this ADR.

## Consequences

- **A cut that only shaves zstd framing after the last content byte still parses complete.**
  Correct: nothing was lost, the manifest is fully restorable. The invariant the model suite pins
  is "no truncation parses as a valid smaller snapshot", not "every truncation rejects".
- **Pre-0082 snapshot files no longer parse** (no trailer). Pre-1.0 policy: no compatibility
  reader; developer snapshots are re-taken, parked lookups deleted.
- `verify` reporting a truncated snapshot as `unreadable` under its set — rather than exit 0 —
  is the fix the bugs.md entry demanded; `restore` now refuses with the true reason.
