# Snapshot deletion and the orphan check

## Status

**Designed 2026-07-19 (a grilling session) — built.** The **shape** shipped first
([ADR-0062](../adr/0062-bulk-operands-positional-addressing-by-flag.md)): `delete` takes
several snapshots as its positional operand, addresses the set with `--set`, validates every
name before deleting any, and confirms once for the whole run. The part this design is
actually about — the orphan check, its report files and `--force` — followed, and the
questions once listed under **Open** are settled in place below (including `-o`, which was
dropped rather than kept — see the amendment note below and in ADR-0062).

Where it lives: the computation and its two output shapes are
[src/lib/orphans.mjs](../../src/lib/orphans.mjs), pure and non-throwing so they are
unit-tested by asserting on returned data with no mocked seams (the split `planCleanup`
already keeps with `cleanup`); the S3 read, the file write and the confirmation policy are
[src/commands/delete.mjs](../../src/commands/delete.mjs).

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
s3cab delete --set <set> <snapshot>...  [--force]
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

Two streams and two artifacts, following [ADR-0010](../adr/0010-cli-output-conventions.md)'s
stream discipline and its **never truncate** principle.

**What the file is** is worth stating exactly, because it is easy to misread: it lists what
the deletion would leave **unreferenced**, not what `delete` removes. `delete` never touches
`objects/`, so every file it names stays stored — and billed — until a `cleanup`. The report
is a *reclaimable-space forecast*, not a manifest of things about to vanish.

- **The full path list → a file**, always written, since it is computed anyway. There are
  **two of them, with different lifecycles**:
  - the **preview**, `~/.s3cab/delete-orphans-preview.txt` — a transient decision aid,
    overwritten every run, written *before* the prompt so that declining still leaves the
    list on disk to read and re-run against without paying for a second scan;
  - the **audit record**, `~/.s3cab/sets/<set>/delete-orphans-<timestamp>.txt` — written
    only once a deletion actually happens, and **kept**.

  The split reverses this design's original "one file, no naming scheme" position, and the
  reason is that these turned out to be two artifacts rather than one file in two places. The
  original objection — per-target names accumulating unpruned — applies to a decision aid,
  which is worthless the moment you have decided. It does not apply to a **record of a
  destructive act**: audit trails are supposed to accumulate. **No cap**, deliberately —
  they are a few KB of text against a tool that moves gigabytes, and a tool whose entire
  subject is "you decide what to retain" should not quietly prune the user's own records.

  Scoped **by set**, and by *location* rather than by filename: the set directory already
  holds that set's `snapshots/`, `exclude.txt` and `env`, so the scoping is free and needs no
  name mangling. Set rather than bucket because the deletion is set-scoped, two sets in one
  bucket produce genuinely different orphan lists, and set names are validated `[a-z0-9-]+`
  ([ADR-0024](../adr/0024-set-name-is-identity.md)) so they are safe path segments.

  **Second** precision in the timestamp, one unit finer than snapshot names' minute
  precision. A snapshot refuses a same-minute collision loudly; this would silently overwrite
  a record that, unlike a snapshot, *cannot be reproduced* — the snapshots it described are
  already gone. Seconds costs nothing and removes the case.

  A **`--force` run still files a record**, one that says the analysis was skipped. An audit
  trail that silently omits the runs which bypassed the safety is worse than one that names
  the gap.
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
Orphan preview — what no snapshot would reference once these are gone:

  2026-06-12T0915             3,201 files   12.4GB
  2026-06-19T0902               118 files    412MB
  2026-07-03T1140                 0 files       0B
  shared across 3 snapshots     842 files    3.1GB
                              ───────────────────────
  total orphaned              4,161 files   15.9GB

Full list:
  C:\Users\me\.s3cab\delete-orphans-preview.txt
