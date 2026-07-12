# A missing member directory aborts the run — fail, not skip

**Status:** accepted (2026-07-12) — **implemented** (2026-07-12). Follows on from
[0052](0052-retire-setup-update-mode.md)/[0053](0053-reattach-command.md), which made `dirs.txt`
the hand-edited surface for a set's directories.

## Context

Since [0052](0052-retire-setup-update-mode.md) retired update mode, a set's member directories are
changed by **editing `dirs.txt` directly** (a public file), and [0053](0053-reattach-command.md)'s
`reattach` pulls that file **verbatim** from the machine that created the set. So a listed
directory can easily not exist when a backup runs: a typo, a deleted or renamed folder, an
**unplugged external drive**, or foreign paths after `reattach` onto a different layout.

Today that path is unguarded: [walk.mjs](../../src/lib/walk.mjs) does `realpathSync.native(dir)`
per member directory, so the first missing one throws a **raw `ENOENT`** and the whole
snapshot/backup dies with a stack-trace-y error — fail-at-first, no listing, no guidance.

The design question is what *should* happen when a listed directory is absent.

## Decision

**A missing (or non-directory) member directory aborts the whole run, with one clear error
listing every offender** — it is not skipped, and the run does not proceed on the remaining
directories. An empty `dirs.txt` is the degenerate case and fails the same way ("nothing to back
up"). The error is [0030](0030-error-message-guidelines.md)-shaped: names the unavailable
directories, explains the likely cause (unplugged drive / deleted folder), and points at the
set's `dirs.txt` to fix. Enforced once in `walkSet` (the shared gate for `snapshot`/`backup`/`tree`).

**Why fail, not skip.** A backup tool's cardinal sin is *silently* backing up less than the user
believes it is. The absence is ambiguous — a **transient** unplugged drive is indistinguishable
from a permanent deletion — so skipping-and-warning would, on the common "I forgot to plug in the
backup drive" case, quietly produce a smaller backup while printing a warning that scrolls past in
a cron log. Failing loudly forces the ambiguity to the surface: reconnect the drive, or edit
`dirs.txt` to drop the directory on purpose. The cost — a nightly backup fails while a drive is
unplugged, rather than backing up the rest — is accepted, because a loud failure is recoverable
and a silent under-backup is not.

`reattach` also prints a **proactive** heads-up (unconditionally, no per-path checking — #5) that
the directory list came from the creating machine and may need editing before the first backup, so
this failure is expected rather than a surprise.

## Rejected alternatives

- **Skip the missing directory and warn.** Rejected as above: it risks a silent under-backup on
  the transient-drive case, the exact failure a backup tool must not have.
- **Check per-directory on `reattach` and warn only about the ones missing here.** Rejected as
  speculative machinery ([0006](0006-minimal-code.md)): the walk-time guard already catches a
  genuinely-missing directory at the moment it matters, so `reattach`'s nudge can be a flat,
  check-free heads-up.
- **Keep the raw `ENOENT`.** Rejected: fails at the first bad path (not a full listing) and reads
  as a crash, not guidance ([0030](0030-error-message-guidelines.md)).

## Consequences

`walkSet` gains an `assertWalkableDirs` pre-check ([src/lib/walk.mjs](../../src/lib/walk.mjs));
`snapshot`, `backup`, and `tree` all fail early and clearly on a bad `dirs.txt`. `reattach` gains
the proactive heads-up ([src/commands/reattach.mjs](../../src/commands/reattach.mjs)). The related
`compare` scope-change wrinkle (a `dirs.txt` change between two snapshots reads as added/deleted
files) is documented in [guide/compare.md](../../guide/compare.md), not code — it is advisory,
read-only output, and rare.
