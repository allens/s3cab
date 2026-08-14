# Tier 3: what only wall-clock time can test

Some behaviours cannot be compressed into a test run: S3 lifecycle rules act
on a schedule of **days**, real throttling cannot be aimed, and credential
expiry arrives when the session says so. Tier 1 fakes time (`virtual-clock`),
Tier 2 skips these (no backend declares `lifecycle-expiry` —
[CAPABILITIES.md](CAPABILITIES.md)); this file is the brief's answer for the
remainder: *if it can't be tested in a normal run, write down the procedure
and how often to run it.*

All procedures use the conformance bucket (`test-s3cab-<owner>-conformance`,
sole-owner, versioned) and the scoped test profile. The bucket's lifecycle —
applied by `scripts/setup-test-bucket.mjs --conformance` — expires current
objects, noncurrent versions and orphaned delete markers after **1 day**
(AWS runs lifecycle evaluation roughly once a day, so allow up to ~48 h for
an effect to land).

## 1. Lifecycle expiry vs. the versioning backstop (~quarterly, and before 1.0)

The concurrency analysis leans on "versioning backstops a bad delete"
(docs/design/backup.md, proposals/concurrency-and-locking.md). A backup
bucket's recommended lifecycle expires *noncurrent* versions — so the
backstop has a fuse, and nothing in s3cab measures it. This procedure
observes the fuse burning end-to-end:

1. `npm run test:conformance` first — start from a green tier and an empty
   bucket (the suite wipes it).
2. Day 0: `s3cab setup` a set against the conformance bucket, `backup` a
   small tree, then delete one referenced object out-of-band
   (`aws s3api delete-object --bucket <bucket> --key objects/<hash>` with the
   test profile) — the delete-marker shape a mistaken deletion leaves.
3. Same day: `s3cab verify <bucket>` reports the object `missing` (exit 1);
   confirm the noncurrent version still exists
   (`aws s3api list-object-versions --bucket <bucket> --prefix objects/<hash>`)
   and that removing the delete marker
   (`aws s3api delete-object … --version-id <marker-id>`) restores
   `verify` to exit 0. Re-delete it to re-arm the experiment.
4. Day 2–3 (after lifecycle has run): the noncurrent version is **gone** —
   `list-object-versions` shows nothing. `verify` still reports plain
   `missing`; nothing distinguishes "recoverable until yesterday" from
   "gone forever". Record the actual expiry lag observed.
5. Sweep: `npm run test:conformance` (its wipe resets the bucket).

What this checks that no tier can: the *real* window during which the
versioning backstop holds, against the bucket configuration we actually
recommend. If s3cab ever grows a versioning check or a "recoverable until"
report, this procedure becomes its acceptance test.

## 2. Abandoned multipart uploads are reclaimed (~quarterly)

A killed backup can orphan multipart parts, which cost money invisibly
(`AbortIncompleteMultipartUpload` is the guard, set to 1 day):

1. Start a backup of a >16 MB file and kill the process mid-transfer
   (Ctrl+C is not enough of a test — use a hard kill).
2. `aws s3api list-multipart-uploads --bucket <bucket>` shows the orphan.
3. Day 2: the orphan is gone. If it isn't, the lifecycle rule regressed.

## 3. Credentials expiring mid-run (opportunistic — when an SSO session is near expiry)

Cannot be scheduled: AWS SSO sessions expire on their own clock. When one is
within ~10 minutes of expiry (`aws sts get-caller-identity` still works but
the portal shows the session ending):

1. Start a large backup (multi-GB, or many files) under the expiring profile.
2. Let the session lapse mid-run.
3. Record what s3cab does: the expected honest outcome is a thrown
   credential error and a non-zero exit, with the local snapshot intact and
   the next backup resuming (objects-first means nothing published lies).
   A backup that hangs, retries forever, or — worst — publishes a manifest
   after partial uploads is a Tier 3 catch to file in proposals/bugs.md.

## 4. Real throttling (opportunistic — piggyback on the pagination test)

S3 throttling (503 SlowDown) cannot be provoked on demand at test scale, and
the retry relay (ADR-0068) absorbs what does occur. `test:conformance`'s
pagination case (1000+ rapid PUTs) is the likeliest natural trigger — if a
run of it ever fails with a throttling error surfacing *above* the relay,
that is a relay bug: capture the full error and file it. No separate
procedure; just never dismiss such a failure as flaky.

## Cadence summary

| Procedure | When |
| --- | --- |
| 1. Lifecycle vs. backstop | Quarterly, and once before the 1.0 format freeze |
| 2. Multipart reclaim | Quarterly, same session as 1 |
| 3. Credential expiry | Opportunistic, when an SSO session is about to lapse |
| 4. Real throttling | Passive — treat any throttling surfacing in Tier 2 as a bug, never flake |
