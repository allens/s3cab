# A bucket is required at setup; no local-only sets

**Status:** partly accepted (2026-06-21). The **setup-requirement half is implemented** —
`setup` requires `--bucket` and always touches S3 (it pulled forward with the
[0024](0024-set-name-is-the-whole-identity.md) collision check, which can't run without a
bucket). **Still pending:** the code cleanup this unlocks — folding `resolveRemoteSet` into
`resolveSet`, making `BackupSet.bucket` non-optional, and deleting `formatSets`' "(no
bucket — local only)" branch — is its own slice (the last of the redesign). Full design in
[proposals/local-config-and-remote-storage-structure.md](../../proposals/local-config-and-remote-storage-structure.md).

`s3cab setup` requires `--bucket`: a set is bound to its bucket at creation, and setup always
touches S3 (to run the collision check, [0024](0024-set-name-is-the-whole-identity.md)). The
bucket-less, local-only set — a fully working offline snapshot engine that deferred binding a
bucket — is removed.

## Why

The whole tool depends on having an S3 bucket; "setup" should mean *you are set up*. The
local-only model produced a **deferred surprise**: the user discovers at `backup` time that
they were never actually configured for backup, and has to go back to `setup` to bind a bucket
anyway. Requiring the bucket up front turns that into one clear contract.

It is also simpler on every code axis. With every set guaranteed a bucket (and, per
[0024](0024-set-name-is-the-whole-identity.md), a namespace equal to its name), the two-tier
resolver collapses: `resolveRemoteSet`'s "no bucket bound" / "no namespace" guards become dead
code and fold back into `resolveSet`, `BackupSet.bucket` becomes non-optional, and the
collision check lives in exactly one place (`setup`) instead of firing at every "first remote
touch." Keeping local-only would keep the two-tier split *and* spread the check across
setup-with-bucket / bind-later / first-backup with "already registered?" conditionals.

## Consequences

- What's lost is narrow: creating a set with **zero** S3 configured (the "try a snapshot
  before touching the cloud" path). Offline operation generally is **not** lost — after a
  one-time online `setup`, `snapshot`/`compare`/`tree` still run with no network; only the
  ~5 seconds of setup needs connectivity, which is reasonable for a tool whose reason to exist
  is S3 backup.
- `formatSets`' "(no bucket — local only)" branch, `backup`'s "no bucket bound" guard, and the
  local-only e2e cases all delete.
- Weighed against [0002](0002-no-lock-in-hard-constraint.md) (no lock-in): no-lock-in is about
  the *stored format* being self-evident and recoverable without s3cab, not about running
  s3cab itself offline — so requiring a bucket at setup does not dent it.
