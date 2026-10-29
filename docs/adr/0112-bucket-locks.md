# Locks in the bucket keep uploads and deletes apart

**Status:** accepted & implemented (2026-10-29; proposed 2026-10-28). Replaces the 7-day grace
window and "don't clean up while a backup is running" (the [format spec](../../guide/format.md)
and [design/backup.md](../design/backup.md)).

## Context

Under objects first, snapshot last, what a running backup uploads, or skips because the bucket
already holds it, is referenced by nothing until its snapshot lands. To `cleanup` it is an orphan,
and `delete` removes referenced content on purpose. The grace window covered fresh uploads only:
an old object a backup skipped could still be deleted before the snapshot landed, leaving a
snapshot that can't be restored and a backup that exited 0. The model suite and the crash tier
both reproduce it (the `PIN` tests). `delete` was never covered at all.

One bucket holds sets from any number of machines, so "don't run cleanup while a backup is
running" asks for something its reader often can't see.

## Decision

**Uploads and deletes never overlap, on any machine.** An upload is `backup` or any form of
`upload`; a delete is `cleanup` or `delete`. Uploads don't exclude each other, and neither do
deletes: two cleanups, or a cleanup and a `delete`, can safely cross, as
[0090](0090-deletion-record-format-compaction.md) requires. Reading takes no lock.

### The lock

- **Key:** `locks/<kind>-<instant>`, the kind `upload` or `delete`, the instant UTC to the
  millisecond in ISO 8601's basic form: `locks/upload-20261027T140205.123Z`. Basic, because a
  colon in a key needs escaping when a request is signed, and ISO doesn't allow mixing the forms.
  The key without `locks/` is the lock's **id**.
- **Written with a no-overwrite PUT** (`If-None-Match: *`). On a 412, read the key back: if its
  bytes are the ones you sent, it is your own write, retried after a lost response, and the lock
  is yours. Otherwise another run took that instant: take a fresh one and write again.
- **Contents:** `KEY=value` lines, read as `.info` is read.
  ```
  COMMAND=backup
  SET=photos
  BY=allen@DESKTOP
  PID=18204
  STARTED=2026-10-27T14:02:05.123Z
  ```
  `COMMAND` is what is running. `SET` is there when the run is for one set, which every upload is
  except `upload --bucket`. `BY` is `user@machine`, as in `@SNAPSHOT BY`, and `PID` the process:
  together they say whose process holds the lock, the one thing a rule reads (below). `STARTED`
  is the key's instant in the extended form, the 24-character form `.info` uses. The rest is for
  people and messages.
- **A lock never expires.** Its age says nothing about whether its run is alive: a first backup
  runs for hours. 0048 rejected age-based breaking of the work file for the same reason. What
  does say so is the process, below.

### An upload

1. **Write the upload lock, before anything that decides what to skip.** Everything the run then
   sees in the bucket stays there until it ends, because no delete can start meanwhile.
2. **List `locks/`**, removing any leftover of this machine's (below).
3. **Any delete lock:** remove your own lock and refuse. Nothing has been touched.
4. **Upload**, objects first and the snapshot last.
5. **Remove the lock**, on any failure the run survives too, and on an interrupt (Ctrl+C, which
   first removes the lock, then quits; a second press quits at once). Only a hard stop — a
   crash, a power cut, a killed process, that second press — leaves it.

There is no `--wait`. A scheduled backup that refuses fails loudly, and the next schedule tries
again.

### A leftover lock

A lock a hard stop left must clear itself, but only a run that knows the lock is dead may remove
it. The lock's `BY` and `PID` say whose process holds it, and whether a process on this machine
is alive is the OS's to answer (`kill(pid, 0)`: `ESRCH` is gone; `EPERM` is alive, another
user's). So:

- **Every upload and delete, when it lists `locks/`, removes any lock whose `BY` is its own
  `user@machine` and whose process is gone**, and says so.
- **Another machine's lock is always taken as alive.** Nothing here can tell, so it is `unlock`'s.
- **A reused pid reads as alive**, so a dead lock stays until `unlock`: the error is a refusal,
  never a live lock removed.
- **Two machines with one `user@machine`** — a cloned machine ([0108](0108-set-ownership.md)'s
  known gap), or one username on two machines with one hostname — would each judge the other's
  locks by their own process table, and could remove a live one. Accepted: `user@machine` is the
  identity every record keeps, and the collision needs the same name on two machines sharing one
  bucket.
- **A lock a run couldn't remove** (it couldn't reach the bucket) is reported with the `unlock`
  command, and the run still succeeds: the next upload or delete from this machine removes it.
- **`--resume` keeps its one meaning**, the work file ([0092](0092-recover-the-interrupted-work-file.md));
  no run carries a flag for the lock.

