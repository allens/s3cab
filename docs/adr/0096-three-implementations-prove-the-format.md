# Three implementations prove the format: s3cab, a clean-room writer, a clean-room reader

**Status:** proposed (2026-10-07). The model is settled. The writer is not built, and the reader
exists only as frozen clean-room runs.

**s3cab is the tool.** It is both a writer and a reader of the format. Beside it sit two programs,
each derived from the spec alone (`guide/format.md` and `guide/exclude.md`, plus nothing of
s3cab's). Each proves the format in one direction and serves a second goal of its own.

| | Writer | Reader |
|---|---|---|
| **Proves** | a backup can be *written* from the spec | a backup can be *read* from the spec |
| **Second goal** | education: shows how s3cab works | an alternative restore tool |
| **Commands** | snapshot and upload, with full exclude syntax | restore |
| **Language** | Python | Go (or C) |
| **AWS SDK** | allowed (boto3) | **not allowed**; requests signed by hand |

## The writer

Its readers are people learning how s3cab works, so its brief adds one requirement beyond the
spec: **someone who can code a little should be able to work out how s3cab fundamentally works
from it in about half an hour.** That is s3cab's founding readability test, which `src/`
outgrew as features and robustness were added. It means one file, roughly 500 lines including
comments.

It is **correct but unoptimised**: no hash reuse, no fused pipeline, no parallelism. Slow but
right is the point. Correctness covers:

- the exact format;
- full exclude syntax;
- objects first, snapshot last;
- uploads verified with `ChecksumSHA256`.

The SDK is allowed because boto3's `upload_file` hides multipart, retries and the credential
chain, none of which is the format. Python is chosen because it is the most widely readable
language for a short program.

**The writer is also the test of what the spec may demand.** If a straightforward Python writer
can't do something portably, that requirement has to be justified as *essential*, or it becomes
*optional* in the spec. Expected first cases:

- the IANA time zone in the `#SNAPSHOT` header, which Python's standard library can't get
  portably on Windows;
- whether `#SNAPSHOT`'s fields are commitments at all. `format.md` calls metadata payloads
  "context", yet s3cab reads the header's start instant (ADR-0072, ADR-0094).

**Full exclude syntax is in scope.** Exclusion decides what a backup holds, and the syntax is
small: four tokens and a trailing `/`. It also carries a reader trap: `*` matches one *or more*
characters.

## The reader

Restore is the half of s3cab you can do without s3cab: a snapshot row names the object, and
fetching it is one request. The reader turns that into a tool, with **no AWS SDK, no S3 client
library and no shelling out**. Clean-room runs 2 (C++23) and 3 (Go) already showed the cost: an
HTTP client, SHA-256/HMAC, zstd and about 80 lines of SigV4.

Go is preferred over C for the alternative restore tool. A static binary for every target from
one machine is more portable in practice than C's per-platform libcurl, OpenSSL and libzstd.

## How the three prove each other

Each writer's output must be restored correctly by each reader:

| Written by ↓ / read by → | s3cab | clean-room reader |
|---|---|---|
| **s3cab** | its test suite | clean-room runs 1–3 today |
| **clean-room writer** | s3cab accepts spec-derived output | **the spec proven without s3cab** |

The bottom-right cell is the only one that proves the *spec* rather than compatibility with
s3cab's reading of it. With three implementations, a disagreement is also a vote: where two
agree, the fault is probably in the third, or in a sentence of the spec only it read that way.

What a writer comparison must allow for, because these aren't defects:

- **Row order isn't specified**, so file rows are compared as a set. The spec should say order
  is not significant.
- **Metadata payloads are "context"**, so `#EXCLUDED`/`#SKIPPED`/`#ERROR` rows are compared by
  path, not wording.
- **Timestamps and snapshot names** differ by run.

File rows (hash, size, mtime, path) and the excluded paths must match exactly.

## Frozen evidence vs maintained tools

Clean-room runs are frozen by design. Each one is a single reading of the spec on a given date,
and maintaining it would slowly import s3cab's behaviour and erode its independence. Two rules
reconcile that with a reader people rely on and a writer people learn from:

1. **A run is promoted, then maintained under the spec-only rule.** Every fix must be justified
   by the spec text. A fix that needs knowledge the spec lacks means the spec is fixed first.
2. **The runs worth keeping are made at the 1.0 format freeze.** Before 1.0 the format moves, so
   runs are rehearsals that find spec gaps. At 1.0 the format becomes the promise
   ([0002](0002-no-lock-in-hard-constraint.md)), and programs written against it stay valid,
   which is when an alternative restorer is worth shipping.

## Open

- **The writer's harness.** `scripts/cleanroom/` is restore-shaped. It needs a writer brief and a
  step that runs the whole matrix: build the corpus, write it with both writers, restore each
  result with every reader, then compare with `compare.py`.
- **Set state.** Does the writer write the `sets/<set>/` markers (`info`, `dirs.txt`) so s3cab
  adopts its sets? The spec documents them, so probably yes.
- **Where the promoted programs live, and whether s3cab ships the reader** beside its own
  release.
- **Starting point.** A bash spike of the writer side is preserved at
  [scripts/s3cab-mini.sh](../../scripts/s3cab-mini.sh). The two silent-corruption bugs it hit
  are a warning about what the writer must get right.
