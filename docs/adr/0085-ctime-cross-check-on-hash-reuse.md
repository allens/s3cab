# Distrust a size+mtime match whose ctime postdates the baseline

**Status:** accepted — designed and implemented 2026-08-14. Tightens the change-detection reuse
rule of [0045](0045-change-detection-local-baseline-list-fallback.md); the placeholder exemption
preserves [0081](0081-online-only-files-skipped.md)'s guarantee.

## Context

The last entry from the 2026-08-12 durability audit, confirmed on real NTFS: **a same-size
rewrite that puts the old mtime back is invisible to change detection.** The baseline reuse check
(`fileProps`) trusts `size` + `mtime` — both settable from userland — so a `touch -r`-shaped edit
(or FAT32's 2-second timestamps colliding with nobody asking) carries the baseline's hash forward
against new bytes. The next backup uploads nothing, and restore then "succeeds" with the old
content. `--rehash` existed as the escape hatch, but an escape hatch the user must know to pull is
not a guard.

The other half of the audit entry — the same shape escaping `fileChange`'s drift test *during*
upload — is already closed by [0083](0083-streamed-digest-upload-guard.md): the PUT hashes the
bytes it actually sends, whatever the stat claims.

What userland cannot set back is **ctime**: the rewrite, and the `utimes` call restoring the
mtime itself, both bump it. And the baseline already records when it was taken — the `#SNAPSHOT`
header's instant ([0072](0072-timestamps-utc-in-files-local-in-names.md)), minted at pass start from
the same system clock that stamps ctime. Comparing the two costs no syscall (the one `lstat` per
file already carries `ctimeMs`) and no format change.

## Decision

**`fileProps` reuses a size+mtime match only if the file's ctime predates the baseline
snapshot's instant** (`baselineMs`, threaded from `readBaseline`'s existing `instant` through
`generateSnapshot`'s `previousInstant`, which parses it to epoch millis once per pass rather than
once per file). A ctime at or after that instant proves the file was touched since the baseline
recorded it, so it is re-hashed.

Two deliberate trust grants:

- **No instant, no check.** The `prop` command's `--lookup` has no snapshot instant to offer;
  behaviour there is unchanged.
- **A dehydrated cloud placeholder keeps reusing its stored hash regardless.** Dehydration moves
  *only* ctime, so without the exemption every file the sync client reclaims would read as
  touched — and, having no bytes on disk to re-hash, drop out of the backup, exactly what
  [0081](0081-online-only-files-skipped.md) exists to prevent. Windows-only like all
  placeholder detection; elsewhere the same stat shape is a real sparse file and the guard
  applies.

## Consequences

- The confirmed `touch -r` repro now re-hashes: one extra file read, the new bytes are backed
  up, and the model-tier pinning test asserts the restore returns them.
- **Self-healing, one pass.** The re-hash lands the file in a baseline whose instant is newer
  than its ctime, so a distrusted file costs a single re-read, not one per backup.
- A false distrust is always safe — the re-hash produces the same hash and the pipeline dedups
  on it — so the check errs conservative: `>=` at the boundary, and metadata-only churn (chmod,
  ownership) after a backup triggers one re-hash too.
- Residuals, accepted: FAT32 records no change time, so the escape remains there (`--rehash`
  stays the documented recourse); a system clock set backwards between passes can stamp a
  baseline instant that postdates a later edit's ctime (`warnIfClockWentBack` already flags the
  situation); parked-hash lookups ([0067](0067-park-hashes-on-interrupt.md)) merged into an
  older baseline may re-hash once on resume.
- The model-based suite's virtual clock sits behind real time, so in that tier the guard
  distrusts every reuse — harmless (identical hashes, same snapshots), and the reason the exact
  older-vs-newer boundary is pinned in `file-props.test.mjs` rather than the model tier.
