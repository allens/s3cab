# `forget` removes snapshots; `delete` moves to path-scoped content removal

**Status:** accepted (settled 2026-07-19 in a grilling session) — the `forget` rename is
**implemented** (PR #218, with the prerequisite baseline-trust fix in #220 and `restore`'s
graceful degrade in #219), and the path-scoped `delete` was built under
[0064](0064-path-scoped-delete-deletion-record.md), which also **amends this ADR's closing
shape line**: `delete` addresses the *bucket* (`--bucket`), not a set. **The verb table
below stands; the `delete` rationale is superseded by
[0089](0089-hash-operand-delete.md)** (2026-08-22): "delete `foo` from my backups" was
built on a path operand, and `delete` now takes content hashes fed by `find`. Reasoned
under the **Command Line Interface Guidelines** ([clig.dev](https://clig.dev), the
`cli-design` skill) and [0012](0012-consumer-vocabulary-naming.md).

## Context

`delete` shipped (PR #217, [0062](0062-bulk-operands-positional-addressing-by-flag.md),
[docs/design/snapshot-deletion.md](../design/snapshot-deletion.md)) as the snapshot-removal
primitive: remove named remote snapshots; `cleanup` later reclaims what nothing references.

A second removal operation then surfaced: **retroactively removing named paths from history
already taken** — "I have absolutely no use for `foo`; it is a waste to keep it backed up."
Nothing covers that today: excludes only stop *future* backups, and removing old snapshots
never touches content still referenced by current ones. The settled shape for the new
operation (same session) is **delete the objects backing those paths, never rewrite the
snapshots** — snapshots stay accurate point-in-time records; a repository-level **deletion
record** marks the removal as deliberate so `verify` can tell expected-missing from
corruption and `restore` can skip gracefully (sketch in the delivery plan; a design doc when
built).

So two removal operations need verbs — and the shipped one is holding the best word for the
other one.

## Decision

| Operation | Verb |
| --- | --- |
| Remove named remote **snapshots** (today's `delete`) | **`forget`** |
| Remove named **paths'** content from the whole backed-up history (new) | **`delete`** |

**Why `forget` for snapshot removal:**

- **restic uses `forget` for exactly this operation** (remove a snapshot from the repository;
  content reclaimed by a later `prune`) — the peer tool a casual-but-technical user most
  likely knows, so the expectation comes free (clig: consistency).
- **Temporal fit.** A snapshot is a point in time (CONTEXT.md); you forget *a moment*, you
  retire *a thing in service*.
- **It is the accurate word for what happens.** The command removes only the snapshot file;
  the content lingers until `cleanup`. "The repository forgets the moment; the stuff remains
  until swept" is nearly literal.
- **The danger gradient matches the name gradient:** the metadata-level operation gets the
  soft verb; the operation that destroys referenced content gets the hard one.

**Why `delete` for path removal:** "delete `foo` from my backups" is the plainest possible
reading of the plainest verb — [0012](0012-consumer-vocabulary-naming.md) wins over matching
Borg (whose `borg delete <archive>` uses the word for snapshot removal). A deliberate trade:
plain-English fit over peer-tool alignment, taken with eyes open.

Both commands keep [0062](0062-bulk-operands-positional-addressing-by-flag.md)'s shape — bulk
operand positional (snapshots / paths), addressing via `--set`/`-S`. No new shape decision.

## Why not the alternatives

- **`retire` for snapshot removal** — the runner-up. Reads well, but CONTEXT.md's Reattach
  entry already uses "retired" for *machine* succession, and one word carrying two meanings
  is the synonym drift the glossary's `_Avoid_` apparatus exists to prevent. It also connotes
  preservation-in-honor (a retired jersey is kept, not destroyed) and reads more naturally at
  machine/set scope than at moment scope.
- **A new verb (`purge`/`discard`/`expunge`) for the path operation, `delete` unchanged** —
  avoids all rename churn. Rejected: `purge` sits on the Cleanup entry's `_Avoid_` list
  precisely because it evokes routine janitorial sweeping, the opposite of a deliberate
  override; `discard`/`expunge` are weaker than the word users will actually reach for. Churn
  is explicitly cheap pre-1.0 (CLAUDE.md convention #5's version gate); a worse name forever
  is not.
- **Swap the other way (`forget` for paths)** — mismatched on both sides: it would repurpose
  restic's snapshot-removal word for a different operation, and give the tool's most
  destructive command its gentlest verb.

## Consequences

- **Rename churn** across `src/commands/delete.mjs` (→ `forget.mjs`), the registry, render,
  tests, `guide/maintenance.md`, [snapshot-deletion.md](../design/snapshot-deletion.md),
  [backup.md](../design/backup.md) ("`delete` is the retention primitive" prose), and
  CONTEXT.md (a **Forget** entry; `delete` in the retired sense joins its `_Avoid_` list).
  Scope from a fresh `grep` at build time.
- **The report filenames follow the settled provenance principle** (the command's name
  prefixes its artifacts): `forget-unrestorable-preview.txt` /
  `forget-unrestorable-<timestamp>.txt`, folding in the `unrestorable` vocabulary verdict
  (see the delivery plan).
- **Stale muscle memory must fail loudly.** After the swap, an old-style
  `s3cab delete --set <set> <snapshot>` hits the *new* command with a snapshot name as a
  path. That must be a clear error (the name matches no backed-up path), never a silent
  no-op — and the new command's validation should be checked against exactly this case.
- **The new `delete` becomes the second command that removes stored objects** — CONTEXT.md's
  Cleanup entry ("the only command that removes stored objects") is corrected when it lands.
  Unlike `cleanup` it removes content that live snapshots still reference, so it takes the
  strongest confirmation in the tool (clig: for severe/irreversible cases, require typing a
  non-trivial string — design at build time, `cli-design` skill).
- **The deletion record is a repository-format addition** → documented in
  [guide/format.md](../../guide/format.md) when built ([0002](0002-no-lock-in-hard-constraint.md):
  recovery from the stored files alone).
- **Hard prerequisite:** the backup baseline-trust bug
  ([proposals/bugs.md](../../proposals/bugs.md)) must be fixed first — path-scoped deletion
  removes objects that recent local baselines still believe stored, so shipping it before
  that fix widens a silent-corruption hole.
