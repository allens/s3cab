# The s3cab home is `~/.s3cab` on every OS — not XDG or AppData

**Status:** accepted (settled 2026-07-03, in a clig.dev conformance review) —
**implemented** since the beginning ([src/lib/home.mjs](../../src/lib/home.mjs)); this ADR
pins the choice so it isn't re-litigated.

## Context

clig.dev recommends the XDG base-directory spec for per-user paths (`~/.config/<tool>` for
config, `~/.local/share/<tool>` for data); Windows' native convention is
`%APPDATA%`/`%LOCALAPPDATA%`. s3cab instead keeps *everything* — env files, sets, snapshot
manifests, the objects cache — under one `~/.s3cab` directory, identical on every OS.

## Decision

Keep `~/.s3cab`, one dotdir, same literal path everywhere. Because:

1. **The path is public contract, not an implementation detail.** It is printed in help
   topics, error messages, and the guide, and the format spec's recovery story depends on a
   user finding their own data. One stable path beats three per-OS paths in every piece of
   user-facing text.
2. **The directory is deliberately semi-visible** — easy to find when you go looking, not in
   your face day-to-day (hence a dotdir). `~/.local/share` fails the "easy to find" half:
   it's too hidden for data the user owns and may need to walk into during recovery.
3. **XDG isn't native on Windows** — the OS sets no `XDG_*` variables; only ported Unix
   tools emulate it there. The consumer audience is heavily Windows.
4. **Peer-group precedent:** `~/.aws`, `~/.ssh`, `~/.docker` — the tools s3cab sits beside —
   all use the dotdir on every platform.

`S3CAB_HOME` remains the single relocation knob (test isolation, or a user who wants the
state elsewhere) — see [src/lib/home.mjs](../../src/lib/home.mjs).

## Consequences

Docs, help text, and error messages may spell the literal `~/.s3cab/...` paths (and do).
This is a deliberate, recorded divergence from clig.dev's XDG recommendation — the kind its
own "break rules with intention" clause blesses.
