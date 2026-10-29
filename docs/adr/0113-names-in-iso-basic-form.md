# Timestamped names use ISO 8601's basic form

**Status:** accepted & implemented (2026-10-29). Supersedes the spelling of names in
[0072](0072-timestamps-utc-in-files-local-in-names.md); everything else there stands.

## Context

A snapshot is named by the local time it started, to the minute: `2026-06-12T0915`. A forget
audit file is named the same way, to the second: `forget-unrestorable-2026-05-01T080213.txt`.
The colons are dropped because Windows refuses them in a filename, but the hyphens stay, so the
date is in ISO 8601's extended form and the time in its basic form. ISO 8601 doesn't allow
mixing the two in one representation, so the name is in no standard form, only one s3cab made
up. The lock keys added in [0112](0112-bucket-locks.md) are already in basic form throughout
(`locks/upload-20261027T140205.123Z`).

## Decision

**Every timestamped name is in ISO 8601's basic form: no hyphens, no colons.** A snapshot is
`20260612T0915`, a forget audit file `forget-unrestorable-20260501T080213.txt`. A string the
spec defines takes an official standard's form, not a mix of its own (user, 2026-10-28).

What 0072 decided about names is unchanged: local wall clock, no zone, minute precision for a
snapshot and second precision for an audit file. A basic-form name still sorts by its text,
and still begins with the local date (`20260612`), which a retention policy can read straight
from the name.

## Considered and rejected

- **Extended form, `2026-06-12T09:15`** — easier to read, but Windows can't name a file with a
  colon.
- **Keeping the mixed form** — easier to read than basic form, but not a standard's form, so a
  reader can't parse it by naming a standard.
- **Accepting both forms when reading** — pre-1.0, s3cab writes no compatibility code
  (CLAUDE.md → Coding conventions). A snapshot in the old form is no longer a snapshot.
