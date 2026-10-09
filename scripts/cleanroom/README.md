# The clean-room exercise

> **Partly built** ([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)):
> the harness that builds each clean room is here, and everything below describes it. Still to
> come: the clean-room programs for the current spec; the CI matrix that builds and runs them;
> `compare-restore.mjs` and `compare-snapshot.mjs` in place of `compare.py`; and, before 1.0,
> keeping only the latest programs, so [restorers/](restorers/) stops being append-only and the
> earlier runs' programs go, while their reports in `docs/` stay.

A literal test of [ADR-0002](../../docs/adr/0002-no-lock-in-hard-constraint.md)'s
no-lock-in promise: a session that has read
[guide/format.md](../../guide/format.md) and **nothing else** writes a restorer
from scratch, and its output is compared byte-for-byte against s3cab's own. The
restorer itself is the lesser result. The main one is the list of places the
spec is ambiguous, silent, or wrong, ranked by whether a wrong guess corrupts a restore
or merely costs the implementer an afternoon.

Reports so far: [run 1](../../docs/format-spec-audit.md) (2026-08-12, Python,
boto3), [run 2](../../docs/format-spec-audit-2.md) (2026-08-20, C++23, no
SDK) and [run 3](../../docs/format-spec-audit-3.md) (2026-08-23, Go, no SDK).
Diffing a new run's list against the last one is what makes a re-run worth
doing — an item that reappears is a fix that didn't land.

**Each platform's restorer is written in that platform's canonical language:**
C# on Windows, Swift on macOS, C on Linux. The aim is not variety, or avoiding
any language. It is to show what recovering your data takes with as little as
possible beyond the operating system: on each platform, its own language, its
own frameworks or system libraries, and nothing of s3cab's. Runs 2 (C++) and 3
(Go) predate that rule and stay as history. The restorers are one half of
[ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)'s
three-way proof: a clean-room backup is the other. That is two Python programs,
one per pillar of a backup, each written in its own clean room by a session that
never sees the other's, so the snapshot file between them is defined by the spec
alone. Like the restorers, both are written on every platform: a session can only
test where it runs, and each platform changes what a backup has to get right —
Windows path casing and drive letters, a time zone Python can't name there, text
mode writing CRLF. They stay Python everywhere, and each has to run unchanged on
all three. Nothing here is distributed; it lives in the repo as evidence.

**Two kinds of file live here, with opposite lifecycles.** The harness is ours,
maintained, and improved every run as findings come in: the seed script, the three
build scripts, the modules they share (`cleanroom.mjs`, `fixtures.mjs`,
`restore-bucket.mjs`), and `compare.py`.
[restorers/](restorers/) is append-only and frozen — one program per run, never
updated, because each one's value is being a fixed reading of the spec on a
given date.

Two buckets, one per role
([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)):
`S3CAB_TEST_BUCKET_CLEANROOM_RESTORE` holds the **golden set** every restorer
reads, and `S3CAB_TEST_BUCKET_CLEANROOM_BACKUP` is emptied for each clean-room
upload's turn. The snapshot room has no bucket at all: a snapshot is a local file.

The golden set is seeded **once per format change**, on Linux or WSL, since only
a Linux filesystem holds every fixture. The root must be on that filesystem —
`~`, not `/mnt/c`:

```sh
node --env-file=.env.test scripts/setup-test-bucket.mjs --days 365 <restore-bucket>
node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs ~/s3cab.sandbox
rm -r ~/s3cab.sandbox
```

Every run then happens in a **sandbox**: one directory outside the repo, built
from empty and deleted once the run is harvested — create, run, harvest,
destroy, then the next.

```text
C:\s3cab.sandbox\
  cleanroom\   the session opens here: spec, brief, credentials (not for
               a snapshot), and sets\ (snapshot, upload) or reference\ (restore)
  fixtures\    the trees it backs up (snapshot, upload)
  .s3cab\      s3cab's home while the build runs it (upload, restore)
```

A restorer run, end to end — the same commands on every OS:

```powershell
# create
node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs C:\s3cab.sandbox
# run: open a session in C:\s3cab.sandbox\cleanroom and say "go"
# harvest: its program and report into the repo, and its restore compared
python3 scripts/cleanroom/compare.py <its-restore-dir> C:\s3cab.sandbox\cleanroom\reference\<snapshot>
# destroy
Remove-Item -Recurse C:\s3cab.sandbox
```

The two halves of the backup are the same sequence with their own scripts, and
like a restorer, each is built and run on every OS. A snapshot run needs no
bucket, and so no test environment:

