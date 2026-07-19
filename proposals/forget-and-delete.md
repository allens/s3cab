# forget & delete — the deletion rework

The plan and design sketches for the deletion rework settled 2026-07-19 (the grilling session
that began as the orphan/unreferenced vocabulary stress-test and grew). **The decisions of
record live elsewhere** — the verb realignment in
[ADR-0063](../docs/adr/0063-forget-snapshots-delete-paths.md), the prerequisite bug in
[bugs.md](bugs.md) — this file is the *coordination spine*: PR slicing, dependencies, and the
sketches that aren't yet ADR/design-doc material. Per this directory's rules, sections are
deleted as their PRs land (lasting knowledge moves to ADRs / docs/design/ / guide/ first).

## What was settled (the user's calls, 2026-07-19)

- **`delete` (snapshot removal) is renamed `forget`; the freed `delete` becomes path-scoped
  content removal** — "I have no use for `foo`, stop paying to back it up", applied to
  history already taken. ADR-0063 carries the full reasoning.
- **Snapshots are never rewritten.** The new `delete` removes the *objects* backing the named
  paths (where nothing outside those paths still references them) and leaves every snapshot
  file intact as an accurate point-in-time record. Old snapshots then contain paths whose
  content is deliberately gone — acceptable, *because you decided you didn't care about those
  files* — provided the tooling can tell "deliberately gone" from "corrupted".
- **That distinction is carried by a repository-level deletion record** (a real repository
  primitive, not just a local log), consulted by `verify` and `restore`. **One artifact, not
  two**: machine-parsed *and* human-readable (the TSV-with-comment-header idiom snapshot
  files and the forget report already use), doubling as the audit record.
- **The backup baseline-trust bug (bugs.md, HIGH) is a hard prerequisite** for the new
  `delete` — path deletion removes objects recent local baselines still believe stored, so
  without the fix it widens the silent-corruption hole. Drift direction rule from that
  session: local *ahead* of remote is benign; local *believing more is stored than is* must
  not survive.
- **Churn and pre-release contract breaks are acceptable** — the right design trumps both
  (CLAUDE.md #5's version gate).

## The PR train

| PR | What | Depends on |
| --- | --- | --- |
| **A** | The baseline-trust bug fix ([bugs.md](bugs.md)) | fix-shape confirmation (sketch below) |
| **B** | Rename `delete`→`forget` **+** the `unrestorable` sweep (below) — two commits, one PR (same files, same guide prose) | — |
| **C** | `restore` degrades gracefully on a missing object (standalone robustness — today one missing object aborts the whole run mid-loop, [src/commands/restore.mjs](../src/commands/restore.mjs) has no catch around `getObject`) | — |
| **D** | The new `delete`: deletion record + purge computation + `verify` partition + `restore` record-awareness + `backup` record-subtraction + format-spec section + CONTEXT.md repairs + confirmation UX | A, B, C merged |

**Parallelism:** A, B, C touch disjoint files (A: `lib/upload.mjs`/`backup.mjs`; B:
`commands/delete.mjs`, `lib/orphans.mjs`, guide, design docs; C: `commands/restore.mjs`) — all
three can run concurrently as separate worktree sessions branched from `origin/main`. D is
strictly last. Each session: worktree + PR + Copilot review; A and D touch the S3 read/write
path → run `npm run test:integration` before push; scope every rename from a fresh `grep`,
not from this file.

## Sketches (proposals, not settled — confirm at each PR's session start)

### PR A — candidate fix shape: trust the baseline iff it still exists remotely

The objects-first/snapshot-last invariant means **a remote snapshot's presence proves its
objects were stored**, and `cleanup` never deletes referenced objects — so a baseline snapshot
that *still exists remotely* is a trustworthy skip-list, and one that doesn't isn't. One cheap
existence check (HEAD) on the baseline before `planUpload` trusts it; on failure, fall back to
the LIST path a first backup already takes. Note the invariant this leans on is exactly what
the new `delete` breaks — which is why PR D must extend the fix by also subtracting
deletion-record hashes from any baseline (interlock recorded in bugs.md).

### PR B — the `unrestorable` sweep (verdict grilled 2026-07-19, moved here from misc.md)

The original proposal — swap `orphan` to files and coin "unreferenced" for objects — was
grilled on its premise and **rejected**: there is no second reference-counted entity (a path
has no stored identity of its own; only objects carry a reference count), and
`planOrphans` renders the *same* orphan-object state by path, not a second state. What
`delete`'s (→ `forget`'s) report actually names is a **user consequence**: *a path no
surviving snapshot lists, so `restore` can no longer produce it* — **unrestorable**, hooking
onto the existing **Restore** vocabulary instead of borrowing `cleanup`'s storage-accounting
word. `orphan` stays exactly as CONTEXT.md defines it (object-side, `cleanup`'s domain);
`CleanupResult.orphanObjects` and the ~185-occurrence object-side surface are untouched.

Scope (rename + sweep together): `commands/delete.mjs` → `forget.mjs`, registry/render/tests,
`lib/orphans.mjs` module + exports (`planOrphans` → `planUnrestorable`, `OrphanPlan` →
`UnrestorablePlan`), the stdout header ("Orphan preview" → unrestorable family), report
filenames → `forget-unrestorable-preview.txt` / `forget-unrestorable-<timestamp>.txt`
(command-prefix provenance principle, settled when the files were named), the forget/delete
sections of [guide/maintenance.md](../guide/maintenance.md),
[snapshot-deletion.md](../docs/design/snapshot-deletion.md),
[backup.md](../docs/design/backup.md)'s retention-primitive prose, and CONTEXT.md (**Forget**
entry; **Unrestorable** entry cross-referencing Orphan and Restore).

