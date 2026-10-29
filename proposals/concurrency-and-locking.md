# Concurrency & locking

Epic: the places where two s3cab runs — or one crashed run and its successor — can step on
each other.

**The cross-machine half is settled.** Items 1 (`cleanup` deleting an object a running
`backup` relies on) and 3 (`delete` as a third destructive actor) are closed by
[ADR-0112](../docs/adr/0112-bucket-locks.md): uploads and deletes hold locks in the bucket and
never overlap, the grace window is gone, and the tests that pinned both races now assert the
refusal. The item numbers below are kept as other documents cite them. What ADR-0112 leaves of
item 3 is under its old number.

**Versioning backstops a mistaken delete only if versioning is on, and no code path checks** —
see the entry in [engine-robustness.md](engine-robustness.md).

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

**Confirmed live under real SIGKILL** (2026-08-14, crash tier —
[test/crash/crash.test.mjs](../test/crash/crash.test.mjs)): the work-file residue exists only
for a kill **inside the fused pipeline** (before/between object PUTs, mid-multipart); a kill in
the window *between the last object PUT and the manifest PUT* leaves no work file, because it
has already been renamed into place. Since [ADR-0112](../docs/adr/0112-bucket-locks.md) a kill
anywhere before the manifest lands also leaves the set's `.upload.lock` and the run's lock in
the bucket, so every kill before the commit point now makes the rerun refuse, and `--resume`
is the one answer to all of it: it removes the dead bucket lock, takes the local file over, and
reuses the parked hashes. What the hard kill costs is still the interrupted hash pass.

### A hard-killed work file turned out to be readable (2026-09-13)

**Measured on the real 280,232-file OneDrive set**, after a backup died un-gracefully about 3h16m
in (no handler ran, so nothing was parked): the leftover work file, then `.snapshot.tsv.zst`,
decompressed **cleanly** to 50,328,875 bytes holding **271,909 whole file rows of 280,232** — 97% of the pass.
The only damage was the final TSV line, torn mid-hash; the rows themselves were all there.

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

## 3. `delete`'s cross-set case (what ADR-0112 leaves)

The delete lock closes the race with a *running* backup: a backup that skipped an object
because the bucket held it can no longer have that object deleted beneath it. What stays is the
**cross-set** case from the 2026-08-12 durability audit (provenance in [bugs.md](bugs.md)),
which [ADR-0089](../docs/adr/0089-hash-operand-delete.md) accepts: `find` sees hash H referenced
only where the user is looking, a backup of *another* set lands a snapshot referencing H
between that `find` and the delete lock, and the delete removes H. The record explains the
absence, so that set's `verify` reports expected-missing and exits 0 and its `restore` skips the
file and exits 0 — nobody involved gets a signal. Not corruption; the one place "the record
makes it fine" reads thinnest. A re-check of the reference set under the lock, immediately
before deleting, is what would close it.

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

## State of play (2026-10-29)

Two pieces are built. [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md) makes a
hard-killed work file recoverable with `--resume` (§2's *"Recovering it, rather than deleting
it"*), and [ADR-0112](../docs/adr/0112-bucket-locks.md) settles the cross-machine half with
locks in the bucket that never expire — the user is the liveness check there too, through
`--resume` and `unlock`, so the two halves share one stance rather than one mechanism.

What is left is local: item 2's stale lock itself, where the **unique-temp-name-per-run** option
would make recovery automatic rather than user-invoked, and §4's uncompressed work file as a way
to make what a dead run leaves behind worth having. Both are self-contained and block nothing.
Re-read ADR-0048 and ADR-0067 before designing either; between them they fix half the design
space.