```

Two counting rules the table depends on, both worth stating because they make the columns
*not* scale together: **files are paths** (what the user is deciding about, and what the
report lists), while **bytes are counted once per object** — dedup stores one copy however
many paths point at it.

**One layout whatever the snapshot count.** A single snapshot renders the same table, which
comes out as one row plus a total repeating it — mildly redundant, never unclear. Consistency
across runs is worth more than the two lines a special case saves, and it is one code path
with no threshold for anyone to learn.

### The report file carries no per-row size

The file answers *"am I about to lose the last copy of this file"*, and a size does not help
with that. Worse, a size column **actively misleads**: dedup stores one object for however
many paths point at it, so summing the column overstates the space involved, and the sum
disagrees with the summary's total. The one trustworthy figure is the total, so it lives in
the **header**, where it cannot be summed into something wrong — and it states files and
objects separately, which is where the dedup story now lives:

```
# 4,161 files, holding 15.9GB across 3,908 stored objects.
# (Fewer objects than files: identical content is stored once, however many
# files hold it — so the space freed is the object total, not the file count.)
```

This is preferred over charging each hash to the last snapshot that released it (the
sequential-simulation approach, which also works and needs no extra scan). Three reasons:
it is **order-independent** — the same selection always yields the same table, where
sequential attribution shifts with argument order; it **makes the shared category visible**,
teaching the model rather than needing a footnote; and it needs no "last referencing
snapshot" rule for anyone to learn. Cost is one pass counting references per hash within the
selection.

### An unreadable snapshot caveats the preview — it does not abort

A snapshot that will not decompress or parse has *unknown* references, so content it alone
holds looks orphaned when it is not. `cleanup` treats this as an abort ([interlock
#1](backup.md)) and is right to: it **deletes** off the back of those numbers, so a wrong
orphan set destroys live data.

`delete` is the opposite case and takes the opposite decision — **warn, name the snapshots,
and carry on.** Nothing is deleted from `objects/` here; the preview is advisory, and the
deletion the user asked for is unaffected by whether some *other* set's snapshot is damaged.
Refusing would let one damaged snapshot anywhere in the bucket block every deletion in it,
which is a worse failure than an overstated number the warning already flags. The direction
of the error is stated, not just its existence: the preview can only **overstate** what is
orphaned, never understate it, so acting on it is still safe.

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
`cleanup`; with the check in hand it *could* also say how much is reclaimable now and how
much is grace-held, instead of a vague "objects may still be stored". **Not built** — that
split needs each object's `lastModified`, which means a second whole-bucket enumeration
(`objects/`, the LIST `cleanup` does), doubling the cost of the check to refine a number the
user is not acting on at this moment. The preview says what would be orphaned; `cleanup` says
what is reclaimable *today*. Revisit if the two-command handoff proves confusing in use.

If the two-scans-per-session ever genuinely hurts, the smallest fix is a chain flag on
`delete` that runs the sweep in the same process reusing the scan — additive, and by then
there would be evidence rather than a guess.

## Settled while building

- **The artifact's filenames — provisional `last-delete.txt` rejected as too vague.** The
  names are now `delete-orphans-preview.txt` and `delete-orphans-<timestamp>.txt`, each
  saying outright what it holds. Rejected along the way: `last-delete-snapshot-orphaned-files.txt`,
  which **garden-paths** — "delete-snapshot-orphaned-files" parses as an imperative,
  *"delete the snapshot-orphaned files"*, so the name reads as a list of things to remove,
  which is precisely the misunderstanding the report must not create (see the Output
  section: `delete` removes none of them). `.txt` rather than `.tsv` although the body is
  tab-separated: it is written to be *read*, and `.txt` opens in an editor rather than a
  spreadsheet. Both live under `s3cabDir()`, so `S3CAB_HOME` relocates them with the rest of
  s3cab's local state.

- **`--force` stays `--force`/`-f`; `--no-check` rejected.** The self-documentation is real
  but bought too dearly. It would diverge from `upload --force`, which already means
  "bypass the protective default" here, leaving two spellings of one idea; `-f` is the
  entrenched short form (`rm -f`) and `--no-check` has none to offer; and it would be
  *inaccurate* — the flag skips the check **and** the confirmation, which travel together,
  so naming it after only the check describes half of what it does. `--force` names the
  category (bypass the safety) rather than one member of it.

- ~~Whether `-o` meaning a *file* here and a *directory* on `restore` is tolerable.~~
  ~~**Settled: it is.**~~ **Superseded: `delete` has no `-o` at all.**
  [ADR-0062](../adr/0062-bulk-operands-positional-addressing-by-flag.md)'s closing section
  kept `-o` but named the condition that would reopen it — *"if the report ever grows into
  something other than 'the long form of what you just read'"*. It did, in this design: the
  report became two artifacts, and the one worth keeping has a fixed, correct home in the set
  directory. `-o`'s stated justification was that concurrent deletes would clobber the single
  file; the audit trail solves that properly, since nothing of value is lost when a transient
  preview is overwritten. Dropping it also retires the file-vs-directory asymmetry with
  `restore -o` that the ADR had to argue its way out of. See that ADR's amendment.

- **Vocabulary deferred, deliberately.** A proposal to move **orphan** to the *file* side and
  call the object state **unreferenced** came up while building and is recorded in
  [proposals/misc.md](../../proposals/misc.md) — **not actioned here**. A rename spanning
  CONTEXT.md, `cleanup`, `render`, the guide and [backup.md](backup.md), landing inside a
  feature diff, makes that diff unreviewable. This design therefore uses `orphan` in both the
  file and object sense, as the current glossary does.

## Open

- **Retention policy** (keep-last / daily / weekly / monthly) remains deferred — it is the
  one open piece of the backup plan, waiting on real usage to show the shapes
  ([backup.md](backup.md)). This design deliberately adds no snapshot *selectors*
  (`--before`, `--keep-last`): those are retention policy through the back door.
