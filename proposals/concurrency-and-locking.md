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

**Two sharpenings from the 2026-08-12 durability audit** (see
[bugs.md](bugs.md) for its provenance; the residual hole above was confirmed exactly as written,
by a cold read):

- **The stale-plan window is human-minutes, not milliseconds.** The interactive confirmation sits
  *between* the scan and the deletes, so the plan is already as old as the user's decision time
  by the time it executes. Any reasoning that treats this race as a narrow instant is measuring
  the wrong interval — the same is true of `delete` in §3, which has the slower prompt of the two.
- **`forget` + `cleanup` interleaves into the same hole from the other side.** A running backup
  has already passed its baseline HEAD and is skipping the objects that baseline vouches for. If
  the baseline is *forgotten* mid-run and `cleanup` follows, those objects — old, now unreferenced
  — are deletable before the new manifest lands. The 2026-07-19 baseline-trust fix closes this for
  the *next* backup (it re-HEADs and falls back to a LIST); it cannot help the one already in
  flight, whose check has passed.

**Versioning backstops all of this only if versioning is on, and no code path checks** — see the
entry in [engine-robustness.md](engine-robustness.md).

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

**Note (2026-06-26): a SIGINT handler is the wrong tool for this** — it only catches Ctrl+C,
not a crash/SIGTERM/power-loss, so the robust startup-sweep layer has to exist regardless, and
then covers the Ctrl+C case too.

**Orthogonal (2026-07-28):** [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md) *does* use
a SIGINT handler — but for a different job (parking a read-only hash lookup on a graceful stop),
not for sweeping this stale lock, which it leaves untouched. That verdict above still holds for
*this* item; the two don't collide.

> **Two accepted ADRs already constrain this half — read both before designing.**
> [ADR-0048](../docs/adr/0048-snapshot-lock-atomic-temp-file.md) makes the temp file *itself*
> the lock (atomic `wx` create; the artifact becomes the snapshot on success) and explicitly
> **rejects** a separate `.lock` file carrying PID/host (a second artifact that can disagree
> with the work file), **PID-liveness auto-break** (needs that file; PID reuse gives false
> "alive" verdicts), and **age-based auto-break** (a legitimate run can hash a multi-GB file
> for minutes without touching the work file). So *"a real lock file with a PID + liveness
> check"* above is **not** a live option — it is decided-against, and reviving it means
> amending ADR-0048 with new reasoning, not quietly re-proposing it.
>
> [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md) then supplies the sharpest framing
> anyone has put on this: *"that ADR's danger is exclusively two **writers** on one fixed temp
> name."* Reading is harmless — the parked lookup file needs none of the rejected heuristics
> because every reused hash is re-validated against the live file's size+mtime. That points
> squarely at the surviving option: **a unique temp name per run** (timestamp/PID *in the
> name*) dissolves the two-writers-on-one-name danger at its root, with no second artifact and
> no liveness guesswork. That is the live starting point for item 2.
>
> **ADR-0067 also shrank this item.** A *graceful* interrupt now parks the work file as
> `.snapshot.lookup.tsv.zst` instead of leaving a stale lock, so Ctrl+C no longer wedges the
> next run. What remains is only the **hard-kill / crash / power-loss** case — which ADR-0067
> says outright it does not solve. Smaller, and rarer, but still hand-cleaned.

## 3. `delete` is a third destructive actor (added by the deletion rework)

Since [ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md), `delete` also removes
objects bucket-wide — so the "two commands that must not race a backup" framing above is now
three, and `delete`'s profile is the *least* protected of them:

- **The 7-day grace window does not help it at all.** Grace protects `cleanup` because cleanup
  only ever targets *unreferenced* objects. `delete` deliberately removes content live
  snapshots still reference, chosen by path — object age is irrelevant to its plan.
- **It carries no "don't run this while a backup is running" line**, where `cleanup` does
  ([src/commands/cleanup.mjs](../src/commands/cleanup.mjs), the `console.warn` after a
  reclaim). Whether that omission is a gap or is genuinely covered by the record is a question
  for whoever picks this up — adding the line is the cheap interim either way.
- **ADR-0064 judged its race safe-degrading**, and that reasoning still stands: a backup that
  skipped uploading an object (conditional PUT saw it present) and publishes its snapshot just
  after a `delete` removes that object yields a snapshot referencing deleted content — but the
  deletion record *explains* the gap, so `verify` reports it as expected-missing and `restore`
  skips it with a date. Degraded, never silently corrupt.
- _My analysis, not a decision:_ the sharper variant is the **cross-set** one — `delete`'s scan
  sees hash H referenced only inside its scope and marks it deletable, while a concurrent
  backup of a set *outside* that scope publishes a snapshot referencing H. That set never
  consented to the deletion, and its brand-new snapshot lands already record-explained-missing.
  Still not corruption, but it is where "the record makes it fine" reads thinnest, and it is
  what a lock (or re-checking the reference set immediately before deleting) would actually
  close.
