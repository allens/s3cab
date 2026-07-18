# Storage tiers

Epic: let a user choose how their bucket stores objects, because **cost is a real feature
driver** for this tool. Consolidated here 2026-07-18 from two scattered stubs that said
overlapping things in two places (in the files now called `cloud-onboarding.md` and
`engine-robustness.md`).

**Not designed yet — a topic for a grilling session.** What follows is the framing and the
tradeoffs already known, captured so that session starts with context rather than from scratch.

## The brief

The big fundamental is **instant-access vs archive tiers**. There are lots of tradeoffs to
consider — small file vs large file among them — so the shape needs grilling before anything
is built. There are **platform differences** in play too. And once the best strategy is known,
this sounds like something for the **CloudFormation template** to express rather than the
data plane.

## What's built today

`putFile` hardcodes `StorageClass: INTELLIGENT_TIERING` for AWS, alongside AES256
server-side encryption ([src/lib/s3.mjs:349-355](../src/lib/s3.mjs#L349-L355)). Both are
gated off when a custom endpoint is set, so non-AWS providers get neither. There is no user
control over the tier at any level — not at `setup`, not at `provider`, not per-backup.

## Tradeoffs already recorded

- **Async tiers make `restore` two-phase.** Glacier / Deep Archive retrieval is initiate →
  wait hours → download. That's a real shape change to the restore command, not a config
  knob — and it would touch `verify` too, which reads object metadata.
- **Intelligent-Tiering ignores objects under 128 KB.** A content-addressed store can hold
  *many* tiny objects, so the small-file cost story needs its own look. This is likely the
  same root as the "small file vs large file" tradeoff above.
- **Retrieval latency and cost bleed into UX**, not just the bill — which is why the old
  stub guessed this would end up a `setup`-time choice.

## Open questions for the grilling session

_These are my framing of what's undecided, not decisions taken._

- **Where does the choice live** — per set at `setup`, per provider, per backup run, or a
  bucket-level lifecycle rule s3cab merely documents rather than sets?
- **Does s3cab set the tier at all, or leave it to the template?** The user's steer is that
  this belongs in the **generated CloudFormation template** once the strategy is known — which
  fits: that template already owns a lifecycle rule for noncurrent versions, so tiering could
  be the same mechanism's job, keeping `putFile` and the data plane free of tier logic
  entirely. Worth testing against the case where a user wants different tiers for different
  sets in one bucket.
- **How does a two-phase restore surface?** A blocking wait, a resumable "come back later"
  command, or a refusal with guidance — this is the biggest command-shape question in the
  epic and squarely `cli-design` territory.
- **Small objects**: pack them, exempt them from archive tiers, or accept the cost and say
  so plainly in the guide?
- **Platform differences.** Storage classes are AWS vocabulary, and a CloudFormation-expressed
  strategy is AWS-only by construction. R2 / B2 / others have their own tier models or none,
  and `putFile` already gates AWS-only PUT params behind `customEndpoint()`
  ([src/lib/s3.mjs:349-355](../src/lib/s3.mjs#L349-L355)) — so the question is whether tiering
  is an AWS-only feature that degrades gracefully elsewhere, or an abstraction across
  providers. Relates to
  [docs/design/s3-provider-compatibility.md](../docs/design/s3-provider-compatibility.md).
- **Does an existing bucket's tier get migrated**, or does the choice only apply to new
  uploads?

## Related

- [ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md) — the versioning +
  lifecycle model tiering would sit beside.
- [cloud-onboarding.md](cloud-onboarding.md) — if the strategy lands in the CloudFormation
  template, it lands there.
- Reclamation already interacts with lifecycle windows; archive tiers add early-deletion
  minimum-duration charges to that picture ([docs/design/backup.md](../docs/design/backup.md)).
