# Object uploads are held to their digest: `putFile` hashes the bytes it streams

**Status:** accepted — designed and implemented 2026-08-14; the check moved before completion
2026-10-24. Completes
[0069](0069-fused-snapshot-upload-pipeline.md)'s drift guard; the failure is reported through
that ADR's per-file drift channel.

## Context

The 1.0-format durability audit (2026-08-12) rated this the worst shape it found short of the
truncated-manifest hole: **a file rewritten *during* its upload is stored as wrong bytes under a
right hash, silently.** The drift guard (`fileChange`, lib/upload.mjs) re-checks size and mtime in
the sliver between hashing and PUT start — and never again. The transfer itself then re-reads the
file with `createReadStream`, and for a multipart-sized body (16 MB parts; the user data profile's
top files run 1.3–14 GB) that read window is minutes long. A write landing inside it produces an
object whose bytes are not the preimage of its key.

The consequences compound: `verify` checks presence and size only, so a same-size in-place write
is invisible forever; `restore` does catch the mismatch (`writeFileAtomic`'s digest check) but
aborts the whole run on it; and the object is *permanent* — every later backup's conditional PUT
sees the key present and skips it, so the corruption self-perpetuates across the dedup graph.

## Decision

**When the caller knows the content's expected SHA-256, `putFile` hashes the bytes it actually
streams and holds the finished transfer to that digest** — passed as a plain option value
(`sha256`), exactly as the download twin passes `hash` to `writeFileAtomic`. `putObject` always
passes it: under `objects/` the key *is* the digest.

1. **Tap the one stream being sent; never re-read.** The body is the file stream with a hashing
   pass-through — zero extra I/O. Re-hashing the file after the transfer would double the read on
   the multi-GB files this exists for *and* race the same window again; a second `lstat` guard
   would only narrow the window, not close it. Only the sent bytes can say what was sent.
2. **The digest is compared before the upload completes, and a mismatch throws
   `ContentMismatchError` with nothing stored.** The comparison runs when the body ends, inside the
   stream handed to lib-storage, which sends a single PUT, or completes a multipart upload, only
   after the body has ended, and aborts the multipart upload when the body throws. So the wrong
   bytes are never visible under the key, even to a run killed a moment later. Not a check after
   the transfer and a delete of what it stored: a crash between the two left the corrupt object
   for every later run's conditional PUT to trust.
3. **A forced overwrite (`upload --file --force`) is held to the same check**, and on a mismatch
   the key keeps whatever it held, since nothing was sent to replace it.
4. **`uploadObjects` catches the type and records a `"changed"` drift** — the same fact as the
   pre-PUT guard, caught later: that file is skipped, the remaining transfers continue, `backup`
   refuses to publish its manifest with the existing `fileChangedError` advice. Any other
   `putFile` throw is still a transport failure that stops the run. `upload --file` catches it
   too, and says the file changed while it was read.
5. **A 412 (object already present) means nothing was stored**; the object under the key is
   genuine content that hashes to it. A file below multipart size meets the check before its PUT,
   so one that changed is a `"changed"` drift even when the key is already held. A multipart-sized
   no-clobber file meets the HEAD preflight first, and a held key skips it unread. Both outcomes
   store nothing wrong; the file's change goes unreported only when its old bytes are stored
   already.
6. **A mismatch survives the abort.** lib-storage rethrows the body's error only after its
   `AbortMultipartUpload`, so a refused abort, or a part that failed alongside, would replace it.
   `putFile` keeps the mismatch and rethrows it, the other error as its `cause`. The everyday
   policy grants `s3:AbortMultipartUpload` ([0033](0033-bucket-onboarding-security-model.md)), so
   the abort normally succeeds. Where it doesn't (an older identity, a hand-written policy), the
   parts stay until the bucket's lifecycle rule for incomplete uploads clears them, and only
   `S3CAB_DEBUG` shows why. Not a warning saying so: after a clean abort, the other error can be
   a sibling part's, so the warning would sometimes be false.

Not `x-amz-checksum-sha256`, which would have S3 refuse the mismatch itself: it covers a single
PUT only, since S3 has no whole-object SHA-256 for a multipart upload, and S3-compatible
providers' support for it varies. The check before completion needs nothing from the store.

The manifest PUT (`uploadSnapshotFile`) passes no digest: a snapshot file is not
content-addressed, is written immediately before its upload, and is not user-writable data.

## Consequences

- The last unguarded window in "hash, then send" is closed: hash→PUT-start (`fileChange`),
  during-hash (the post-hash re-check), and now PUT-start→PUT-end all refuse rather than store.
- Every object upload pays one streaming SHA-256. Hashing is already the pipeline's bread and
  butter (the same bytes were hashed to name the object moments earlier); no measurable cost.
- A PUT that applies but loses its response, is retried
  ([0068](0068-network-retries-above-the-sdk.md)), and collects a 412 from its own success stored
  bytes that already passed the check, so "already present" is true of them too.
- **The guard rests on lib-storage's order**: the last part held until the body ends, and an abort
  when it throws. A unit test pins it on the wire (no PUT, no Complete, an Abort), so an SDK
  upgrade that changes it fails there.
- A run killed during a multipart upload, mismatched or not, leaves its parts uncompleted:
  invisible, never an object, and billed until the bucket's lifecycle rule for incomplete
  uploads clears them.
