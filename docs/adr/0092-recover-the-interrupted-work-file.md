# A hard-killed run's work file is offered back as `--resume`, not only as something to delete

**Status:** accepted. Reverses the scoping half of
[0067](0067-park-hashes-on-interrupt.md) — hard kills are no longer out of scope — while leaving
[0048](0048-snapshot-lock-atomic-temp-file.md)'s lock and 0067's graceful-interrupt parking exactly
as they are.

## Context

0067 parks the work file when it sees the interrupt, and says of the case where it doesn't:

> **SIGKILL and power loss are explicitly out of scope.** No handler runs, so the temp is left
> truncated at the lock name and the next run re-hashes: no harm, only time.

"No harm, only time" was the whole of the reasoning, and two things since have made it wrong.

**The hard kill is not exotic — it is the *second* Ctrl+C.** 0067's own handler force-quits on the
second signal, deliberately, so the user is never stuck behind a flush. But the abort it installs
is only observed *between files* (`propsRows` returns between rows), and since the fused pass
([0069](0069-fused-snapshot-upload-pipeline.md)) that pull sits behind the uploader. On a set whose
bytes are in multi-gigabyte video files, the gap between pressing Ctrl+C and the run noticing is
minutes. It looks inert, so the user presses it again — and that is the documented path into the
state 0067 declared out of scope.

**"Only time" is not true where the re-read can never be banked.** On a volume behind the Windows
Cloud Files filter driver, reading a file moves its ctime; [0085](0085-ctime-cross-check-on-hash-reuse.md)
handles that by trusting the *completing* run's own `#END` instant. A killed run writes no `#END`,
so it has no instant to offer and nothing it read is bankable. A first seed of such a set can
therefore fail to seed indefinitely: each attempt re-reads from zero, and only a run that survives
to the trailer ever gets to keep anything.

And the data was already there. Two specimens from the same set (280,277 files, ~2 TB), both from a
double Ctrl+C: 10,467,989 compressed bytes decompressing to 272,727 whole lines — 272,692 file rows,
**97% of the pass** — ending in a 95-character prefix of a row, torn mid-`mtime` while writing a
2.8 GB file. That is hours of hashing, sitting in a file the CLI's only advice was to delete.

## Decision

The work file is read back, and offered to the user as a resumption. Three parts, and the third is
the one the user actually meets:

1. **A tolerant read.** `parseSnapshotStream` takes `{ tolerant }`: no `#END` required, and a final
   row that is a prefix of one is dropped rather than throwing. Held rather than dropped as it is
   met, so a torn row *followed by another line* still throws — mid-file damage is corruption, and
   only the next line proves the tear wasn't the end. Every other reader stays strict, which is what
   keeps [0082](0082-snapshot-end-trailer.md)'s trailer the truncation detector it was built to be.
   The flag is module-private in effect: `readParkedLookup` is its only caller.

2. **The file's mtime is its trust boundary.** A recovered file has no `#END` instant, and the
   obvious reading — "no boundary, so reuse on size+mtime alone" — silently drops 0085's guard for
   exactly the rows this ADR exists to save. Its mtime is the honest stand-in: the last write the
   killed run managed, so later than every read it made, which is the property 0085 needs. Rounded
   **up** to the millisecond for the reason `completionInstant` already rounds up — a boundary that
   lands mid-millisecond must not sit *before* a ctime stamped in the same millisecond.

3. **The lock error leads with recovery.** `inProgressError` now offers two commands, the
   resumption first and the deletion second, in the user's own terms: *carry on from the file hashes
   it had already worked out*, or *start the pass over, reading those files again*. Both `snapshot`
   and `backup` take `--resume`, which adopts the file (unlink-then-rename onto the parked name,
   Windows's rename rule, as 0067 already does) and then leaves the ordinary parked-lookup path to
   read it, prefer it over the previous snapshot, and delete it when a snapshot lands.

**One reader, one mode.** `readParkedLookup` reads tolerantly *always*, rather than branching on
whether this file arrived by parking or by recovery. The branch would exist to be stricter with a
file 0067 already guarantees is whole, and a "was this recovered?" flag threaded through the read is
a second thing to get wrong for no behaviour ([0006](0006-minimal-code.md)).

## Why the user decides, and s3cab never does

`--resume` is a flag and not the default, because the work file at the lock name is
indistinguishable — from the outside, and by design — from a run writing right now. 0048 refused
PID and age heuristics for that reason and the refusal stands: **the user is the liveness check.**
They know whether another s3cab is running on this machine; s3cab can only guess, and a wrong guess
is two writers on one file.

That is also why the error is the surface. There is no state in which a user needs `--resume`
without having just been told about it: they meet the leftover file by being refused, and the
refusal names both ways out.

## Rejected

- **Periodic flushing, or a `#CHECKPOINT` row.** Both buy a *guarantee* about how much survives a
  kill; the tolerant read buys whatever happened to survive, and measurement says that is 97%. The
  format change and the per-N-rows flush would be paid on every routine run to improve the rare one.
- **Auto-adopting the file when it looks old.** 0048, again. Age is not liveness — a snapshot of a
  slow set legitimately holds the lock for hours.
- **Naming it `--recover`.** Collides with `restore`'s vocabulary, which is about getting files back
  from the cloud; this is about carrying on with a local pass. (`--continue` is a JS reserved word
  and reads as "the run is still going", which it isn't.)
- **Treating the adoption as its own step (`s3cab resume <set>`).** It is a modifier on the run the
  user was already trying to make, not a separate operation — and a command would have to duplicate
  every flag of the run it precedes.

## Consequences

**A recovered run is cumulative, like a parked one.** The adopted file becomes the parked lookup, the
new pass re-records every reused row into its own work file, and a *second* kill leaves a fuller one.
Repeated hard kills now make progress, which is the property 0067 gave only to graceful ones.

**The `#END` trailer keeps its meaning, and gains a sharper one.** Its absence still means "cut
short"; what changes is that the work file — the one file whose absence of a trailer is *expected* —
is now read by a caller that knows so. `verify`, `restore`, `compare` and every snapshot read are
untouched.

**`--resume --rehash` is coherent and does what it says**: the adoption happens before the `rehash`
early-return in `readBaseline`, so the combination unlocks the set and then re-hashes everything.
The unlock is the half the user wanted; the hashes they explicitly asked to throw away.

**A work file from a *different, still-running* s3cab can be adopted if the user says so.** That is
the cost of making the user the liveness check, and it is the same cost 0048 already accepted for
`del`. The outcome is no worse than deleting it: both runs then write, and the loser's rename fails.