```powershell
node scripts/cleanroom/build-snapshot-cleanroom.mjs C:\s3cab.sandbox
```

An upload run's turn starts from an empty bucket, which the build leaves for you
to empty:

```powershell
aws s3 rm s3://<backup-bucket>/ --recursive
node --env-file=.env.test scripts/cleanroom/build-upload-cleanroom.mjs C:\s3cab.sandbox
```

## cleanroom.mjs

Reads the one root every script here takes, and writes the clean room each
build script hands over: a byte copy of
[guide/format.md](../../guide/format.md) (plus
[guide/exclude.md](../../guide/exclude.md) for a snapshot, the one role whose
output the exclude grammar decides), a brief naming the language, credentials
where the role has a bucket, and nothing else. The language is Python for both
halves of the backup and the platform's canonical one (above) for a restorer, so
runs differ by reader and by spec version. It also holds `cli`, the subprocess
that drives the real s3cab for the builds that need its output. The restorer brief is language-neutral apart from one
sentence — which names no version and no toolchain, leaving the session to find
"the most modern version that comes as standard" on the machine it's on.

The sandbox has to be **outside the repo**, and every script refuses otherwise:
a session opened inside is handed [CLAUDE.md](../../CLAUDE.md) before it reads
anything, and that file discusses the `#SNAPSHOT` header's UTC instant, the
`#DIR` headers, the drive-letter normalisation and the TSV encoding. Those are
restore-correctness facts the exercise exists to make someone derive, and the
contamination is invisible in the result — the ambiguity list simply comes back
shorter, which reads as a spec that has been fixed. Keep previous runs' reports
out of the sandbox too: diffing the lists afterwards is the reader's job. They
also refuse a sandbox that isn't empty, so nothing from the last run can
ride along beside the new brief.

The brief is written as the clean room's own `CLAUDE.md`, so the run starts from
a bare "go" instead of a pasted wall of text — and, because that file is
re-injected as the context compacts, the rule that matters survives a run long
enough to write a program, where an opening-turn instruction would scroll away.

`ENVIRONMENT.md` names **one** bucket. Copying `.env.test` across would be
handier and is the wrong shape: it also names the crash and conformance buckets,
whose suites assert whole-bucket state and which hold deliberately torn
repositories — snapshots published over swept objects, written on purpose by
`test/crash`. That is the exact signature this exercise hunts, so a session that
wandered into one would report a real observation as a spec defect. The bucket
comes only from the role's `S3CAB_TEST_BUCKET_CLEANROOM_*` variable, which
`--env-file=.env.test` supplies with the `AWS_*` settings without the file itself
travelling.

Libraries come from the platform's packages, and the brief bars **any AWS SDK or
S3 client library, packaged or not** — the restorer signs its own requests, and
may not drive the `aws` CLI to do its work either. That rule has to name the SDK
rather than say "platform packages only", because the archive's coverage is
uneven: Ubuntu packages an SDK for Go, Ruby and Perl but none for C++, so the
looser wording would hand one language the thing it denies another and leave two
runs incomparable. Consulting the CLI while getting SigV4 right stays allowed
and is disclosed in the report — a development aid is not a dependency, and
whether signing is derivable from public docs alone is itself worth knowing.

The point is a second result beside the ambiguity list: s3cab depends on the AWS
SDK completely, so nothing has ever established what *reading* the format needs.
A restorer that talks to S3 with an HTTP client and nothing else is evidence for
[ADR-0002](../../docs/adr/0002-no-lock-in-hard-constraint.md)'s no-lock-in
promise of a kind a documented format can't be — and it is why the earlier
Python run doesn't answer this, having used boto3.

Credentials go over as static keys in `credentials.env` (`credentials.ps1` on
Windows), resolved through the
SDK chain at build time — `AWS_PROFILE` would be useless to a restorer with no
SDK to read `~/.aws/config` with. They are session credentials, so the run must
sign `x-amz-security-token` too, and they expire: `ENVIRONMENT.md` states the
deadline and tells the session that a 403 following requests that worked means
the window closed rather than a signing bug, and to stop and say so. Each build
mints a fresh window, the permission set's session duration (8 hours here, 12
being the IAM Identity Center maximum) — several times what a run takes.

Built on Windows, the clean room gets a Windows brief. Nothing comes as standard
there and there is no package archive, so the toolchain sentence becomes
"installed on this machine, standard library only" — install it before the run,
in C# against the .NET Framework that ships with Windows, whose `GZipStream`
decompresses gzip ([ADR-0097](../../docs/adr/0097-gzip-snapshot-compression.md)).
The brief also tells the session to
work natively, never through WSL: a user-level `CLAUDE.md` loads into every
session, and one that routes Windows work through WSL would turn a Windows run
into a Linux one without saying so. The credentials go over as `credentials.ps1`
for the same reason.

