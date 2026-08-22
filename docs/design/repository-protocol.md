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
| `objects/<sha256>` | absent → present | `backup`, `upload` — conditional PUT (`IfNoneMatch: "*"`) in `putObject` ([objects.mjs](../../src/lib/objects.mjs)) | `cleanup`, `delete` — via `deleteStoredObject`, the only remover |
| `snapshots/<set>/<name>.tsv.zst` | absent → present, then **immutable** | `backup`, `upload --snapshot` — no-clobber PUT in `uploadSnapshotFile` ([upload.mjs](../../src/lib/upload.mjs)) | `forget` only |
| `sets/<set>/info` | absent → claimed → re-stamped | `setup` claims it (conditional `putText`, first-writer-wins); `reattach` re-stamps OWNER with a plain PUT, preserving CREATED ([set-marker.mjs](../../src/lib/set-marker.mjs)) | never |
| `sets/<set>/dirs.txt`, `exclude.txt` | absent → present, overwritten freely | `setup`, `reattach`, `backup` (`pushSetConfig`, best-effort) | `pushSetConfig`, when the local file goes away |
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
| `<name>.tsv.zst` | A landed local snapshot. **Nothing on it records whether it was ever uploaded** — `readBaseline` takes the latest by name regardless, and remote existence is established later by a single HEAD. |
| `.snapshot.tsv.zst` | The in-progress work file, doubling as the per-set lock ([ADR-0048](../adr/0048-snapshot-lock-atomic-temp-file.md)) |
| `.snapshot.lookup.tsv.zst` | Hashes parked by an interrupted run ([ADR-0067](../adr/0067-park-hashes-on-interrupt.md)), closed with a `PARTIAL` `#END` trailer. Candidates only — every entry is re-validated by `fileProps` against the live file's size+mtime, and its ctime against the trailer's own completion instant ([ADR-0085](../adr/0085-ctime-cross-check-on-hash-reuse.md)), which is why it needs no liveness check. |

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

1. `readBaseline` — pick the latest **local** snapshot. Local read.
2. `storedHashes` ([upload.mjs](../../src/lib/upload.mjs)) — compare the baseline's remote
   snapshot against the local file, **byte for byte**
   ([ADR-0084](../adr/0084-snapshot-identity-byte-equality.md)). Identical → trust the baseline's
   hashes as the skip-list, minus every hash named by a deletion record. Anything else → drop the
   baseline and LIST `objects/` as a first backup would. **[atomic]** read. This was a name-only
   HEAD until 2026-08-14, which let another machine's same-named snapshot vouch for a local
   baseline that was never uploaded.
3. Acquire the lock — `open(".snapshot.tsv.zst", "wx")`. **[atomic]**, and a same-minute snapshot
   name is refused before this, by `existsSync` on the final name.
4. Per file: one `lstat` + hash (or a reuse of the baseline hash on identical size+mtime), then in
   the upload transform a second `lstat` via `fileChange`, then the conditional PUT.
   **[multi-step]** — the whole loop, and every object PUT within it, is interleavable with any
   other command against the bucket. Individual PUTs are **[atomic]**.
5. Land the local snapshot — `rename(tmp, final)`. **[atomic]**. A graceful interrupt instead
   renames the work file to the parked-lookup name.
6. Throw on any collected upload failure or drift — **before** step 7, so no manifest is published.
   The local snapshot from step 5 survives.
7. `uploadSnapshotFile` — no-clobber PUT of the manifest. **[atomic]. This is the commit point.**
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

- `--snapshot` — objects first, manifest last; same commit point, same atomicity.
- `--dir` — objects only, no manifest.
- `--file` — `fileChange` guard, then one conditional PUT **[atomic]**. `--force` is the only path
  in the whole tool that overwrites an existing object, and therefore the only repair for a
  corrupt one.

### `forget`

1. LIST the set's remote snapshots and require **every** named snapshot to exist before deleting
   **any** — a typo cannot leave the first two of three already gone.
2. Optional whole-bucket unrestorable scan → preview file → prompt (skipped together by `--force`).
3. DELETE each manifest. **[multi-step]** across names; each DELETE **[atomic]**.
4. Write the local audit record — deliberately *after* the deletes, so it records what actually
   happened.

### `cleanup`

1. Read every snapshot in the bucket (`referencedObjects`).
2. LIST `objects/`.
3. Read deletion records **last**.
4. Plan: orphan = stored − referenced, minus anything younger than `GRACE_MS`
   (7 days, [cleanup.mjs](../../src/lib/cleanup.mjs)); an object with no `LastModified` is treated
   as brand new and therefore protected.
