# Path-scoped `delete`: participating-set scope, the deletion record, and the destructive-command pattern

**Status:** accepted (settled 2026-07-20, the PR D grilling session; builds on
[0063](0063-forget-snapshots-delete-paths.md), whose closing shape line it amends); the
record-naming bullet partly superseded by
[0087](0087-deletion-record-suffix-on-collision.md). Reasoned under clig.dev (the `cli-design`
skill) and [0012](0012-consumer-vocabulary-naming.md).

> **Partly superseded by [0087](0087-deletion-record-suffix-on-collision.md)** (accepted): a
> same-minute record now takes the next free name (`-2`, `-3`) instead of failing, and the
> `S3CAB_DEBUG` overwrite escape is removed. Everything else here — the prefix, the
> record-first ordering, the row shape, the destructive-command pattern — stands.

## Context

[0063](0063-forget-snapshots-delete-paths.md) freed the `delete` verb for **retroactively
removing named paths' content from history already taken** and settled the core mechanics:
objects deleted, **snapshots never rewritten**, a repository-level **deletion record**
marking the removal deliberate. What remained open — record name/format, scope, confirmation
UX, consumer semantics — was settled in this session and is recorded here.

## Decisions

### The deletion record — `deletions/<timestamp>.tsv`

- **One plain uncompressed TSV per `delete` run** under a new top-level prefix
  `deletions/` (S3 has no atomic append; per-run files avoid lost updates). Plural
  noun-of-events matching `snapshots/`; `deleted/` was rejected as reading like a folder
  *containing* the deleted things. Uncompressed because the record doubles as the
  human-readable audit artifact and is small — direct readability beats a negligible size
  win (snapshots compress because they are huge).
- **Minute-precision local timestamp names, the snapshot-name grammar** — one story for
  both timestamped artifacts. ~~The collision this invites is handled like a same-minute
  snapshot: a **conditional PUT** (`IfNoneMatch: *`) refuses a same-minute second run loudly
  ("wait a minute"); records are never overwritten. `S3CAB_DEBUG` drops the condition
  (dev/test escape).~~ **Superseded by
  [0087](0087-deletion-record-suffix-on-collision.md)** (2026-08-18): the PUT is still
  conditional, but a taken name now takes the next free one (`-2`, `-3`) rather than failing,
  and the `S3CAB_DEBUG` escape is gone. Refusing bought a snapshot's safety guarantee and
  nothing here, while costing a legitimate second delete. Second precision was rejected:
  denser names, a second timestamp shape in the spec, and the refusal is safe here because of
  ordering (next bullet). (`forget`'s *local* audit files stay at seconds deliberately: they
  are written *after* the destructive act, where refusal is impossible — and they are not
  bucket format.)