## fixtures.mjs

The trees every build backs up, eight sets of them. Each build makes its
own, and two builds never match byte for byte (random content, natural mtimes),
which costs no proof anything: a clean-room snapshot's rows are checked against
`s3cab snapshot` of its own sandbox's trees, an upload is handed s3cab's
snapshot of its own, and a restore is checked against s3cab's restore of the
same golden set. They share the module so there is one list to
keep.

It is committed code rather than a chat because run 1's corpus is **gone** —
staged by hand, and its harness "was a session artifact and is not preserved"
([run 1](../../docs/format-spec-audit.md)). The value of a re-run is diffing its
ambiguity list against the last one, and that comparison needs the same fixtures
underneath. Every run that builds fixtures by hand throws them away again.

Which fixtures, and why each one, is the coverage matrix in the module's own
header: one line per audit finding F1–F16, naming the fixture that would catch a
regression — and naming the two findings a corpus *cannot* provoke (F4, F15)
rather than quietly dropping them so the table looks complete.

Run 2 added four more, each for a rule the corpus asserted but never made a run
*obey* — its report described its handling of all four as written and never
executed. `spread` is the only set with more than one member directory, without
which the two candidate restore layouts produce identical trees and the corpus
makes its own Tier 1 question unanswerable. (Two member dirs sharing a
*basename* are deliberately absent: s3cab refuses that under `--output`, so the
set would have no reference tree, and the refusal is already the answer.)
`faults/deleted.txt` is deleted and left deleted, so a file is absent *and*
recorded — F5's fixture re-backs its file up, which is the presence-wins trap
and leaves nothing for the skip path to skip. `corrupt` puts wrong bytes under a
right key, the case where the spec neither requires re-hashing a download nor
says what to do when it fails. And `faults` gets a second snapshot with its
`#END` trailer removed and the rest recompressed: truncating the compressed
bytes would test gunzip's own check instead, and the trailer's whole purpose is
catching a backup killed mid-write.

`spread` also carries the exclude grammar: each rule in
[guide/exclude.md](../../guide/exclude.md) gets a pattern, a path it drops and a
near miss it keeps, so a snapshot that implements less than the whole grammar
records a different tree. `edge`'s exclude file is the one a Windows editor
leaves, CRLF endings and no final newline, which the spec says travel into the
bucket byte for byte and are trimmed when read: a snapshot that keeps the CR or
drops the unterminated last line backs up a file it should exclude, and an upload
that rewrites the file no longer stores a byte copy.

Four fixture groups **cannot exist on Windows**: NTFS forbids control characters
in names, strips trailing spaces, and folds case. On macOS, APFS folds case and
Unicode normal form, so the case pair and the NFC/NFD pair are lost there; those
two are probed on the filesystem, not gated on the OS. A snapshot or upload
build skips them with a loud notice naming each one, because a partial corpus that reads as
a complete one is the same silent-shortening failure the exercise exists to
hunt; the seed refuses to run without them. Keep them in the corpus permanently
anyway — for a Windows restorer they *become* the point, where one that refuses
them is behaving correctly and one that silently strips the trailing space and
reports success is not. A symlink, by contrast, is attempted everywhere and
skipped only on the error: Windows has them, it just wants Developer Mode.

## build-snapshot-cleanroom.mjs

Builds a snapshot sandbox: the clean room, with each set's `dirs.txt` and
`exclude.txt` in its `sets\`, pointing at the trees in `fixtures\`. The session
writes each set's snapshots beside them, laid out as the spec's local side
describes. Nothing of s3cab's runs and nothing touches the network: there is no
bucket and no credentials, so the snapshot brief is the one that needs only
Python's standard library. The exclude patterns are the ones the seed gives
s3cab in place of `setup`'s starter file, so both snapshots skip the same files.
Run it on each platform in turn, as with a restorer: the session writes and tests
its program on the machine the sandbox is built on.

```sh
node scripts/cleanroom/build-snapshot-cleanroom.mjs <root>
```

## build-upload-cleanroom.mjs

Builds an upload sandbox: the clean room, with each set's `dirs.txt`,
`exclude.txt` and `snapshots\` in its `sets\`, the snapshots s3cab took of the
trees in `fixtures\`. It is the one backup room handed s3cab's output, and on
purpose: an upload has to start from a snapshot, and s3cab's is the one the
spec describes. It is input, not a target to converge on, the same as the
snapshots every restorer reads; what it costs is that an encoding question the
examples settle drops out of this room's report, which is the snapshot room's to
raise. s3cab snapshots offline once a set exists, so the build writes each set
straight into `.s3cab\` rather than running `setup`, which would publish the
`sets/` entry that is the session's to write. The session's upload is the first
thing in the bucket. Like the snapshot build, it runs on each platform in turn.

Then two sets are damaged, each the upload side of the golden set's damage
under the same name. `corrupt`'s `b-corrupt.txt` is rewritten after its
snapshot with its size and mtime kept, so only hashing the bytes uploaded
notices: stored as it is, it is exactly the wrong-bytes object the seed plants
by hand, made the way a real one gets made. And `faults` gets a second snapshot,
a minute older, with its `#END` trailer cut off. s3cab publishes neither set's
damaged snapshot. The spec says a trailerless snapshot is damaged goods, but
says nothing of a file that changed since its snapshot, so what the session does
with `corrupt` is a reading to report, not a rule to check.

