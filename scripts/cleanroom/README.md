# The clean-room exercise

> **Partly built** ([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)):
> the harness that builds each clean room is here, and everything below describes it. Still to
> come: the clean-room programs for the current spec; the CI matrix that builds and runs them;
> and `compare-restore.mjs` in place of `compare.py`.

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
own frameworks or system libraries, and nothing of s3cab's. Run 2 (C++) predates
that rule. The restorers are one half of
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
`restore-bucket.mjs`), and the checkers, `compare-snapshot.mjs`, `check-upload.mjs`,
`compare.py` and `audit-transcript.mjs`.
A clean room's program is frozen — never updated, because its value is being a
fixed reading of the spec on a given date — and kept only while it reads the
current format. Then it goes, and its report links the last commit that held it.

Two buckets, one per role
([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)):
`S3CAB_TEST_BUCKET_CLEANROOM_RESTORE` holds the **golden set** every restorer
reads, and `S3CAB_TEST_BUCKET_CLEANROOM_BACKUP` is emptied for each clean-room
upload's turn. A snapshot clean room has no bucket at all: a snapshot is a local file.

The golden set is seeded **once per format or fixture change**, on Linux or WSL,
apart from the runs, which only read it: only a Linux filesystem holds every
fixture, so seeding is the one step a Windows or macOS run couldn't do
([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)). The
root must be on that filesystem — `~`, not `/mnt/c`:

```sh
node --env-file=.env.test scripts/setup-test-bucket.mjs --days 365 <restore-bucket>
node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs ~/s3cab.sandbox
rm -r ~/s3cab.sandbox
```

Every run then happens in a **sandbox**: one directory outside the repo, built
from empty and deleted once the run is harvested — create, run, harvest,
destroy, then the next.

```text
~/s3cab.sandbox/
  cleanroom/   the session opens here: spec, brief, credentials (not for
               a snapshot), and sets/ (snapshot, upload) or reference/ (restore)
  fixtures/    the trees it backs up (snapshot, upload)
  .s3cab/      s3cab's home while the build runs it (upload, restore)
```

A restorer run, end to end — the same commands on every OS (`$HOME` expands in
PowerShell and sh alike):

```powershell
# create
node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs $HOME/s3cab.sandbox
# run: headless, from the clean room; follow its transcript (audit-transcript.mjs
# says where it lands) with Get-Content -Wait -Tail 5
cd $HOME/s3cab.sandbox/cleanroom
claude -p --safe-mode --append-system-prompt-file CLAUDE.md --session-id <a new uuid> --model claude-opus-5-5 --effort xhigh --permission-mode auto --max-budget-usd 15 go
cd -
# check: its restore compared, and its transcript audited
python3 scripts/cleanroom/compare.py <its-restore-dir> $HOME/s3cab.sandbox/cleanroom/reference/<snapshot> | tee $HOME/s3cab.sandbox/cleanroom/check.txt
node scripts/cleanroom/audit-transcript.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/audit.txt
# keep: the clean room, minus its credentials, into the experiments folder
Remove-Item $HOME/s3cab.sandbox/cleanroom/credentials.*
New-Item -ItemType Directory -Force $HOME/s3cab.experiments
Move-Item $HOME/s3cab.sandbox/cleanroom $HOME/s3cab.experiments/2026-10-12-restore-windows-opus55-xhigh
# harvest, if it was a real set's run: its program and report into the repo
# destroy
Remove-Item -Recurse $HOME/s3cab.sandbox
```

The two halves of the backup are the same sequence with their own scripts, and
like a restorer, each is built and run on every OS. A snapshot run needs no
bucket, and so no test environment:

```powershell
node scripts/cleanroom/build-snapshot-cleanroom.mjs $HOME/s3cab.sandbox
# run, then check: its snapshots compared, and its transcript audited
node scripts/cleanroom/compare-snapshot.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/check.txt
node scripts/cleanroom/audit-transcript.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/audit.txt
```

An upload run's turn starts from an empty bucket, which the build leaves for you
to empty:

```powershell
aws s3 rm s3://<backup-bucket>/ --recursive
node --env-file=.env.test scripts/cleanroom/build-upload-cleanroom.mjs $HOME/s3cab.sandbox
# run, then check: the bucket it left, and its transcript audited
node --env-file=.env.test scripts/cleanroom/check-upload.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/check.txt
node scripts/cleanroom/audit-transcript.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/audit.txt
```

The checkers run before the sandbox is destroyed, on the machine that built it:
they read its trees, and the upload checker reads what the clean room was handed.

