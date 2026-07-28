# Concurrency & locking

Epic: the places where two s3cab runs — or one crashed run and its successor — can step on
each other. **To revisit before release** (user call, 2026-07-18): the backup/cleanup race
below sits uncomfortably as a documented "don't do that", and a lock file may well be the
answer for both items here.

Both items were previously scattered — the race was documented only in
[docs/design/backup.md](../docs/design/backup.md) as an accepted caveat, the temp-file half in
`engine-robustness.md` — but they are one subject: s3cab has no locking anywhere, and the two
symptoms differ only in whether the contended resource is remote or local.

## 1. `cleanup` can delete an object a running `backup` is relying on

**The race.** Under objects-first/snapshot-last, a backup uploads objects and only then
publishes the snapshot referencing them. A concurrent `cleanup` marks from published snapshots
only, so anything uploaded-but-not-yet-referenced looks exactly like an orphan.

**What already protects it.** The fixed 7-day **grace window**
([src/lib/cleanup.mjs:21](../src/lib/cleanup.mjs#L21)) — no object younger than a week is ever
swept, so a normal in-flight backup is safe without a lock. There is deliberately no `--grace`
knob.

**The residual hole the grace window does _not_ cover.** An **old** object (past grace —
typically a crash orphan from weeks back) that a running backup *skips uploading* because the
conditional PUT shows it already present, deleted by cleanup in the gap between that skip and
the snapshot upload. The published snapshot then references an object that is gone.

**Not single-user.** One repository is one bucket holding multiple sets from any number of
users and machines ([ADR-0013](../docs/adr/0013-one-repository-one-bucket.md)), so this is a
cross-machine race, not just a two-terminals-on-one-laptop one — and scheduled backups make it
likelier. A single user running commands one at a time essentially cannot hit it.

**Current stance** (docs/design/backup.md): locking was judged over-engineering for this
audience; instead "don't run cleanup while a backup is running", said in cleanup's output. The
design doc says explicitly: *do not "optimize away" the grace window or this warning.* Versioning
backstops it anyway — the delete is soft and recoverable, and `verify` reports the result as
`missing`. **Revisiting that stance is the point of this epic**; if it changes, amend
docs/design/backup.md.

## 2. Stale temp-file recovery (the local half)

A crashed or interrupted snapshot leaves `.snapshot.tsv.zst` behind, and every later snapshot
fails until the user hand-deletes it.

The wrinkle: that temp file does **double duty** — it is both the orphan-on-death *and* the
crude in-progress **lock** (`withSnapshotFile` refuses to run if it exists). That is exactly
why a naive "stale temp → delete it" sweep on startup is unsafe: it cannot tell a dead run's
orphan from a concurrent live run.

The robust fix breaks the double duty so the two become distinguishable:

- a **unique temp name per run** (timestamp/PID in the name), so an orphan never collides with
  a live run and any run can sweep strays on startup; or
- a real **lock file** with a PID + liveness check.

Ties into the known lock-file TODO in `snapshot.mjs`.

**Note (2026-06-26): a SIGINT handler is the wrong tool for this** — it only catches Ctrl+C,
not a crash/SIGTERM/power-loss, so the robust startup-sweep layer has to exist regardless, and
then covers the Ctrl+C case too.

**Orthogonal (2026-07-28):** [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md) *does* use
a SIGINT handler — but for a different job (parking a read-only hash lookup on a graceful stop),
not for sweeping this stale lock, which it leaves untouched. That verdict above still holds for
*this* item; the two don't collide.

## If a lock is the answer, it has to answer both

_My framing, not a decision taken._ Item 2's lock is **local** (a file beside the snapshot, PID
liveness works). Item 1's is **remote and cross-machine** — a lock object in the bucket, with
no PID to check liveness against, needing a lease/expiry so a crashed machine cannot wedge
everyone else's cleanup forever. They are not the same mechanism, and item 1 is much the harder
of the two. Worth deciding whether to solve them together or accept two designs.
