---
name: cleanroom
description: >-
  Drive s3cab's clean-room exercise (ADR-0096) from the repo session: plan a
  round, build a room, hand it over, then check, harvest and destroy it. Use when
  asked to start, continue or plan clean-room work: "start clean room", "next
  clean room", "clean-room shakedown", "run the snapshot room on Windows". Not for
  changing the harness itself.
---

# Clean-room runs

Read [scripts/cleanroom/README.md](../../../scripts/cleanroom/README.md) first. It
holds the commands, the buckets, and the rules that differ by purpose (model,
effort, what is kept). This file is only the procedure. Where they disagree, the
README wins; fix this file.

**This session never is the clean room.** It sits in the repo and can read
everything; the room's session must read nothing but what the build hands it. So
every room has a stop in the middle, where the user opens that session.

## A run is three choices

- **Purpose**: shakedown, real, or comparison (README).
- **Role**: snapshot, upload, or restore.
- **Platform**: the machine this session runs on. A room is built, run, checked
  and destroyed on one machine.

Ask for any that wasn't given. Given none, propose the next room of the round and
stop for a yes.

## A round

Snapshot, then upload, then restore, each on every platform the user has. Snapshot
and upload are always separate rooms (ADR-0096). Comparison runs are the snapshot
role only. The shakedown round comes first; the real round starts once its fixes
have landed and the spec is frozen.

## Preflight, once per round and after any harness change

- `main` is clean and up to date.
- Each checker the round will use has been seen to **fail**: given s3cab's own
  output it passes, and given that output with one row changed it fails. A checker
  never seen failing proves nothing by passing.
- Restore role: the restore bucket's stamp matches (the build refuses otherwise).
  If not, it is reseeded from WSL, per the README.

Report, and stop.

## One room

1. **Build** with the role's command from the README. An upload empties the backup
   bucket first. The sandbox root must not exist: if a stale one does, show what
   is in it and ask before deleting it.
2. **Hand over, and stop.** Tell the user: open a new Claude Code session in
   `<root>/cleanroom`, set `/model` and `/effort` for the purpose, check that
   `/effort` shows the level, and say "go". Then wait for them to say it's done.
3. **Check** with the role's checker, before anything is moved or deleted. Show its
   output in full.
4. **Harvest** by purpose:
   - *real*: the program and report go where the README says, the report under the
     next audit number, naming model and effort, and its list diffed against the
     previous run's.
   - *shakedown*: nothing enters the repo. Read the report and list what it found
     as harness faults and spec errors to fix.
   - *comparison*: nothing enters the repo. Copy the report to a place outside it
     that the user names, for judging with the model names hidden.
5. **Destroy** the sandbox, and stop.

Report each step as: *as planned*, *new*, *next*. Nothing is committed without the
user's word.
