# Engine & remote robustness

Epic: make the S3/remote engine sturdy, narrow, and operationally tunable.

- **Bucket versioning is load-bearing everywhere and verified nowhere.** The whole soft-delete
  and ransomware-recovery story rests on it —
  [ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md), [guide/maintenance.md](../guide/maintenance.md)
  ("Versioning: why any of this is safe"), and the reassurance in
  [concurrency-and-locking.md](concurrency-and-locking.md) §1 that the backup/cleanup race is
  survivable because the delete is soft. `s3cab aws` turns versioning on when it provisions a
  bucket, but **no code path ever asks whether it is on**: there is no `GetBucketVersioning`
  anywhere in [src/lib/s3.mjs](../src/lib/s3.mjs). On a hand-made or provider bucket where it was
  never enabled, every `forget` / `delete` / `cleanup` is a hard delete and every accepted race
  above converts from recoverable to permanent — with no warning at any point, because the
  degradation is invisible until the day someone needs to undo something. Not a loss path on its
  own; an amplifier under all of them. Cheapest shape is probably a one-call check where the
  repository is already being inspected (`verify`, or a `provider --check`-style probe —
  [provider-check.md](provider-check.md)), reported as a finding rather than an error, and noting
  that some S3-compatible providers have no versioning to check. _(From the 2026-08-12 durability
  audit; provenance in [bugs.md](bugs.md).)_
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting, resumability of
  a multi-thousand-file upload run. _(Mostly addressed: request + connection timeouts landed so a
  dropped connection fails instead of hanging — [ADR-0065](../docs/adr/0065-s3-client-request-timeouts.md)
  — and a backup now rides out a wifi drop or a VPN switching on, with a plain-language message
  when it can't, via retries above the SDK —
  [ADR-0068](../docs/adr/0068-network-retries-above-the-sdk.md). Still open: bandwidth limiting,
  and resumability of a whole run.)_

_Moved out 2026-07-18 — stale temp-file recovery / the lock-file question →
[concurrency-and-locking.md](concurrency-and-locking.md); metadata privacy →
[metadata-privacy.md](metadata-privacy.md); storage-class exposure →
[storage-tiers.md](storage-tiers.md). Two landed items (verify's finding model and moving
orphan reporting to `cleanup`, both 2026-07-05) were deleted rather than kept as ✅ entries —
they are of record in [ADR-0042](../docs/adr/0042-verify-bucket-operand.md) and
[docs/design/backup.md](../docs/design/backup.md), and git history holds the write-ups._
