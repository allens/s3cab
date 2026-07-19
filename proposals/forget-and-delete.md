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
- **The backup baseline-trust bug (was bugs.md HIGH; fixed by PR A) is a hard prerequisite**
  for the new `delete` — path deletion removes objects recent local baselines still believe
  stored, so without the fix it widens the silent-corruption hole. Drift direction rule from
  that session: local *ahead* of remote is benign; local *believing more is stored than is*
  must not survive. The fix's invariant (a remote snapshot's presence proves its objects
  stored) is exactly what path-deletion breaks — PR D must extend it by also subtracting
  deletion-record hashes from any baseline.
- **Churn and pre-release contract breaks are acceptable** — the right design trumps both
  (CLAUDE.md #5's version gate).

## The PR train

| PR | What | Depends on |
| --- | --- | --- |
| ~~**A**~~ | ~~The baseline-trust bug fix ([bugs.md](bugs.md))~~ **— landed** (trust the baseline iff it still exists remotely; one HEAD in `uploadSnapshot`, miss → LIST fallback) | — |
| ~~**B**~~ | ~~Rename `delete`→`forget` **+** the `unrestorable` sweep~~ **— landed** | — |
| ~~**C**~~ | ~~`restore` degrades gracefully on a missing object~~ **— landed** (absent object → per-file skip, all unproduced paths reported at the end, exit 1; integrity/operational errors still abort; no deletion-record awareness — that is D's) | — |
| **D** | The new `delete`: deletion record + purge computation + `verify` partition + `restore` record-awareness + `backup` record-subtraction + format-spec section + CONTEXT.md repairs + confirmation UX | A, B, C merged ✓ |

**A, B and C have all landed (PRs #220, #218, #219) — D is unblocked.**

The D session: worktree + PR + Copilot review; it touches the S3 read/write
path → run `npm run test:integration` before push; scope every rename from a fresh `grep`,
not from this file.

## Sketches (proposals, not settled — confirm at each PR's session start)

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
