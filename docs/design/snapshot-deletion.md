# Snapshot deletion and the orphan check

## Status

**Designed 2026-07-19 (a grilling session) — not built.** Everything below describes the
*target*; `src/` is what works now. The **shape** below has shipped
([ADR-0062](../adr/0062-bulk-operands-positional-addressing-by-flag.md)): `delete` takes
several snapshots as its positional operand, addresses the set with `--set`, validates every
name before deleting any, and confirms once for the whole run. What it does **not** yet do is
the part this design is actually about — the orphan check, the report file, `-o` and
`--force`.

## Purpose

`delete` is the retention **primitive** — it removes a remote snapshot, and `cleanup` later
reclaims objects nothing references any more ([backup.md](backup.md)). Today it tells you
nothing about what you are about to lose. This design adds the missing half: **before
deleting, report which stored content would be left with no snapshot referencing it.**

The information flow is currently backwards. You learn what a deletion orphaned *afterwards*,
from `cleanup`'s dry run, as hash counts with no paths. A preview at the moment of decision is
where it belongs — particularly for the deletion that takes out a set's last snapshot, which
orphans everything unique to that set.

## The shape

```
s3cab delete --set <set> <snapshot>...  [--force] [-o <file>]
```

Snapshots are the bulk operand; the set is addressing ([ADR-0062](../adr/0062-bulk-operands-positional-addressing-by-flag.md)).

## What the check computes

For the snapshots named in one run:

```
orphaned = (hashes those snapshots reference) − (hashes every surviving snapshot references)
```

Two properties make this the only correct formulation:

- **It is bucket-wide.** Dedup is global across sets ([ADR-0013](../adr/0013-one-repository-one-bucket.md)),
  so another set can reference the same content. Answering from the target set's own snapshots
  would report content as orphaned that another set still needs — the fastest way to make a
  deletion preview lie.
- **It is computed over the whole selection at once, not per snapshot.** Content referenced by
  two of the named snapshots and nothing else is orphaned only when *both* go. Evaluating each
  snapshot independently against the current state reports zero for each while deleting both
  orphans it.

`referencedObjects` ([lib/remote.mjs](../../src/lib/remote.mjs)) already produces the
enumeration this needs. The difference itself is a **`Set.difference()`** — the operation the
code should say outright, and an idiom already used in [lib/compare.mjs](../../src/lib/compare.mjs).
The argument may be any *set-like* (a `Map` qualifies — `size`/`has`/`keys`); an array or a
bare iterable throws, though `tsc` catches that. The receiver must be a real `Set`, so the
*direction* of a difference decides whether it is allocation-free.

> **Not a reason to rewrite `planCleanup`.** Its orphan pass walks a `Map` and would have to
> materialise `new Set(stored.keys())` first. Measured at 1M objects: 167 ms as written vs
> 634 ms via `Set.difference`. The performance gap is not the point — a few hundred
> milliseconds is noise inside a command dominated by network reads — but the Set version is
> not *clearer* either (it re-`get`s from the Map and needs a type assertion), so there is no
> trade to make. Leave it.

## Cost, and why the shape follows from it

The check is **inescapably a whole-bucket snapshot read**: every snapshot of every set, read
and decompressed. There is no cheaper exact answer short of a stored refcount index, which
would be a format change that can drift — and a drifted refcount in a deletion path deletes
live data.

That single fact drives three decisions:

- **Multiple snapshots per run.** Housekeeping snapshot-by-snapshot pays the scan every time.
  One run over several snapshots pays it once — the reason snapshots became the bulk operand.
- **The full detail is written to a file, not left to shell redirection.** Forgetting `>` on
  an instant command is an annoyance; here it costs a second full scan. See below.
- **`delete` and `cleanup` stay separate commands** (below).

## Output

Two streams and one artifact, following [ADR-0010](../adr/0010-cli-output-conventions.md)'s
stream discipline and its **never truncate** principle:

- **The full path list → a file**, always written, since it is computed anyway. Default
  `~/.s3cab/last-delete.txt`, overwritten each run, relocatable with `-o`/`--output`
  (matching `restore -o`). Deliberately a single "last run" file rather than a name per
  snapshot: it is a transient decision aid, and per-target names would accumulate files
  nobody prunes in the home directory of a tool whose other job is reclaiming space. Two
  concurrent deletes would clobber it; `-o` is the answer, not a naming scheme.
- **The summary → stdout**, ending with that file's **absolute path on its own indented
  line** so it can be pasted straight into an editor or Explorer — the copy-pasteable style
  [ADR-0030](../adr/0030-error-message-guidelines.md) already requires for fixes. Windows is
  the primary environment; "pipe it somewhere" is not a substitute for a discoverable file.
