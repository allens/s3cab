# Storage tiers

Epic: let a user choose how their bucket stores objects, because **cost is a real feature
driver** for this tool. Consolidated here 2026-07-18 from two scattered stubs that said
overlapping things in two places (in the files now called `cloud-onboarding.md` and
`engine-robustness.md`).

**The instant-access half is now decided and built** — see
[ADR-0066](../docs/adr/0066-glacier-ir-storage-tier.md) (grilling session 2026-07-21). What
remains open, and what this proposal now tracks, is the **archive-tier half** (async retrieval),
which is a bigger change because it reshapes `restore`.

## What's decided (ADR-0066)

The big fundamental was **instant-access vs archive tiers**; the instant-access side is settled:

- **Default tier:** s3cab uploads straight to **Glacier Instant Retrieval** (`GLACIER_IR`) — the
  cheapest instant-access class. This **replaces** the old Intelligent-Tiering default, whose
  128 KB floor stranded a content-addressed store's many small objects at Standard price.
- **Mechanism:** set in the **data plane** (`awsOnlyPutParams`, [src/lib/s3.mjs](../src/lib/s3.mjs)),
  not a CloudFormation lifecycle transition. This **reverses** the earlier steer below — dedup makes
  a transition fee pure waste, and the CF template is optional so a hand-made bucket would get
  nothing from it.
- **Hardcoded, no knob** — one legal value today ([ADR-0006](../docs/adr/0006-minimal-code.md)).
- **AWS-only**, still gated by `customEndpoint()`; other providers get their default.
- **Small objects / costs:** accepted and documented in [guide/aws.md](../guide/aws.md) (128 KB
  minimum billing, 90-day minimum duration, retrieval fee) rather than packed or exempted.
- **Existing objects:** new uploads only; migrating a populated bucket is a documented one-off
  lifecycle rule, not a command.

## What's still open — archive tiers

Archive tiers (Glacier Flexible / Deep Archive) are **deferred, not designed** — a topic for a
future grilling session. The framing and known tradeoffs, captured so that session starts with
context rather than from scratch:

- **Async tiers make `restore` two-phase.** Glacier / Deep Archive retrieval is initiate →
  wait hours → download. That's a real shape change to the restore command, not a config
  knob — and it would touch `verify` too, which reads object metadata. This is why archive tiers
  are their own epic and not a quick follow-on to ADR-0066.
- **How does a two-phase restore surface?** A blocking wait, a resumable "come back later"
  command, or a refusal with guidance — the biggest command-shape question in the epic, squarely
  `cli-design` territory.
- **Early-deletion minimums get sharper.** Glacier IR already has a 90-day minimum (ADR-0066
  accepts it); the deep-archive tiers have longer ones (Deep Archive: 180 days), which interacts
  harder with `cleanup`/`forget` reclamation windows.
- **Where would the archive choice live** — per set at `setup`, per backup run, or a bucket-level
  rule? ADR-0066 settled the *instant* case as "no knob"; a second, genuinely different tier is
  the first real second-use-case that could justify a user-facing choice.
- **Platform differences.** Storage classes are AWS vocabulary; archive support elsewhere (R2/B2)
  varies or is absent, so archive tiering would be AWS-only that degrades gracefully — same stance
  as ADR-0066's instant tier. Relates to
  [docs/design/s3-provider-compatibility.md](../docs/design/s3-provider-compatibility.md).

### The reversed steer (kept for the record)

The earlier recorded position was that tiering *"belongs in the generated CloudFormation template
rather than the data plane,"* reasoning that the template already owns a lifecycle rule so tiering
could be the same mechanism's job. ADR-0066 reversed this for the instant tier (dedup + optional
template). If archive tiering ever revisits the mechanism question, start from ADR-0066's reasoning,
not this original steer.

## Related

- [ADR-0066](../docs/adr/0066-glacier-ir-storage-tier.md) — the instant-access decision.
- [ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md) — the versioning +
  lifecycle model tiering sits beside.
- [cloud-onboarding.md](cloud-onboarding.md) — if archive strategy ever lands in the template.
- Reclamation already interacts with lifecycle windows; archive tiers add larger early-deletion
  minimum-duration charges to that picture ([docs/design/backup.md](../docs/design/backup.md)).
