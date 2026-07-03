# `verify` is set-scoped, variadic, and defaults to all sets

**Status:** accepted (settled 2026-07-03, in a grilling session over the slice-5 design) —
not yet implemented (`verify` is still a registry stub). Sits in the command-shape lineage
of [0035](0035-aws-profile-sets-command-rationalization.md)/[0036](0036-setup-mutates-list-shows-drop-sets.md)/[0040](0040-restore-requires-set-name.md);
the full design (finding classes, report, ordering invariant) is in
[docs/design/backup.md](../design/backup.md).

## Context

`verify` checks that backups are complete and undamaged: every object a snapshot
references must exist in `objects/` at its recorded size, established with LIST requests
only (no egress). Two facts shape the surface:

- **The stored-side enumeration is bucket-wide no matter what.** S3 offers no cheap
  per-key existence probe at scale — one LIST (1,000 keys + sizes per request) beats
  per-key HEADs by orders of magnitude — so even checking a single set pays the full
  `objects/` LIST. It is the *only* meaningful cost of a verify run.
- **There is no honest way to skip that LIST on a later run.** S3 exposes no bucket
  change signal, and any marker s3cab maintained itself would only record *cooperative*
  writes — while verify's whole threat model is uncooperative change (console
  mis-deletes, lifecycle rules, ransomware). A verify that trusts "nothing changed" is
  blind to exactly what it exists to catch.

The design doc briefly leaned bucket-wide for the check itself (one repository-health
fsck); grilling reversed that — naming a set and being judged on the whole bucket
(`verify photos` failing over damage in `bob-documents`) breaks the porcelain's
set-first promise.

## Decision

- **Set-scoped semantics:** each named set is checked against *its own* references —
  "is this backup restorable?". Findings are reported per set.
- **Variadic:** `verify [<set>...]` — one run pays one `objects/` LIST however many sets
  it checks. This, not cross-run caching, is how the LIST tax is shared.
- **No argument means *every* set** — a deliberate exception to the sole-set porcelain
  default ([0040](0040-restore-requires-set-name.md) weighed the same question for
  `restore` and went the other way). The reasons invert here: `restore` is a careful
  mutator where naming the set removes ambiguity; `verify` is a read-only checker whose
  marginal per-set cost is a few small snapshot GETs, so "check everything" is the
  do-what-I-mean default. The orphan count (stored − referenced) is reported only in an
  all-sets run — with a subset named it is not computable and is omitted.
- **Exit 1 when any named set has findings** (0 = verified clean; 2 stays bad input) —
  `s3cab verify || alert` is the cron idiom. No dedicated exit code until a script
  actually needs "damaged" vs "check failed".
- **Remote read-only, one local side effect:** verify never writes to the bucket (it
  runs on List+Get credentials), but it **rewrites the per-bucket objects cache** from
  the completed LIST (atomic temp + rename; never from a partial LIST). The LIST is
  authoritative ground truth already paid for: the rewrite warms the next backup and
  auto-heals a *poisoned* cache — the cached-but-absent entry that silently causes
  future missing objects — instead of telling a consumer to delete a cache file. Safe
  both ways by the staleness asymmetry.

## Consequences

- [src/commands.mjs](../../src/commands.mjs): `verify`'s `set` arg becomes variadic when
  the stub gains its body; the summary wording covers the all-sets default.
- The *referenced* enumeration is a lib function only — no plumbing command until a
  caller outside `verify`/`cleanup` appears (hand recovery already has
  `zstdcat snapshots/*/*.tsv.zst | cut -f1 | sort -u`).
- `cleanup` is unaffected: its referenced union **must** stay bucket-wide (deleting on
  less than the whole truth would eat another set's data), per the shared-domain note in
  [docs/design/backup.md](../design/backup.md).
