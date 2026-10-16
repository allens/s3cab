# Clean-room implementations prove the format: s3cab, a clean-room backup, clean-room restorers

**Status:** proposed (2026-10-07; amended 2026-10-09: the clean-room backup's two programs are
written in separate clean rooms, on every platform; amended 2026-10-12: the clean-room backup is
proof only, with no readability goal; amended 2026-10-16: the clean-room backup is one program
again, walk to bucket, and the harness for it is built; and the golden set is seeded by GitHub
Actions on all three platforms, into one bucket every run reads). The model is settled. The clean-room
backup program is not yet written, and the restorers exist only as frozen clean-room runs. Partly
superseded by [0107](0107-the-spec-is-the-public-repository-format.md): the spec is format.md
alone, so a clean-room backup needs neither s3cab's exclude syntax nor its config files.

**s3cab is the tool.** It both backs up and restores. Beside it sit two kinds of **clean-room
implementation**, each derived from the spec alone (`guide/format.md`, plus nothing of s3cab's).
Each proves the format in one direction, and the restorer serves a second goal of its own.

| | Clean-room backup | Clean-room restorer |
|---|---|---|
| **Proves** | a backup can be *written* from the spec | a backup can be *read* from the spec |
| **Second goal** | none: proof only | a restore path that needs nothing of s3cab's |
| **Programs** | `s3cab-backup.py`, walk to bucket, one per platform | one restorer per platform |
| **Language** | Python everywhere; each program written on its platform and run on all three | the platform's canonical one: C# on Windows, Swift on macOS, C on Linux |
| **Libraries** | the standard library plus boto3; nothing else | **no AWS SDK**; requests signed by hand |

"Clean-room" is what separates these from s3cab, which backs up and restores too.

## The clean-room backup

One program, from the walk to the bucket:

```
s3cab-backup.py <bucket> <set> <dir>...
```

It needs nothing of s3cab's: no set files and no exclude syntax, since the spec is the repository
format alone ([0107](0107-the-spec-is-the-public-repository-format.md)) and leaving files out is
a tool's own choice. A set is a label and a list of directories. Several directories, not one,
because that is more than a loop: one snapshot spans them all as `@SET DIR` rows, placement takes
the longest whole-segment match, overlapping directories stop the backup, and `spread`, the only
multi-directory set, is what makes the restore layout question answerable. Not the `<bucket>/<set>`
form: it makes every program split a string and gives the spec nothing to check.

**They are proof, not teaching.** Not also a half-hour read for someone who codes a little,
because proof needs the whole spec on every platform, byte for byte: Windows casing, paths past
`MAX_PATH`, names with no UTF-8 form and the zone lookup are what the proof is for and what a gist
leaves out, and a line target only packs them tighter. A readable reference is a separate idea,
which needs no clean room since it proves nothing ([proposals/misc.md](../../proposals/misc.md)).

**One program, not a snapshot room and an upload room.** The split of 2026-10-09 put the snapshot
file between two sessions, so that two readers of the spec, one on each side of the file, tested
that the spec alone defines it, and so that the harness could stage the upload room's inputs: a
file changed after its snapshot, and a snapshot missing its `.`. The clean room validates the
format, and measured against that, each of those is tested where it belongs:

| What | Where it's tested |
|---|---|
| Stored objects hash to their keys (format) | `check-backup`, every object, every run |
| What makes a file valid (format) | restorers, against the restore fixtures' torn `faults` snapshot |
| Hashing the bytes as they're sent (implementation) | the harvest review of the program's code; s3cab's own tests for its upload |
| Refusing a torn snapshot handed in (implementation) | s3cab's tests for `upload`; the Uploading checklist keeps the rule |

What fusing gains: no s3cab output reaches any clean room, since the upload room's exception went
with the room, and a real set is three runs of a real program instead of six. What it loses: the
staged after-snapshot change, which was the only thing that ever made a room face a file whose
bytes don't match while sending. A fused program controls its own walk, and nothing changes a
file between its hash and its send, so that question is asked only if the reader thinks of it
unprompted. The second reader goes too: the published snapshot is read by `check-backup` and the
restorers alone, so an uploader *parsing* rows is tested by nobody but a restorer. And every
backup run takes a bucket turn, with boto3 and a credential window, where a snapshot room needed
neither and could run beside an upload.

**The cost to watch is a shallower reading.** One session now covers both the "Writing a
snapshot" and "Uploading" checklists. The first fused run's guesses against each are compared with
the last split runs' (30 snapshot, 33 upload); clearly fewer argues for splitting again.

**Written on every platform, like the restorers.** A session can only test on the machine it
runs on, so a program written on Linux meets Windows for the first time in CI. A failure there
arrives without the guesses behind it, and the report never holds that platform's findings: the
same silent shortening the fixtures' skip notice exists to prevent. Both halves of the job have
such findings. The walk has to spell a Windows path as the filesystem reports it, uppercase the
drive letter, name the IANA zone where Python can't, and reach paths past `MAX_PATH`. The upload,
writing `.info` through Python's text mode on Windows, writes CRLF, which the spec forbids.
Neither s3cab nor any restorer reads that file strictly enough to notice, so the backup's own
checker has to. The seed is different in kind: it produces the golden set rather than reading the
spec, so it runs in CI, where every platform is.

The language stays one, and so does the portability rule below: every program, wherever it was
written, must run unchanged on all three platforms. So the portability test gets three programs
instead of one, each tested first-hand where it was written and by CI everywhere else.

It is **correct but unoptimised**: no hash reuse, no fused pipeline, no parallelism. Slow but
right is the point. Correctness covers:

- the exact format;
- objects first, snapshot last;
- the whole bucket layout the spec documents, each set's `snapshots/<set>.info` included;
- every object stored is the bytes its key names, which is the spec's own definition of the
  key. The brief prescribes no way of ensuring it: how the program does is part of its reading
  of the spec.

The SDK is allowed because boto3's `upload_file` hides multipart, retries and the credential
chain, none of which is the format. Python is chosen because it is a different runtime from
s3cab's Node, so a behaviour both would get from one runtime (how it lists a directory, spells a
path or writes gzip) can't pass the comparison unseen; and because its standard library is broad
and the same on all three platforms, so what it can't do portably is a fair finding about the
spec.

