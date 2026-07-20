# Performance — walk/snapshot hot path

Epic: speed and memory on large trees (a photo/video archive is tens to hundreds of thousands
of files). Watch for per-file overhead — small costs mount up.

- **Lazy-load the AWS SDK at dispatch** (backburner — deliberately deferred in favour of the
  simpler, more predictable static esbuild bundling). The entry point statically imports the
  whole command registry, which pulls the SDK on every invocation, even `--version`. Measured
  2026-07-03 (Windows): raw source ~510ms, esbuild bundle ~290ms, SEA `s3cab.exe` ~275ms warm
  (~1.6s on the first-ever run — antivirus scanning the 104 MB binary, one-time), bare
  `node -e ""` ~190ms — so both shipped forms pay only ~90–100ms for s3cab+SDK; a lazy
  `await import` at dispatch could reclaim most of that, at the cost of complicating the
  bundle. Revisit only if startup ever feels sluggish in the shipped form.
- **Parallel hashing.** `createPropsGenerator` hashes one file at a time; SHA-256 is I/O-bound
  but a small concurrency pool (even 4–8 in-flight `prop()`s, no worker threads needed) should
  speed cold snapshots substantially on SSDs.
- **Use S3's native SHA-256 checksums on upload** (`ChecksumSHA256`). The object key *is* the
  SHA-256 — having S3 verify the body against it end-to-end is a perfect fit (#1/#2), gives
  free corruption detection on PUT, and gives `verify` a server-side primitive (HEAD checksum
  vs key) without downloading. Check S3-compatible-provider support
  ([docs/design/s3-provider-compatibility.md](../docs/design/s3-provider-compatibility.md)).
- **`hashes` accumulates every hash in memory** then joins one giant string; stream lines out
  as pages arrive (a million-object bucket is plausible for a photo library).
- **Re-measure the 5 MB slurp/stream hash boundary** in `prop.mjs` during any perf pass. Files
  ≥ 5 MB stream through a hash; smaller ones slurp via one-shot `crypto.hash`. The cutoff was
  chosen empirically on real data but predates the one-shot path, so the optimum may have
  moved. (The already-settled half — why the stream path takes Node's default `highWaterMark`
  rather than an explicit 8 MB buffer — is a comment at the code in `lib/file-props.mjs`,
  where anyone tempted to reintroduce one will actually see it.)
- **The deletion record is re-read in full on every `verify`/`backup`/`cleanup` run**
  (ADR-0064): `readDeletionRecords` does a `LIST deletions/` plus one `GET` per record file,
  every run, and records accumulate unbounded (no cap, deliberately — they double as the audit
  trail). Most repositories never run `delete`, so the common case is one empty LIST; but a
  heavy-delete repository's routine backup slowly pays more and more just to re-read deletion
  history it already knew. Latent, not yet felt. Fixes range in ambition: periodically
  **compact** many records into one (keeping the audit content), or read only records **newer
  than the baseline** the consumer already trusts. Revisit when a real repo's `deletions/`
  grows into the hundreds, or the read shows up in a backup profile.
