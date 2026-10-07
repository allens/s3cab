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
([src/lib/cleanup.mjs](../src/lib/cleanup.mjs), `GRACE_MS`) — no object younger than a week is
ever swept, so a normal in-flight backup is safe without a lock. There is deliberately no
`--grace` knob.

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

Both interleaves are now **pinned by deterministic tests** (2026-08-14, model-based suite):
*"cleanup sweeps an old object a running backup just skipped"* and *"forget + cleanup mid-backup
delete the baseline's objects before the manifest lands"* in
[test/model/model.findings.test.mjs](../test/model/model.findings.test.mjs) — each reproduces the
race in-process (the interleaving command runs from inside the backup's manifest PUT), asserts the
dangling reference, and confirms `verify` reports it. Hypothesis → confirmed; whatever locking
decision this epic reaches inherits them as regression tests.

**Confirmed multi-process against real S3** (2026-08-14, crash tier): both interleaves reproduce
with genuinely separate processes — the real CLI, separate `S3CAB_HOME`s, one real bucket, the
in-flight backup parked immediately before its manifest PUT while a real `cleanup --force` (and,
for the second interleave, `forget --force` first) runs to completion from another process. In
both, the released backup **publishes its manifest and exits 0**; the store then holds dangling
references and the snapshot is unrestorable. The two `PIN` tests in
[test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs) are the deterministic
repros (grace compressed to seconds via the labeled `S3CAB_XGRACE_MS` test instrument — the
interleaving itself is the production one). The same suite confirms the **safe** arms with the
mechanism named live:

- *backup ∥ cleanup at real grace*: minutes-old crash orphans a second backup reuses survive the
  sweep — `GRACE_MS` is the protection, exactly as documented above.
- *backup ∥ backup, shared content across sets*: a backup whose upload plan went stale mid-run
  lands every object PUT on an existing key; the no-clobber conditional PUT's 412 is treated as
  "already stored" and both sets restore byte-identically.
- *backup ∥ backup, same set + same snapshot name*: the no-clobber manifest PUT leaves exactly
  one winner; the loser fails loudly, its objects stored but unrecorded, and re-runs. **This is a
  supported configuration, not a misuse** — two live machines on one set is discouraged-but-
  tolerated and explicitly never locked out
  ([ADR-0024](../docs/adr/0024-set-name-is-the-whole-identity.md), reaffirmed by
  [ADR-0053](../docs/adr/0053-reattach-command.md); the naming *claim* is the settled hard gate,
  first-person-wins at `setup`). So the loser's error message is the whole product surface for
  this, and it was wrong until 2026-08-18 — "already backed up" was true of the name and false of
  the data. Fixed there; **not** a candidate for a lock.
- *backup ∥ forget alone*: safe because `forget` deletes only `snapshots/<set>/` keys — every
  object the in-flight manifest references is still stored.
- *cleanup ∥ forget*: safe because cleanup reads snapshots strictly **before** its objects LIST,
  so a mid-run forget makes it conservative (keeps now-unreferenced objects for the next run),
  never destructive.
- *cleanup ∥ cleanup* and *forget ∥ forget*: safe because S3 `DeleteObject` is idempotent —
  overlapping sweeps of the same plan can't fail each other. (Two forgets of one snapshot both
  report success and both file an audit record; cosmetic.)
- *setup ∥ setup claiming one name*: two conditional claim PUTs released simultaneously produce
  exactly one 200 and one 412; the loser's error names the owner and offers `reattach`.

**Versioning backstops all of this only if versioning is on, and no code path checks** — see the
entry in [engine-robustness.md](engine-robustness.md).

## 2. Stale temp-file recovery (the local half)

A crashed or interrupted snapshot leaves `.snapshot.tsv.gz` behind, and every later snapshot
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
> `.snapshot.lookup.tsv.gz` instead of leaving a stale lock, so Ctrl+C no longer wedges the
> next run. What remains is only the **hard-kill / crash / power-loss** case — which ADR-0067
> says outright it does not solve. Smaller, and rarer, but still hand-cleaned. _(Since
> [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md): still hand-cleared, but the
> clearing is now `--resume`, which keeps the dead run's hashes rather than binning them. The
> lock itself is as unsolved as ever — the user is still the liveness check.)_