**Every run is kept**, real or experiment, in `~/s3cab.experiments/`, one folder
per run named for its date, role, platform, model and effort. What moves there is
the clean room, minus its credentials, with the checker's and the audit's output
beside the report: the audit's is the run's token cost by model, kept for
comparing runs later. The fixtures stay behind, since every build makes them
afresh. The folder is cleared by hand. It sits in the home folder, so a later
session that reads an earlier run's report is a stray the audit lists.

Every run is built, run and checked the same way, and the audit reports its
token cost by model. What differs is whether it is recorded, and that is decided
at the end.

**Experiment first, on any model at any effort**, until the process runs
smoothly: to catch harness faults and glaring spec errors cheaply, or to see
which model writes the nicest program. Nothing is recorded. Findings are fixed
in the harness or the spec, and a report worth comparing is kept outside the
repo with its token cost. A quiet experiment proves nothing about the spec.

**Then a real set: every role on every platform you have, start to finish, on
one model at `xhigh`**, the best model you have when the set starts. A run in a
real set is recorded if its transcript audit came back clean. Its report
continues the `docs/format-spec-audit-<n>.md` numbering, its title naming the
role and the platform, the model and the effort; a backup program goes in
`backup/<platform>/` here (`linux`, `windows`, `macos`), and a restorer in
`restorers/`. The spec is frozen for the length of the set: each
run's findings are collected, and fixed only after the last run, so every run in
the set reads the same spec.

One model across the set is the point: a weaker reader lists fewer ambiguities,
which would read as a spec that improved. The effort is `xhigh` because too
shallow a reading fails silently: an ambiguity the session never noticed looks
like a spec without one, and no checker catches it. A better model, when you
have one, means the whole real set again, even on an unchanged spec; its lists
diffed against the last set's show how much depends on the reader. Across sets
the reader may differ, so a list that shrinks across a change of model is not
evidence the spec got better. Every reader is still Claude, as was s3cab's
author, so a gap they all fill the same way can still pass the byte-for-byte
comparison.

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
anything, and that file discusses the snapshot's UTC start instant, the
`@SET DIR` rows, the drive-letter normalisation and the TSV encoding. Those are
restore-correctness facts the exercise exists to make someone derive, and the
contamination is invisible in the result — the ambiguity list simply comes back
shorter, which reads as a spec that has been fixed. Keep previous runs' reports
out of the sandbox too: diffing the lists afterwards is the reader's job. They
also refuse a sandbox that isn't empty, so nothing from the last run can
ride along beside the new brief.

Beyond that, the sandbox relies on the session doing as the brief says, and checks
that it did. Nothing stops a session in `~/s3cab.sandbox` reading `~/.s3cab` (real
snapshots) or `~/.claude` (the transcripts and memory of every session that worked
on s3cab); `audit-transcript.mjs` lists every path it touched there, in temp or in
the repo, and every time it ran s3cab or went to the web. Any of those voids the
run. If runs keep straying, move the sandbox somewhere more isolated; until then,
the repo is the one place ruled out outright, because what it leaks arrives before
the session's first tool call, where no audit sees it.

The run is headless (`claude -p`), started from the clean room so its transcript
lands where the audit looks, and nobody sits in it. `--safe-mode` leaves out every
`CLAUDE.md`, skill, plugin, hook and MCP server — the user's own included, which
would otherwise steer the run: one that routes Windows work through WSL turns a
Windows run into a Linux one without saying so. Safe mode drops the clean room's
own `CLAUDE.md` too, so the brief comes in through `--append-system-prompt-file`.
That puts it in the system prompt, so the run starts from a bare "go" and the brief
survives a run long enough to write a program, where an opening-turn instruction
would be compacted away. `--permission-mode auto` keeps the classifier reviewing
each call; with nobody to ask, a blocked call is refused and the run carries on.
`--session-id` fixes the transcript's name before the run starts, so it can be
followed from the first line. `--max-budget-usd` caps the spend.

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
work natively, never through WSL, and the credentials go over as `credentials.ps1`,
so that a Windows run stays one.

## fixtures.mjs

