# Fuse snapshot generation and upload into one streaming pass

**Status: proposal (not built).** Agreed-worth-doing direction from a design
discussion; graduates to an ADR + a `docs/design/backup.md` update when built, and
this file is deleted then. Reference spike: [scripts/fused-snapshot-upload-spike.mjs](../scripts/fused-snapshot-upload-spike.mjs).

## The problem

`backup` runs in three phases: **find files** (fast, `Dirent`-only, no stat),
**generate snapshot** (phase 2: one `lstat` per file + hash the changed ones →
write the TSV), then **upload** (phase 3: read the TSV back, diff against what's
stored, PUT each missing object, snapshot last). Phases 2 and 3 are separate
commands (`snapshot`, `upload`) composed by `backup`.

A file's `size`/`mtime` are captured in phase 2 and re-checked against the live
file in phase 3 ([src/lib/upload.mjs](../src/lib/upload.mjs), the drift guard). If
the file changed in between, the run **hard-fails** — correctly, because storing
the current bytes under the snapshot's recorded hash would corrupt that object
across the dedup graph. But that window spans *the rest of phase 2 plus all of
phase 3* — minutes on a large set. So editing a file during a backup (a Word doc
with OneDrive/cloud autosave is the motivating case) aborts the whole run, and
the recovery — regenerate the snapshot from scratch — pays the multi-minute stat
pass again and can fail identically on the next autosave.

s3cab is not meant for very hot files (a live database), but it *should* let
someone keep working on a document during a backup without a painful hard-fail.

## The idea

Interleave phases 2 and 3: **PUT each object immediately after it is hashed**,
instead of writing the whole snapshot and re-reading it to upload. The gap
between capture and upload collapses from minutes to milliseconds, so drift on an
actively-edited file effectively stops happening. This attacks the cause (the
time gap) rather than patching the symptom.

### It's a pipeline, and the pieces already exist

The seam is a stream of hashed rows — `[path, Props]`, exactly the shape
`stringifySnapshot` already consumes. `writeSnapshot` today runs:

```
pipeline(files, propsRows(getProps), stringifySnapshot, writeStream)
```

Fusing **inserts one pass-through transform**:

```
pipeline(files, propsRows(getProps), uploadObjects(store), stringifySnapshot, writeStream)
```

where `uploadObjects` PUTs each row's object (skipping what's already stored, one
PUT per distinct hash) and yields the row on to the TSV sink unchanged. `snapshot`
omits the stage; `backup` includes it; the snapshot-manifest PUT is the
coordinator's step **after** the pipeline drains. The spike runs this end-to-end
against a fake store and confirms: 4 files → 3 PUTs (dedup), and the manifest is
byte-identical whether or not the upload stage is present.

### Why this is a simplification, not new machinery

- **Deletes the round-trip.** Today `upload` writes the snapshot to disk then
  re-reads and re-parses 264k rows purely because it is a separate phase. Fusing
  removes that.
- **Dissolves the drift guard.** Its whole reason to exist is the phase gap;
  collapse the gap and it shrinks to a near-no-op.
- **Makes `uploadObjects` source-agnostic.** It consumes an `AsyncIterable<Row>`
  regardless of source: a live producer (`backup`) or a re-read snapshot file
  (`upload <snapshot>`). One consumer, two sources.

### Wins that fall out

- **Cheap retry for free.** A `backup` that dies still writes the complete local
  snapshot (the TSV is cheap and local), so `upload <set> <that-snapshot>` retries
  just the upload — seconds, no re-stat. (Naïve retry still fails on a file that
  drifted *again*; converging on that needs adopt-on-drift below.)
- **Adopt-on-drift becomes a small local add**, if we later want zero failures:
  in `uploadObjects`, on a drifted row, re-hash and PUT the current bytes under
  their current hash and patch that one row before the manifest is written. One
  place, used by both commands. Compare stays correct (the file reads as
  *modified*, which is true).
- **Overlap (pipelining) is possible** — hashing is CPU/disk-bound, uploading is
  network-bound — but see the non-goal below.

## Decisions

- **Cross-object upload concurrency is a NON-GOAL.** The SDK's multipart `Upload`
  (`queueSize: 32`, measured — [src/lib/s3.mjs](../src/lib/s3.mjs), ADR-0060)
  already parallelizes *within* a big file, which is most of the win. The only
  gap is *many small files* (each a single-part PUT, so sequential request
  latency dominates) — a first-backup-of-a-large-archive concern, not steady-state
  incrementals. Deferring costs nothing: the fused pipeline is sequential
  (`await store.put`, zero look-ahead), and a bounded pool drops in at exactly one
  seam (`uploadObjects`) later *if* small-file latency is ever measured to matter.
- **The phase separation relaxes, but isn't abandoned.** `snapshot` stays a
  standalone offline artifact (no cloud, self-describing — ADR-0002,
  guide/format.md; `compare`/`tree` depend on it). `backup` composes
  producer + upload + sink; the `upload` command stays (re-read source). Three
  thin porcelain compositions over shared deep parts — not the callback-into-
  snapshot shape, which leaks upload's state and splits the snapshot-last
  invariant across two modules.

## Invariants to preserve

- **Objects-first / snapshot-last** — the manifest PUT is a post-drain step, so a
  snapshot's presence still proves its objects exist.
- **Complete-local-artifact on upload failure** — always finish writing the local
  TSV even if uploads fail, so the cheap-retry path has something to resume from.
- **7-day grace window** — still covers uploaded-but-not-yet-referenced objects
  against a concurrent `cleanup`.

## Open work when this is picked up

- Split `writeSnapshot` so the sink takes *pre-hashed* rows rather than hashing
  via `getProps` (small — `stringifySnapshot` already consumes the row shape).
- Decide `#EXCLUDED` handling if adopt-on-drift ever rewrites the manifest (those
  rows aren't retained on read today).
- Measure the hash-vs-upload wall-clock split on a real incremental to confirm
  there's no pipelining regret in going sequential (expected: upload is tiny for
  incrementals).
- Give a read failure at **PUT** time the `#ERROR` treatment. A file that can't be
  hashed already becomes an `#ERROR` row and the run carries on (`propsRows` →
  `stringifySnapshot`), but one that becomes unreadable *between* hashing and the
  upload's read throws out of `putFile`'s `createReadStream` and aborts the run.
  Fusing shrinks that window from minutes to milliseconds; closing it means one
  code path for "couldn't read this file" instead of two behaviours either side of
  the seam.
