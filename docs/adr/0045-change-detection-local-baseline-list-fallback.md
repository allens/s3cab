# Change detection: drop the objects cache; baseline = local snapshot + on-demand LIST + conditional-PUT backstop

**Status:** accepted (settled 2026-07-06 in a grilling session; **engine implemented** —
`backup`/`uploadSnapshot`, behind the existing `backup`). The **companion** to
[ADR-0044](0044-upload-unified-command-surface.md): 0044 records the *command-surface*
reshape (unify `upload`, retire `backup --snapshot`); this records the *change-detection*
engine. Both were sliced from a shared upload/change-detection proposal (since retired, its
work done); this is the first (engine) slice, and lands with **no** command-surface change. The full
behaviour lives in [docs/design/backup.md](../design/backup.md) ("How `backup` computes the
upload set").

## Context

`backup` never re-uploads content that is already stored — the object key *is* the content
hash, so an already-present object needs no PUT. The question is only how *cheaply* it decides
what to skip. The shipped engine narrowed the upload set three ways: diff the target snapshot
against the **latest remote snapshot**, minus a **persistent per-bucket objects cache**
(`~/.s3cab/objects.<bucket>`), with the conditional PUT (`noClobber`) as the net.

Two facts undercut that design:

- **The cache never changed *what* uploaded.** The conditional PUT (plus the ≥ 8 MB HEAD
  preflight before a multipart upload) already prevents any wasted transfer. The cache only
  ever saved **round-trips**, and only for objects present in the bucket but absent from the
  diff baseline (churned out of the latest snapshot, or from another set in the shared
  bucket). Yet it was the one component that could be **poisoned**: a cached-but-absent entry
  silently skips a needed upload and breaks the objects-first/snapshot-last invariant. That
  hazard is why `verify` and `cleanup --delete` had to carry cache-rewrite/healing machinery
  — a whole subsystem defending a round-trip saving that is **zero in the common case**.
- **A set is owned by exactly one machine** (the `sets/<name>/` marker; `--inherit`
  *re-stamps* the owner, it never shares — [ADR-0024](0024-set-name-is-the-whole-identity.md)).
  So the machine's **local** snapshot history already knows every prior upload of that set;
  there is no other machine whose uploads it wouldn't see. (This corrects an earlier
  assumption that a set could be backed up from several machines — it cannot.) Fetching the
  *remote* snapshot to diff was therefore never necessary for a set you own.

## Decision

1. **Drop the persistent per-bucket objects cache** — `knownObjects` / `recordObjects` /
   `writeObjectsCache` / `objectsCachePath` in `objects.mjs`, its use in `uploadSnapshot`, and
   the `--skip-cache` flag.
2. **`backup`'s change-detection baseline is the set's previous *local* snapshot.** Its
   objects were stored when it was uploaded (the snapshot-last invariant), so anything it
   references is skipped with **no network read**. `backup` (porcelain) resolves the baseline
   and hands it to the `uploadSnapshot` plumbing.
3. **First backup (no previous local snapshot) → an on-demand `LIST` of `objects/`.** With no
   local baseline, LIST the store once and diff the target against what is already there —
   the batch existence-check (one paged LIST vs. a per-object HEAD), run exactly when there is
   nothing local to diff against. Print `Scanning existing objects in '<bucket>'…` to stderr
   **before** the LIST so the tool never looks hung on a large store.
4. **The conditional PUT (`noClobber`) stays the correctness backstop.** It silently no-ops
   any already-present object the baseline missed, so **correctness never rides on the
   baseline** — the baseline is purely a round-trip optimization.
5. **`verify` and `cleanup` drop their cache rewrite/healing duties**, keeping their
   `LIST`-based integrity roles. `verify` becomes fully read-only (List+Get, no local state);
   `cleanup --delete` no longer rewrites a local cache nor warns other machines to run
   `verify` first (there is no cache left to poison).

This is deterministic, not a state-dependent "auto": snapshot mode with a baseline diffs
against it; without one it LISTs. Nothing hunts for "which snapshot is latest/previous" inside
the plumbing — that resolution is `backup`'s job ([ADR-0044](0044-upload-unified-command-surface.md)).

## Consequences

- **Simpler engine, fewer failure modes.** The one locally-poisonable component is gone; the
  invariant no longer depends on a local file staying honest. `verify`/`cleanup` shrink.
- **Partly supersedes [ADR-0042](0042-verify-bucket-operand.md)'s** "rewrites the objects
  cache" consequence — verify's sole former side effect. The bucket-operand decision itself
  stands.
- **Accepted trade-off:** a *tiny* first backup into a *huge* shared bucket pays a big LIST to
  save few round-trips. Accepted as a one-time first-run cost; an opt-*out* is added only if
  it ever bites (CLAUDE.md #7). Object keys are SHA-256 hex (uniformly distributed), so the
  LIST can be prefix-parallelised later if a million-object store makes it worth it.
- **Off-AWS backstop reliability is unverified.** Because the conditional PUT is now the
  *only* correctness backstop, its behaviour on multipart uploads off-AWS (R2/B2/MinIO/Wasabi)
  needs a per-provider check ([docs/design/s3-provider-compatibility.md](../design/s3-provider-compatibility.md))
  before we lean on it there. On AWS it is confirmed (`If-None-Match: *` on
  `CompleteMultipartUpload`, forwarded by the SDK's `lib-storage` `Upload`); keep the ≥ 8 MB
  HEAD preflight, which stops a large already-present object burning a whole transfer before
  the completion-time check fires.
- **`status` is unaffected** — its read-only estimate still diffs the latest *local* against
  the latest *remote* snapshot (a machine-independent property), distinct from the local
  baseline `backup` now uses.
