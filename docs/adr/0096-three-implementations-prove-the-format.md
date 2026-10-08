# Clean-room implementations prove the format: s3cab, a clean-room backup, clean-room restorers

**Status:** proposed (2026-10-07). The model is settled. The clean-room backup is not built, and
the restorers exist only as frozen clean-room runs.

**s3cab is the tool.** It both backs up and restores. Beside it sit two kinds of **clean-room
implementation**, each derived from the spec alone (`guide/format.md` and `guide/exclude.md`,
plus nothing of s3cab's). Each proves the format in one direction and serves a second goal of its
own.

| | Clean-room backup | Clean-room restorer |
|---|---|---|
| **Proves** | a backup can be *written* from the spec | a backup can be *read* from the spec |
| **Second goal** | education: shows how s3cab works | a restore path that needs nothing of s3cab's |
| **Programs** | `s3cab-snapshot.py` and `s3cab-upload.py`, with full exclude syntax | one restorer per platform |
| **Language** | Python; one program, run on every platform | the platform's canonical one: C# on Windows, Swift on macOS, C on Linux |
| **Libraries** | the standard library and boto3, nothing else | **no AWS SDK**; requests signed by hand |

"Clean-room" is what separates these from s3cab, which backs up and restores too.

## The clean-room backup

Its readers are people learning how s3cab works, so its brief adds one requirement beyond the
spec: **someone who can code a little should be able to work out how s3cab fundamentally works
from it in about half an hour.** That is s3cab's founding readability test, which `src/`
outgrew as features and robustness were added. It means two programs, `s3cab-snapshot.py` and
`s3cab-upload.py`, roughly 500 lines between them including comments. The snapshot file is all
that passes from one to the other, so the format itself is their interface.

It is **correct but unoptimised**: no hash reuse, no fused pipeline, no parallelism. Slow but
right is the point. Correctness covers:

- the exact format;
- full exclude syntax;
- objects first, snapshot last;
- the whole bucket layout the spec documents, `sets/<set>/` markers included, so s3cab can
  reattach and restore its sets unaided;
- every object stored is the bytes its key names, which is the spec's own definition of the
  key. The brief prescribes no way of ensuring it: how the program does is part of its reading
  of the spec.

The SDK is allowed because boto3's `upload_file` hides multipart, retries and the credential
chain, none of which is the format. Python is chosen because it is the most widely readable
language for a short program.

**It is also the test of what the spec may demand.** One program, written once, has to run on
Linux, macOS and Windows with the standard library and boto3 alone. If it can't do something
portably, that requirement has to be justified as *essential*, or it becomes *optional* in the
spec. A wider dependency rule would hide exactly these gaps. Expected first cases:

- the IANA time zone in the `#SNAPSHOT` header, which Python's standard library can't name for
  the local machine on any platform, and can't resolve on Windows without the `tzdata` package;
- whether `#SNAPSHOT`'s fields are commitments at all. `format.md` calls metadata payloads
  "context", yet s3cab reads the header's start instant (ADR-0072, ADR-0094).

**Full exclude syntax is in scope.** Exclusion decides what a backup holds, and the syntax is
small: four tokens and a trailing `/`. It also carries a trap: `*` matches one *or more*
characters.

**Nothing of s3cab's output reaches its clean room.** It checks itself against the spec and the
bucket only. Comparing its rows with s3cab's happens afterwards, outside the room: given s3cab's
snapshots to diff against, it could converge by imitation, and every ambiguity resolved that way
would vanish from its report.

## The clean-room restorers

Restore is the half of s3cab you can do without s3cab: a snapshot row names the object, and
fetching it is one request. A restorer turns that into a program, with **no AWS SDK, no S3
client library and no shelling out**. Clean-room runs 2 (C++23) and 3 (Go) already showed the
cost: an HTTP client, SHA-256/HMAC, zstd and about 80 lines of SigV4.

**Nothing here is distributed.** The clean-room implementations live in the repo, on GitHub, as
evidence for anyone who wants to check the claim. s3cab's releases ship s3cab alone.

**Each platform's restorer is written in that platform's canonical language.** Part of its job
is to show how little recovering your data takes beyond the operating system, and the platform's
own language, with its own frameworks or system libraries, shows that best. Variety for its own
sake is not a goal, and nor is avoiding a language.

Snapshots are gzip ([ADR-0097](0097-gzip-snapshot-compression.md)), which every platform's own
stack reads; zstd, before it, was the one thing none could:

- **Windows: C# on the .NET Framework that ships with Windows**, so **nothing is installed**.
  `HttpClient`, `SHA256`/`HMACSHA256` and `GZipStream` are all in the in-box framework. A clean
  room has to find a way to compile without installing a toolchain: the in-box `csc.exe`, which
  is limited to C# 5, or `Add-Type` from Windows PowerShell 5.1. Expected traps include long
  paths, which the .NET Framework needs an opt-in for, and the TLS defaults.
- **macOS: Swift.** `swiftc` comes with the Xcode command-line tools; HTTPS (`URLSession`),
  SHA-256/HMAC (CryptoKit) and zlib (Compression, raw deflate behind gzip's 10-byte header) come
  with the OS, so **nothing comes from Homebrew**.
- **Linux: C**, the language POSIX specifies and the system is built in: libcurl, OpenSSL and
  zlib, one `apt`/`dnf` install of their headers.

Runs 1–3 (Python with boto3, C++23, Go) predate the rule. Their programs can go once the
bootstrapper below has produced their replacements; their reports in `docs/` stay, since the
report, not the program, is what a later run is diffed against.

## How the three prove each other

Every backup must be restored correctly by every restorer:

| Backed up by ↓ / restored by → | s3cab | clean-room restorer |
|---|---|---|
| **s3cab** | its test suite | clean-room runs 1–3 today |
| **clean-room backup** | s3cab accepts spec-derived output | **the spec proven without s3cab** |

The bottom-right cell is the only one that proves the *spec* rather than compatibility with
s3cab's reading of it. With three implementations, a disagreement is also a vote: where two
agree, the fault is probably in the third, or in a sentence of the spec only it read that way.

What comparing two backups must allow for, because these aren't defects:

- **Row order isn't specified**, so file rows are compared as a set. The spec should say order
  is not significant.
- **Metadata payloads are "context"**, so `#EXCLUDED`/`#SKIPPED`/`#ERROR` rows are compared by
  path, not wording.
- **Timestamps and snapshot names** differ by run.

File rows (hash, size, mtime, path) and the excluded paths must match exactly.

## Frozen, and timed to 1.0

Clean-room implementations are frozen by design. Each is one reading of the spec on a given
date; maintaining it would slowly import s3cab's behaviour and erode its independence. Since none
is distributed, none needs to be maintained. A program that drifts from a later format is a
breaking change to notice, not a bug to patch.

**The runs worth keeping are made at the 1.0 format freeze.** Before 1.0 the format moves, so
runs are rehearsals that find spec gaps. At 1.0 the format becomes the promise
([0002](0002-no-lock-in-hard-constraint.md)), and programs written against it stay valid
indefinitely.

## Open

- **`scripts/cleanroom/` becomes a bootstrapper** for building the clean-room implementations
  against the current spec. `build-backup-cleanroom.mjs` and `build-restore-cleanroom.mjs` each
  build a sandbox for one run, with the language derived from role and platform. Still to build: a CI workflow that runs the whole
  matrix, described below.

  **What it keeps is settled.** Before 1.0, only the latest clean-room implementations are
  committed, each replacing its predecessor; the reports in `docs/` keep the history. After
  1.0, one set is kept per major format version. The hope is that there is only ever one,
  because a major format change is a broken promise ([0002](0002-no-lock-in-hard-constraint.md)).
  A session-written program can't be regenerated identically, which is why the outputs are
  committed at all.

  **The bucket is settled: one, `S3CAB_TEST_BUCKET_CLEANROOM`, used in turns.** Every backup
  in the matrix backs up the same file contents, so they share every hash, and a bucket's
  `objects/` is shared by all its sets. Two backups in one bucket at once would let one's
  object stand in for the other's: hiding a bad upload, or leaking
  `build-restore-cleanroom.mjs`'s deliberate damage (`faults`, `corrupt`) into the other backup's sets. So a turn is: empty the
  bucket, one backup, every restorer restores it. The turns are s3cab's, on Linux, where every
  fixture can exist; then the clean-room backup's, once per OS. A second bucket would not remove
  the turns, since the clean-room backup alone takes three. The bucket is
  `test-s3cab-<owner>-cleanroom`, and `test-s3cab-ci-cleanroom` in CI; nothing else uses it.
  The clean room leaves the integration bucket, which CI's integration suite owns outright and
  expires within a day.

  **The matrix runs in GitHub Actions**, on Linux, macOS and Windows runners, with the turns
  ordered by job dependencies and a concurrency group. It builds and runs the committed
  programs; it never writes them. On each runner, the reference for a restore is s3cab's own
  restore there, and the clean-room backup's rows are compared with `s3cab snapshot` of the
  same trees, which is local and needs no bucket. A personal bucket of the same name serves the
  sessions that write the programs, one session at a time.

  **The clean-room backup backs up its sandbox's fixture trees in place**, so its paths and
  mtimes are the ones s3cab snapshotted and its rows compare without re-rooting. A copy would
  not do: copying loses the sub-millisecond mtimes the trees keep on purpose.
- **The macOS restorer waits for a Mac.** Writing a restorer is an agent session that compiles
  and tests against the bucket as it goes, and the brief's CryptoKit and Compression exist only
  on macOS. An agent on a hosted macOS runner is possible but awkward: a job checks out the
  repo the clean room must not see, can't ask anything mid-run, and stops at six hours. Once
  written, CI builds and runs it like the others.
- **Where the clean-room backup lives.** It is a clean-room run, so beside the restorers in
  `scripts/cleanroom/` is the natural home.
- **Starting point.** A bash spike of the backup side is preserved at
  [scripts/s3cab-mini.sh](../../scripts/s3cab-mini.sh). The two silent-corruption bugs it hit
  are a warning about what the clean-room backup must get right.
