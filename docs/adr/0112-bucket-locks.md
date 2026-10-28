# Locks in the bucket keep uploads and deletes apart

**Status:** proposed (2026-10-28). Replaces the 7-day grace window and "don't clean up while a
backup is running" (the [format spec](../../guide/format.md) and
[design/backup.md](../design/backup.md)). Leaves [0048](0048-snapshot-lock-atomic-temp-file.md)'s
local work-file lock as it is.

## Context

Under objects first, snapshot last, what a running backup uploads, or skips because the bucket
already holds it, is referenced by nothing until its snapshot lands. To `cleanup` it is an orphan,
and `delete` removes referenced content on purpose. The grace window covered fresh uploads only:
an old object a backup skipped could still be deleted before the snapshot landed, leaving a
snapshot that can't be restored and a backup that exited 0. The model suite and the crash tier
both reproduce it (the `PIN` tests). `delete` was never covered at all, and in its cross-set case
the deletion record explains the gap away, so nobody is told.

One bucket holds sets from any number of machines, so "don't run cleanup while a backup is
running" asks for something its reader often can't see.

## Decision

**Uploads and deletes never overlap, on any machine.** An upload is `backup` or any form of
`upload`; a delete is `cleanup` or `delete`. Uploads don't exclude each other; deletes do, so two
cleanups can't cross either. Reading takes no lock.

### The lock

- **Key:** `locks/<kind>-<instant>`, the kind `upload` or `delete`, the instant UTC to the
  millisecond in ISO 8601's basic form: `locks/upload-20261027T140205.123Z`. Basic, because a
  colon in a key needs escaping when a request is signed, and ISO doesn't allow mixing the forms.
  The key without `locks/` is the lock's **id**.
- **Written with a no-overwrite PUT** (`If-None-Match: *`). A 412 means another run took that
  instant: take a fresh one and write again. So no two locks share an id, and comparing ids as
  text puts them in time order.
- **Contents:** `KEY=value` lines, read as `.info` is read.
  ```
  COMMAND=backup
  SET=photos
  BY=allen@DESKTOP
  STARTED=2026-10-27T14:02:05.123Z
  ```
  `COMMAND` is what is running. `SET` is there when the run is for one set, which every upload is
  except `upload --bucket`. `BY` is `user@machine`, as in `@SNAPSHOT BY`. `STARTED` is the key's
  instant in the extended form, the 24-character form `.info` uses.
- **A lock never expires.** Its age says nothing about whether its run is alive: a first backup
  runs for hours. 0048 rejected age-based breaking of the local lock for the same reason.

### An upload

1. **Write the upload lock, before anything that decides what to skip.** Everything the run
   then sees in the bucket stays there until it ends, because no delete can start meanwhile.
2. **List `locks/`.**
3. **Any delete lock:** remove your own lock and refuse. Nothing has been touched.
4. **s3cab only: take the local work-file lock** (0048).
5. **Remove any other upload lock with your `SET` and `BY`.** It is a dead earlier run of this
   one: the local lock proves nothing else on this machine is running it.
6. **Upload**, objects first and the snapshot last.
7. **Remove the lock**, on a failure too when the bucket can still be reached. A crash leaves it,
   and step 5 of that set's next run clears it.

There is no `--wait`. A scheduled backup that refuses fails loudly, and the next schedule tries
again.

### A delete

Plan and confirm without a lock: cleanup's reading, listing, plan and y/N, and delete's checks and
typed bucket name. Then:

1. **Write the delete lock.**
2. **List `locks/`.**
3. **Any upload lock, or a delete lock with a lower id:** remove your own lock and refuse, naming
   each lock. With `--wait`, remove it, wait 30 s and go back to step 1. Holding it while waiting
   would turn away every backup that starts meanwhile. That is the drain below, and turning
   backups away should be an admin's choice, not a side effect.
4. **Cleanup only: top up.** List `snapshots/` again, read every snapshot that landed since the
   plan, and drop its objects from the plan. No snapshot can land now, so the plan is final.
   A backup that ran entirely between the plan and step 1 is caught here.