0048 rejected a pid as a way to judge the work file, which only the next run of the same set on
the same machine ever meets: there the user's word, `--resume`, costs nothing and guesses
nothing. A lock in the bucket is met by every machine, and the pid is the one thing that lets a
machine tell its own dead runs from a live run anywhere else.

### Where s3cab takes the locks

Inside the lib operations that decide what to skip or delete, never in the commands that call
them: the fused backup pass (objects and snapshot in one pass, [0069](0069-fused-snapshot-upload-pipeline.md),
moved out of the `backup` command for this), `uploadSnapshot`, `uploadDir` and `uploadFile` take
the upload lock; `reclaim` (top up, delete orphans, compact) and `deleteContent` (record, then
delete) take the delete lock. A command parses, plans, confirms and renders; it cannot upload or
delete without passing through one of those, so no command carries a "takes the lock" flag, and
the lock's `COMMAND` is derived from the operation.

### A delete

Plan and confirm without a lock: cleanup's reading, listing, plan and y/N, and delete's checks and
typed bucket name. Then:

1. **Write the delete lock.**
2. **List `locks/`**, removing any leftover of this machine's.
3. **Any upload lock:** remove your own lock and refuse, naming each lock in plain words. With
   `--wait`, remove it, say which locks it is waiting on, wait 30 s and go back to step 1, with no
   limit, saying so again whenever the list changes. Holding the lock while waiting would turn
   away every backup that starts meanwhile: that is the drain below, an admin's choice, not a side
   effect.
4. **Cleanup only: top up.** List `snapshots/` again and read every snapshot key that was not in
   the listing the plan was built from: by key, never by name or time, because a snapshot is
   named for its start and lands hours later. Their objects leave the orphan plan and join the
   set compaction keeps rows for, and cleanup's damage checks apply to them: one that is
   unreadable, or has a refused row, aborts the run. No snapshot can land now, so this is final.
5. **Delete:**
   - `delete` writes its deletion record, then deletes.
   - `cleanup` deletes its orphans, then compacts the deletion record (0090), trimming against
     the topped-up set.
6. **Remove the lock**, on any failure the run survives too, and on an interrupt: a half-done
   cleanup leaves only orphans, and a half-done `delete` is explained by its record, so rerunning
   finishes either. Only a hard stop leaves it, for the next run from this machine, or `unlock`.

**Both sides write first and look second.** An upload and a delete that start together each see
the other's lock, so at worst both refuse. If either looked first, both could see nothing and
carry on.

### `unlock`

```
s3cab unlock --bucket <bucket> [<id>...] [-n|--dry-run] [-f|--force]
```

- It lists every lock in plain words (what is running, which set, which machine, since when),
  warns that removing a running command's lock lets a delete remove what a backup needs,
  silently, and asks y/N.
- It removes **exactly the locks it showed**, never one written after. Ids narrow the list.
- Without a terminal it needs `--force` and ids. `--force` always needs ids, so nothing can remove
  a lock nobody looked at.
- An id that names no lock is reported; the others are still removed, and the run exits 1.

### Draining a busy bucket

To get a cleanup in while backups keep starting, an admin denies `s3:PutObject` on
`<bucket>/locks/upload-*` to the identities that back up. New backups refuse at step 2, running
ones finish, the cleanup runs, and the deny comes off. This needs a provider whose policies can
deny, as AWS's can; elsewhere `--wait` is the only way in. It is documented, not built.

### What the spec holds

- **The format spec gets** `locks/` in the layout, a section on locks that opens by telling a
  reader to skip it — the key, the lines, write first look second, and that a run may remove a
  lock from its own machine whose process is gone — the upload steps in the Uploading checklist
  and the delete steps in the Deleting checklist, with "write first, look second" and its reason
  beside each. The Reading checklist adds `locks/` to what a reader ignores.
- **Provider and permissions:** a listing shows a key written a moment before (AWS S3 has
  guaranteed it since December 2020), and every identity that uploads or deletes can put, delete
  and list under `locks/`. A run that can't remove its lock reports it; the next run from its
  machine, or `unlock`, removes it.
- **Left to each tool:** `--wait`, the messages, `unlock`.
- **Like `.info`, these are rules for tools that follow the spec,** not enforcement: anyone holding
  the bucket's write keys can ignore them.

### Rejected

- **Keeping the grace window as a backstop.** It guards against our own bugs, not a gap in the
  design, and testing is what guards against bugs.
- **An expiry or a lease.** See "A lock never expires".
- **Clearing a leftover by its `SET` and `BY`.** `upload` runs beside `backup` on the same set,
  so a match on those removes live locks; `BY` and `PID` name one process.
