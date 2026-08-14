# A remote snapshot is "ours" only if byte-identical: trust and idempotence by content

**Status:** accepted — designed and implemented 2026-08-14. Refines the baseline-trust check of
[0045](0045-change-detection-local-baseline-list-fallback.md) and the snapshot-immutability rule
`uploadSnapshotFile` enforces; both now key on bytes.

## Context

Two entries from the 2026-08-12 durability audit share one root cause: **a snapshot *name* does
not identify a snapshot.** Names are minute-resolution local wall clock (`2026-01-05T0000`), so
two machines sharing a set — or one machine and its own lost-response retry — can hold the same
name for different documents, and every check that asked S3 "does this name exist?" was really
asking a different question than it thought:

1. **Baseline trust (HIGH).** `storedHashes` believed the local baseline the moment a HEAD found
   *any* remote snapshot under its name. Machine B's same-name snapshot thereby vouched for
   machine A's never-uploaded one: A skipped every hash its local baseline lists, published a
   manifest referencing objects that exist nowhere, and reported clean success. The conditional-PUT
   backstop never fires for a hash the skip-list wrongly covers — this is the one decision where
   correctness *does* ride on the baseline.
2. **Manifest self-412 (false failure).** `uploadSnapshotFile`'s no-clobber PUT can lose its
   response; the SDK retry ([0068](0068-network-retries-above-the-sdk.md)) then harvests a 412
   from its own success, and the immutability error told the user a completed backup had failed —
   advice pointing at a re-run that would hit the same wall.

ETags cannot arbitrate identity: they are a content hash only for single-part uploads on real S3,
and the store contract is S3-*compatible* (ADR-0002/0019). What is dependable is the format
itself: **a remote snapshot file is byte-identical to its local form by design**
([0004](0004-tsv-snapshot-manifests.md); `downloadRemoteSnapshots` already relies on it in the
other direction), and manifests are small zstd-compressed TSVs, cheap to fetch whole.

## Decision

**One primitive, `matchRemoteSnapshot` (lib/remote.mjs): fetch the remote snapshot under the
name and compare its bytes to the local file — `"identical" | "different" | "absent"`.** Both
call sites branch on it:

1. **`storedHashes` trusts the baseline only on `"identical"`.** `"absent"` keeps its existing
   warning; `"different"` warns that another machine may share the set. Either way the baseline
   is dropped entirely — its skips are exactly the untrusted data — and the run falls back to
   the store LIST, like a first backup. The check upgrades from HEAD to GET; the cost is one
   small manifest read at the start of a backup.
2. **`uploadSnapshotFile` treats a 412 whose remote copy is `"identical"` as quiet success** —
   publishing is idempotent for the manifest's own bytes, which is precisely the lost-response
   retry meeting its own first attempt. Anything else under the name keeps the immutability
   error: that really is someone else's snapshot, and it is never overwritten.

## Consequences

- Cross-machine same-name vouching is closed end to end: the model-tier scenario (A offline at
  the shared minute, B publishes, A backs up) now uploads A's objects and leaves the store
  consistent, where it used to publish dangling references that only `verify` caught later.
- A completed backup whose manifest PUT response was lost now reports the success it was.
- The residual same-minute manifest **race** stands: two machines PUTting the same name
  concurrently still end with one winner, and the loser's 412 correctly reports the conflict
  (its bytes differ). Nothing here serializes writers — it only stops presence from being read
  as proof of authorship.
- The trust check now needs `s3:GetObject` where it needed `s3:HeadObject` — no policy change,
  since every documented policy already grants GET for restore. (`HeadObject` itself stays on
  the hot path as `putFile`'s multipart preflight.)
