# User-facing path files use the native separator; `/` is an internal matching form

**Status:** accepted (settled 2026-07-12, folded into the ADR-0050 starter-exclude work). Refines
how `starterExclude` ([src/lib/sets.mjs](../../src/lib/sets.mjs)) is written.

## Context

The starter `exclude.txt` a new set is born with was written with posix `/` separators on every
platform (`**/node_modules/`, …). The reasoning was portability: `/` is a path separator on
every OS, whereas `\` is only one on Windows (it is a legal *filename character* on POSIX), and
a set's `exclude.txt` is pushed to the remote and can be pulled onto another machine by
`--inherit` — so a `\`-written pattern could silently stop matching if inherited on macOS/Linux.

But that traded the *everyday* experience of every Windows user for a *rare, non-catastrophic*
edge case. `exclude.txt` is not an internal artifact — it is a **public file the user opens and
edits**, and everywhere else s3cab faces the user it speaks native paths: the upload progress
line, the snapshot `path`/`#DIR`/`#EXCLUDED` rows (the walk stores `resolve(parentPath, name)`
verbatim — native), error messages. A Windows user, who may know nothing of macOS or Linux, met
one file that spoke a foreign separator. Worse, it was inconsistent even *within* a set's config
directory: `dirs.txt` already stores native absolute paths, beside a posix `exclude.txt`.

The `/` form is genuinely needed — but only *inside the matcher*, which normalizes any path and
any pattern to `/` to define a segment ([src/lib/exclude.mjs](../../src/lib/exclude.mjs),
[src/lib/walk.mjs](../../src/lib/walk.mjs) `path.split(sep).join(posix.sep)`). That is an
implementation detail of matching, not a contract the user must learn.

## Decision

**Write user-facing path files with the platform's native separator; keep `/` strictly as the
internal matching form.** `starterExclude`'s patterns pass through `nativePattern` (`replaceAll("/", sep)`),
and its header describes the native separator (`'\'` on Windows). The matcher is unchanged, so a
pattern written with `\`, `/`, or a mix all match identically — the separator is a *display*
choice, never a semantic one.

The cross-platform-inherit concern is **deferred to the boundary where it belongs**: the day
`--inherit`/`restore` grows real cross-OS support, that is where a pattern (and the native
absolute paths in snapshots, already the bigger obstacle) should be converted — paid once, when
the rare migration actually happens, not by every Windows user on every edit. A `# note` for the
migrator can be added then.

**Not changed:** the committed dogfood template [.s3cab/exclude.txt](../../.s3cab/exclude.txt)
stays posix `/` — it is a *repo* file (LF, [ADR-0021](0021-lf-line-endings-prettier-code-only.md)),
read by contributors on every OS, and works verbatim because the matcher normalizes it.

## Consequences

On Windows a new set's `exclude.txt` (and the `setup` notice that lists its active patterns) now
reads `**\node_modules\`, `**\.git\`, … — the paths a Windows user recognises. The pushed remote
copy is native for now (single-platform round-trips are unaffected; cross-OS is the deferred
boundary case). `starterExclude` is platform-dependent, so tests normalize it back to `/` to
assert the pattern *set* and separately assert native separators are used.
