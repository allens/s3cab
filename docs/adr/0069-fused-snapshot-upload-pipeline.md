# `backup` fuses snapshot generation and upload into one streaming pass

**Status:** accepted & implemented. Refines [0044](0044-upload-unified-command-surface.md) (the
`upload`/`backup` split — the *command surface* is unchanged; only what `backup` composes moves)
and keeps [0045](0045-change-detection-local-baseline-list-fallback.md)'s change-detection model
intact. Rides inside the write governed by [0048](0048-snapshot-lock-atomic-temp-file.md) and
[0067](0067-park-hashes-on-interrupt.md), so a backup inherits the snapshot lock and the
park-on-interrupt behaviour unchanged.

## Context

`backup` ran in three phases: **find files** (fast, `Dirent`-only, no stat), **generate the
snapshot** (one `lstat` per file, hash the changed ones, write the TSV), then **upload** (read
that TSV back, diff it against what's stored, PUT each missing object, snapshot last). Phases 2
and 3 were separate commands — `snapshot()` then `upload()` — composed by `backup`.

A file's `size`/`mtime` are captured in phase 2 and re-checked against the live file in phase 3
(the drift guard: PUTting a file that changed since it was hashed would file its *current* bytes
under the *old* content's hash, corrupting that object for every snapshot and path that dedups to
it). That check is right, but the window it spans was *the rest of phase 2 plus all of phase 3* —
minutes on a large set. So editing a document during a backup — the motivating case is an open
Word document with cloud autosave — aborted the whole run, and the recovery paid the multi-minute
stat pass again and could fail identically on the next autosave.

s3cab is not for very hot files (a live database is explicitly out of scope), but it should let
someone keep working on a document while a backup runs.

## Decision

**Interleave the two phases: PUT each object immediately after it is hashed.** The seam is a
stream of hashed rows — `[path, Props]`, exactly the shape `stringifySnapshot` already consumes —
so fusing inserts *one pass-through transform* into the pipeline the snapshot writer already ran:

```
files → propsRows(getProps) →                    stringifySnapshot → writeStream   (snapshot)
files → propsRows(getProps) → uploadObjects(…) → stringifySnapshot → writeStream   (backup)
```

`writeSnapshot` gained one optional `through` transform; `uploadObjects` (lib/upload.mjs) PUTs each
row's object and yields the row on unchanged. The hash→PUT gap collapses from minutes to
milliseconds, which attacks the *cause* of the drift failure rather than patching the symptom.

This is a **pipe, not a callback**. A callback handed into `snapshot` would leak upload's state
into the snapshot writer and split the snapshot-last invariant across two modules; a transform owns
its own state and reports back to whoever built it, and the writer never learns what it does.

Three thin porcelain compositions over shared deep parts, which is why the generation engine moved
to `lib/snapshot.mjs` (`readBaseline` + `generateSnapshot`):

| Command | Composition |
| --- | --- |
| `snapshot` | `readBaseline` → `generateSnapshot` → compare |
| `backup` | `readBaseline` → `storedHashes` → `generateSnapshot` **with the uploader spliced in** → manifest |
| `upload --snapshot` | read the snapshot → `storedHashes` → the *same* `uploadObjects` transform → manifest |

`snapshot` stays a standalone offline artifact (no cloud, self-describing —
[0002](0002-no-lock-in-hard-constraint.md), guide/format.md; `compare`/`tree` depend on it), and
`upload --snapshot <name>` stays as the re-read path. One PUT loop and one drift guard now serve
both sources.

### What falls out

- **The round trip is gone.** `upload` used to write the snapshot to disk and then re-read and
  re-parse every row purely because it was a separate phase.
- **`backup` no longer computes a compare it throws away.** It got `until`/`since` out of
  `snapshot()`'s returned diff; it now knows both directly.
- **The drift guard got *stronger*, not weaker.** Because it re-checks after hashing, it catches a
  file that changed **while it was being hashed** — a mixed-content read the phase-boundary guard
  could only notice minutes later, if at all.
- **Retry is cheap.** See the failure split below.

## Nothing in the uploader throws mid-stream

The transform is a **link in a pipeline**, not a function the coordinator calls, and that decides
how it may fail. A throw inside a link makes `stream.pipeline` destroy every stream in the chain —
including the snapshot writer — so the file being written is truncated mid-zstd-frame and
`withSnapshotFile` unlinks it. One dropped connection at file 200,000 would take the entire hash
pass with it: exactly the cost this ADR exists to remove.

So the transform **never throws**. It records what went wrong, keeps the rows flowing, and the
coordinator reads `result()` once they have drained — then throws, before publishing any manifest.
The local snapshot therefore always lands complete, whatever went wrong. That single artifact
covers both recoveries, because a fresh run reads the latest local snapshot as its **hash lookup**:
nothing is ever hashed twice.

The two kinds of failure differ only in what happens next:

| | Failed transfer | Drifted file |
| --- | --- | --- |
| Cause | network, credentials, a rejected PUT | the file changed, vanished, or became unreadable between hashing and its PUT |
| Rest of the run | further uploads abandoned (one dead link is enough; the SDK-level retry window is already spent — [0068](0068-network-retries-above-the-sdk.md)) | **only that file is skipped** — every other file's bytes are still good and still go up |
| Reported as | `failure` — the terminal one, checked first | `drifted` — per-file data the coordinator judges (see the amendment below) |
| Raised as | a plain error, wrapped with the resume command | `FileChangedError` (error.mjs), built by the coordinator from the drift data |
| The fix offered | `upload <set> --snapshot <name>` — the transfers alone | `s3cab backup <set>` — a fresh pass |

> **Amended 2026-07-30 — two outcome fields, and a third source.** The outcome originally carried
> **one** `failure` slot, first-wins, which conflated the two rows of the table above: a drift on an
> early row hid a dropped connection met on a later one, so the run failed blaming the wrong thing
> and offered the wrong fix. They are different in kind — a drift is per-file and **plural**, a
> transport failure is singular and terminal — so `result()` now returns `{ drifted, failure }`, and
> every coordinator checks `failure` first. Drift is reported as **data** (`Drift` = a `FileChange`
> plus its path) rather than as a built error, because what a drifted file *means* depends on the
> caller: fatal where a manifest is about to be published, a reportable skip where none is. So
> `fileChangedError` is raised by the coordinator, not the transform — which also means
> `uploadObjects` needs no set name and takes only `{ bucket, stored }`.
>
> The same change gave the transform its **third source**: `uploadDir` (`upload --dir`, the folder
> seed) had its own PUT loop, predating this one, and therefore none of this guard — it hashed a file
> and re-read it to send it with nothing re-confirming in between. It is now a row source like the
> other two. That path is the one place a skipped file does **not** fail the run: it publishes no
> manifest, so a skip leaves nothing inconsistent, and the skips are returned for the command to
> name. `upload --file` shares the same window and now calls the same `fileChange` guard, though not
> the loop — `--force` means "overwrite deliberately", which the transform has no concept of.

Drift needs the *fresh backup* because that row can never be reconciled with the file as it now
stands: `upload --snapshot` deliberately never re-hashes, so retrying it would fail on the same row
forever. A fresh backup re-hashes only that file and reuses the rest.

**"Can't check" counts as drift.** *Every* `lstat` failure in the guard is a change, not just
ENOENT — a file we cannot stat is one we cannot confirm, which is reason enough not to store it,
and letting an EACCES/EIO escape would throw from inside the pipeline link and truncate the
snapshot, defeating the paragraph above (caught in review on #245). The three reasons are kept
apart for the message — *changed*, *removed*, *could no longer be read (errno)* — because being
specific costs one string union, and the raw error rides along as `cause` for `S3CAB_DEBUG`. The
advice is shared: no manifest was published, so whichever happened, the run didn't finish and
wants running again.

**Why the snapshot keeps its real name.** ADR-0067 parks an interrupted run's work file under
`.snapshot.lookup.tsv.zst` precisely because it is *incomplete* — it must never masquerade as a
full snapshot. A failed backup's snapshot is **complete**: every row is there, because the rows
kept flowing. It is a true snapshot of the disk that simply hasn't been uploaded, which is exactly
what the `snapshot` command produces on purpose — so it earns an ordinary name, needs no new
machinery, and can't be mistaken for anything. (Parking it instead was considered and rejected:
the parked file would have to be written by a *graceful* stop to be a valid zstd stream, which
means threading an abort through `withSnapshotFile`, and the result would be strictly weaker than a
real snapshot — a lookup you can't `compare`, `restore` from, or `upload --snapshot`.)

The one row a drifted snapshot holds that isn't true of the disk is self-correcting: `fileProps`
re-validates every candidate hash against the live file's size and mtime before reusing it
(0067's own safety argument), so the next run simply re-hashes that file.

## Invariants preserved

- **Objects-first / snapshot-last.** The manifest PUT is a post-drain step in the coordinator
  (`uploadSnapshotFile`), so a snapshot's presence still proves its objects exist.
- **The snapshot file is byte-identical** with or without the transform — fusing changes *when*
  objects ship, never *what* the snapshot records. Asserted in snapshot-file.test.mjs.
- **The lock and the parked lookup** ([0048](0048-snapshot-lock-atomic-temp-file.md),
  [0067](0067-park-hashes-on-interrupt.md)) are untouched: the uploader rides *inside*
  `withSnapshotFile`, so Ctrl+C during a backup parks its hashes exactly as during a snapshot,
  and the objects already uploaded are left as harmless orphans.
- **The 7-day grace window** still covers uploaded-but-not-yet-referenced objects against a
  concurrent `cleanup` — and it now covers a *longer* stretch of each run, since objects start
  landing at the beginning of the pass rather than the end.
- **Change detection** ([0045](0045-change-detection-local-baseline-list-fallback.md)) is
  unchanged in substance: the previous **local** snapshot is the baseline, trusted only once a
  HEAD confirms it still exists remotely, minus what the deletion record says was deleted
  ([0064](0064-path-scoped-delete-deletion-record.md)); a first backup LISTs the store instead.
  The decision now happens **before** any hashing, so a credentials or network problem surfaces in
  seconds rather than after a long pass.

## Consequences

- **"What's already stored" is now a materialized `Set`, not a streamed subtraction.** The old
  `planUpload` had the whole target snapshot in hand and could delete-as-you-scan the LIST, so
  peak memory scaled with the snapshot; the fused pipeline asks about one row at a time, so
  membership has to be random-access. The Set is sized by the store on a first backup (~110 bytes
  per stored object — tens of MB for a large real store) and by the baseline snapshot otherwise,
  the same order as the snapshot Maps a run already holds. Accepted for a desktop tool; the LIST
  form is only paid when there is no trustworthy baseline.
- **Cross-object upload concurrency stays a non-goal.** The SDK's multipart `Upload` already
  parallelizes *within* a big file ([0060](0060-multipart-tuning-in-flight-bytes.md)), which is
  most of the win. The gap is many *small* files, where sequential request latency dominates — a
  first-backup-of-a-large-archive concern, not steady-state incrementals. Deferring costs nothing:
  the transform is sequential (`await putObject`, zero look-ahead) and a bounded pool drops into
  exactly one seam later, *if* small-file latency is ever measured to matter.
- **`status` keeps `planUpload`** (now pure: target + stored → plan), so its read-only estimate
  still applies the same "is this content stored?" rule the fused transform applies row by row.
- **The `cleanup`-versus-running-`backup` race widens a little.** The store LIST now happens
  *before* the hash pass rather than after it, so the gap between "the store told us this object
  exists" and "the manifest is published" grows by roughly the hashing time. That is the residual
  race already documented in docs/design/backup.md (a concurrently-running `cleanup` deleting an
  old orphan a backup was relying on via the conditional-PUT skip); the 7-day grace window still
  doesn't cover it, and the mitigation is unchanged and already printed by `cleanup` — don't run
  it while a backup is running.
- **A backup blocked by the snapshot lock now discovers it slightly later.** The store question is
  settled before `generateSnapshot`, which is what acquires the lock
  ([0048](0048-snapshot-lock-atomic-temp-file.md)) — so a second concurrent backup pays the
  baseline HEAD (or, on a first backup, the store LIST) before failing with "already in progress".
  Accepted rather than pre-checking the lock file: a probe outside the atomic `wx` is exactly the
  heuristic 0048 rejected, and the cost lands only on a run that was going to fail anyway.
- **`backup` no longer prints the `Comparing 'a' → 'b'` line**, because it no longer runs a
  compare whose result it discarded.

## Still open (carried over from the proposal this replaces)

- **Adopt-on-drift** — on a drifted row, re-hash and PUT the current bytes under their current
  hash and patch that one row before the manifest is written, so the run *succeeds* with that file
  at its newer content instead of asking for a fresh backup. It lands in one place
  (`uploadObjects`) for both sources, and would need a bounded re-attempt (a file being written can
  drift again) plus a decision on `#EXCLUDED` rows, which aren't retained on read. Deferred: with
  the window at milliseconds a drift means the file is being written at that instant, and the
  fresh-backup path is cheap now that the hash pass survives.
- **Reporting a drifted file as an `#ERROR` row** — a smaller cousin of the above: land the row as
  `#ERROR` rather than as an entry, so the snapshot *is* uploadable and the file is visibly "didn't
  make this backup" rather than the run failing. Worth weighing against adopt-on-drift when either
  is picked up; both change what a manifest may say about a file, which is why neither rode along
  here.
- **A read failure at PUT time still isn't `#ERROR`-treated.** A file that can't be *hashed*
  becomes an `#ERROR` row and the run carries on; one that becomes unreadable between hashing and
  the PUT surfaces as a transfer failure instead. Closing that needs a reliable local-read vs.
  remote-failure distinction, which the SDK error surface doesn't hand over cheaply — and treating
  a network error as a per-file `#ERROR` would quietly produce a snapshot full of them. Left until
  the distinction is worth its code.
- **Measure the hash-vs-upload wall-clock split** on a real incremental, to confirm there is no
  pipelining regret in going sequential (expected: upload is tiny for incrementals).