- **A local file instead of the pid** — this ADR's first form: a per-set `.upload.lock` holding
  the lock's id for the run's length, taken over with `--resume` after a hard stop, renamed
  `.upload.unlock` by a run that finished with its lock still in the bucket. It cleared only a
  set's own upload lock on its own machine, left a killed `cleanup`, `delete` or `upload --bucket`
  to `unlock`, needed the rename and an own-id check before every removal, and asked `--resume`
  of a run with nothing to resume. The pid clears every lock from the machine with nothing on
  disk.
- **A machine id, or the MAC address, in `BY` to tell two machines with one name apart.** A MAC
  changes with the adapter, and an id would be invented and kept for this alone; `user@machine`
  is the identity every record already keeps.
- **Deletes excluding each other.** Crossing is safe (0090), blocking it was reversed once
  already ([0087](0087-deletion-record-suffix-on-collision.md)), and the tie-break it needs can't
  be made sound: an id is chosen before its PUT lands, so two deletes can each see only a later
  one.
- **Keeping a delete's lock after a failure it survives.** It stops every backup on every machine
  until someone notices, and there is nothing to inspect first.
- **A delete lock for the whole run.** Planning only reads, and the top-up makes its result final.
- **Splitting cleanup into "list orphans" and a separate delete.** The top-up keeps one command
  and costs only the reading of the new snapshots.
- **Waiting by default, asking at a terminal whether to wait, or a limit on `--wait`.** A deleter
  refuses at once unless told to wait, a prompt shouldn't stand in for a flag, and whoever asks to
  wait can stop it, or wrap it in `timeout`.
- **The set or the machine in the key, or a random suffix.** Millisecond time and the
  no-overwrite PUT make the id unique, and `user@machine` can hold any character.
- **`unlock --all`.** Nobody would have looked at what it removes.
- **A typed bucket name to confirm `unlock`.** The y/N already shows each lock's machine and age,
  which is what the decision needs.

## Consequences

- **Tests:** the four interleave tests in `test/crash/concurrency.test.mjs` and
  `test/model/model.findings.test.mjs` flip to assert refusal, as does the crash tier's safe arm
  where a cleanup succeeds beside a held backup. The cleanup-against-cleanup arm stays as it is.
  The grace window's machinery goes: `GRACE_MS`, `S3CAB_XGRACE_MS` and `test/crash/killswitch.mjs`'s
  rewrite of it, the crash test that ages objects past it, and the model harness's virtual object
  age (`test/model/harness/runner.mjs`, `fake-s3.mjs`, `test/model/CAPABILITIES.md`).
- **A cleanup can now delete a crashed backup's fresh orphans,** which the grace window used to
  keep. The retried backup uploads them again: it costs time, never data, because step 2 comes
  before anything decides what to skip.
- **A hard stop anywhere before the snapshot lands leaves the lock**, and the next backup,
  upload, cleanup or delete from that machine removes it, saying so.
- **The seeding gap:** a cleanup between `upload --dir` and the first backup deletes the seeds,
  and the backup uploads them again. The guide says so: it's for the people sharing a bucket to
  avoid, not something to build for.
- **For `delete`, the lock closes the race with a running backup,** where a backup skips an
  object the delete then removes. It doesn't close the silent cross-set case of
  `proposals/concurrency-and-locking.md`: a snapshot of another set that lands between `find` and
  the delete lock still has its gap explained away by the record. That stays 0089's accepted
  consequence.
- **Older s3cab versions, and tools written to the earlier spec, take no locks.** With the grace
  window gone, a new cleanup can delete an old client's in-flight uploads, so the guide says to
  upgrade every machine before cleaning up.
- **Docs:** `guide/format.md` as above, losing the two rules under "objects first, snapshot last";
  `guide/maintenance.md` (locks, `--wait`, `unlock`, draining, the seeding gap, upgrading every
  machine); `guide/aws.md` (the `locks/` permissions); `GLOSSARY.md` (Lock, Upload lock and
  Delete lock in; Grace window out); `docs/design/backup.md`'s grace-window and
  residual-race bullets; `docs/design/repository-protocol.md`'s cleanup steps and its "the ordering
  … is itself a guard"; `docs/design/snapshot-deletion.md`; forward pointers in 0069 and 0104;
  `test/README.md`; the grace window in `.github/workflows/nightly.yml` and
  `proposals/cleanroom-fixtures.md`; the header comments of `src/lib/bucket-scan.mjs` and
  `src/commands/cleanup.mjs`; `inProgressError`'s "if no snapshot or backup … is running", which
  gains upload; items 1 and 3 of `proposals/concurrency-and-locking.md` go.