**It is also the test of what the spec may demand.** Each program, wherever it was written, has
to run on Linux, macOS and Windows with the standard library and boto3. If it can't do something
portably, that requirement has to be justified as *essential*, or it becomes *optional* in the
spec. A wider dependency rule would hide exactly these gaps. Expected first case: the IANA time
zone in `@SNAPSHOT START`, which Python's standard library can't name for the local machine on
any platform, and can't resolve on Windows without the `tzdata` package.

**Nothing of s3cab's output reaches the clean room.** It checks itself against the spec only.
Comparing its snapshot with s3cab's happens afterwards, outside the room: given s3cab's snapshots
to diff against, it could converge by imitation, and every ambiguity resolved that way would
vanish from its report. The room is handed the trees and, for each set, its name and member
directories, and nothing of what makes any set hard: which ones a backup has to refuse is the
spec's to say.

**What the checker holds it to.** Each published snapshot is downloaded and compared row for row
with `s3cab snapshot` of the same trees, taken in a throwaway home whose set names the backup
bucket, so `@SET BUCKET` compares like with like; the row is optional, so it is compared only when
the room wrote it. Each set has an expectation from the fixture table: published, or, for a set
whose names the spec says to stop on, nothing published; a `.info` claimed before the walk
refused stays a note. s3cab runs with no patterns, so `spread`'s near misses and `edge`'s
`ignored.*` are ordinary files in the backup bucket, and the seed's patterns stay the seed's;
`faults` and `corrupt` are ordinary trees too, their names describing damage only the restore
fixtures have.

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
  `HttpClient`, `SHA256`/`HMACSHA256` and `GZipStream` are all in the in-box framework. The
  build names its compiler in `ENVIRONMENT.md`: the in-box `csc.exe`, which is limited to C# 5,
  or `Add-Type` from Windows PowerShell 5.1, even where something newer is installed. Expected
  traps include long paths, which the .NET Framework needs an opt-in for, and the TLS defaults.
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

- **Row order isn't significant**: a reader goes by each row's type, so file rows are
  compared as a set.
- **Which pattern excluded a path**, when several match, and **how the system words an
  error** aren't fixed by the spec, so `#excluded`/`#error` rows are compared by path.
- **Timestamps and snapshot names** differ by run.
- **An excluded directory** may be one `#excluded` row or a row for each file in it. The spec
  doesn't say which, so until it does a difference of that kind is reported, not failed.
- **`@SNAPSHOT START`'s time zone** is reported, not failed, until the spec says whether the
  field is a commitment (the first expected case above).

