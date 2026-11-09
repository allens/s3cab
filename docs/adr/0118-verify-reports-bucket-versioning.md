# `verify` reports whether the bucket keeps old versions

**Status:** accepted & implemented (2026-11-08). Extends [0042](0042-verify-bucket-operand.md)'s
report and [0117](0117-health-reports-count-only-what-they-checked.md)'s exit rule; adds a grant to
[0033](0033-bucket-onboarding-security-model.md)'s policy.

## Context

[0033](0033-bucket-onboarding-security-model.md) makes bucket versioning the backstop under the
everyday identity: with it on, `forget`, `delete` and `cleanup` write delete markers and the bytes
survive as noncurrent versions; with it off, every one of them is permanent.
[guide/maintenance.md](../../guide/maintenance.md) calls it the single thing that converts every
mistake on that page from permanent to recoverable. `s3cab aws` turns it on, and nothing read it
back: a bucket made by hand without it, or one whose versioning someone switched off, gave no
sign until the day a delete needed undoing.

S3 answers `GetBucketVersioning` with `Enabled`, `Suspended`, or no status at all for a bucket
that never had it on. Some S3-compatible providers have no versioning to report.

## Decision

1. **`verify` reads the bucket's versioning**, one `GetBucketVersioning` after the bucket scan,
   and reports one of four states: `enabled`, `suspended`, `never-enabled`, or `unknown` when the
   server refused the read.
2. **Only `suspended` is a finding**, so only it makes `verify` exit 1 (user, 2026-11-08: "Only if
   suspended"). It means versioning was on and has been switched off: a change in the bucket, the
   kind `s3cab verify <bucket> || alert` exists to catch, and an early step for anyone setting out
   to destroy a backup. `never-enabled` and `unknown` print a note and leave the exit code alone.
   Both are lasting states (a bucket made without it, a provider without it, an identity without
   the grant), and an alarm that fires on every run trains the user to ignore it, the reason
   [0064](0064-path-scoped-delete-deletion-record.md) keeps deliberate deletions out of the exit
   code.
3. **A lasting refusal is reported, not thrown.** When the server refuses with `AccessDenied` or
   `NotImplemented`, the note names it and the rest of the report stands: an identity without the
   new grant must not lose the check it already had. Any other failure, such as a dropped link, a
   `SlowDown` or an expired token, fails `verify` as it would during the scan: a passing failure
   reported as a note would hide a suspended bucket behind exit 0.
4. **`bucketPolicy()` grants `s3:GetBucketVersioning`** on the bucket. It reads a setting and
   writes nothing, so 0033's property, that a leaked everyday key can never permanently destroy
   anything, is untouched. `s3:PutBucketVersioning` stays ungranted.

## Considered and rejected

- **Exit 1 whenever versioning isn't on.** The loudest, but on a provider with no versioning every
  `verify` fails for good.
- **A note only, never the exit code.** The smallest, but a cron job reads only the exit code, so a
  bucket whose versioning was switched off would never reach anyone.

## Consequences

- An identity deployed before this has no `s3:GetBucketVersioning` until its stack is redeployed;
  until then `verify` notes `couldn't check (AccessDenied)`. A policy written by hand needs the
  same grant.
- `verify`'s result is `{ bucket, versioning, sets }`, so `--json` carries the state.
- The model tier's fake store answers `never-enabled`: it declares no `versioning` capability
  ([test/model/CAPABILITIES.md](../../test/model/CAPABILITIES.md)).