### PR D — the deletion record and its consumers

- **Record sketch:** per-run TSV files under a bucket prefix (S3 has no atomic append; one
  file per `delete` run avoids lost updates), comment header (when, set, what was asked for)
  + `hash → path(s) → timestamp` rows. Name/prefix open — "deletion record" and `deleted/`
  are placeholders. It is a **format-spec addition** ([guide/format.md](../guide/format.md),
  ADR-0002): a future reader must be able to interpret it from the stored files alone.
- **Purge computation:** the exclusive-reachability variant of the `orphans.mjs` shape — a
  hash is deletable only if *every* reference to it, bucket-wide across all sets, lies under
  the named paths. Content shared with anything outside the selection survives.
- **`verify`:** partition `missing` into **expected** (hash in the deletion record — reported
  with its context, e.g. "deleted 2026-07-19", not a fault) vs **unexplained** (today's
  alarming finding, unchanged). Proposed: expected-missing alone exits 0, so
  `verify || alert` cron stays meaningful.
- **`restore`:** on a missing object, consult the record — a hit is a graceful per-file skip
  ("deliberately deleted on …"), reported at the end; a miss stays a loud failure.
- **`backup`:** subtract record hashes from any baseline (the PR A interlock).
- **Confirmation UX:** the only command that removes content live snapshots still reference →
  strongest confirmation in the tool; clig suggests typed-string confirmation for the
  severe/irreversible tier (`cli-design` skill at build time). Probably preview-by-default
  like `cleanup`. Old muscle memory (`s3cab delete --set s <snapshot>`) must fail loudly —
  a snapshot name matches no backed-up path.
- **CONTEXT.md repairs:** Cleanup's "the only command that removes stored objects" sentence;
  whether "unrestorable" needs widening or purged content is simply "deleted" (the natural
  reading once the command is `delete`) — resolve during D, deliberately.

## Deferred / not in this train

- **A "which snapshots contain this path" query command** — floated, has standalone value,
  but the new `delete`'s preview subsumes most of it. Revisit on demand.
- **Retention automation** (keep-last / daily / weekly / monthly) — unchanged; builds on
  `forget` + `cleanup` once real usage shows the shapes.