**Confirmed live under real SIGKILL, and measured narrower than it reads** (2026-08-14, crash
tier — [test/crash/crash.test.mjs](../test/crash/crash.test.mjs)): the residue exists only for a
kill **inside the fused pipeline** (before/between object PUTs, mid-multipart). A kill in the
window *between the last object PUT and the manifest PUT* — the widest torn-transition gap —
leaves **no** lock, because the work file has already been renamed into place; the rerun recovers
unaided (baseline HEAD misses the never-published manifest, falls back to a LIST, reuses the
orphaned objects). When the lock *is* left, the rerun refuses with `inProgressError`'s message
("A snapshot of this set is already in progress — or a previous one was interrupted…"), which
names the exact file and the delete command — observed verbatim, and recovery after the delete
was clean in every case. What the hard kill costs beyond the hand-delete is the interrupted hash
pass.

### A hard-killed work file turned out to be readable (2026-09-13)

**Measured on the real 280,232-file OneDrive set**, after a backup died un-gracefully about 3h16m
in (no handler ran, so nothing was parked): the leftover work file, then `.snapshot.tsv.zst`,
decompressed **cleanly** to 50,328,875 bytes holding **271,909 whole file rows of 280,232** — 97% of the pass.
The only damage was the final TSV line, torn mid-hash. There is no `#END`, so `parseSnapshotStream`
asserts and nothing will read it — but the rows themselves were all there.

That replaces the parenthetical this paragraph used to carry ("the work file dies mid-zstd-frame"),
and it qualifies **§4's point 2**: the failure mode attributed there to plain text — *"complete
lines are readable, and the only new code is tolerating a partial final line"* — is what the
**compressed** work file actually did. Node's zstd stream flushes blocks as it goes, so a hard kill
loses the in-flight block, not the stream. (That was zstd. Since snapshots became gzip
([ADR-0097](../docs/adr/0097-gzip-snapshot-compression.md)) the same shape is expected, since
deflate also writes its blocks as it goes, and `recoverWorkFile`'s unit test cuts a gzip work file
short and recovers a clean prefix. No real hard kill has been measured on gzip yet.)

_Not a refutation, and it must not be read as one — n=1._ The crash tier observed a mid-frame death
on 2026-08-14, and the obvious reconciliation is **size**: a 10MB compressed stream has flushed
hundreds of blocks, while a small or early-killed run may still sit entirely in the compressor's
buffer. If that holds, the two observations agree and the rule is "a long run's work file survives,
a short one's may not" — which is the right way round, since the long run is the one worth
recovering. **Worth a crash-tier case that kills a large run**, because it decides how much of §4
is still being bought.

**Second specimen, n=2 (2026-09-18).** Same set, a *double* Ctrl+C rather than a crash — the second
press force-quits by design ([ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md)), so no park
ran and the file was still at the lock name. 10,467,989 compressed bytes → 50,462,720 decompressed,
**272,692 file rows of 280,277 found** (plus 1 `#SNAPSHOT`, 1 `#DIR`, 32 `#EXCLUDED`, 1 `#ERROR`),
ending in a 95-character prefix of a row torn mid-`mtime` while writing a 2.8 GB file. 97% again,
and the size hypothesis survives: another long run, another survivable file. The crash-tier case
that kills a *large* run is still unwritten and still the thing that would settle it.

This specimen also moved the *reachability* of the case. The hard kill is not only SIGKILL and power
loss: it is this ADR-0067 handler's own second interrupt, reached by a user who pressed Ctrl+C twice
because the first press looked inert (the abort is observed between files, and since ADR-0069 that
pull sits behind the uploader — on a 2.8 GB file, minutes).