- **The confirmation → stderr**, last, so it is the final thing on screen above the prompt.

### The summary breaks orphans down per snapshot

Each orphaned hash is referenced by one or more of the named snapshots. Count them:

- referenced by **exactly one** → attribute it to that snapshot
- referenced by **two or more** → a **shared** line: content orphaned only because all of
  them are going

```
2026-06-12T0915    3,201 files   12.4 GB   (only this snapshot)
2026-06-19T0902      118 files      412 MB (only this snapshot)
2026-07-03T1140        0 files        0 B
shared across all three           842 files   3.1 GB
                                  ─────────────────────
total orphaned                  4,161 files  15.9 GB
```

This is preferred over charging each hash to the last snapshot that released it (the
sequential-simulation approach, which also works and needs no extra scan). Three reasons:
it is **order-independent** — the same selection always yields the same table, where
sequential attribution shifts with argument order; it **makes the shared category visible**,
teaching the model rather than needing a footnote; and it needs no "last referencing
snapshot" rule for anyone to learn. Cost is one pass counting references per hash within the
selection.

### The last snapshot of a set

Deleting a set's last remote snapshot orphans everything unique to that set and is the most
consequential form of this operation. It gets an explicit line saying so — the signal belongs
in **what is said, not in how much**: a distinct warning naming the set is likelier to stop
someone than a longer list they scroll past. (The full list is in the file either way, never
truncated.)

## Confirmation

**One prompt covering the whole run**, on a TTY, after the summary. Non-interactive runs
proceed — naming specific snapshots is explicit intent, and clig.dev forbids blocking a
script on a prompt (unchanged from today's `delete`).

Per-snapshot prompting was considered and rejected: it means N prompts in a feature built for
bulk work, which is the pattern that trains people to hold down `y`. The cost of one prompt is
that it is all-or-nothing — spot a mistake and you answer `n`, fix the list and re-run, paying
the scan again. The report is what lets you check the list before committing.

**`--force`/`-f` skips both the check and the confirmation**, degrading to today's behaviour.
The two travel together because skipping the check leaves the prompt nothing useful to say;
this matches `rm -f` and the existing `upload --force` ("bypass the protective default").

## Why `delete` and `cleanup` do not merge

The check costs what `cleanup`'s scan costs, which invites folding them into one command.
Rejected, for three reasons:

1. **The grace window means a merged command often could not reclaim anything.** The 7-day
   window is measured from each object's `lastModified`, not from when it was orphaned. Delete
   a year-old snapshot and its objects are sweepable; delete yesterday's and its objects are
   grace-protected, so a merged command would validate, delete, sweep, and reclaim nothing —
   with the space arriving a week later via a `cleanup` you still have to remember.
2. **It would drag `cleanup`'s concurrency hazard into a common command.** `cleanup` must not
   run while a backup is running ([proposals/concurrency-and-locking.md](../../proposals/concurrency-and-locking.md));
   `delete` has no such hazard — it touches one snapshot object and never `objects/`.
3. **The operands differ.** `delete` is set-scoped; `cleanup` is bucket-scoped, deliberately
   symmetric with `verify` ([ADR-0042](../adr/0042-verify-bucket-operand.md)).

And the saving is smaller than it looks. A housekeeping session today is: delete (scan),
delete (scan), delete (scan), cleanup (scan) — four scans. **Accepting multiple snapshots per
run collapses that to two**; merging would take it from two to one. The bulk operand captures
most of the prize for almost none of the cost.

What is kept from the merge instinct is a **precise handoff**. `delete` already points at
`cleanup`; with the check in hand it can say how much is reclaimable now and how much is
grace-held, instead of a vague "objects may still be stored".

If the two-scans-per-session ever genuinely hurts, the smallest fix is a chain flag on
`delete` that runs the sweep in the same process reusing the scan — additive, and by then
there would be evidence rather than a guess.

## Open

- **The artifact's filename.** `~/.s3cab/last-delete.txt` is provisional.
- ~~Whether `-o` meaning a *file* here and a *directory* on `restore` is tolerable.~~
  **Settled: it is** — see [ADR-0062](../adr/0062-bulk-operands-positional-addressing-by-flag.md)'s
  closing section. `-o`/`--output` on both.
- **Whether `--force` should also be spelled `--no-check`** for self-documentation, at the
  cost of a mouthful and of diverging from `upload --force`.
- **Retention policy** (keep-last / daily / weekly / monthly) remains deferred — it is the
  one open piece of the backup plan, waiting on real usage to show the shapes
  ([backup.md](backup.md)). This design deliberately adds no snapshot *selectors*
  (`--before`, `--keep-last`): those are retention policy through the back door.
