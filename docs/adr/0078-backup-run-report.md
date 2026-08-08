# What a completed backup reports

**Status:** proposed — designed 2026-08-08, **not built**. Nothing below describes live
behaviour. Extends [0043](0043-human-first-output.md)'s human-first rendering and
[0076](0076-one-progress-line-driven-by-a-clock.md)'s *live* line to the **finished run**, and
depends on [0027](0027-compare-local-only-adoption-syncs-manifests.md) keeping `compare` local.

## Context

A backup's whole report is its closing line:

```
Backed up 'onedrive' (snapshot 2026-08-08T0206): uploaded 426 objects
```

Which leaves a user who has just waited 11 minutes unable to say what the run *did*. The
question that opened this (user, 2026-08-08) was "s3cab used to print each file as it went, like
rsync — why not any more?" It didn't: [0076](0076-one-progress-line-driven-by-a-clock.md)
retired a wall of *leftover per-file byte bars*, not a log. The real want underneath was **"some
idea what it had just done"**, which is a different question and has a different answer.

Four facts shaped the design, all found in the code and in a real set:

- **`compare` already answers it.** Bare `s3cab compare` diffs the latest snapshot against the
  one before — run after a backup, that *is* the run's report. It was one command away the whole
  time and nothing pointed at it.
- **Objects are not files.** `426 objects` counts content blobs PUT to S3. Content-addressed
  dedup ([0001](0001-file-level-content-addressable-dedup.md)) means a moved file changes
  everything and uploads nothing, and one object can serve many new paths. The user's question
  was about files; the existing line answers about objects.
- **Two silent categories, both real in a live set.** The `#SKIPPED` rows are parsed into
  `Snapshot.skipped` "so callers can report what was ignored" and **no caller exists**;
  `#ERROR` rows are surfaced only by `compare`. In the set that prompted this,
  `D:\OneDrive\Personal Vault` was skipped on 08-08 and absent from the 08-01 snapshot — the
  skipped set changed between runs and nothing said so — and an EBUSY file had failed on *every*
  run without ever being mentioned. This is the "a backup quietly holding less than you think"
  failure [`walk.mjs`](../../src/lib/walk.mjs) already calls the one this tool can least afford.
- **Excluded files are different in kind.** `#EXCLUDED` rows are written and **ignored on read**,
  so `compare` can never show them — but they are also the one category the user *chose*.

## Decision

**A finished backup reports in files, prints in full only what it alone knows, and hands the
detail to `compare`.**

1. **The report is about files, not objects.** The object counts stay — they are the transfer —
   but they no longer stand in for what happened.

2. **The dividing line.** `backup` prints **in full** only what **only `backup` can know**:
   objects uploaded, bytes, elapsed times, drift, baseline trust, excluded files. Everything the
   **snapshot** holds — added / modified / deleted / moved / skipped / errored — is a **count plus
   a copy-pasteable command**. The snapshot is permanent, so nothing is ever lost by not printing
   it; the command is what makes recovery work, because bare `compare` stops meaning "that run"
   as soon as another backup lands.

3. **`compare` gains skipped items, listed in full, not diffed.** Full listing is what lets a
   user answer "what *was* that symlink?" on any run, not just the one where it first appeared.
   Recurring noise is then a signal to add an exclude pattern — the design working, not a cost.

4. **Two closing blocks, because they are different in kind.** A diff against the baseline, and
   facts about this snapshot:

   ```
   Backed up 'onedrive' → snapshot 2026-08-08T0206
   Hashed 1.8TB in 9m 12s, uploaded 426 objects (14.9GB) in 2m 12s
   Changes since 2026-08-01T0846: 425 added, 1 modified, 0 deleted, 0 moved
   Couldn't be backed up: 1 skipped, 1 error
     s3cab compare --since 2026-08-01T0846 --until 2026-08-08T0206
   ```

   `Changes since` names the baseline: "425 added" is meaningless without *since when*. `moved`
   is included so a large reorganisation doesn't read as "nothing happened" beside
   `uploaded 0 objects`. The heading is **`Couldn't`**, not "Not backed up" — excluded files are
   also not backed up, in their thousands, and the distinction that matters is *didn't choose to*
   versus *couldn't*.

5. **Interactive runs are offered the detail; the pointer prints either way.** A
   `Show what changed? [y/N]` prompt via the existing `promptYesNo` (default **No** — the shared
   helper's invariant serves `forget`/`cleanup` and is not worth a variant to save one keystroke).
   A yes renders the **already-in-memory** `CompareResult` through `renderCompareResult` — the same
   renderer `compare` uses — to **stdout**, since output the user asked for is output
   ([0010](0010-cli-output-conventions.md)).

6. **An unattended run prints the same thing minus the prompt.** One output shape, not two: the
   scheduled run's log gets the counts and the command, and the snapshot on disk holds the rest.
   Dumping a full diff into a cron mail is [0076](0076-one-progress-line-driven-by-a-clock.md)'s
   wall-of-bars mistake in new clothes.

7. **A first backup runs no compare at all** — `First backup of 'onedrive' — 266,121 files`, no
   prompt. There is no "what changed" question, and it is the one run where building the diff is
   most expensive (every file is an `AddedEntry`) and least informative. The
   `Couldn't be backed up` block still prints; it matters *more* on a first run.

8. **One computation, not two.** The counts come from `compareSnapshots` re-reading the snapshot
   just written, with the baseline handed in pre-parsed from memory (it already accepts that
   form). Accumulating the diff during the fused pass would be cheaper and would reimplement
   `compare` — and a summary reading `425 added` above a command that lists 424 is a trust bug in
   the one place this design asks for trust. One parse of a file still in the page cache is the
   price of "these cannot diverge".

9. **Hash time and upload time are reported separately.** The fused pass
   ([0069](0069-fused-snapshot-upload-pipeline.md)) is strictly sequential — `uploadObjects`
   awaits each PUT before yielding the row — so two accumulators sum to the pass exactly. One
   figure for both makes 14.9GB in 11m 24s read as a 22MB/s link when the time went on reading
   1.8TB off the disk, and "is my disk slow or my upload slow" is the whole diagnostic question.

10. **All of it lands in `BackupResult`**, so `--json` gains the counts and times deliberately
    rather than by accident. A renderer that computes its own facts is what
    [0043](0043-human-first-output.md) exists to prevent.

11. **The preamble names the destination bucket**, on a second line. Today the bucket is named
    only by the store LIST's line, which fires *only* when there is no trusted baseline — so
    s3cab names it on a first backup and never again.

## Consequences

- **`generateSnapshot` widens.** It returns `{name, path}` and discards the counts and timings
  this needs.
- **`s3cab backup --json` gains fields.** A public output-shape commitment, made on purpose.
- **The walk's mid-run skipped line stays**, and previews what the closing block repeats. It is
  `walkSet`'s, shared with `tree` ([`tree.mjs`](../../src/commands/tree.mjs)), and suppressing it
  for one caller means threading a flag through two functions for that caller alone — working
  rule #3. The repetition costs one line at the top of a long run.
- **[0076](0076-one-progress-line-driven-by-a-clock.md) §4 gains a sentence when this is built,
  not before** — it is marked implemented, and an unbuilt clause inside it would be exactly the
  drift the documentation-discipline rule forbids.
- **Out of scope, captured in [proposals/](../../proposals/):** `tree --excluded` (exclusion
  discoverability — the data is computed on every walk and discarded), and the progress line's
  in-flight detail (the "what *is* it uploading?" question, which is about the live line, not the
  report).