5. Interlocks: an unreadable snapshot aborts **both** modes; missing objects refuse the acting path.
6. Prompt, then DELETE each orphan. **[multi-step]**, and the scan→prompt→delete window is the
   race surface.
7. Compact the deletion record (acting runs only, and only past both interlocks): union every
   record file, drop rows no snapshot references, conditional PUT of the merge at a fresh index
   **before** deleting the absorbed files. **[multi-step]**; a crash between the write and the
   deletes leaves duplicate rows, which readers dedupe and the next compaction collapses.

**The ordering in 1–3 is itself a guard**, not incidental: reading snapshots before the object
LIST means a concurrently-uploaded object appears unreferenced but *young*, where grace protects
it; reading deletion records last means a record written during the scan can only ever add
explanation, never remove it.

### `delete` ([ADR-0089](../adr/0089-hash-operand-delete.md))

1. Operands are content hashes (positional or `--from-file`, typically `find` output) —
   removal is repository-wide by construction, so there is no snapshot scan and no plan step.
2. Preflight: one HeadObject per hash. **[multi-step]** across hashes; a missing object is
   reported and skipped, and the ContentLength fills the record's size column.
3. The strongest confirmation in the tool (type the bucket name).
4. **Record first, then the deletes** — conditional PUT of `objects.deleted-<n>.tsv` at the
   lowest free index, then each `deleteStoredObject`. **[multi-step]**, deliberately ordered so
   a crash between them leaves an *over-complete* record (objects recorded as deleted that
   still exist, which reads as simply present) rather than unexplained absences.

### `verify`

Read-only; no transition. Reads manifests → LIST → deletion records, in that order, for the same
reason `cleanup` does. **Checks presence and size only — it never re-hashes object content**, so
a wrong-bytes-under-a-right-key object is outside what `verify` can see by construction. Sets
`process.exitCode = 1` on unexplained findings.

### `restore`

Per object: `getObject` → `writeFileAtomic` (digest check) → rename **[atomic]** per file. Two
failure modes, deliberately different:

- **absent object** → skip and continue; the deletion record partitions the outcome
  (recorded → exit 0, unexplained → exit 1);
- **anything else, including a digest mismatch** → propagates and **aborts the entire run**
  ([restore.mjs](../../src/commands/restore.mjs)).

### `reattach`

Read `info` → pull `dirs.txt`/`exclude.txt` and the remote snapshots (each landing via an atomic
local write) → re-stamp OWNER with a plain PUT **[atomic]**. It **never disables the prior
machine**: two live machines on one set is a tolerated state, not an error state — which is a
precondition for [C2](#where-the-model-is-violable). The outgoing `OWNER` is read here and
nowhere else, so this is also where the co-existence warning is issued (design/backup.md).

### `setup`

Local-exists check → `claimRemoteSet`, a conditional `putText` **[atomic]**, first writer wins and
the loser gets a loud collision error.

## The atomic gates, in one list

Five operations carry every state change that matters. Everything else is either a read or a step
whose failure leaves only recoverable residue:

1. `open(tmp, "wx")` — the per-set lock.
2. `rename(tmp, final)` — the local snapshot lands.
3. Conditional PUT of an object — idempotent under content addressing, so a retry or a duplicate
   delivery is a no-op rather than an overwrite.
4. **No-clobber PUT of the manifest — the commit point.**
5. Conditional PUT of `info` / a deletion record — first-writer-wins claims.

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
- The `cleanup`-vs-backup and `delete`-vs-backup races —
  [proposals/concurrency-and-locking.md](../../proposals/concurrency-and-locking.md) §1 and §3.
- The conditional-write backstop off-AWS — [s3-provider-compatibility.md](s3-provider-compatibility.md),
  Finding 3 item 5.
- Bucket versioning is recommended by every guide and **checked by no code path** —
  [proposals/engine-robustness.md](../../proposals/engine-robustness.md).
- A truncated stored snapshot object reading as a shorter valid snapshot — **closed 2026-08-14** by
  [ADR-0082](../adr/0082-snapshot-end-trailer.md)'s `#END` trailer: a prefix cut either loses the
  trailer or tears a row. (Independently found 2026-08-11; the audit did not catch this one,
  because it is zstd frame semantics rather than protocol.) What remains is defence-in-depth, not a
  hole — checking the decompressor consumed a complete frame —
  [proposals/engine-robustness.md](../../proposals/engine-robustness.md).
