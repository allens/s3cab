# Bucket onboarding security model: a soft-delete everyday identity, versioning as backstop

**Status:** accepted (refined by [0056](0056-onboarding-via-cloudformation.md) — `bucketPolicy()`
becomes a *managed* policy reused by the IAM user and the Roles Anywhere role, plus SSE-S3 encryption
and `DeletionPolicy: Retain`, all carried into a CloudFormation template; the security model here
stands).

The `aws` command (and the AWS path of `setup`) sets a user up with an everyday cloud
identity and a bucket configured so the pair has the property a backup tool should have: **a
leaked everyday key can add to your backup and tweak its own set markers, but can never
*permanently destroy* your content or history.** This ADR records how that property is
achieved, because the choices (why `DeleteObject` is granted at all, why per-prefix scoping was
*not* used) are not obvious from the policy JSON alone.

The least-privilege policy is `bucketPolicy()` in [src/lib/s3.mjs](../../src/lib/s3.mjs) — the
single source of truth, emitted by `s3cab aws` and referenced by
[docs/integration-testing.md](../integration-testing.md) §1.

## 1. One everyday identity, explicit-verb least privilege

The policy grants exactly `s3:ListBucket` on the bucket plus `s3:GetObject` / `s3:PutObject` /
`s3:DeleteObject` on its objects — **explicit verbs, never the `s3:*Object` wildcard.** The two
statements split because the object actions target `…/*` while bucket-level `ListBucket` targets
the bare bucket ARN. One identity covers the common case; no extra users are minted.

## 2. The privilege seam is *soft-vs-permanent*, not per-prefix

`DeleteObject` **is** granted — `setup` already needs it (the stale-`exclude.txt` cleanup in
`set-marker.mjs`), and the future cleanup command will too. But on a **versioned** bucket
`DeleteObject` is a *soft* delete: it writes a delete marker, and the bytes survive as a
noncurrent version. The everyday key deliberately lacks **`DeleteObjectVersion`**, so it can
never truly erase anything. Permanently scrubbing a version is a rare, elevated-identity
operation (needed only to reclaim space *before* the lifecycle window, or to hard-scrub) that
most users never set up. This is exactly why the policy uses explicit verbs: an `s3:*Object`
wildcard would silently re-grant `DeleteObjectVersion` and dissolve the seam.

**Per-prefix scoping was considered and parked.** Append-only on `objects/`+`snapshots/` with
delete confined to `sets/` would be a tighter policy, but with versioning as the backstop the
marginal gain is small and it adds policy surface. Revisit only if identities split or
versioning is dropped. (Recorded in [proposals/cloud-onboarding.md](../../proposals/cloud-onboarding.md)
as future work.)

## 3. Versioning ON is the backstop that makes the above safe

Onboarding turns versioning on; it is what makes a soft delete recoverable (and what cushions
the classic mark-while-uploading race a future cleanup sweep would face). The lifecycle the
command generates is shaped around it:

| Setting | Value | Why |
| --- | --- | --- |
| Versioning | Enabled | recover any deleted/overwritten backup |
| Lifecycle: noncurrent-version expiry | ~90 days | the disaster-recovery window — a documented cost/safety **dial** (longer = safer; shorter only to reclaim pruned space sooner). In a CAS store this costs ≈0 in steady state: objects are immutable, so noncurrent versions arise only from deletes. |
| Lifecycle: abort incomplete multipart | 1 day | pure waste with zero recovery value (s3cab does not resume multiparts). |
| Lifecycle: current-object expiry | **none** | the cardinal sin — never auto-delete a live backup. |

This is the **opposite** of the *test* bucket's lifecycle (which expires *current* objects after
1 day as a cost cap — [docs/integration-testing.md](../integration-testing.md),
`scripts/setup-test-bucket.mjs`). The two must never be unified — accidentally doing so would
expire someone's backups. (Only the *policy* is shared between backup and test, not the
lifecycle — see [0032](0032-generative-onboarding-not-active-provisioning.md).)

## Consequences

- A leaked everyday key is bounded to soft, recoverable damage; permanent destruction needs an
  identity the user rarely creates, and versioning + the 90-day window backstops even a buggy
  delete.
- `DeleteObject` being in the everyday policy is intentional, not an over-grant — the
  soft/permanent split, not the presence of *a* delete verb, is the security boundary.
- A future **cleanup** (mark-and-sweep GC) command runs on this same everyday key — all
  soft-deletes, versioning-backstopped (see [proposals/cloud-onboarding.md](../../proposals/cloud-onboarding.md)).
