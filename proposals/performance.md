# Performance — walk/snapshot hot path

Epic: speed and memory on large trees (a photo/video archive is tens to hundreds of thousands
of files). Watch for per-file overhead — small costs mount up.

- **Parallel hashing.** `createPropsGenerator` hashes one file at a time; SHA-256 is I/O-bound
  but a small concurrency pool (even 4–8 in-flight `prop()`s, no worker threads needed) should
  speed cold snapshots substantially on SSDs.
- **Use S3's native SHA-256 checksums on upload** (`ChecksumSHA256`). The object key *is* the
  SHA-256 — having S3 verify the body against it end-to-end is a perfect fit (#1/#2), gives
  free corruption detection on PUT, and gives `verify` a server-side primitive (HEAD checksum
  vs key) without downloading. Check S3-compatible-provider support
  ([docs/specs/s3-provider-compatibility.md](../docs/specs/s3-provider-compatibility.md)).
- **`hashes` accumulates every hash in memory** then joins one giant string; stream lines out
  as pages arrive (a million-object bucket is plausible for a photo library).
- **Re-measure the 5 MB slurp/stream hash boundary** in `prop.mjs` during any perf pass. Files
  ≥ 5 MB stream through a hash; smaller ones slurp via one-shot `crypto.hash`. The cutoff was
  chosen empirically but predates the one-shot path, so the optimum may have moved.
- **`compare` at the end of `snapshot` re-reads and re-decompresses** the snapshot file it just
  wrote — fine today, noted for a perf pass.
