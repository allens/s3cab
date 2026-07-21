# Upload straight to Glacier Instant Retrieval: the cheapest instant-access tier, set in the data plane

**Status:** accepted & implemented. Sets the object storage tier on the S3 data plane
established by [0059](0059-aws-provisioning-boundary-static-imports.md) (`awsOnlyPutParams` in
`src/lib/s3.mjs`), replacing the Intelligent-Tiering default. **Reverses** the steer recorded in
[proposals/storage-tiers.md](../../proposals/storage-tiers.md) that tiering belongs in the
CloudFormation template — the reasoning below is why. Applies [0006](0006-minimal-code.md)
(hardcoded, no knob) and [0002](0002-no-lock-in-hard-constraint.md) (costs documented, not hidden).

## Context

`putFile` stamped `StorageClass: INTELLIGENT_TIERING` on every AWS upload (gated off for custom
endpoints, so non-AWS providers got no class). That was accretion, never a reasoned decision — and
it is the wrong default for what s3cab actually is:

- **Write-once.** Content-addressed dedup means each unique object is PUT exactly once, ever.
- **Read-rarely.** Objects are only read on a `restore` — a rare event for a backup.
- **Many small objects.** A file-level content-addressable store holds lots of sub-128 KB objects.

Intelligent-Tiering fits none of these. Its headline feature — auto-moving objects between access
tiers by observed access — earns its keep only for data with a *shifting, unknown* access pattern,
which a backup does not have. Worse, **IT never archives objects smaller than 128 KB**: they sit in
the Frequent Access tier at full Standard price (~$0.023/GB) forever, and IT still bills a
per-object monitoring fee on everything larger. So the current default quietly strands exactly the
small objects a content-addressed store is full of at the *most* expensive rate.

## Decision

**Upload straight to `GLACIER_IR` (S3 Glacier Instant Retrieval)** in `awsOnlyPutParams`, the
cheapest storage class that still has millisecond retrieval. Hardcoded, no user knob; still gated
by `customEndpoint()`, so off-AWS providers are unaffected. Scope is **instant-access only** —
async archive tiers are explicitly *not* in scope (see Consequences).

**Why Glacier IR over the other instant tiers.** At ~$0.004/GB it is ~6× cheaper than Standard,
and it archives *everything*, small objects included. Its 128 KB minimum-billable size — the usual
objection — cuts the *other* way here: billed as 128 KB × $0.004, any object over ~22 KB is still
cheaper than Standard, and the small-object case that hurts IT is precisely the one Glacier IR
fixes. No monitoring fee. The cost it adds — a per-GB retrieval fee — lands only on reads, which a
write-once-read-rarely backup almost never does.

**Why the data plane, not the CloudFormation template** (this is the reversal). The recorded steer
was to keep `putFile` free of tier logic and express tiering as a CF lifecycle transition. Three
facts overturn it:

1. **Dedup makes a lifecycle transition pure waste.** Every unique object is written once; landing
   it as Standard and paying a per-object transition request to move it to Glacier IR spends money
   to relocate something we could have placed correctly on the first PUT. `GLACIER_IR` is a valid
   `StorageClass` on `PutObject` — land it there directly, for free.
2. **The CF template is optional.** Onboarding is generative
   ([0032](0032-generative-onboarding-not-active-provisioning.md)); a user who created the bucket
   by hand never applied a template, so a template-only rule would tier *nothing* for them. The
   data-plane PUT works for every bucket regardless of how it was born.
3. **"Keep the data plane clean" was already moot** — the data plane set a storage class *today*
   (the IT line). This changes one enum value; it does not introduce tier logic.

The split stays clean: **the data plane owns _how new objects are stored_ (Glacier IR); the CF
template's lifecycle rule keeps owning _when old versions are reaped_** (the 90-day
noncurrent-version expiry, [0033](0033-bucket-onboarding-security-model.md)) — orthogonal jobs, no
overlap.

## Consequences

- **New uploads land as Glacier IR immediately.** Existing objects are untouched; re-tiering an
  already-populated bucket is a documented manual one-off (a bucket lifecycle rule transitioning to
  `GLACIER_IR`), not a new command — building migration machinery for a rare one-time action is
  over-engineering ([0006](0006-minimal-code.md)).
- **Cost caveats accepted and documented, not engineered around** — the transparency pillar
  ([0002](0002-no-lock-in-hard-constraint.md)) means we state them plainly in the guide rather than
  hide them:
  - the **128 KB minimum-billable size**;
  - the **90-day minimum-storage duration** — deleting an object sooner still bills 90 days, which
    touches the `cleanup`/`forget` prune path for churny sets;
  - the **per-GB retrieval fee** on reads.

  *Packing* small objects into blobs (breaks the one-object-per-file model,
  [0001](0001-file-level-content-addressable-dedup.md), and the recovery contract,
  [0002](0002-no-lock-in-hard-constraint.md)) and *exempting* them (a size threshold + split-tier
  branch in the hot path) were both rejected as complexity out of proportion to the pennies saved.
- **The 90-day minimum aligns with the existing reclamation window.** The CF template already
  expires noncurrent versions at 90 days, so a soft-deleted version reaped on the normal path has
  met Glacier IR's minimum duration — no early-deletion penalty there.
- **Off-AWS is unchanged.** `GLACIER_IR` is AWS vocabulary; the `customEndpoint()` gate means
  R2/B2/Spaces still get the provider default, exactly as before.
- **Archive tiers remain deferred.** Glacier Flexible / Deep Archive would force `restore` (and
  `verify`) to become two-phase (initiate → wait hours → download) — a command-shape change, not a
  config knob. That is a separate future epic, tracked in
  [proposals/storage-tiers.md](../../proposals/storage-tiers.md); nothing here forecloses it.
- **Pinned, not just present.** `src/lib/s3.test.mjs` now asserts the upload's storage-class header
  is specifically `GLACIER_IR`, so an accidental revert to Intelligent-Tiering fails the suite.
