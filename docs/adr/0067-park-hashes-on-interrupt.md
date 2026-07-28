# A graceful interrupt parks the snapshot's hashes for the next run to reuse

**Status:** accepted

Hash reuse depends on there being a *previous completed snapshot* to look up against
([commands/snapshot.mjs](../../src/commands/snapshot.mjs) loads the latest snapshot into the
lookup; [lib/file-props.mjs](../../src/lib/file-props.mjs) reuses a stored hash only when `size`
**and** `mtime` still match). One window is unprotected: the **first-ever snapshot of a large
tree, interrupted during the hash pass** — exactly the run with no prior snapshot to fall back
on. Files in real target trees take minutes each to hash, and the workflow for a first seed is
"keep restarting until it's up"; re-hashing the whole tree on every restart makes that
impractical.

So: on a **graceful interrupt**, the snapshot writer ends its stream cleanly and **renames** its
work file aside instead of unlinking it. The next run reads it as a hash lookup, overlaid on the
normal previous-snapshot lookup, and deletes it once a snapshot lands.

| State | File | Meaning |
| --- | --- | --- |
| Active (lock held) | `.snapshot.tsv.zst` | a run is writing right now — keep out ([0048](0048-snapshot-lock-atomic-temp-file.md)) |
| Parked | `.snapshot.lookup.tsv.zst` | nobody's writing; hashes to reuse |

The parked name says **lookup**, not *resume*: the next run writes a brand-new snapshot and
consults this file only as a `lookup` — the word the code already uses (`fileProps(path,
lookup)`). It is a leading-dot, non-datestamped name, so `snapshotNames`' datestamp filter can
never mistake it for a real snapshot; `list` never shows it, and nothing uploads or restores it
(every remote path addresses a snapshot by *name*, through `snapshotFileName`).

## Why this doesn't touch the lock

Resuming only ever **reads** the parked file. Every candidate hash is re-validated against the
live file's `size`+`mtime` before reuse, so an entry from a stale — or even a concurrently
written — file is either still valid (match → correct reuse) or invalidated (mismatch →
re-hash). There is **no corruption path from reading**, so this needs none of the PID / age /
liveness heuristics [0048](0048-snapshot-lock-atomic-temp-file.md) rejected. That ADR's danger is
exclusively two *writers* on one fixed temp name; the lock still owns that, unchanged.

The same argument is why the parked file's `#SNAPSHOT` identity is deliberately **not** checked
against the set before trusting it: a path whose size and mtime still match is the same file
whichever set recorded it, so the check would reject nothing that could do harm — it would only
be ceremony ([0006](0006-minimal-code.md)).

This also does **not** solve `proposals/concurrency-and-locking.md` item 2 (a hard-killed run
still leaves a stale lock the user deletes by hand). The two are orthogonal, and the 2026-06-26
note there — *"a SIGINT handler is the wrong tool for this"* — still stands **for stale-lock
sweeping**: a handler can't clean up after a crash it never sees. This uses the handler for a
different job, and accepts up front that it covers only the interrupts a handler *can* see.

## Which interrupts, and the shape of the mechanism

One handler on **SIGINT + SIGHUP + SIGTERM**. SIGINT (Ctrl+C) is the blessed, documented path
and works on every platform; SIGHUP/SIGTERM are best-effort — closing the console window on
Windows raises SIGHUP with a short grace period, and a modest snapshot can finalise inside it.
Best-effort is *safe* because finalising ends in an atomic rename: either it completes (a valid
parked file) or it doesn't (the temp is left at the lock name → today's "delete and retry"). There
is no half-baked-parked-file outcome.

**SIGKILL and power loss are explicitly out of scope.** No handler runs, so the temp is left
truncated at the lock name and the next run re-hashes: no harm, only time. That is what buys us
the right to skip periodic flushing, a defensive truncated-zstd parser, and a `--resume` flag.

Consequent choices:

- **The handler is installed around the write** (`withSnapshotFile`), not at the top-level
  dispatch, which has no handle on the open stream to finalise. `backup` inherits it through
  `snapshot()`. It is removed as the write unwinds, so an interrupt anywhere else keeps Node's
  default "die now".
- **Aborting is a request to stop cleanly, not a teardown.** The signal reaches the row generator
  (`propsRows`), which simply *returns* between files; the pipeline then ends the ordinary way and
  flushes, so the file stops on a whole row. A second interrupt force-quits, so the user is never
  stuck behind a flush — at the cost of the ordinary hard-kill outcome.
- **Delete on success, not on read**, so a second interruption still preserves the earlier work:
  while a resumed run is in flight both files exist. Parking is therefore **cumulative** — a
  resumed run re-records the reused rows into its own work file, so each cycle parks a fuller
  lookup and repeated interruptions make real progress. Replacing is unlink-then-rename (Windows
  will not rename onto an existing file), and always correct because the new file is a superset.
- **Read on every snapshot**, not gated to a first run: fewer lines than an "is this the first?"
  branch, and harmless in the routine case — a daily re-snapshot already has a complete previous
  snapshot, so the parked file is simply consumed. `--rehash` skips it, because it means re-hash
  everything.
- **A stop is not a failure.** The writer throws `InterruptedError`, which the CLI catches by
  type and reports plainly at exit 130 (128 + SIGINT), rather than as `ERROR:` at exit 1.

## What this is not

s3cab once had a **persistent global hash cache** — `~/.s3cab/.hash-cache.snapshot.json`, a
`path → {mtime, size, sha256}` map flushed by a `process.on("exit")` handler. It was deliberately
retired in favour of "the hash store is the snapshot TSV, written once atomically". **That
decision stands; this does not revive it.** The parked file is the *work file of one interrupted
run*, discarded as soon as a snapshot lands — not a permanent cross-run cache.

## Consequences

An interrupt arriving in the sliver between the last row and the rename parks a *complete*
lookup instead of landing the finished snapshot — the writer only knows the run was asked to
stop, not that it happened to be done. Accepted rather than plumbed around ([0006](0006-minimal-code.md)):
on a tree big enough to interrupt, that window is milliseconds against hours, and the cost when
it does hit is a re-run that reuses every hash and finishes almost instantly.

One more transient local file to document ([guide/format.md](../../guide/format.md)), alongside
the existing temp — both under the set's `snapshots/`, both leading-dot, neither ever uploaded.
The user-facing promise ("Ctrl+C to pause a long first snapshot") is stated in `snapshot`/`backup`
`--help`.
