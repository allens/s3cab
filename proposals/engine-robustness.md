# Engine & remote robustness

Epic: make the S3/remote engine sturdy, narrow, and operationally tunable.

- **Snapshot reads drop a mid-download body error.** `readRemoteSnapshot` (and the local
  snapshot read in `snapshot-file.mjs`) pipe the body through zstd-decompress with a plain
  `.pipe`, which doesn't forward the source's `error` — a truncated/dropped read stalls the
  parser instead of failing. `compose`/`pipeline` *do* propagate it, but their teardown
  **aborts the live S3 request** on normal completion (this regressed #171 with `ABORT_ERR`, so
  `readRemoteSnapshot` was reverted to `.pipe`). Proper fix: make `parseSnapshotStream` the
  terminal sink of a `pipeline` (source fully consumed before teardown), applied to both read
  paths, with a real-S3 mid-stream-error integration test — needs local real-S3 to verify
  ([docs/integration-testing.md](../docs/integration-testing.md)). (The *download* path,
  `getObject` → `writeFileAtomic` via `pipeline`, already propagates — #171 fixed it by dropping
  the old `S3ReadStream` wrapper; only the snapshot *reads* remain.)
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run.

_Moved out 2026-07-18 — stale temp-file recovery / the lock-file question →
[concurrency-and-locking.md](concurrency-and-locking.md); metadata privacy →
[metadata-privacy.md](metadata-privacy.md); storage-class exposure →
[storage-tiers.md](storage-tiers.md). Two landed items (verify's finding model and moving
orphan reporting to `cleanup`, both 2026-07-05) were deleted rather than kept as ✅ entries —
they are of record in [ADR-0042](../docs/adr/0042-verify-bucket-operand.md) and
[docs/design/backup.md](../docs/design/backup.md), and git history holds the write-ups._