```sh
node --env-file=.env.test scripts/cleanroom/build-upload-cleanroom.mjs <root>
```

## seed-restore-cleanroom-bucket.mjs

Seeds the restore bucket with the **golden set**: eight backup sets made by
s3cab from the fixtures, then deliberately damaged. It runs only when
`guide/format.md` changes, and only on Linux: Windows refuses the `[POSIX]`
names, and macOS's APFS silently folds names that differ only in case or
Unicode normalization. It builds the fixtures before touching the bucket and
stops if any group was skipped, since a golden set missing one would be partial
for every run after it.

It stamps the bucket with the hash of the `format.md` it was seeded from — as a
bucket tag, not a key, because a restorer works out the bucket's contents from a
listing and would report a key the spec doesn't describe. The stamp is removed
first and written last, so a seed that fails halfway leaves a bucket every
restore build refuses.

**It empties the bucket for you**, when the bucket is its own to empty. A seed
needs an empty repository — snapshots are immutable and a set name belongs to
whoever claimed it first — and there is never a reason to keep the previous
golden set, so the question worth asking is not "may I clear this?" but "is
this bucket mine to clear?": an `.env.test` pointing somewhere forgotten, a live
integration run. The set names answer it, since the integration suite names its
sets for the clock (`rt1755…`) and never one of ours. A bucket holding only our
own names is cleared and reported; anything else and the script stops and names
what it found. It is a check and not a lock — a suite that *starts* after the
check still loses its in-flight objects.

Two sets are deliberately broken, in four different ways, because s3cab's own
damage handling is the part a corpus most easily leaves untested. `faults` has
an object torn out of the store through the SDK with **no** deletion record (the
unexplained-damage case: report it, carry on, exit nonzero), one file deleted
*with* a record (the explained one, skipped with its date), and a snapshot
missing its trailer. `corrupt` has an object whose bytes don't hash to its key.
The damaged snapshot is backdated a minute so the intact one stays `faults`'s
latest; it exists only in S3.

```sh
node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs <root>
```

The bucket wants an expiry longer than the format is expected to hold still, or
the golden set sweeps out from under the runs it serves:
`node --env-file=.env.test scripts/setup-test-bucket.mjs --days 365 <bucket>`.

## build-restore-cleanroom.mjs

