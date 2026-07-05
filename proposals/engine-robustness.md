# Engine & remote robustness

Epic: make the S3/remote engine sturdy, narrow, and operationally tunable.

- **S3ReadStream doesn't propagate body-stream errors.** `Body.pipe(this)` — `pipe` doesn't
  forward `error` events, so a mid-download failure may hang or end the stream silently. (No
  caller yet, but `restore` is built on it.)
- **`emptyBucket` is uncalled, destructive, and deletes one object per request.** Either
  remove until a caller exists or switch to batched `DeleteObjects` (1000/request). Its
  existence in the bundle is risk with no reward today.
- **Stale temp-file recovery.** A crashed/interrupted snapshot leaves `.snapshot.tsv.zst` and
  every later snapshot fails until the user hand-deletes it. The wrinkle is that this temp file
  does **double duty** — it's both the orphan-on-death *and* the crude in-progress **lock**
  (`withSnapshotFile` refuses to run if it exists), which is exactly why a naive "stale temp →
  delete it" on startup is unsafe: it can't tell a dead run's orphan from a concurrent live run.
  The robust fix breaks that double duty so the two are distinguishable — a **unique temp name
  per run** (timestamp/PID in the name) so an orphan never collides with a live run and any run
  can sweep strays on startup, or a real **lock file** with a PID + liveness check. Ties into the
  known lock-file TODO in `snapshot.mjs`. **Note (2026-06-26): a SIGINT handler is the wrong tool
  for this** — it only catches Ctrl+C, not a crash/SIGTERM/power-loss, so the robust startup-sweep
  layer has to exist regardless and then covers the Ctrl+C case too.
- **Metadata privacy.** `upload` attaches hostname, username, and the full local path to every
  object — useful provenance, but it's PII sitting in object metadata, and the local path
  reveals structure the content-addressed layout otherwise hides. Make it opt-in/opt-out and
  document it.
- **✅ DONE (2026-07-05) — `verify` finding model: drop the ambiguous-size skip and
  `conflictingRows`.** Landed: verify now returns a flat per-path `problems` list (`missing` /
  `wrong-size`), each file's recorded size checked directly against the one stored object, so a
  size conflict surfaces as a wrong-size problem on the exact file that disagrees with storage.
  ADR-0042 and `docs/design/backup.md` amended. Kept here (not deleted) as the anchor for the
  `human-first-output.md` slice-3 dependency. Original write-up follows.
  verify's
  size check deliberately *skips* any hash whose recorded size is ambiguous (two different sizes
  recorded for the same content across rows), reporting it instead under a separate
  `conflictingRows` category (see `src/lib/verify.mjs`, ADR-0042). But conflicting rows can only
  arise from a bug or a corrupt/torn manifest — identical content ⇒ identical size, always — and
  when they do, at least one recorded size must disagree with the **real stored object**. Yet the
  ambiguous-skip means verify never size-checks it against the bucket, so a genuinely wrong
  recorded size on a conflicting hash is *never reported as a mismatch* — only as an abstract
  "conflicting rows" that doesn't tell the user which file is wrong against storage. **Fix:**
  check each file's recorded size against the one actual stored object size directly; a conflict
  then surfaces naturally as per-file **wrong size** findings (the file(s) whose recorded size ≠
  stored). This removes the ambiguous-skip special case *and* the `conflictingRows` category, and
  is fully consistent with the file-centric verify output in
  [human-first-output.md](human-first-output.md). Residual: a conflicting hash whose object is
  *missing* is just "missing" (the conflict is moot). **A serious correctness flaw in a
  freshly-shipped feature** — record accurately and fix; when it lands, amend ADR-0042 and
  `docs/design/backup.md`. **Sequencing:** land this *before* the human-first-output epic's verify
  renderer slice (slice 3), so the file-centric renderer is built once against the corrected model.
- **✅ DONE (2026-07-05) — `verify`: move orphaned-object reporting to `cleanup`.** Landed:
  verify no longer computes orphans (`orphanObjects` / `orphanObjectsExact` gone), its result is
  now `{ bucket, sets }`, and `cleanup`'s non-destructive mode owns the orphan count with the
  unreadable-snapshot caveat as a hard safety gate. ADR-0042 and `docs/design/backup.md` amended.
  Original write-up follows.
  verify previously reported
  `orphanObjects` (stored − referenced) plus an `orphanObjectsExact` flag (ADR-0042). Orphans are
  a *cleanup* concern (reclaiming wasted space), **not** an *integrity* one — they never threaten
  restorability — so carrying them over-complicates verify, and is the **sole** reason
  `orphanObjectsExact` (and its unreadable-snapshot upper-bound caveat) exists in verify at all.
  Remove both from verify's result; surface the orphan count in **`cleanup`'s
  non-destructive/preview mode**, where the unreadable-snapshot caveat becomes a **hard safety
  gate** (never delete an object a snapshot you couldn't read might reference) rather than an
  advisory hint. verify's result then simplifies to `{ bucket, sets }` (per-set `problems` +
  `unreadableSnapshots`). Amend ADR-0042 and [cloud-cleanup.md](cloud-cleanup.md) when it lands;
  same "before slice 3" sequencing as the finding-model fix above.
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run.
- **Storage-class exposure.** `INTELLIGENT_TIERING` is hardcoded for AWS; users may want
  Glacier-class economics — but retrieval latency/cost then bleeds into `restore`/`verify` UX.
  Probably a `setup`-time choice.