- **Independently reached by the 2026-08-12 durability audit** (provenance in [bugs.md](bugs.md)),
  which found this cross-set variant cold — without reading this file — and rated it the most
  serious of the three destructive-actor races. Two things it adds to the bullet above:
  - **Nobody involved gets a signal.** Because the deletion record explains H, the affected set's
    `verify` reports expected-missing and exits **0**, and its `restore` skips the file and exits
    **0**. The set that never consented has no mechanism by which it could find out — where the
    `cleanup` race in §1 at least surfaces as `missing`. That is the concrete sense in which "the
    record makes it fine" is thinnest: the record is not merely inadequate here, it is actively
    supplying the explanation that suppresses the alarm.
  - **`delete`'s window is the widest of the three**, because its confirmation is the
    type-the-bucket-name prompt — the slowest deliberate pause in the tool sits between its scan
    and its deletes.

## 4. Write the work file **uncompressed**, compress at finalize (revived 2026-07-29)

_User idea, previously rejected as "added complexity" — raised again after the fused pipeline
landed, on the grounds that the scales may have moved. The analysis below is mine._

Today `withSnapshotFile` streams rows through zstd-19 into `.snapshot.tsv.zst`, so the work file
is only readable if the stream was closed cleanly. The proposal: write it as plain `.snapshot.tsv`
and compress once at finalize.

**Why it looks better than it did.** Three things from building
[ADR-0069](../docs/adr/0069-fused-snapshot-upload-pipeline.md):

1. **It already forced a design compromise.** Parking the work file on a *drift* failure (rather
   than binning it) was designed and abandoned for exactly this: a throw inside a pipeline link
   makes `stream.pipeline` destroy the chain, so the file ends mid-zstd-frame and parking it would
   park something unreadable. ADR-0069 solved that a better way — the upload transform never
   throws, so the file always closes cleanly — but the constraint is real and will bite the next
   time something wants to keep a *partial* work file.
2. **Hard kill and power loss still cost the whole hash pass.** [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md)
   put them out of scope deliberately, and what that bought was "no defensive truncated-zstd
   parser, no periodic flushing, no `--resume`". Plain text collects most of that robustness
   without the parser: complete lines are readable, and the only new code is tolerating a partial
   *final* line, where `parseSnapshotStream` currently asserts. On a multi-hour first seed that is
   the difference between losing everything and losing one row.
3. **The write window is now longer and more eventful.** Since the fusion, uploads happen *inside*
   the write, so the work file is open across all the network work rather than local work alone.

**The bonus, and the ADR it touches.** If the work file is already plain text, keeping it at
finalize (rename to `.snapshot.tsv` beside the compressed snapshot) makes the latest manifest
openable in any editor at the cost of a rename — **not** a second write.
[ADR-0061](../docs/adr/0061-debug-only-uncompressed-snapshot-sidecar.md) keeps that sidecar
debug-only, and its reasoning is explicitly cost-based ("a second artifact per snapshot forever —
bytes, a second write per run"). That cost genuinely changes here, so 0061 would need **revisiting
on its own terms**, not quietly overtaking. Its other leg still stands: the no-lock-in pillar is
already met by standard `.tsv.zst`, so the case rests on convenience plus the robustness above.
Holding both an uncompressed and a compressed copy locally is **not** an objection (user,
2026-07-29) — it is redundancy, not a problem.

**What it costs.** Finalize stops being a bare atomic rename and becomes read → zstd → write →
rename, which moves level-19 compression off the overlapped path (where the hash pass currently
hides it) into a visible few seconds at the end of a large run. Reading needs no change —
`readSnapshotFile` already switches on the `.zst` extension, and `readSnapshot` already probes the
plain `.tsv` form.

**How it meets item 2.** It does *not* dissolve the stale lock: a hard-killed run still leaves the
work file at the lock name, still hand-deleted. What changes is what that leftover is *worth* —
combined with the unique-temp-name-per-run option above, a dead run's hashes become something the
successor can sweep up and reuse instead of bin.

## State of play (2026-07-29)

Nothing here is built. Three things changed around it without resolving it: the deletion rework
(ADR-0063/0064) **added a third customer** (§3), [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md)
**shrank item 2** to the hard-kill case while sharpening how to think about it, and the fused
pipeline (ADR-0069) revived the **uncompressed work file** as a way to make what a dead run leaves
behind worth having (§4). Ripe to pick
up: self-contained, blocks nothing, and it is the standing pre-release item (user call,
2026-07-18). Take the one-mechanism-or-two decision below *after* re-reading ADR-0048 and
ADR-0067, which between them already fix half the design space.

## If a lock is the answer, it has to answer both

_My framing, not a decision taken._ Item 2's lock is **local** (a file beside the snapshot, PID
liveness works). Item 1's is **remote and cross-machine** — a lock object in the bucket, with
no PID to check liveness against, needing a lease/expiry so a crashed machine cannot wedge
everyone else's cleanup forever. They are not the same mechanism, and item 1 is much the harder
of the two. Worth deciding whether to solve them together or accept two designs.
