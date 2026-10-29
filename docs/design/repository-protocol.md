# Repository protocol — states, transitions, atomicity

## Status

Design note describing **built behaviour**, first derived from the code at `88fbc70` (2026-08-11)
and kept in step with it since — `git log` on this file is the record, most recently the `delete`
and `cleanup` sections for [ADR-0089](../adr/0089-hash-operand-delete.md) and
[ADR-0090](../adr/0090-deletion-record-format-compaction.md). Only the derivation point is pinned:
a current-as-of hash in prose rots exactly like a line number.
Nothing here is proposed or aspirational: where a claim is about intent rather than mechanism it
says so. The known ways the model can be violated are **not** restated here — each is tracked in
its own home and linked from [Where the model is violable](#where-the-model-is-violable).

<sub>Written from an adversarial durability audit of the 1.0 format freeze (2026-08-12, Claude
Fable at xhigh reasoning; the full report, including the ruled-out list and the reasoning behind
each finding, is kept **outside the repo** as `s3cab-durability-audit-2026-08-12.pdf`). The audit
had to derive this model from eight modules before it could attack anything; it is written down
so the next durability question starts from a checkable model instead of re-deriving one.</sub>

## What this is for, and how it differs from its neighbours

- [guide/format.md](../../guide/format.md) is the **format** promise, user-facing: what the bytes
  mean and what will not change under a reader. It states the invariant; it does not enumerate
  who writes what, when.
- [backup.md](backup.md) is the **design rationale** for the backup subsystem, including the
  accepted races and the reasoning that accepted them.
- This note is the **protocol**: the legal states of a repository, every transition a command
  performs, and which of those transitions are atomic. It exists so a durability claim ("can a
  published snapshot ever reference an absent object?") can be checked against a model rather
  than re-derived from the code each time.

Line numbers are deliberately absent — files and symbol names only, because a line number in
prose rots silently.

## Legal states

### In the bucket

| Key | States | Written by | Deleted by |
| --- | --- | --- | --- |
| `objects/<sha256>` | absent → present | `backup`, `upload` — conditional PUT (`IfNoneMatch: "*"`) in `putObject` ([objects.mjs](../../src/lib/objects.mjs)) | `cleanup`, `delete` — via `deleteStoredObjects`, the only remover |
| `snapshots/<set>/<name>.tsv.gz` | absent → present, then **immutable** | `backup`, `upload --snapshot` — no-clobber PUT in `uploadSnapshotFile` ([upload.mjs](../../src/lib/upload.mjs)) | `forget` only |
| `snapshots/<set>.info` | absent → claimed → taken over | `setup` claims it (conditional `putText`, first-writer-wins, only while `snapshots/<set>/` is empty); `takeover` rewrites OWNER and CLAIMED with a plain PUT, keeping CREATED, or claims it conditionally when absent ([set-marker.mjs](../../src/lib/set-marker.mjs)) | never |
| `.s3cab/sets/<set>/dirs.txt`, `exclude.txt` | absent → present, overwritten freely | `setup`, `backup` (`pushSetConfig`, best-effort) | `pushSetConfig`, when the local file goes away |
| `objects.deleted-<n>.tsv` | absent → present, then **immutable** (never overwritten — compaction writes a *new* index) | `delete` — conditional PUT at the lowest free index, walking upward on collision ([deletion-record.mjs](../../src/lib/deletion-record.mjs)) | `cleanup` — compaction removes absorbed files, only *after* their merge lands at a fresh index ([ADR-0090](../adr/0090-deletion-record-format-compaction.md)) |

Two properties of `objects/` are worth stating precisely, because most of the durability surface
rests on them:

- **The store trusts the hash on write and verifies it only on read.** `putObject` sends whatever
  the named path holds under the key it was given; nothing re-reads the object afterwards to
  confirm the bytes hash to the key. The check happens on the way out, in `writeFileAtomic`
  ([atomic-file.mjs](../../src/lib/atomic-file.mjs)), which digests the downloaded bytes before
  the rename. So a wrong-bytes-under-a-right-key object is *storable*, and is detected only when
  something restores it.
- **A zero-byte `objects/` folder marker is legal** and skipped by `listStoredObjects`.

### On the machine

`~/.s3cab/sets/<set>/snapshots/` holds three shapes ([snapshot-file.mjs](../../src/lib/snapshot-file.mjs)):

| File | Meaning |
| --- | --- |
| `<name>.tsv.gz` | A landed local snapshot. **Nothing on it records whether it was ever uploaded** — `readBaseline` takes the latest by name regardless, and remote existence is established later by a single HEAD. |
| `.snapshot.tsv.gz` | The in-progress work file, doubling as the per-set lock ([ADR-0048](../adr/0048-snapshot-lock-atomic-temp-file.md)) |
| `.snapshot.lookup.tsv.gz` | Hashes parked by an interrupted run ([ADR-0067](../adr/0067-park-hashes-on-interrupt.md)), stopping after its last file row with no closing `.`. Candidates only — every entry is re-validated by `fileProps` against the live file's size+mtime (and, if the set opts in, its ctime — [ADR-0094](../adr/0094-change-time-check-opt-in.md)), which is why it needs no liveness check. |

Beside them, `~/.s3cab/sets/<set>/claim` holds the OWNER and CLAIMED this machine wrote to
`snapshots/<set>.info` ([ADR-0108](../adr/0108-set-ownership.md)). Its presence means this
machine holds the set; a holder check (`assertHeld` in
[set-marker.mjs](../../src/lib/set-marker.mjs)) that finds the marker changed deletes it.

## The invariant, and the single place it is enforced

> A snapshot's presence under `snapshots/` guarantees every object it references is already
> present under `objects/`.

Mechanically this reduces to one thing: **the manifest PUT is the commit point, it is atomic, and
every object upload strictly precedes it.** In `backup` ([backup.mjs](../../src/commands/backup.mjs))
the ordering is enforced by three consecutive guards — the pipeline's collected upload `failure`
throws, then collected `drifted` files throw, and only then is `uploadSnapshotFile` called. In
`upload --snapshot` the same ordering is internal to `uploadSnapshot`.

Everything else in the protocol is arranged so that a run which dies before that PUT leaves only
orphan objects, which are storage cost rather than damage.

## Transitions

Marked **[atomic]** where a single indivisible operation carries the state change, and
**[multi-step]** where an observer can catch the repository between states.

### `backup` — the long one (fused pipeline, [ADR-0069](../adr/0069-fused-snapshot-upload-pipeline.md))

First, `assertHeld` reads `snapshots/<set>.info` and refuses unless its OWNER and CLAIMED match
`claim`. **[atomic]** read.

Then the upload lock ([ADR-0112](../adr/0112-bucket-locks.md), `holdUploadLock` in
[locks.mjs](../../src/lib/locks.mjs)), around everything below: no-clobber PUT of
`locks/upload-<instant>` **[atomic]**; LIST `locks/` **[atomic]** — a lock of this machine's
whose process is gone is removed on the way, and a `delete-` lock means remove the own lock and
refuse. Write first, look second. The lock is removed on every exit — success, failure or
Ctrl+C — after step 7 and before step 8; only a hard stop leaves it, for the next run from
this machine, or `unlock`.

1. `readBaseline` — pick the latest **local** snapshot. Local read.
2. `storedHashes` ([upload.mjs](../../src/lib/upload.mjs)) — compare the baseline's remote
   snapshot against the local file, **byte for byte**
   ([ADR-0084](../adr/0084-snapshot-identity-byte-equality.md)). Identical → trust the baseline's
   hashes as the skip-list, minus every hash named by a deletion record. Anything else → drop the
   baseline and LIST `objects/` as a first backup would. **[atomic]** read. This was a name-only
   HEAD until 2026-08-14, which let another machine's same-named snapshot vouch for a local
   baseline that was never uploaded.
3. Acquire the lock — `open(".snapshot.tsv.gz", "wx")`. **[atomic]**, and a same-minute snapshot
   name is refused before this, by `existsSync` on the final name.
4. Per file: one `lstat` + hash (or a reuse of the baseline hash on identical size+mtime), then in
   the upload transform a second `lstat` via `fileChange`, then the conditional PUT.
   **[multi-step]** — the whole loop, and every object PUT within it, is interleavable with any
   other command against the bucket. Individual PUTs are **[atomic]**.
5. Land the local snapshot — `rename(tmp, final)`. **[atomic]**. A graceful interrupt instead
   renames the work file to the parked-lookup name.
6. Throw on any collected upload failure or drift — **before** step 7, so no manifest is published.
   The local snapshot from step 5 survives.
7. `uploadSnapshotFile` — `assertHeld` again, then the no-clobber PUT of the manifest.
   **[atomic]. This is the commit point.** The check and the PUT are two requests: a takeover
   landing between them lets this run publish anyway (ADR-0108 states the gap).
   A 412 here is resolved by byte-identity: identical is this run's own retried PUT and succeeds
   quietly. The two losing outcomes — different (another machine's snapshot holds the name) and
   absent (that snapshot deleted between the 412 and the read) — share **one** past-tense
   message: the name *was* already taken when we wrote it, the objects are stored, this backup
   went unrecorded, run it again. One user action, one wording; the past tense stays true whether
   or not the colliding snapshot is still there.
8. `pushSetConfig` — best-effort mirror of `dirs.txt`/`exclude.txt`; failure is tolerated and
   changes nothing about the backup's validity.

### `snapshot`

Steps 1, 3, 4-without-uploads, 5. **Purely local — it performs no bucket transition at all**
([snapshot.mjs](../../src/commands/snapshot.mjs) imports only the engine and the comparer).

### `upload`

Every form holds the upload lock around the whole operation, as `backup` does.

- `--snapshot` — objects first, manifest last; same holder check, commit point and atomicity.
- `--dir` — objects only, no manifest.
- `--file` — `fileChange` guard, then one conditional PUT **[atomic]**. `--force` is the only path
  in the whole tool that overwrites an existing object, and therefore the only repair for a
  corrupt one.

### `forget`

First, `assertHeld`, as `backup` does.

1. LIST the set's remote snapshots and require **every** named snapshot to exist before deleting
   **any** — a typo cannot leave the first two of three already gone.
2. Optional whole-bucket unrestorable scan → preview file → prompt (skipped together by `--force`).
3. DELETE each manifest. **[multi-step]** across names; each DELETE **[atomic]**.
4. Write the local audit record — deliberately *after* the deletes, so it records what actually
   happened.

### `cleanup`

1. Read every snapshot in the bucket (`referencedObjects`).
2. LIST `objects/`.
3. Read deletion records **last**. (1–3 are one call, `scanBucket` in
   [bucket-scan.mjs](../../src/lib/bucket-scan.mjs); `verify` reads through the same one.)
4. Plan: orphan = stored − referenced ([cleanup.mjs](../../src/lib/cleanup.mjs)).
5. Interlocks: an unreadable snapshot, or one with a refused row, aborts **both** modes; missing
   objects and an invalid deletion record refuse the acting path.
6. Prompt. Everything so far ran with no lock, so a preview costs a running backup nothing.
7. The delete lock ([ADR-0112](../adr/0112-bucket-locks.md), `holdDeleteLock` in
   [locks.mjs](../../src/lib/locks.mjs)): no-clobber PUT of `locks/delete-<instant>`
   **[atomic]**, then LIST `locks/` **[atomic]**, removing any lock of this machine's whose
   process is gone. An `upload-` lock means remove the own lock and refuse, naming each; with
   `--wait`, remove it, sleep `WAIT_MS`, and write it again. Write first, look second.
8. Top up: LIST `snapshots/` again and read every key the scan's listing lacked; their objects
   leave the orphan plan and join the reference set, and step 5's checks apply to them. No
   snapshot can land from here on, so the plan is final.
9. DELETE each orphan. **[multi-step]** across orphans; each **[atomic]**.
10. Compact the deletion record (acting runs only, and only past every interlock): union every
    record file, drop rows no snapshot references, conditional PUT of the merge at a fresh index
    **before** deleting the absorbed files. **[multi-step]**; a crash between the write and the
    deletes leaves duplicate rows, which readers dedupe and the next compaction collapses.
11. Remove the lock, on every exit; a hard stop leaves it for the next run from this machine,
    or `unlock`.

**The ordering in 1–3 still matters**: reading snapshots before the object LIST means an object
a running backup uploads during the scan appears unreferenced, which step 8 resolves if its
snapshot has landed by then and step 7 refuses on if it hasn't; reading deletion records last
means a record written during the scan can only ever add explanation, never remove it. That is
why the three reads are one function rather than three calls a command makes in sequence: a
caller cannot get the object listing without the snapshots having been read first, and
`bucket-scan.test.mjs` asserts the order at the S3 seam.

### `delete` ([ADR-0089](../adr/0089-hash-operand-delete.md))

1. Operands are content hashes (positional or `--from-file`, typically `find` output) —
   removal is repository-wide by construction, so there is no snapshot scan and no plan step.
2. Preflight: one HeadObject per hash. **[multi-step]** across hashes; a missing object is
   reported and skipped, and the ContentLength fills the record's size column.
3. The strongest confirmation in the tool (type the bucket name).
4. The delete lock, as `cleanup`'s step 7: written, then `locks/` listed; an upload lock
   refuses or, with `--wait`, waits.
5. **Record first, then the deletes** — conditional PUT of `objects.deleted-<n>.tsv` at the
   lowest free index, then `deleteStoredObjects`. **[multi-step]**, deliberately ordered so
   a crash between them leaves an *over-complete* record (objects recorded as deleted that
   still exist, which reads as simply present) rather than unexplained absences.
6. Remove the lock, on every exit.

### `verify`

Read-only; no transition. Reads manifests → LIST → deletion records, in that order, for the same
reason `cleanup` does — through the same `scanBucket`. **Checks presence and size only — it never re-hashes object content**, so
a wrong-bytes-under-a-right-key object is outside what `verify` can see by construction. Sets
`process.exitCode = 1` on unexplained findings.

### `restore`

Per object: `getObject` → `writeFileAtomic` (digest check) → rename **[atomic]** per file. Two
failure modes, deliberately different:

- **absent or corrupt object** → skip and continue. For an absence the deletion record
  partitions the outcome (recorded → exit 0, unexplained → exit 1); a digest mismatch is always
  exit 1, since no `delete` produces wrong bytes. A name the destination filesystem refuses is
  skipped the same way at exit 1 — a local outcome, not a repository one;
- **anything else** (network, credentials, a full disk) → propagates and **aborts the entire run**
  ([restore.mjs](../../src/commands/restore.mjs)).

### `reattach`

Read `<set>.info` → pull the remote snapshots this machine lacks, each landing via an atomic local
write. No bucket transition: it writes nothing remote.

### `takeover`

`reattach`'s reads → pull `dirs.txt`/`exclude.txt` where no local file exists → rewrite OWNER
and CLAIMED with a plain PUT, or a conditional `putText` when the set has no `.info`
**[atomic]** → write `claim`. The previous holder's next `assertHeld` refuses.

### `setup`

Local-exists check → LIST `snapshots/<set>/`, refusing if it isn't empty → `claimRemoteSet`, a
conditional `putText` **[atomic]**, first writer wins and the loser gets a loud collision error.

## The atomic gates, in one list

Five operations carry every state change that matters. Everything else is either a read or a step
whose failure leaves only recoverable residue:

1. `open(tmp, "wx")` — the per-set lock.
2. `rename(tmp, final)` — the local snapshot lands.
3. Conditional PUT of an object — idempotent under content addressing, so a retry or a duplicate
   delivery is a no-op rather than an overwrite.
4. **No-clobber PUT of the manifest — the commit point.**
5. Conditional PUT of `<set>.info` / a deletion record — first-writer-wins claims.

Gates 3, 4 and 5 all rest on the S3 conditional write (`If-None-Match: *`). That is a single
mechanism carrying four separate correctness promises, and it is only verified on AWS — see
[s3-provider-compatibility.md](s3-provider-compatibility.md), Finding 3 item 5.

## Where the model is violable

The audit that produced this note found the invariant **holds under process termination at every
step** — the commit point is real, and no kill sequence broke it. What it did break was
concurrency and time. Those findings live in their own homes rather than here, so this note stays
a description of the protocol rather than a running defect list:

- **C1** (mid-transfer mutation stores wrong bytes under a right key) and **C2** (the baseline HEAD
  matched on snapshot *name*, so a second machine's same-named snapshot could vouch for a local
  snapshot that was never uploaded) — both **fixed 2026-08-14**, by
  [ADR-0083](../adr/0083-streamed-digest-upload-guard.md)'s streamed-digest check on the PUT and
  [ADR-0084](../adr/0084-snapshot-identity-byte-equality.md)'s byte-identity comparison
  respectively. Kept named here because the transitions above cite them.
- A takeover between a backup's holder check and its manifest PUT, a snapshot uploaded between
  `setup`'s LIST of `snapshots/<set>/` and its claim, and a `claim` copied with the rest of a
  home — the three gaps [guide/format.md](../../guide/format.md#who-holds-a-set) states
  ([ADR-0108](../adr/0108-set-ownership.md)).
- The `cleanup`-vs-backup and `delete`-vs-backup races — **closed 2026-10-29** by
  [ADR-0112](../adr/0112-bucket-locks.md)'s locks. What stays is `delete`'s cross-set case,
  [0089](../adr/0089-hash-operand-delete.md)'s accepted consequence
  ([proposals/concurrency-and-locking.md](../../proposals/concurrency-and-locking.md)).
- The conditional-write backstop off-AWS — [s3-provider-compatibility.md](s3-provider-compatibility.md),
  Finding 3 item 5.
- Bucket versioning is recommended by every guide and **checked by no code path** —
  [proposals/engine-robustness.md](../../proposals/engine-robustness.md).
- A truncated stored snapshot object reading as a shorter valid snapshot — **closed 2026-08-14** by
  [ADR-0082](../adr/0082-snapshot-end-trailer.md)'s trailer, now a lone `.` line: a prefix cut
  either loses it or tears a row. (Independently found 2026-08-11; the audit did not catch this one,
  because it is compression-stream semantics rather than protocol.) Since snapshots became gzip
  ([ADR-0097](../adr/0097-gzip-snapshot-compression.md)) there is a second, independent check:
  gunzip verifies the stream's own length and CRC-32 trailer, so a cut also fails to decompress.
