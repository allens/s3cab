# A new set defaults `.git` out — but `setup` discloses every skipped pattern

**Status:** accepted (settled 2026-07-12, after a real `backup` run streamed a repo's
`.git/AUTO_MERGE`, `.git/index`, `.git/logs/HEAD`, … as backup content). Refines the
starter-exclude policy that had lived only as a code comment on `starterExclude`
([src/lib/sets.mjs](../../src/lib/sets.mjs)).

## Context

A new backup set is born with a starter `exclude.txt` (`starterExclude`). The standing rule
was: **active** patterns are strictly "you'd almost never want this backed up" (regenerable
dependency trees, OS metadata); anything **arguable** ships commented, because *a backup tool
must not silently skip files a user might mean to keep*. Under that rule `.git/` was
**commented** — a developer's history is arguably worth keeping, and it might not be on a
remote.

In practice that made a first `backup` of any working tree stream `.git`'s churning internals
(`AUTO_MERGE`, `FETCH_HEAD`, `index`, `logs/…`) as content: pure noise that changes every
commit, bloats the object store, and buries the files the user actually cares about. Ordinary
users (the target audience) have no `.git` at all; developers nearly always have the history
on a remote already.

The tension is real: excluding `.git` by default is exactly the "silent skip" the rule
forbids. What made `.git` *arguable* was invisibility, not the pattern itself.

## Decision

1. **`.git/` moves to the active default** (`**/.git/`), alongside `**/node_modules/`. Two OS-noise
   patterns that were mis-filed under "arguable" join it — **`**/._*`** (macOS AppleDouble
   files) and **`**/desktop.ini`** (Windows folder settings) — since they are the same
   never-wanted class as the already-active `.DS_Store` / `Thumbs.db`.
2. **`setup` discloses the skip.** On seeding the starter, the notice now **lists every active
   pattern**, one per line, instead of the old "skips node_modules and OS noise" summary. The
   default protects the common case; the listing informs the uncommon one (a developer who
   *does* want `.git` sees it named and can delete the line). This is what resolves the tension
   — the skip is defaulted, not *silent*.
3. **Genuinely arguable patterns stay commented:** `dist/`, `build/`, `coverage/`,
   `__pycache__/`, `*.tmp`, `*.log`. These can hold deliverables or real data a user means to
   keep, and no cheap disclosure makes defaulting them out safe.

The active/arguable split survives; `.git` crosses it only because setup-time disclosure is a
new, adequate mitigation. The list of active patterns is derived from `starterExclude` at print
time (`parseLines`, [src/lib/read-lines.mjs](../../src/lib/read-lines.mjs)) so the notice can
never drift from what is actually skipped.

## Consequences

`starterExclude` and the dogfood template [.s3cab/exclude.txt](../../.s3cab/exclude.txt) both
gain the three patterns (the template already carried `.git`; it now also matches the default's
OS-noise core). `readLines` is split into `parseLines(text)` + `readLines(path)` so the same
active-line rule serves both file reads and the in-memory starter. Existing sets are untouched
— the starter is a birth gift for *new* sets only, and `inherit` still reproduces a remote
config verbatim.
