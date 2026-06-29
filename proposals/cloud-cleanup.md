# Cloud cleanup & the parked cloud-destination work

Provisional ideas left over after the `bucket` onboarding command shipped (its built parts went
to [ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md) /
[0033](../docs/adr/0033-bucket-onboarding-security-model.md) /
[0034](../docs/adr/0034-bucket-command-shape.md) and [guide/bucket.md](../guide/bucket.md)).
Nothing here is of record — it is the backlog the onboarding design surfaced.

## The cleanup command (the big one)

A future **cleanup** command (name TBD — avoid `gc`/`prune` jargon per
[ADR-0012](../docs/adr/0012-consumer-vocabulary-naming.md)). It is classic **mark-and-sweep**
over the bucket-*global* object pool ([ADR-0013](../docs/adr/0013-one-repository-one-bucket.md)):

1. Read **every snapshot of every set** (from the **remote** — the authoritative copy) to mark
   the live set of hashes. Marking from one set's snapshots alone would delete objects another
   set still needs — the #1 way CAS GC eats live data.
2. Sweep `objects/` for unreferenced orphans and `DeleteObject` them (soft).

Key insight: **snapshot deletion is the precondition for cleanup.** While any snapshot
references a hash, that object is live; an object becomes an orphan only when the last snapshot
referencing it is pruned. So `objects/` grows monotonically until old snapshots are deleted.
Snapshots are therefore "append-only in everyday use, pruned during retention" — the same
category as objects. Retention *policy* (keep-last-N, time-based, GFS) is its own future design.

Cleanup runs on the **everyday key** (all soft-deletes; versioning backstops even a buggy sweep
— recoverable for the lifecycle window, which also cushions the classic mark-while-uploading
race — see [ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md)). Space comes back
**automatically** via the lifecycle within the window — most users never need the elevated
`DeleteObjectVersion` identity.

## Parked / related future work

- **Storage access tiers.** Cost is a first-class concern and the intent is **cheap async
  storage** (Glacier / Deep Archive family). s3cab already uploads AWS objects with
  `StorageClass: INTELLIGENT_TIERING` (a good baseline). Two things to chew on when picked up:
  (a) async tiers make `restore` a **two-phase** operation (initiate retrieval → wait hours →
  download) — a real shape change to the restore command, not just a config knob; (b)
  Intelligent-Tiering does not monitor objects <128 KB, and a CAS store can have *many* tiny
  objects, so the small-file cost story needs its own look.
- **Per-prefix IAM policy.** The natural future tightening of the security model
  ([ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md)) — append-only on
  `objects/`+`snapshots/`, delete confined to `sets/` — if identities split or versioning is
  dropped. Not done now: with versioning as the backstop the marginal gain is small and it adds
  policy surface.
- **`--run` active mode** for the non-secret bucket steps (create/versioning/lifecycle, which
  need no IAM dep and handle no secret) — left explicitly open but out of scope for v1
  ([ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md)).
- **`emptyBucket()`** in [src/lib/s3.mjs](../src/lib/s3.mjs) is currently **dead code** (no
  caller) — a future delete/teardown primitive. Flagged here, not removed (CLAUDE.md
  convention #5).
