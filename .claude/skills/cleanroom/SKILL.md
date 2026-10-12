---
name: cleanroom
description: >-
  Drive s3cab's clean-room exercise (ADR-0096) from the repo session: plan the
  runs, build a sandbox, hand it over, then check, harvest and destroy it. Use
  when asked to start, continue or plan clean-room work: "start clean room",
  "next clean room", "run the snapshot clean room on Windows". Not for
  changing the harness itself.
---

# Clean-room runs

Read [scripts/cleanroom/README.md](../../../scripts/cleanroom/README.md) first. It
holds the commands, the buckets, and the rules for model, effort and what is
recorded. This file is only the procedure. Where they disagree, the README wins;
fix this file.

**This session never is the clean room.** It sits in the repo and can read
everything; the clean room's session must read nothing but what the build hands
it. So every run has a stop in the middle, where the user opens that session.

## A run is two choices

- **Role**: snapshot, upload, or restore.
- **Platform**: the machine this session runs on. A sandbox is built, run, checked
  and destroyed on one machine.

The user picks the model and effort when opening the clean room's session; whether
the run is recorded is decided at the end (step 4). Ask for a role if none was
given; given none, propose the next run and stop for a yes.

## Experiments, then a real set

Experiments come first, on any model at any effort, until the process runs
smoothly; then a real set, on one model at `xhigh` (README). Either way the order
is snapshot, then upload, then restore, each on every platform the user has.
Snapshot and upload are always separate clean rooms (ADR-0096). During a real set
the spec is frozen: findings are collected, and nothing in `guide/` changes until
its last run.

Seeding the golden set is **not** part of either. It happens on Linux or WSL
whenever the spec or the fixtures change; a restore run on any platform needs only
a matching stamp, never the backup runs before it.

## Preflight, before a real set and after any harness change

- `main` is clean and up to date.
- Each checker the runs will use has been seen to **fail**: given s3cab's own
  output it passes, and given that output with one row changed it fails. A checker
  never seen failing proves nothing by passing.
- Restore role: the restore bucket's stamp matches (the build refuses otherwise).
  If not, stop: reseeding is its own step, from Linux or WSL, per the README.

Report, and stop.

## One run

1. **Build** with the role's command from the README. An upload empties the backup
   bucket first. The sandbox root must not exist: if a stale one does, show what
   is in it and ask before deleting it.
2. **Hand over, and stop.** Tell the user: open a new Claude Code session in
   `<root>/cleanroom`, set `/model` and `/effort`, check that `/effort` shows the
   level, and say "go". Then wait for them to say it's done.
3. **Check** with the role's checker and `audit-transcript.mjs`, before anything is
   moved or deleted. Show both outputs in full. A stray the audit lists voids the
   run whatever the checker says; its token totals go in the step's report.
4. **Harvest.** Check the model and effort in the audit's output, then:
   - *a real set's run with a clean audit is recorded*: the program and report go
     where the README says, the report under the next audit number, and its list
     diffed against the last set's. Its findings wait for the set's last run.
   - *anything else is an experiment*: nothing enters the repo. List what the report
     found as harness faults and spec errors to fix. If the user is comparing runs,
     first copy the report and its token totals to a place outside the repo that
     they name.
5. **Destroy** the sandbox, and stop.

Report each step as: *as planned*, *new*, *next*. Nothing is committed without the
user's word.