- **Record-first ordering:** the record is written *before* any object is deleted, so a
  crash mid-run can never leave missing objects unexplained. Over-recording (a recorded
  delete that then didn't finish) is the safe direction — the objects are simply present.
- **Rows are `hash<TAB>path`, one per reference the deleted objects had — all of them,
  every set** (under `--everywhere` that includes other sets' paths, whose tooling needs the
  explanation). No per-row timestamp (the filename is the timestamp) and no per-row size
  (misleading under dedup — totals live in the `#` header, the forget-report reasoning).
  The header carries generated / bucket / `user@machine` / in-scope sets / scope / the
  requested paths / totals. Parsing skips `#` lines; a row counts only if its first field
  is 64 hex chars — lenient only in the direction that never explains away an absence.
- **A format-spec addition** ([guide/format.md](../../guide/format.md), the
  [0002](0002-no-lock-in-hard-constraint.md) contract): a future reader must be able to
  interpret it from the stored files alone.

### Scope: participating sets; outside references protect

Named paths resolve to content **within the sets attached on the running machine that
point at the bucket** (`~/.s3cab/sets/`, filtered by bucket). An object is deleted only
when **every reference to it, bucket-wide, sits inside that selection** — any reference
from an unattached set (another user's, or this user's other machine's) **protects** the
object, with the preview naming the keeper ("survives: still referenced by set
`desktop-media` — not attached on this machine"; the fix is `reattach` + re-run).

- **The guarantee this buys:** `delete` cannot break any other user's restorability, *by
  construction* — attachment is the consent. Expected-missing can only ever appear in sets
  that were participating on the deleting machine.
- **Rejected: bucket-wide path matching** (the original sketch's literal reading). An exact
  absolute-path collision in a stranger's set would have deleted their content with only
  preview-vigilance standing in the way — safety by attention, not construction.
- **Rejected: single-set scope.** "Delete everything under `foo`" should cover all *your*
  sets holding it; per-set runs add ceremony, and `--set` would promise a boundary the
  protective scan doesn't have. There is no repository-level "my sets" concept to scope by
  — the local attachment list is the machine's honest approximation, pointed in the
  fail-safe direction (an unknown set can only protect, so a stale local view deletes
  *less*, never more).

### `--everywhere`: the content-scoped override

For the leaked-secret/malware case: the matched hashes are deleted **regardless of outside
references** — every reference anywhere becomes expected-missing, all of it written into
the record, with the affected out-of-scope sets named hard in the summary. Two constraints:
**resolution is still participating-sets-only** (a stranger's same-named path may hold
*different* content, which must never be swept up by name — the nuke is "this exact byte
sequence", never "this name"), and it is the same pipeline with the protection filter
switched off, not a second algorithm.

### Command shape — and the ADR-0063 amendment

```
s3cab delete --bucket <bucket> <path>... [-n|--dry-run] [-f|--force] [--everywhere]
```

- **Addresses the bucket, not a set** — amending 0063's closing "addressing via `--set`"
  line, which predated the scope decision: with bucket-wide protection and multi-set scope,
  a `--set` flag would misleadingly suggest set-scoped deletion. `delete` joins
  `verify`/`cleanup` as the repository-level trio, on the standard credential chain
  ([0033](0033-bucket-onboarding-security-model.md)'s everyday identity already carries the
  needed soft-`DeleteObject`). Per [0062](0062-bulk-operands-positional-addressing-by-flag.md)
  the bulk operand (paths) stays positional and addressing moves to a flag — hence
  `--bucket` (verify/cleanup take the bucket positionally only because they have no bulk
  operand). Old muscle memory `delete --set <set> <snapshot>` now fails twice over: unknown
  option, and a snapshot name matches no backed-up path (every named path must match, or
  the run errors before showing anything).
- **Acts by default; `-n/--dry-run` previews; `-f/--force` skips the prompt.** An
  imperative verb with an explicit object should do what it says; the safety is the
  confirmation, not a neutered default. Single-pass like `cleanup`: one whole-bucket scan →
  summary (per-path table, per-set breakdown) + preview file (`~/.s3cab/delete-preview.txt`,
  written before the prompt) → confirm → delete from the in-memory plan. (A cleanup-style
  `--delete` act flag was rejected: `delete --delete` collides with the command's own name,
  and the bare imperative silently doing nothing is the deeper flaw.)
- **The strongest confirmation in the tool** (0063's tier, clig's severe class): **type the
  bucket name** — the thing being irreversibly changed. **Non-interactive runs refuse
  without `--force`** (fail with instructions, never block) — deliberately stricter than
  `forget`. `--force` skips only the prompt: never the scan (the scan *is* the
  computation), and never the **unreadable-snapshot interlock** — an unreadable snapshot's
  references are unknown, and an unknown reference is exactly what must protect an object
  here, so acting aborts (`cleanup`'s logic); only a dry run proceeds, caveated.

### Consumer semantics

- **`verify`** partitions missing into **expected** (hash in the record — reported per
  path with its deletion date, a separate field, *not* a problem) vs **unexplained**
  (unchanged, alarming). **Expected-missing alone exits 0**: the state is permanent and
  deliberate, and exiting 1 forever would train users to ignore `verify || alert`.
  Binary 0/1 — no third exit code. A recorded hash that is stored anyway (re-backed-up)
  is simply present; the record entry is moot.
- **`restore`**: an absent object with a record hit is a graceful per-file skip, reported
  with its date; records are fetched lazily on the first absence (the happy path pays
  nothing). Expected-deleted skips alone leave **exit 0**; any unexplained absence stays
  exit 1.
- **`backup`** subtracts record hashes from a trusted baseline (the
  [0045](0045-change-detection-local-baseline-list-fallback.md)/baseline-trust interlock's
  second half): remote existence proves the baseline's objects were stored *then*; the
  record says what a later delete removed since. Still-present files simply re-upload.
- **`cleanup`** subtracts record hashes from its missing-object interlock — without this,
  the first `delete` would make `cleanup --delete` refuse forever.

### The destructive-command pattern (tool-wide; conversions done)

`delete` instantiates the pattern the tool standardizes on: **act by default with a
tier-proportionate confirmation, `-n/--dry-run` to preview, non-interactive destructive
runs require `--force`.** The follow-up conversions landed (PR #223): `cleanup` is
act-by-default + `-n` with its y/N tier (`cleanup --delete` no longer exists), and
`forget`'s non-TTY runs require `--force`. One grammar now covers all the tool's
destructive commands.

## Consequences

- `guide/format.md` gains the `deletions/` section; `guide/maintenance.md` gains `delete`
  (with an under-the-hood subsection); CONTEXT.md gains **Delete** and **Deletion record**
  and corrects Cleanup's "only command that removes stored objects".
- Old snapshots may list paths whose content is deliberately gone — acceptable *because
  the user decided they didn't care about those files*, and detectable as deliberate via
  the record. The deleted content's word is **"deleted"**; **"unrestorable"** stays
  `forget`'s preview term.
- `forget`'s unrestorable preview may overstate slightly for content a `delete` already
  removed (it counts references, not stored presence) — an accepted, safe-direction
  imprecision; revisit if it confuses in practice.
- A concurrent backup can re-upload content while a `delete` runs (its conditional PUT
  sees the object present pre-delete, skips, then the delete lands) — the published
  snapshot's gap is still record-explained, so this degrades to expected-missing, never
  silent corruption.
