# Three implementations prove the format: s3cab, a clean-room writer, a clean-room reader

**Status:** proposed (2026-10-07). The model is settled. The writer is not built, and the reader
exists only as frozen clean-room runs.

**s3cab is the tool.** It is both a writer and a reader of the format. Beside it sit two programs,
each derived from the spec alone (`guide/format.md` and `guide/exclude.md`, plus nothing of
s3cab's). Each proves the format in one direction and serves a second goal of its own.

| | Writer | Reader |
|---|---|---|
| **Proves** | a backup can be *written* from the spec | a backup can be *read* from the spec |
| **Second goal** | education: shows how s3cab works | a restore path that needs nothing of s3cab's |
| **Commands** | snapshot and upload, with full exclude syntax | restore |
| **Language** | Python, on every platform | the platform's canonical one: C# on Windows, Swift on macOS, C on Linux |
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
fetching it is one request. The reader turns that into a program, with **no AWS SDK, no S3 client
library and no shelling out**. Clean-room runs 2 (C++23) and 3 (Go) already showed the cost: an
HTTP client, SHA-256/HMAC, zstd and about 80 lines of SigV4.

**Nothing here is distributed.** The readers and the writer live in the repo, on GitHub, as
evidence for anyone who wants to check the claim. s3cab's releases ship s3cab alone.

**Each platform's reader is written in that platform's canonical language.** Part of the
reader's job is to show how little recovering your data takes beyond the operating system, and
the platform's own language, with its own frameworks or system libraries, shows that best.
Variety for its own sake is not a goal, and nor is avoiding a language.

The target assumes snapshots move from zstd to gzip
(ADR-0097, implemented in PR #381). zstd was the one thing no
platform's own stack could read, and gzip removes it:

- **Windows: C# on the .NET Framework that ships with Windows**, so **nothing is installed**.
  `HttpClient`, `SHA256`/`HMACSHA256` and `GZipStream` are all in the in-box framework. A clean
  room has to find a way to compile without installing a toolchain: the in-box `csc.exe`, which
  is limited to C# 5, or `Add-Type` from Windows PowerShell 5.1. Expected traps include long
  paths, which the .NET Framework needs an opt-in for, and the TLS defaults. *While snapshots are
  still zstd, this falls back to C# on .NET 11 (`ZstandardStream`), its one install.*
- **macOS: Swift.** `swiftc` comes with the Xcode command-line tools; HTTPS (`URLSession`),
  SHA-256/HMAC (CryptoKit) and zlib (Compression, raw deflate behind gzip's 10-byte header) come
  with the OS. With gzip **nothing comes from Homebrew**; under zstd, `brew install zstd`.
- **Linux: C**, the language POSIX specifies and the system is built in: libcurl, OpenSSL and
  zlib, one `apt`/`dnf` install of their headers (libzstd under zstd).

Runs 1–3 (Python with boto3, C++23, Go) predate the rule. Their programs can go once the
bootstrapper below has produced their replacements; their reports in `docs/` stay, since the
report, not the program, is what a later run is diffed against.

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

## Frozen, and timed to 1.0

Clean-room programs are frozen by design. Each is one reading of the spec on a given date;
maintaining it would slowly import s3cab's behaviour and erode its independence. Since none is
distributed, none needs to be maintained. A program that drifts from a later format is a
breaking change to notice, not a bug to patch.

**The runs worth keeping are made at the 1.0 format freeze.** Before 1.0 the format moves, so
runs are rehearsals that find spec gaps. At 1.0 the format becomes the promise
([0002](0002-no-lock-in-hard-constraint.md)), and programs written against it stay valid
indefinitely.

## Open

- **`scripts/cleanroom/` becomes a bootstrapper** for building the writer and the readers
  against the current spec. Today it is restore-shaped (`create.mjs`, `stage.mjs`,
  `compare.py`). It needs:
  - a writer brief beside the reader brief;
  - the language derived from role and platform, rather than passed as `--lang`;
  - a step that runs the whole matrix: build the corpus, write it with both writers, restore
    each result with every reader, then compare.

  **What it keeps is settled.** Before 1.0, only the latest writer and readers are committed,
  each replacing its predecessor; the reports in `docs/` keep the history. After 1.0, one set
  is kept per major format version. The hope is that there is only ever one, because a major
  format change is a broken promise ([0002](0002-no-lock-in-hard-constraint.md)). A
  session-written program can't be regenerated identically, which is why the outputs are
  committed at all.
- **Set state.** Does the writer write the `sets/<set>/` markers (`info`, `dirs.txt`) so s3cab
  adopts its sets? The spec documents them, so probably yes.
- **Where the writer lives.** It is a clean-room run, so beside the restorers in
  `scripts/cleanroom/` is the natural home.
- **Starting point.** A bash spike of the writer side is preserved at
  [scripts/s3cab-mini.sh](../../scripts/s3cab-mini.sh). The two silent-corruption bugs it hit
  are a warning about what the writer must get right.