The trees the restore seed and the snapshot and upload builds back up, eight
sets of them. Each makes its own, and no two match byte for byte (random
content, natural mtimes),
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
says what to do when it fails. And `faults` gets a second snapshot cut off after
its last file row, as a backup killed mid-write leaves it, and recompressed:
truncating the compressed bytes would test gunzip's own check instead, and
catching that cut is the closing `.`'s whole purpose.

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
trees in `fixtures\`. It is the one backup clean room handed s3cab's output, and on
purpose: an upload has to start from a snapshot, and s3cab's is the one the
spec describes. It is input, not a target to converge on, the same as the
snapshots every restorer reads; what it costs is that an encoding question the
examples settle drops out of this report, which is the snapshot clean room's to
raise. s3cab snapshots offline once a set exists, so the build writes each set
straight into `.s3cab\` rather than running `setup`, which would claim it in the
bucket with the `snapshots/<set>.info` that is the session's to write. The
session's upload is the first thing in the bucket. Like the snapshot build, it
runs on each platform in turn.

Then two sets are damaged, each the upload side of the golden set's damage
under the same name. `corrupt`'s `b-corrupt.txt` is rewritten after its
snapshot with its size and mtime kept, so only hashing the bytes uploaded
notices: stored as it is, it is exactly the wrong-bytes object the seed plants
by hand, made the way a real one gets made. And `faults` gets a second snapshot,
a minute older, cut off after its last file row. s3cab publishes neither set's
damaged snapshot. The spec says a snapshot without its closing `.` is damaged goods, but
says nothing of a file that changed since its snapshot, so what the session does
with `corrupt` is a reading to report, not a rule to check.

```sh
node --env-file=.env.test scripts/cleanroom/build-upload-cleanroom.mjs <root>
```

## compare-snapshot.mjs

Checks a snapshot clean room's work: each set's latest snapshot in
`cleanroom\sets\<set>\snapshots\` against `s3cab snapshot` of the same trees,
taken there and then in a throwaway home, so s3cab's output never exists while
the session could read it. It compares what ADR-0096 lists: file rows exact by
path, the `@SET DIR` rows, the `#excluded` and `#error` paths, and
nothing of the names and instants that differ by run. It holds the session's file
to the format's rules: five fields a line, LF endings, UTF-8 with no BOM, the
heading row first, the `.` last, and `FILES` and `SIZE` agreeing with the
file rows where it writes them. The padding and `SIZE`'s readable form are the
format's recommendations, so a file that departs from them gets a note, not a
mismatch.

Two more differences come back as notes, because the spec hasn't decided them: the time zone in `@SNAPSHOT START`, which Python's standard library
can't name, and an excluded directory written as one row where the other side
wrote a row for each file in it. Paths print JSON-quoted, so a stray CR or one of
the fixtures' control characters shows instead of printing as nothing.

```sh
node scripts/cleanroom/compare-snapshot.mjs <root>
```

## check-upload.mjs

Checks the bucket an upload clean room left. Restoring it can't stand in: no
restore reads a set's `.info`, and a restore can't say whether the session
refused the two snapshots it should have. So, in order:

- every key is in the layout the spec documents, with no deletion record and
  nothing in s3cab's `.s3cab/` folder; what the session put in a folder of its
  own is a note;
- every object hashes to its key, which means downloading every one;
- every published snapshot is byte-identical to the one handed over, none is
  missing, and neither `corrupt`'s nor `faults`'s without its closing `.` is published;
- every object a published snapshot names is stored;
- no object or snapshot carries a `Content-Encoding` or `x-amz-meta-*`;
- every set with a published snapshot has a `snapshots/<set>.info` of `OWNER`,
  `CLAIMED` and `CREATED` lines, each once and ending LF;
- s3cab reattaches every set with a published snapshot and restores each one.

`corrupt` has nothing to publish, so whether the session claimed it anyway is a
note, as is an `OWNER` other than this `user@machine`: what "user" and "machine"
mean is itself a reading.

```sh
node --env-file=.env.test scripts/cleanroom/check-upload.mjs <root>
```

## seed-restore-cleanroom-bucket.mjs

Seeds the restore bucket with the **golden set**: eight backup sets made by
s3cab from the fixtures, then deliberately damaged. It runs only when the stamp
below no longer matches, and only on Linux: Windows refuses the `[POSIX]`
names, and macOS's APFS silently folds names that differ only in case or
Unicode normalization. It builds the fixtures before touching the bucket and
stops if any group was skipped, since a golden set missing one would be partial
for every run after it.

It stamps the bucket with a hash of what made it: `format.md`, `fixtures.mjs`
and the seed script itself. Hashing the spec alone let a build accept a golden
set from older fixtures, and a run measured against a corpus missing what was
added since passes without saying so. The stamp is a bucket tag, not a key,
because a restorer works out the bucket's contents from a listing and would
report a key the spec doesn't describe. The stamp is removed
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
missing its closing `.`. `corrupt` has an object whose bytes don't hash to its key.
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
stamped from another spec or other fixtures, which is the cue to reseed. The same command
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
each set first, which only reads the bucket.

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

**To be rewritten in JavaScript as `compare-restore.mjs`** when the CI matrix is
built, beside the two backup checkers above. It is Python only because run 2's
session wrote it that way: Node reads byte paths too (`readdir` with `encoding: "buffer"`), and
nanosecond mtimes (`lstat` with `bigint: true`).

```sh
python3 scripts/cleanroom/compare.py <my-restore-dir> <reference-dir>
```

