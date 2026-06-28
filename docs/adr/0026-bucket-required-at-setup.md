# A bucket is required at setup; no local-only sets

**Status:** accepted (2026-06-21) — implemented. Part of the 2026-06-20 redesign with
[0024](0024-set-name-is-the-whole-identity.md) and [0025](0025-drop-per-bucket-env-layer.md);
full design in [docs/specs/backup.md](../specs/backup.md). `setup` requires `--bucket` and
always touches S3 when creating (it pulled forward with the
[0024](0024-set-name-is-the-whole-identity.md) collision check, which can't run without a
bucket); the code cleanup it unlocks then landed — `resolveRemoteSet` folded into `resolveSet`,
`BackupSet.bucket` is non-optional (`readSet` enforces it), and `formatSets`' "(no bucket —
local only)" branch is gone.

`s3cab setup` requires `--bucket` when creating: a set is bound to its bucket at creation, and
creating a set always touches S3 (to run the collision check, [0024](0024-set-name-is-the-whole-identity.md)). The
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
- `formatSets`' "(no bucket — local only)" branch, the `resolveRemoteSet` guard, and the
  local-only e2e cases are all removed; the bucket invariant is now enforced once, in `readSet`.
- Weighed against [0002](0002-no-lock-in-hard-constraint.md) (no lock-in): no-lock-in is about
  the *stored format* being self-evident and recoverable without s3cab, not about running
  s3cab itself offline — so requiring a bucket at setup does not dent it.
