# Engine & remote robustness

Epic: make the S3/remote engine sturdy, narrow, and operationally tunable.

- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run. _(Mostly addressed: request + connection timeouts landed so a
  dropped connection fails instead of hanging — [ADR-0065](../docs/adr/0065-s3-client-request-timeouts.md)
  — and a backup now rides out a wifi drop or a VPN switching on, with a plain-language message
  when it can't, via retries above the SDK —
  [ADR-0068](../docs/adr/0068-network-retries-above-the-sdk.md). Still open: bandwidth limiting,
  and resumability of a whole run.)_

_Moved out 2026-07-18 — stale temp-file recovery / the lock-file question →
[concurrency-and-locking.md](concurrency-and-locking.md); storage-class exposure →
[storage-tiers.md](storage-tiers.md). Two landed items (verify's finding model and moving
orphan reporting to `cleanup`, both 2026-07-05) were deleted rather than kept as ✅ entries —
they are of record in [ADR-0042](../docs/adr/0042-verify-bucket-operand.md) and
[docs/design/backup.md](../docs/design/backup.md), and git history holds the write-ups._
