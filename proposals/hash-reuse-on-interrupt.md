# Hash reuse after an interrupted snapshot

Let a user **stop a long first snapshot with Ctrl+C and resume without re-hashing** what was
already done. Worked out with the user in a 2026-07-28 grilling session; provisional, not of
record.

## The problem

Hash reuse depends entirely on there being a *previous completed snapshot* to look up against
([commands/snapshot.mjs](../src/commands/snapshot.mjs) loads the latest snapshot into `lookup`;
[lib/file-props.mjs](../src/lib/file-props.mjs) reuses a stored hash only when `size` **and**
`mtime` still match). Two things are therefore already safe and need no work:

- once a snapshot completes it is a durable lookup — every later snapshot reuses hashes;
- in `backup` (snapshot → upload), an interrupted *upload* keeps the completed snapshot's hashes.

The one unprotected window is the **first-ever snapshot of a large tree, interrupted during the
hash pass** — exactly the run with no prior snapshot to fall back on. Today an interruption
throws away every hash computed so far: the work goes to the single temp file
`.snapshot.tsv.zst`, which only becomes a real snapshot via the final atomic `rename`
([lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)). A clean failure unlinks it; a hard kill
leaves it as a *lock* the next run refuses (`inProgressError`). Either way the next attempt
re-hashes from zero.

## Why it's worth it

Individual files in the target trees take **minutes each** to hash, so a single lost file is a
lot of wall-clock. The user's real workflow is "keep restarting until the first seed is up" —
close the laptop, come back, continue. Re-hashing the whole tree each restart makes that
impractical. Narrow window, but the worst case for cost and the likeliest run to be interrupted.

## What we are *not* doing

An earlier s3cab had a **persistent global hash cache** — `~/.s3cab/.hash-cache.snapshot.json`
(earlier `.properties-cache.json`), a `path → {mtime, size, sha256}` map flushed by a
`process.on("exit")` handler. It was **deliberately retired** in favour of "the hash store is
the snapshot TSV, written once atomically" (the redesign before PR #113, which removed the last
vestige — the commented-out SIGINT handler in `s3cab.mjs`). We are **not** reviving a permanent
cross-run cache; that decision stands. This is the narrow thing: reuse the hashes from *one*
interrupted run, then discard them.

(The old memory of "a WIP snapshot used as a lookup + an exit handler to flush it" is really a
memory of that retired cache. Reusing the in-progress snapshot as a lookup is a *new* idea.)

## Design

### The parked lookup file

On a **graceful** interrupt, the handler stops the walk, ends the writer so only *complete* rows
flush, and **renames** the temp `.snapshot.tsv.zst` → **`.snapshot.lookup.tsv.zst`**. The next
run, on start, reads that file's entries into the lookup (overlaid on the normal
previous-snapshot lookup), walks the tree fresh under a new snapshot name, and reuses every hash
whose `size`+`mtime` still match. On successful completion it **deletes** the parked file.

Note the name: it is **not** a resume of that snapshot file. The next run writes a brand-new
snapshot; the parked file is consulted only as a **hash lookup** — the exact word the code
already uses (`fileProps(path, lookup)`). Hence `.snapshot.lookup.` and not `.resume.`. Chosen
so file and code speak the same language, and the name doesn't promise a continuation that
doesn't happen.

Two names, two meanings — this is what keeps the ADR-0048 lock intact (below):

| State | File | Meaning |
| --- | --- | --- |
| Active (lock held) | `.snapshot.tsv.zst` | a run is writing right now — keep out |
| Parked (resumable) | `.snapshot.lookup.tsv.zst` | nobody's writing; hashes to reuse |

The parked name is a leading-dot, non-datestamped name, so the snapshot detector
(`/\d{4}-\d{2}-\d{2}T\d{4}\.tsv\.zst$/` in
[snapshot-file.mjs](../src/lib/snapshot-file.mjs)) never mistakes it for a real snapshot, and
`list` never shows it. It is local-only — never uploaded, never restored.

### Reading it is always safe — no liveness probe

