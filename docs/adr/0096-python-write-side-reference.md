# A Python reference for the write side, readable in half an hour

**Status:** proposed (2026-10-07). The idea is settled; the exact scope and its placement are
not, and nothing is built.

**s3cab is the tool.** `src/` stays the one implementation people use. Two teaching goals sit
beside it, and they split along the format's two directions:

- **Writing a backup:** a Python **reference implementation of snapshot and upload**. This ADR.
- **Reading one back:** the **clean-room restorers** in [scripts/cleanroom/](../../scripts/cleanroom/).
  Each run hands [guide/format.md](../../guide/format.md) and nothing else to a fresh reader. Three
  runs exist: Python with boto3, then C++23 and Go with no AWS SDK. Restore is deliberately left
  to them, because restore is the half of s3cab you can do without s3cab. A snapshot row names
  the object, and fetching it is one `aws s3 cp`. The no-SDK runs showed that reading needs only
  an HTTP client, SHA-256/HMAC, zstd and a page of SigV4.

The write side is the opposite case. It is where every rule lives, and where getting a detail
wrong corrupts a backup silently:

- the content-addressed key;
- the snapshot as the index;
- objects first, snapshot last;
- never trimming a path.

One of s3cab's founding ideas was that anyone could read the whole tool in half an hour and see
how it worked. Features and robustness have since grown `src/` by an order of magnitude, and
that's accepted. The reference brings the founding idea back for the part that needs it.

## What is settled

- **It does snapshot, upload and exclude patterns, and it does them correctly, even if
  slowly.** Correctness covers:
  - the exact format: padded columns, `#SNAPSHOT`/`#DIR`/`#EXCLUDED`/`#SKIPPED`/`#ERROR`/`#END`,
    strict UTF-8, refusing tab/CR/LF in paths, never trimming a path, and native absolute paths
    on Windows, macOS and Linux;
  - objects first, snapshot last;
  - uploads verified with `ChecksumSHA256`, so a file that changed since the snapshot is
    refused rather than stored as wrong bytes under the old hash.

  Optimisation is out: no hash reuse, no fused pipeline, no parallelism. Slow but right is the
  point.
- **It must pass the half-hour reading test.** That means roughly 500 lines, including comments.
- **Python, one file, boto3 the only dependency.** The 3.14 standard library covers the rest:
  `compression.zstd`, `hashlib`, `pathlib`, `fnmatch`, `argparse`. boto3 plays the part the AWS
  SDK plays under [0005](0005-builtins-over-dependencies.md). It is too big to hand-write, and
  `upload_file` puts multipart, retries and the credential chain behind one call a reader can
  take on trust.
- **Same format, same bucket.** What it writes, s3cab and every clean-room restorer must
  restore. That three-way round trip is the reference's test, and a check on the spec itself:
  wherever two of them disagree, either the spec or one of them is wrong.

## Why Python

It is the most widely readable language for a short script, and its readers extend well beyond
s3cab's contributors. That wider audience is who no-lock-in is for. boto3's synchronous calls
also read shorter than the JS SDK's command objects, `lib-storage` and stream plumbing.
JavaScript would have kept one language in the repo; that was weighed and set aside.

## Open, to settle before building

- **Exclude semantics.** Should it use s3cab's exact pattern rules (the `exclude-patterns`
  guide), or a documented subset? Matching s3cab exactly makes `#EXCLUDED` rows comparable;
  a subset is cheaper to read.
- **Anything beyond snapshot and upload.** For example, `delete` with deletion records. It shows
  the record-before-delete ordering, but it isn't fundamental.
- **Set state.** Should it write the `sets/<set>/` markers (`info`, `dirs.txt`) so s3cab
  recognises a set it created?
- **Placement.** It is not a dev utility, so not `scripts/`. The options are a top-level
  directory in this repo or a repository of its own.
- **A maintained portable restorer.** This is separate from the clean room. A static Go or C
  binary with no SDK, offered to users as an emergency restorer, would be a *maintained* program,
  unlike the clean-room restorers, which are frozen by design. Whether s3cab should ship one is
  its own decision.
- **Starting point.** A bash spike is preserved at [scripts/s3cab-mini.sh](../../scripts/s3cab-mini.sh).
  The two silent-corruption bugs it hit are a warning about what the reference must get right.