**Both halves of "looked inert" are now fixed, which makes this route rarer but not closed.** The
press itself was *also* arriving late, because a signal handler needs the event loop as much as the
redraw timer does and the pass was starving both — fixed by the concession in
[#343](https://github.com/allens/s3cab/pull/343). And the line now says `Stopping…` from the first
draw after the press ([ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md), amended
2026-10-01), so the display no longer contradicts the handler's message. What remains is the honest
part: the pass still cannot *stop* until the row it is on finishes, so a user who will not wait out a
multi-gigabyte upload still has the force-quit, and still lands here.

### Recovering it, rather than deleting it — **BUILT** (user, 2026-09-13; landed 2026-09-18)

*"Could we automate recovery? Seems like you can do it anyway, so why not make it a feature?"* —
raised on seeing that the `del` in `inProgressError`'s remedy throws away 3h16m of hashing.

Built as [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md): `--resume` on `snapshot`
and `backup`, a `tolerant` mode on `parseSnapshotStream`, and `inProgressError` offering the
resumption first and the deletion second. The ADR is the record — read it rather than the sketch
this section used to carry. One correction it made to that sketch, kept here because it is the
kind of thing that gets re-proposed:

- **A torn row is forgivable only as the file's *last* line.** Tolerating any malformed row would
  make the mode a corruption-swallower rather than a work-file reader.

**What it does _not_ close.** It needs none of the auto-break heuristics ADR-0048 rejected because
the user remains the liveness check — which is also its ceiling. The **unique-temp-name-per-run**
option above is still what would make recovery *automatic* rather than user-invoked: an orphan that
cannot collide with a live run can be swept and reused with no liveness question left to answer.
That remains the live starting point for item 2; this was the manual half, and it pays off now.

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

Today `withSnapshotFile` streams rows through gzip into `.snapshot.tsv.gz`. A hard-killed work file
is still read back, tolerantly, through `Z_SYNC_FLUSH`
([ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md); point 2 below). The proposal:
write it as plain `.snapshot.tsv` and compress once at finalize.

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
   the difference between losing everything and losing one row. **Overtaken 2026-09-18** — this
   point is what [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md) bought, and it
   bought it *on the compressed file*, because the measurement in §2 says zstd's flushed blocks
   already leave the same "whole lines plus one torn one" shape. The tolerating-a-partial-final-line
   code exists and reads `.tsv.gz` today, so **plain text can no longer claim it.** §4's remaining
   case is the *bonus* below and the design compromise in point 1, not robustness.
3. **The write window is now longer and more eventful.** Since the fusion, uploads happen *inside*
   the write, so the work file is open across all the network work rather than local work alone.

**The bonus, and the ADR it touches.** If the work file is already plain text, keeping it at
finalize (rename to `.snapshot.tsv` beside the compressed snapshot) makes the latest manifest
openable in any editor at the cost of a rename — **not** a second write.
[ADR-0061](../docs/adr/0061-debug-only-uncompressed-snapshot-sidecar.md) keeps that sidecar
debug-only, and its reasoning is explicitly cost-based ("a second artifact per snapshot forever —
bytes, a second write per run"). That cost genuinely changes here, so 0061 would need **revisiting
on its own terms**, not quietly overtaking. Its other leg still stands: the no-lock-in pillar is
already met by standard `.tsv.gz`, so the case rests on convenience plus the robustness above.
Holding both an uncompressed and a compressed copy locally is **not** an objection (user,
2026-07-29) — it is redundancy, not a problem.

**What it costs.** Finalize stops being a bare atomic rename and becomes read → gzip → write →
rename, which moves compression off the overlapped path (where the hash pass currently hides it)
to the end of the run. Under zstd-19 that was a visible few seconds on a large set; gzip is about
30 times faster (ADR-0097), so about a second. Reading *does* need a change. `readSnapshotFile`
already switches on the `.gz` extension, but `readSnapshot` resolves only `<name>.tsv.gz`, and
work-file recovery (`readParkedLookup`, `recoverWorkFile`) reads through
`parseCompressedSnapshotStream` unconditionally, so a plain work file needs its own uncompressed
recovery path.

**How it meets item 2.** It does *not* dissolve the stale lock: a hard-killed run still leaves the
work file at the lock name, still hand-deleted. What changes is what that leftover is *worth* —
combined with the unique-temp-name-per-run option above, a dead run's hashes become something the
successor can sweep up and reuse instead of bin.

## State of play (2026-07-29; amended 2026-09-18)

> **One piece is built.** [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md) makes a
> hard-killed work file recoverable with `--resume` — §2's *"Recovering it, rather than deleting
> it"*. It does not resolve item 2, which is still the stale lock itself; it makes what that lock is
> sitting on worth keeping, and it retires §4's robustness argument (point 2). Everything below
> stands otherwise.

Nothing else here is built. Three things changed around it without resolving it: the deletion rework
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