The reason this needs **no** PID/age/liveness heuristic (the very things
[ADR-0048](../docs/adr/0048-snapshot-lock-atomic-temp-file.md) rejected): resuming only ever
*reads* the parked file, as a lookup. Every candidate hash is re-validated against the live
file's `size`+`mtime` before reuse, so a hash from a stale — or even a concurrently-written —
file is either still valid (match → correct reuse) or invalidated (mismatch → re-hash). There is
**no corruption path from reading**. ADR-0048's concurrency danger is exclusively about two
*writers* on the one fixed temp name; the lock still owns that, untouched. The parked file is a
different name and a read-only input.

### Which interrupts we handle

One handler wired to **SIGINT + SIGHUP + SIGTERM**:

- **SIGINT (Ctrl+C)** — the blessed, documented path. Works on every platform including Windows.
- **SIGHUP / SIGTERM** — pure best-effort ("you might get lucky"). Closing the console window
  on Windows raises SIGHUP with a short grace period; a modest snapshot can finalise in it.

Best-effort is **safe** because the finalise ends in an atomic `rename`: either it completes
(valid parked file) or it doesn't (temp left at the lock name → today's EEXIST "delete and
retry", no resume). There is no half-baked-parked-file outcome.

**Explicitly out of scope: SIGKILL and power-loss.** No handler runs, so the temp is left
truncated at the lock name and the next run re-hashes. Documented as "no harm, only time." This
is what lets us skip periodic-flushing, a defensive truncated-zstd parse, and a `--resume` flag.

Implementation note: a *second* Ctrl+C during finalise should force-quit, so the user never feels
stuck behind the flush.

### Lifecycle

- **Delete on success, not on read** — so a *second* interruption still preserves the earlier
  work. While a resumed run is in flight, both files exist (`.snapshot.tsv.zst` = new work under
  the lock; `.snapshot.lookup.tsv.zst` = the parked input); the parked one is removed only when
  the new snapshot lands.
- **Cumulative** — a resumed run re-writes the reused rows into its own snapshot, so each Ctrl+C
  cycle parks a *fuller* lookup than the last. Repeated interruptions make real progress toward
  the seed.
- **Rename-replaces** — a graceful stop overwrites any existing parked file (its content is a
  superset). Windows can't rename onto an existing target, so this is unlink-then-rename.

### Scope: every snapshot, not just the first

The parked lookup is read on **every** snapshot when present, not gated to the initial run —
fewer lines (no "is this the first?" branch) and harmless in the routine case (a daily
re-snapshot already has a complete previous snapshot, so the parked file just gets consumed).

### Handler placement

Installed around the snapshot write, wired so the interrupt routes into a **"park" branch** of
[withSnapshotFile](../src/lib/snapshot-file.mjs)'s existing `try/finally` — rename to the parked
name instead of the current unlink — rather than living at the top-level `s3cab.mjs` dispatch
(which has no handle on the open stream/fd). `backup` gets it for free through `snapshot()`.

## Relationship to ADR-0048 and the locking epic

This does **not** change the lock and does **not** solve
[concurrency-and-locking.md](concurrency-and-locking.md) item 2 (a hard-killed run still leaves a
stale lock the user must delete). The two are orthogonal: item 2 is "a stale lock blocks the next
run"; this is "don't discard hash work on a graceful stop."

Reconciling the note in item 2 — *"2026-06-26: a SIGINT handler is the wrong tool for this"*:
still true **for stale-lock sweeping** (a handler can't clean up after a crash it never sees).
This feature uses SIGINT for a *different* job — preserving a read-only lookup on a graceful
stop — and accepts up front that it covers only the interrupts a handler can see. No reversal of
that verdict.

## Loose ends to close when building

- Confirm nothing sweeps the set's `snapshots/` dir and uploads/restores the parked file (upload
  pushes real snapshots only; the detector regex already excludes the name — verify in code).
- Decide whether to sanity-check the parked file's `#SNAPSHOT` identity matches the set before
  trusting it (defensive; entries are validated by size+mtime regardless).
- The graceful finalise must not write a torn row: rows are whole-line writes, so a clean
  `end()` flushes only complete lines — verify the zstd `end()` path holds that.
- Docs when built: the snapshot/backup help (the Ctrl+C-to-pause promise), and a note that other
  interrupts just re-hash. `guide/format.md` gains one transient local file
  (`.snapshot.lookup.tsv.zst`) alongside the existing temp.
