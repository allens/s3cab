# `verify` takes a bucket operand, symmetric with `cleanup`

**Status:** accepted (settled 2026-07-03; operand reversed to the bucket during
implementation — see History) — **implemented** (`src/commands/verify.mjs`, over the
`referencedObjects`/`listStoredObjects` lib enumerations and the pure diff in
`src/lib/verify.mjs`). Sits in the command-shape lineage of
[0035](0035-aws-profile-sets-command-rationalization.md)/[0036](0036-setup-mutates-list-shows-drop-sets.md)/[0040](0040-restore-requires-set-name.md);
the full design (finding classes, report, ordering invariant) is in
[docs/design/backup.md](../design/backup.md).

> **Finding model corrected (2026-07-05):** the original per-hash finding classes were
> replaced by a flat **per-path `problems`** list — one row per referenced *file* that is
> `missing` (content absent) or `wrong-size` (its recorded size checked directly against the
> one stored object), grouped by set. This dropped the old ambiguous-size skip and the
> separate `conflictingRows` category: a size conflict between two files sharing content now
> surfaces as a wrong-size problem on the exact file that disagrees with storage, so a
> genuinely wrong recorded size can no longer hide. Hashes never appear in the output — the
> user thinks in files. (Details in [docs/design/backup.md](../design/backup.md).)
>
> **Orphan reporting removed (2026-07-05):** orphan reporting (`orphanObjects` /
> `orphanObjectsExact` — the "orphan count is always reported" decision below, now struck)
> **moved out of verify to `cleanup`'s non-destructive mode**. Orphans are a reclamation
> concern, not an integrity one — they can't threaten restorability — so verify no longer
> computes them, and the upper-bound exactness flag is gone with them; in `cleanup` the
> unreadable-snapshot caveat is a real safety gate (never delete what a snapshot you couldn't
> read might reference), not an advisory hint. **verify's result is now just `{ bucket, sets }`.**
> See [proposals/cloud-cleanup.md](../../proposals/cloud-cleanup.md).

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
- ~~**The orphan count (stored − referenced) is always reported, with an exactness flag.**~~
  **Superseded 2026-07-05 (see the banner):** orphan reporting moved to `cleanup`'s
  non-destructive mode. Orphans are a reclamation concern, not an integrity one, so verify no
  longer computes `stored − referenced` or carries the `orphanObjectsExact` upper-bound flag;
  its result is `{ bucket, sets }`. In `cleanup` the unreadable-snapshot caveat is a hard
  safety gate (never sweep what an unreadable snapshot might reference), not a hint.
- **Exit 1 when any set has findings** (0 = verified clean; 2 stays bad input) —
  `s3cab verify <bucket> || alert` is the cron idiom. No dedicated exit code until a
  script actually needs "damaged" vs "check failed".
- **Remote read-only** — verify never writes to the bucket; it runs on List+Get credentials.
  (It originally *also* rewrote a per-bucket objects cache from the completed LIST, to warm
  the next backup and heal a poisoned cache. That cache was **dropped** by
  [ADR-0045](0045-change-detection-local-baseline-list-fallback.md), so verify now keeps no
  local state at all — its whole result is the per-set findings report.)

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