File rows (hash, size, mtime, path) and the excluded and unreadable paths must otherwise match
exactly.

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
  build a sandbox for one run, with the language derived from role and platform;
  `seed-restore-cleanroom-bucket.mjs` fills the bucket every restorer reads;
  `check-backup.mjs`, with `compare-snapshot.mjs`, checks the backup room's work beyond what a
  restore can see (each set's `.info`, the sets it should have refused, and its rows against
  s3cab's). Still to build: a CI workflow that runs the whole matrix, described below.

  **What it keeps is settled.** Before 1.0, only the latest clean-room implementations are
  committed, each replacing its predecessor; the reports in `docs/` keep the history. After
  1.0, one set is kept per major format version. The hope is that there is only ever one,
  because a major format change is a broken promise ([0002](0002-no-lock-in-hard-constraint.md)).
  A session-written program can't be regenerated identically, which is why the outputs are
  committed at all.

  **The buckets are settled: two, one per role.** Every backup in the matrix backs up the same
  file contents, so they share every hash, and a bucket's `objects/` is shared by all its sets.
  Two backups in one bucket would let one's object stand in for the other's: hiding a bad
  upload, or leaking the restore bucket's deliberate damage (`faults`, `corrupt`) into the
  other backup's sets.

  - **`S3CAB_TEST_BUCKET_CLEANROOM_RESTORE` holds the golden set**: s3cab's backup of the
    fixtures, damage included, which every restorer restores. It is long-lived, and reseeded by
    `seed-restore-cleanroom-bucket.mjs` only when `guide/format.md` or the fixtures change; the
    seed stamps the bucket with a hash of the spec, the fixtures and itself, and a restore build
    refuses any other stamp, since a restorer written from today's spec fails against
    yesterday's format through no fault of its own, and passes against yesterday's fixtures
    without meeting what was added since. **Each platform seeds its own sets, in GitHub
    Actions**, suffixed with its name (`edge-windows`), so restorers meet drive letters,
    backslashes and APFS's view of a tree as well as Linux's, and a restorer written without a
    Mac still reads a Mac's backup. CI is the one system that runs all three, so the golden
    set is never two platforms out of three. Every file's content carries its platform's name,
    so no two platforms share an object and one bucket keeps the reason above for one backup
    per bucket. Every restore build is then the same on every OS: reattach every platform's
    sets and restore s3cab's own reference from them.
  - **`S3CAB_TEST_BUCKET_CLEANROOM_BACKUP` is used in turns**: empty the bucket, one clean-room
    backup, every restorer restores it. Every backup program takes a turn on every runner:
    nine turns once macOS has its own.

  The buckets are `test-s3cab-<owner>-cleanroom-restore` and `-cleanroom-backup`, with `ci` as
  the owner in CI; nothing else uses them. The clean room leaves the integration bucket, which
  CI's integration suite owns outright and expires within a day. One bucket is one repository,
  at its root, so a second major format version after 1.0 would need a second golden bucket
  (`…_CLEANROOM_RESTORE_V2`) rather than a prefix. Not a tarball of the golden bucket in the
  repo: it would be a cache of the seed script's output, 40 MB and more added to history on
  every format change, where the long-lived bucket already is that cache.

  **The matrix runs in GitHub Actions**, on Linux, macOS and Windows runners, with the turns
  ordered by job dependencies and a concurrency group. It builds and runs the committed
  programs; it never writes them. On each runner, the reference for a restore is s3cab's own
  restore there, and the clean-room backup's published snapshot is compared with
  `s3cab snapshot` of the same trees there. The sessions that write the programs read CI's
  restore bucket too; a personal backup bucket serves them, one session at a time.

  **The backup turns are the matrix's cost.** They share one bucket, so they run one after
  another, each followed by every restorer. That is the price of testing each backup's
  portability rather than assuming it. If it proves too slow, the lever is a backup bucket per
  runner, so each platform's turns run beside the others' with still one backup per bucket, not
  fewer turns.

  **The clean-room backup reads its sandbox's fixture trees in place**, so its paths and
  mtimes are the ones s3cab snapshotted and its rows compare without re-rooting. A copy would
  not do: copying loses the sub-millisecond mtimes the trees keep on purpose.
- **The macOS programs wait for a Mac.** Writing one is an agent session that tests as it goes,
  on the machine it runs on: the restorer's CryptoKit and Compression exist only on macOS, and
  the backup room is there to meet APFS's folding of case and Unicode normal form first-hand.
  An agent on a hosted macOS runner is possible but awkward: a job checks out the repo the
  clean room must not see, can't ask anything mid-run, and stops at six hours. Once written, CI
  builds and runs them like the others.
- **Where the clean-room backup lives is settled**: beside the restorers, in
  `scripts/cleanroom/backup/<platform>/`, one program per platform. Each run's report continues
  the `docs/format-spec-audit-<n>.md` numbering, its title naming the role and the platform.
- **What to check in its output.** A bash spike of the backup side hit two silent-corruption
  bugs: a path's trailing space trimmed on read, and an unreadable file shifting every later
  hash by one row. Either is easy to write in any language. The fixtures' trailing-space names
  (F2) catch the first in a published snapshot's rows, and `edge`'s unreadable file among twenty
  readable siblings the second.