5. **Write the deletion record**, before any delete, as now.
6. **Delete.**
7. **Remove the lock, on success only.** Any failure after step 3, Ctrl+C included, leaves the
   lock, and the message names it and `unlock`: a half-done delete is worth a look before
   backups resume.

**Both sides write first and look second.** Two runs that start together each see the other's
lock, so at worst both refuse. If either looked first, both could see nothing and carry on.

### `unlock`

```
s3cab unlock --bucket <bucket> [<id>...] [-n|--dry-run] [-f|--force]
```

- It lists every lock (id, command, set, by, age), warns that removing a running command's lock
  lets a delete remove what a backup needs, silently, and asks y/N.
- It removes **exactly the locks it showed**, never one written after. Ids narrow the list.
- Without a terminal it needs `--force` **and** ids, so a script can't remove a lock nobody looked at.
- An id that names no lock is reported, and the run exits 1.

### Draining a busy bucket

To get a cleanup in while backups keep starting, an admin denies `s3:PutObject` on
`<bucket>/locks/upload-*` to the identities that back up. New backups refuse at step 1, running
ones finish, the cleanup runs, and the deny comes off. This is documented, not built.

### What the spec holds

- **The format spec gets** `locks/` in the layout, a section on locks that opens by telling a
  reader to skip it, the upload steps in the Uploading checklist and the delete steps in the
  Deleting checklist, with step 1's reason beside each. The Reading checklist adds `locks/` to
  what a reader ignores.
- **A new provider requirement:** a listing shows a key written a moment before. AWS S3 has
  guaranteed it since December 2020.
- **Left to each tool:** the local lock, `--wait`, the messages, `unlock`, and removing a lock on
  a failure.
- **Like `.info`, these are rules for tools that follow the spec,** not enforcement: anyone holding
  the bucket's write keys can ignore them.

### Rejected

- **Keeping the grace window as a backstop.** It guards against our own bugs, not a gap in the
  design, and testing is what guards against bugs.
- **An expiry or a lease.** See "A lock never expires".
- **A delete lock for the whole run.** Planning only reads, and the top-up makes its result final.
- **Splitting cleanup into "list orphans" and a separate delete.** The top-up keeps one command
  and costs only the reading of the new snapshots.
- **Waiting by default, or asking at a terminal whether to wait.** A deleter refuses at once unless
  given `--wait`, and a prompt shouldn't stand in for a flag.
- **The set or the machine in the key, or a random suffix.** Millisecond time and the
  no-overwrite PUT make the id unique, and `user@machine` can hold any character.
- **`unlock --all`, or removing whatever is there.** It would remove a lock written after the user
  looked.

## Consequences

- **The two `PIN` tests flip to assert refusal** (in `test/crash/concurrency.test.mjs` and
  `test/model/model.findings.test.mjs`). `GRACE_MS` and the `S3CAB_XGRACE_MS` test instrument go,
  and so does cleanup's "Don't run cleanup while a backup is running".
- **A cleanup can now delete a crashed backup's fresh orphans,** which the grace window used to
  keep. The retried backup uploads them again: it costs time, never data, because step 1 comes
  before anything decides what to skip.
- **The seeding gap:** a cleanup between `upload --dir` and the first backup deletes the seeds,
  and the backup uploads them again. The guide says so: it's for the people sharing a bucket to
  avoid, not something to build for.
- **0064's judgement that `delete`'s race degrades safely** no longer matters: the race is gone,
  the cross-set case with it. So is the forget-then-cleanup interleave, because the cleanup meets
  the backup's lock.
- **Docs:** `guide/format.md` as above, losing the two rules under "objects first, snapshot last";
  `guide/maintenance.md` (locks, `--wait`, `unlock`, draining, the seeding gap);
  `GLOSSARY.md` (Lock, Upload lock and Delete lock in; Grace window out); the grace-window and
  residual-race bullets in `docs/design/backup.md`; items 1 and 3 of
  `proposals/concurrency-and-locking.md` go.
