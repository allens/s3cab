# `verify` takes a bucket operand, symmetric with `cleanup`

**Status:** accepted (settled 2026-07-03; operand reversed to the bucket during
implementation — see History) — **implemented** (`src/commands/verify.mjs`, over the
`referencedObjects`/`listStoredObjects` lib enumerations and the pure diff in
`src/lib/verify.mjs`). Sits in the command-shape lineage of
[0035](0035-aws-profile-sets-command-rationalization.md)/[0036](0036-setup-mutates-list-shows-drop-sets.md)/[0040](0040-restore-requires-set-name.md);
the full design (finding classes, report, ordering invariant) is in
[docs/design/backup.md](../design/backup.md).

> **Known finding-model correction pending (2026-07-04):** the size check skips *ambiguous*
> recorded sizes and reports them under a separate `conflictingRows` category — which lets a
> genuinely wrong recorded size go unreported as a mismatch. It is to be replaced by a per-file
> recorded-vs-stored size check (dropping the ambiguous-skip and `conflictingRows`). **Also
> pending:** orphan reporting (`orphanObjects` / `orphanObjectsExact` — the "orphan count is
> always reported" decision below) **moves out of verify to `cleanup`'s non-destructive mode**;
> orphans are a reclamation concern, not an integrity one, and the move removes the upper-bound
> flag from verify entirely. See
> [proposals/engine-robustness.md](../../proposals/engine-robustness.md); this ADR and
> `docs/design/backup.md` get amended when the fixes land.

## Context

`verify` checks that backups are complete and undamaged: every object a snapshot
references must exist in `objects/` at its recorded size, established with LIST requests
only (no egress). Three facts shape the surface:

- **The stored-side enumeration is bucket-wide no matter what.** S3 offers no cheap
  per-key existence probe at scale — one LIST (1,000 keys + sizes per request) beats
  per-key HEADs by orders of magnitude — so even checking a single set pays the full
  `objects/` LIST. It is the *only* meaningful cost of a verify run.
- **So set-scoping buys almost no efficiency.** Because the LIST is paid regardless,
  narrowing to one set saves only a few small snapshot GETs for the *other* sets — not
  the expensive part. What a set operand would buy is *framing* (name the set you know)
  and *credentials* (run under that set's least-privilege env), not cost.
- **A per-set operand can't share one auth context across a shared bucket cleanly.** The
  S3 client is built once per process from the env in force at first touch (`s3.mjs`),
  and the set env layer is additive (`env.mjs`). Checking several sets whose buckets need
  *different* credentials/endpoints in one run isn't isolable without rebuilding that
  boundary — real surgery for a rare configuration.

There is no honest way to skip the LIST on a later run, either: S3 exposes no bucket
change signal, and any marker s3cab maintained would only record *cooperative* writes —
while verify's whole threat model is uncooperative change (console mis-deletes, lifecycle
rules, ransomware). A verify that trusts "nothing changed" is blind to what it exists to
catch. So one run = one bucket LIST, always.

## Decision

- **The operand is the bucket:** `s3cab verify <bucket>` — one repository checked in one
  run, under one credential resolved through the standard chain (like `hashes`/`upload`/`cleanup`,
  not the per-set env). This makes verify the **read-only twin of `cleanup`**: both take
  `<bucket>`, both compose the same two enumerations (*stored* and *referenced*), and they
  are opposite set-differences of them (verify: referenced − stored; cleanup: stored −
  referenced). The design already pairs them; the shared operand makes the pairing structural.
- **Findings are still reported per set.** `referencedObjects` groups the bucket's
  snapshots by the set that owns them (the `snapshots/<set>/` path segment), so the report
  says *which* set each finding belongs to (`photos: clean; bob-documents: 3 missing`).
  Bucket operand, set-level report — the earlier "verify photos shouldn't fail over
  bob-documents" worry was about the operand, not the report, and is answered by keeping
  the report per-set.
- **The orphan count (stored − referenced) is always reported, with an exactness flag.**
  A bucket run reads *every* snapshot, so the difference is precise — *unless* a snapshot
  is unreadable, whose references are then unknown and make the count an upper bound
  (objects it alone referenced look orphaned). The result carries `orphanObjectsExact`
  accordingly. Either way it is a hint toward `cleanup`, never a finding, never affecting
  the exit code.
- **Exit 1 when any set has findings** (0 = verified clean; 2 stays bad input) —
  `s3cab verify <bucket> || alert` is the cron idiom. No dedicated exit code until a
  script actually needs "damaged" vs "check failed".
- **Remote read-only, one local side effect:** verify never writes to the bucket (it runs
  on List+Get credentials), but it **rewrites the per-bucket objects cache** from the
  completed LIST (atomic temp + rename; never from a partial LIST). The LIST is
  authoritative ground truth already paid for: the rewrite warms the next backup and
  auto-heals a *poisoned* cache — the cached-but-absent entry that silently causes future
  missing objects — instead of telling a consumer to delete a cache file. Safe both ways
  by the staleness asymmetry.

## Consequences

- [src/commands.mjs](../../src/commands.mjs): `verify` takes a required `<bucket>`
  positional (fail-fast `requireArg`), like `hashes`/`upload`. It stays in the
  **Backup & restore** help group — a first-class consumer operation about backup safety,
  not a plumbing building block — even though its operand is a bucket.
- The *referenced* enumeration is a lib function only — no plumbing command until a caller
  outside `verify`/`cleanup` appears (hand recovery already reads the hashes straight out
  of the snapshot files with `zstdcat` + `cut`).
- `cleanup` lands the same shape: `<bucket>` operand, the same bucket-wide referenced
  union (its must span every set — deleting on less than the whole truth would eat another
  set's data), the same standard-chain credentials. verify is its dry, read-only half.

## History

Settled first (2026-07-03, in a grilling session over the slice-5 design) as **set-scoped
and variadic** — `verify [<set>...]`, no argument = every set — to preserve the porcelain's
set-first promise. During implementation that reversed, before it ever shipped as code
(the set-scoped form lives only in git history, commit `04016d4`): the efficiency argument
for a set operand turned out to be near-nil (the `objects/` LIST is paid whichever way, so
set-scoping saved only a few snapshot GETs), while an all-sets default over sets in
different buckets exposed the additive-env / single-memoized-client seam with no clean fix.
Taking the bucket directly dissolves both — one bucket, one LIST, one credential — and
falls out symmetric with `cleanup`, with the per-set *report* preserving everything the
set framing was protecting.
