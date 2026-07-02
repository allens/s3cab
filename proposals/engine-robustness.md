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
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run.
- **Storage-class exposure.** `INTELLIGENT_TIERING` is hardcoded for AWS; users may want
  Glacier-class economics — but retrieval latency/cost then bleeds into `restore`/`verify` UX.
  Probably a `setup`-time choice.