Builds a restore sandbox from the golden set: the clean room, with the
`reference\` trees a restorer's output is compared to. It refuses a bucket
stamped from another `format.md`, which is the cue to reseed. The same command
on every OS, and it has to run on the OS under test: s3cab's Windows restore
refuses the case-colliding pair, can't create the control-character names, and
sets mtimes exactly where Linux carries a sub-microsecond error — every one a
difference `compare.py` would charge a restorer for, against a reference built
elsewhere.

`reference\` holds what **s3cab itself restored**, not the fixtures. A correct
restore legitimately differs from its source — no empty directories, no
symlinks, no permissions, mtimes rounded to the millisecond
([guide/format.md](../../guide/format.md)) — so comparing against the sources
would fail a restorer for being right. The script drives the real CLI as a
subprocess to produce them, with `S3CAB_HOME` pointed at the sandbox's `.s3cab\`
so your own `~/.s3cab` is untouched while `~/.aws` keeps working. It reattaches
each set first, which is not read-only: `reattach` rewrites each set's `info`,
naming this machine its owner.

`faults` and `corrupt` restore with a nonzero exit, which the script reports as
expected rather than failing — and their reference trees are whatever s3cab
wrote before it gave up, since a partial tree is the honest reference for a
partial restore. The damaged snapshot is restored by name. Restores that exit
nonzero outside those two are printed with what s3cab said, since on Windows a
short reference tree is expected and has to be read before the clean room is
handed over.

```sh
node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs <root>
```

## compare.py

The differential verifier: walks two restored trees with **raw byte paths** and
compares the path set, per-file SHA-256, and `st_mtime_ns`. Preserved because
run 1's equivalent wasn't — that harness "was a session artifact and is not
preserved", which is half the reason its findings could never be re-tested.

Three details are the whole point. Byte paths, because a comparator that decodes
to `str` can normalise NFC/NFD apart or choke on the `\v`, `\f` and U+0085
fixtures. `st_mtime_ns`, because millisecond comparison would have hidden the
sub-millisecond defect that is run 2's finding 2. And directory mtimes reported
separately, since both tools create directories implicitly at restore time, so
those reflect the run rather than the format.

**To be rewritten in JavaScript as `compare-restore.mjs`**, alongside the
snapshot's row comparator, `compare-snapshot.mjs`, when the CI matrix is built:
one comparator per kind of output. An upload needs none of its own, because its
output is a bucket, and the check of a bucket is restoring it. It is Python only because run 2's session wrote it that
way: Node reads byte paths too (`readdir` with `encoding: "buffer"`), and
nanosecond mtimes (`lstat` with `bigint: true`).

```sh
python3 scripts/cleanroom/compare.py <my-restore-dir> <reference-dir>
```

## restorers/

One program per run, each written from the spec alone, each **deliberately not
maintained** in step with s3cab. If one drifts from a future format, that drift
is a breaking format change to notice — not a bug to patch here.

**All three predate gzip snapshots**
([ADR-0097](../../docs/adr/0097-gzip-snapshot-compression.md)). They read the
earlier `.tsv.zst` files, so none of them restores a corpus staged today. That is
exactly such a drift, recorded rather than patched.

### pyrestore.py — run 1

Python, from [guide/format.md](../../guide/format.md) alone; the experiment
behind [run 1](../../docs/format-spec-audit.md). Its inline `GUESS(n)` comments
are the raw form of that run's findings. An independent reading of the spec as
written on 2026-08-12. Needs Python ≥ 3.14 (stdlib zstd) and boto3.

```sh
python scripts/cleanroom/restorers/pyrestore.py --bucket <bucket> list-sets
python scripts/cleanroom/restorers/pyrestore.py --bucket <bucket> restore <set> <snapshot> --output <dir>
```

### cpprestore.cpp — run 2

C++23, behind [run 2](../../docs/format-spec-audit-2.md). Where `pyrestore.py`
answered whether the format is readable without s3cab, this one answers what
reading it *costs*: libcurl for HTTPS, OpenSSL for SHA-256/HMAC, libzstd for
decompression, and **no AWS SDK, no S3 client library, and no shelling out** —
SigV4 signed by hand, in about 80 lines, working on the first attempt against
the real endpoint. That reduces the vendor's whole SDK, for a reader, to an HTTP
client, two hash primitives, one decompressor and a page of signing arithmetic.
An independent reading of the spec as written on 2026-08-20.

```sh
g++ -std=c++23 -O2 -Wall -Wextra -o s3cab-restore \
  scripts/cleanroom/restorers/cpprestore.cpp -lcurl -lcrypto -lzstd
./s3cab-restore --bucket <bucket> --region <region> list
./s3cab-restore --bucket <bucket> --region <region> restore <set> <snapshot> <outdir>
```

Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` — it has no SDK to read `~/.aws` with, which is why
the clean room gets static keys. Exit 2 means integrity faults, which
it enumerates after restoring everything restorable.

### gorestore/ — run 3

Go 1.22, behind [run 3](../../docs/format-spec-audit-3.md): the same no-SDK
rules as run 2, read against the spec as revised after it — the first run to
exercise run 2's four added fixtures live, and the first measured against a
corpus with every POSIX fixture present (staging ran on Linux). Stdlib plus
Ubuntu's packaged pure-Go zstd (`golang-github-klauspost-compress-dev`); SigV4
hand-rolled over `net/http`, first signed request succeeded. A directory rather
than a file only because Go insists on a module; it is still one frozen program,
`compare.py` beside it being the run's own comparator, written blind to ours.
An independent reading of the spec as written on 2026-08-22.

```sh
cd scripts/cleanroom/restorers/gorestore
GOFLAGS=-mod=mod GOPROXY=off go build -o s3cab-restore . && go test ./...
./s3cab-restore -bucket <bucket> list
./s3cab-restore -bucket <bucket> restore-all -out <dir>
```
