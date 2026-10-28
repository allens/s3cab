# Locks in the bucket keep uploads and deletes apart

**Status:** proposed (2026-10-28). Replaces the 7-day grace window and "don't clean up while a
backup is running" (the [format spec](../../guide/format.md) and
[design/backup.md](../design/backup.md)). Amends [0048](0048-snapshot-lock-atomic-temp-file.md):
uploads also hold a second local file, the run lock.

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
  STARTED=2026-10-27T14:02:05.123Z
  ```
  `COMMAND` is what is running. `SET` is there when the run is for one set, which every upload is
  except `upload --bucket`. `BY` is `user@machine`, as in `@SNAPSHOT BY`. `STARTED` is the key's
  instant in the extended form, the 24-character form `.info` uses. They are for people and
  messages: no rule matches on them.
- **A lock never expires.** Its age says nothing about whether its run is alive: a first backup
  runs for hours. 0048 rejected age-based breaking of the local lock for the same reason.

### An upload

1. **s3cab only: take the set's run lock** (below). If it is held, refuse.
2. **Write the upload lock, before anything that decides what to skip.** Everything the run then
   sees in the bucket stays there until it ends, because no delete can start meanwhile.
3. **List `locks/`.**
4. **Any delete lock:** remove your own lock and refuse. Nothing has been touched.
5. **Upload**, objects first and the snapshot last.
6. **Remove the lock**, on any failure the run survives too. Only a hard stop (a crash, a power
   cut, a second Ctrl+C) leaves it.

There is no `--wait`. A scheduled backup that refuses fails loudly, and the next schedule tries
again.

### The run lock (s3cab's, not the spec's)

A crashed upload's lock must clear itself, but only a run that knows the lock is dead may remove
it. Matching on `SET` and `BY` can't know: `upload` runs beside `backup` on the same set, and a
cloned machine shares `user@machine`
([0108](0108-set-ownership.md)'s known gap). So every upload for a set holds a per-set **run
lock**, `~/.s3cab/sets/<set>/run-lock`:

- **Created atomically** (`open(…, "wx")`, as 0048), before step 2, and removed after step 6. It
  spans the whole time the upload lock exists, which 0048's work file does not: that becomes the
  snapshot before the snapshot is uploaded.
- **It records the upload lock's id**, written before the PUT, so a crash at any point leaves
  the id behind; an id that names no lock is harmless to remove.
- **A run that ends with its upload lock still in the bucket** (it couldn't reach it) releases
  the run lock but leaves the id for the next run, which removes that lock once it holds the run
  lock.
- **A hard stop leaves the run lock itself.** The next upload of that set refuses, as a leftover
  work file makes it refuse today, and says so in plain words. `--resume`, which `backup` already
  has and every set-scoped `upload` form gains, is the user's word that nothing is running: the
  run takes the run lock over and removes the upload lock it records. For a `backup` this is the
  same `--resume` the leftover work file already asks for, so nothing new is asked.
- **`upload --bucket` has no set,** so no run lock: its hard stop leaves a lock for `unlock`.

0048 rejected a second local file because everything its content bought was liveness guessing.
This one guesses nothing: whether the run is dead is the user's word, as for the work file, and
the content is only what to clear up once it is.

### A delete

Plan and confirm without a lock: cleanup's reading, listing, plan and y/N, and delete's checks and
typed bucket name. Then:

1. **Write the delete lock.**
2. **List `locks/`.**
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
6. **Remove the lock**, on any failure the run survives too: a half-done cleanup leaves only
   orphans, and a half-done `delete` is explained by its record, so rerunning finishes either.
   Only a hard stop leaves it, and then `unlock` clears it.

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
  reader to skip it, the upload steps in the Uploading checklist and the delete steps in the
  Deleting checklist, with "write first, look second" and its reason beside each. The Reading
  checklist adds `locks/` to what a reader ignores.
- **Provider and permissions:** a listing shows a key written a moment before (AWS S3 has
  guaranteed it since December 2020), and every identity that uploads or deletes can put, delete
  and list under `locks/`. An upload that can't remove its lock reports it and leaves it for
  `unlock`.
- **Left to each tool:** the run lock, `--wait`, the messages, `unlock`.
- **Like `.info`, these are rules for tools that follow the spec,** not enforcement: anyone holding
  the bucket's write keys can ignore them.

### Rejected

- **Keeping the grace window as a backstop.** It guards against our own bugs, not a gap in the
  design, and testing is what guards against bugs.
- **An expiry or a lease.** See "A lock never expires".
- **Clearing a crashed upload's lock by its `SET` and `BY`.** It removes live locks: see the run
  lock.
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
- **A hard stop between the work file's rename and the snapshot's upload** used to leave nothing;
  now it leaves the run lock, so the next backup asks for `--resume`.
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
  machine); `guide/aws.md` (the `locks/` permissions); `GLOSSARY.md` (Lock, Upload lock, Delete
  lock and Run lock in; Grace window out); `docs/design/backup.md`'s grace-window and
  residual-race bullets; `docs/design/repository-protocol.md`'s cleanup steps and its "the ordering
  … is itself a guard"; `docs/design/snapshot-deletion.md`; forward pointers in 0069 and 0104;
  `test/README.md`; the grace window in `.github/workflows/nightly.yml` and
  `proposals/cleanroom-fixtures.md`; the header comments of `src/lib/bucket-scan.mjs` and
  `src/commands/cleanup.mjs`; `inProgressError`'s "if no snapshot or backup … is running", which
  gains upload; items 1 and 3 of `proposals/concurrency-and-locking.md` go.
