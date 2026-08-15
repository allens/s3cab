# Object uploads are held to their digest: `putFile` hashes the bytes it streams

**Status:** accepted — designed and implemented 2026-08-14. Completes
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
2. **A mismatch deletes the object, then throws `ContentMismatchError`.** S3 has accepted the PUT
   by the time the digest is known, so detection without removal would leave the corrupt object
   for every later run's conditional PUT to trust. The delete is safe *because* the upload was
   no-clobber: it only reaches the check having **created** the key (`IfNoneMatch: "*"`), so it
   cannot destroy another writer's object. The error type certifies the store was left clean — if
   the delete itself fails, a plain `Error` naming the stranded object is thrown instead, and it
   is terminal.
3. **A forced overwrite (`upload --file --force`) leaves the object and reports a plain `Error`.**
   There the created-it proof is exactly what is missing: the key may have held a good object that
   any number of snapshots reference, and this PUT has already replaced it, so deleting would turn
   one bad upload into a hole every one of those restores falls into. Wrong bytes under a name can
   be overwritten by re-running the upload; a missing object cannot be recovered. A plain `Error`,
   not the subclass, because the subclass's meaning is "the store is clean" — and only
   `uploadObjects` catches it by type, which never forces (src/lib/error.mjs's taxonomy: a
   subclass is caught-by-type identity, not decoration).
4. **`uploadObjects` catches the type and records a `"changed"` drift** — the same fact as the
   pre-PUT guard, caught later: that file is skipped, the remaining transfers continue, `backup`
   refuses to publish its manifest with the existing `FileChangedError` advice. Any other
   `putFile` throw is still a transport failure that stops the run. No new user-facing wording.
5. **A 412 (object already present) skips the check.** Nothing was stored; the object under the
   key is genuine content that hashes to it. The *file's* drift is the next run's pre-PUT guard
   to meet.

The manifest PUT (`uploadSnapshotFile`) passes no digest: a snapshot file is not
content-addressed, is written immediately before its upload, and is not user-writable data.

## Consequences

- The last unguarded window in "hash, then send" is closed: hash→PUT-start (`fileChange`),
  during-hash (the post-hash re-check), and now PUT-start→PUT-end all refuse rather than store.
- Every object upload pays one streaming SHA-256. Hashing is already the pipeline's bread and
  butter (the same bytes were hashed to name the object moments earlier); no measurable cost.
- **The 412 path cannot verify, which leaves one residual triple-fault.** A PUT that applies but
  loses its response, is retried ([0068](0068-network-retries-above-the-sdk.md)), and collects a
  412 from its own success returns "already present" with no digest check — so if the file had
  *also* mutated inside that same transfer, the wrong bytes survive. Deleting on 412 is not an
  option: it cannot distinguish our own lost success from another machine's genuine object, and
  a refused PUT may not have streamed the whole body, so the digest is not even complete.
  Accepted: it requires a mid-transfer mutation *and* a lost-response retry on one file's
  transfer, where the closed bug needed no fault at all.
