---
name: cleanroom
description: >-
  Drive s3cab's clean-room exercise (ADR-0096) from the repo session: plan the
  runs, build a sandbox, run it headless, then check, harvest and destroy it. Use
  when asked to start, continue or plan clean-room work: "start clean room",
  "next clean room", "run the backup clean room on Windows". Not for
  changing the harness itself.
---

# Clean-room runs

Read [scripts/cleanroom/README.md](../../../scripts/cleanroom/README.md) first. It
holds the commands, the buckets, and the rules for model, effort and what is
recorded. This file is only the procedure. Where they disagree, the README wins;
fix this file.

**This session never is the clean room.** It sits in the repo and can read
everything; the clean room's session must read nothing but what the build hands
it. So the run is a separate, headless `claude` process that this session starts
in the sandbox and waits for.

## A run is two choices

- **Role**: backup or restore.
- **Platform**: the machine this session runs on. A sandbox is built, run, checked
  and destroyed on one machine.

The user picks the model and effort, and this session passes them to the run;
whether the run is recorded is decided at the end (step 4). Ask for a role if none was
given; given none, propose the next run and stop for a yes.

## Experiments, then a real set

Experiments come first, on any model at any effort, until the process runs
smoothly; then a real set, on one model at `xhigh` (README). Either way the order
is backup, then restore, each on every platform the user has. During a real set
the spec is frozen: findings are collected, and nothing in `guide/` changes until
its last run.

Seeding the golden set is **not** part of either. GitHub Actions does it whenever
the spec or the fixtures change on `main`; a restore run on any platform needs only
a matching stamp, never the backup runs before it.

## Preflight, before a real set and after any harness change

- `main` is clean and up to date.
- Each checker the runs will use has been seen to **fail**: given s3cab's own
  output it passes, and given that output with one row changed it fails. A checker
  never seen failing proves nothing by passing.
- Restore role: the restore bucket's stamp matches (the build refuses otherwise).
  If not, stop: reseeding is its own step, the seed workflow, per the README.

Report, and stop.

## One run

1. **Build** with the role's command from the README, on the platform's root there.
   Before a backup run, empty the backup bucket. The sandbox root must be empty: if
   anything is in it, show what and ask before deleting it.
2. **Run.** Start the README's headless command in the background, from
   `<root>/cleanroom`, with a fresh `--session-id` and the user's model and effort.
   Give the user the tail command for that session's transcript, then wait for the
   notification that it exited. A restore has a reconcile phase: run
   `reconcile-restore-cleanroom.mjs`, read any unexpected nonzero exit it lists, then
   resume the same session with the command it prints, and wait again.
3. **Check** with the role's checker and `audit-transcript.mjs`, before anything is
   moved or deleted, each output saved into the clean room as the README shows. Show
   both in full. A stray the audit lists voids the run whatever the checker says; its
   token totals, and their cost at API rates, go in the step's report.
4. **Harvest.** Check the model and effort in the audit's output, then:
   - *a real set's run with a clean audit is recorded*: the program and report go
     where the README says, the report under the next audit number, and its list
     diffed against the last set's. A restore's record gives both of the checker's
     verdicts, the spec-only one as the evidence about the format. Its findings wait
     for the set's last run.
   - *anything else is an experiment*: nothing enters the repo. List what the report
     found as harness faults and spec errors to fix.
5. **Keep and destroy.** Either way, move the clean room, credentials deleted, and a
   restore's `spec-only/` to
   `~/s3cab.experiments/<date>-<role>-<platform>-<model>-<effort>/` (README), then
   empty the sandbox, and stop.

Report each step as: *as planned*, *new*, *next*. Nothing is committed without the
user's word.
