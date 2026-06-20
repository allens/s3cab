# Engine & remote robustness

Epic: make the S3/remote engine sturdy, narrow, and operationally tunable.

- **S3ReadStream doesn't propagate body-stream errors.** `Body.pipe(this)` — `pipe` doesn't
  forward `error` events, so a mid-download failure may hang or end the stream silently. (No
  caller yet, but `restore` is built on it.)
- **`emptyBucket` is uncalled, destructive, and deletes one object per request.** Either
  remove until a caller exists or switch to batched `DeleteObjects` (1000/request). Its
  existence in the bundle is risk with no reward today.
- **Stale temp-file recovery.** A crashed snapshot leaves `.snapshot.tsv.zst` and every later
  snapshot fails until the user hand-deletes it. Detect staleness (age/PID), offer `--force`,
  or clean up on error via try/finally — ties into the known lock-file TODO.
- **Narrow the S3 SDK boundary to the SDK** (architecture-deepening candidate C). `s3.mjs`
  (meant to be the one SDK seam) also renders terminal progress bars (`cursorTo`/`clearLine`),
  ships an unused `bucketPolicy`, and exposes test-only `deleteObject`/`emptyBucket`. Lift
  progress into a small stderr-progress module (`snapshot` and `restore` hand-roll their own —
  three copies → one), move the test-only ops to a test helper, drop `bucketPolicy` until
  `setup` needs it. The interface narrows to the seam it guards.
- **Metadata privacy.** `upload` attaches hostname, username, and the full local path to every
  object — useful provenance, but it's PII sitting in object metadata, and the local path
  reveals structure the content-addressed layout otherwise hides. Make it opt-in/opt-out and
  document it.
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run.
- **Storage-class exposure.** `INTELLIGENT_TIERING` is hardcoded for AWS; users may want
  Glacier-class economics — but retrieval latency/cost then bleeds into `restore`/`verify` UX.
  Probably a `setup`-time choice.
