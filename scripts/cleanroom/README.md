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
three-way proof: a clean-room backup is the other. That is one Python program,
walk to bucket, written from the spec by a session that has seen nothing else.
Like the restorers, it is written on every platform: a session can only test
where it runs, and each platform changes what a backup has to get right —
Windows path casing and drive letters, a time zone Python can't name there, text
mode writing CRLF. It stays Python everywhere, and each one has to run unchanged
on all three. Nothing here is distributed; it lives in the repo as evidence.

**Two kinds of file live here, with opposite lifecycles.** The harness is ours,
maintained, and improved every run as findings come in: the seed script, the two
build scripts, the modules they share (`cleanroom.mjs`, `fixtures.mjs`,
`restore-bucket.mjs`), and the checkers, `check-backup.mjs` with
`compare-snapshot.mjs`, `check-restore.mjs` with `compare.py`, and
`audit-transcript.mjs`.
A clean room's program is frozen — never updated, because its value is being a
fixed reading of the spec on a given date — and kept only while it reads the
current format. Then it goes, and its report links the last commit that held it.

Two buckets, one per role
([ADR-0096](../../docs/adr/0096-three-implementations-prove-the-format.md)):
`S3CAB_TEST_BUCKET_CLEANROOM_RESTORE` holds the **golden set** every restorer
reads, and `S3CAB_TEST_BUCKET_CLEANROOM_BACKUP` is emptied for each clean-room
backup's turn.

The golden set is seeded **once per format or fixture change**, by GitHub
Actions on Linux, Windows and macOS, apart from the runs, which only read it
([.github/workflows/cleanroom-seed.yml](../../.github/workflows/cleanroom-seed.yml)).
Every run, at home or in CI, reads that one bucket, `test-s3cab-ci-cleanroom-restore`;
a home identity can only read it. A change on `main` to what the stamp covers
reseeds it, and so does dispatching the workflow from `main`:

```sh
gh workflow run cleanroom-seed.yml --ref main
```

Every run then happens in a **sandbox**: one directory outside the repo, built
from empty and deleted once the run is harvested — create, run, harvest,
destroy, then the next.

```text
~/s3cab.sandbox/
  cleanroom/   the session opens here: spec, brief, credentials, and
               reference/ (restore)
  fixtures/    the trees it backs up (backup)
  .s3cab/      s3cab's home while the build runs it (restore)
  session-settings.json   the run's walls, passed with --settings
```

A restorer run, end to end, as on Windows. Elsewhere the commands are the same
(`$HOME` expands in PowerShell and sh alike), except the run's, which names `Bash`
in place of `PowerShell`; the build prints the exact one for its role and platform:

```powershell
# create
node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs $HOME/s3cab.sandbox
# run: headless, from the clean room; follow its transcript (audit-transcript.mjs
# says where it lands) with Get-Content -Wait -Tail 5
cd $HOME/s3cab.sandbox/cleanroom
claude -p --restricted --tools PowerShell,Read,Write,Edit,Glob,Grep,TaskStop --settings ../session-settings.json --safe-mode --append-system-prompt-file CLAUDE.md --session-id <a new uuid> --model claude-opus-5-5 --effort xhigh --permission-mode auto --max-budget-usd 30 go
cd -
# check: its restorer run on every snapshot and compared, and its transcript audited
node --env-file=.env.test scripts/cleanroom/check-restore.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/check.txt
node scripts/cleanroom/audit-transcript.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/audit.txt
# keep: the clean room, minus its credentials, into the experiments folder
Remove-Item $HOME/s3cab.sandbox/cleanroom/credentials.*
New-Item -ItemType Directory -Force $HOME/s3cab.experiments
Move-Item $HOME/s3cab.sandbox/cleanroom $HOME/s3cab.experiments/2026-10-12-restore-windows-opus55-xhigh
# harvest, if it was a real set's run: its program and report into the repo
# destroy
Remove-Item -Recurse $HOME/s3cab.sandbox
```

A backup run is the same sequence with its own scripts, and like a restorer, it
is built and run on every OS. Its run adds `--add-dir ../fixtures`. Its turn starts
from an empty bucket, which the build leaves for you to empty:

```powershell
aws s3 rm s3://<backup-bucket>/ --recursive
node --env-file=.env.test scripts/cleanroom/build-backup-cleanroom.mjs $HOME/s3cab.sandbox
# run, then check: the bucket it left, and its transcript audited
node --env-file=.env.test scripts/cleanroom/check-backup.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/check.txt
node scripts/cleanroom/audit-transcript.mjs $HOME/s3cab.sandbox | tee $HOME/s3cab.sandbox/cleanroom/audit.txt
```

The checker runs before the sandbox is destroyed, on the machine that built it:
it reads the trees the clean room was handed, and takes s3cab's own snapshot of
them there and then.

**macOS runs in GitHub Actions**, a backup only for now
([.github/workflows/cleanroom.yml](../../.github/workflows/cleanroom.yml)): one job
builds, runs, checks and audits, then uploads the clean room with its transcript.
The session signs in with the `CLAUDE_CODE_OAUTH_TOKEN` secret, from
`claude setup-token`; mint one per batch of runs and revoke it after. The artifact
is public, so download it as soon as the run ends, then delete it:

```sh
gh workflow run cleanroom.yml --ref main -f role=backup -f effort=low
gh run download <run-id> --dir ~/s3cab.experiments/<date>-backup-macos-<model>-<effort>
gh api -X DELETE repos/allens/s3cab/actions/artifacts/<artifact-id>
```

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
[guide/format.md](../../guide/format.md), a brief naming the language, the
bucket's credentials, and nothing else. The language is Python for the backup
and the platform's canonical one (above) for a restorer, so runs differ by
reader and by spec version. It also holds `cli`, the subprocess that drives the
real s3cab for the scripts that need its output. The restorer brief is
language-neutral apart from one sentence — which names no version, leaving the
session to find "the most modern version that comes as standard" on the machine
it's on. Windows is the exception, below.

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

Beyond that, the run is walled in by `session-settings.json`, and the audit checks
what the walls don't hold. `--restricted` confines the file tools to the clean room
(and, for a backup, the fixtures) on every platform, and keeps the user's own
settings out, whose `additionalDirectories` would otherwise make a folder in home a
working directory of every session. On Linux, WSL and macOS, Claude Code's shell
sandbox holds every command and every program the session writes and runs: it reads
nothing in the home folder outside those directories, and reaches no host but
`*.amazonaws.com`, through a proxy `ENVIRONMENT.md` tells the session about, since
a program that ignores the proxy variables can't connect at all. Linux and WSL need `bubblewrap` and `socat` installed for it, and
without them the run refuses to start rather than run unwalled. Windows has no shell
sandbox, so there a session's shell can still read `~/.s3cab` (real snapshots) or
`~/.claude` (the transcripts and memory of every session that worked on s3cab), and
reach the web.

`audit-transcript.mjs` lists every path a session touched in home, in temp or in the
repo, and every time it ran s3cab or went to the web from a tool or a shell command.
Any of those voids the run. A program the session wrote and then ran is
not audited: its own requests go unseen, which on Windows nothing else catches. The
repo is ruled out outright, because what it leaks arrives before the session's first
tool call, where neither the walls nor the audit see it.

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
followed from the first line. `--max-budget-usd` caps the spend. `--restricted` drops
every tool `--tools` doesn't name, the web tools among them, so the list holds what
past runs used, with the platform's one shell: `PowerShell` on Windows, where `Bash`
would be Git Bash.

`ENVIRONMENT.md` names **one** bucket. Copying `.env.test` across would be
handier and is the wrong shape: it also names the crash and conformance buckets,
whose suites assert whole-bucket state and which hold deliberately torn
repositories — snapshots published over swept objects, written on purpose by
`test/crash`. That is the exact signature this exercise hunts, so a session that
wandered into one would report a real observation as a spec defect. The bucket
comes only from the role's `S3CAB_TEST_BUCKET_CLEANROOM_*` variable, which
`--env-file=.env.test` supplies with the `AWS_*` settings without the file itself
travelling. For a backup it also lists each set with its member directories, and
nothing of what makes any set hard: which ones a backup has to refuse is the
spec's to say.

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

Built on Windows, the clean room gets a Windows brief. There is no package
archive, so the toolchain sentence becomes "the .NET Framework that ships with
Windows, standard library only", even where something newer is installed; its
`GZipStream` decompresses gzip
([ADR-0097](../../docs/adr/0097-gzip-snapshot-compression.md)). `ENVIRONMENT.md` names its `csc.exe`, found at
build time: a session left to find one searches, and a look in the home folder
voids the run. The brief also tells the session to
work natively, never through WSL, and the credentials go over as `credentials.ps1`,
so that a Windows run stays one.

## fixtures.mjs

The trees the restore seed and the backup build back up: one table, each entry
declaring its set, its name (as code points, or as bytes where it has no UTF-8
form), its kind, its attributes and which platform holds it. The build creates
every entry and then **reads every one back** — the raw name from `readdir`, the
kind from `lstat`, hidden and system from `attrib`, a link's target from
`readlink` — because the creating tool isn't trusted: Node writes a lone
surrogate given as a string as U+FFFD and reports success, symlinks need
Developer Mode or elevation, and NTFS, APFS and ext4 each hold a different
subset of the names. Nothing is checked through `s3cab snapshot`, since an s3cab
bug and a broken fixture would agree. Content is deterministic and carries the
platform's name, so two builds on one platform share every hash and their rows
diff directly, and the three platforms' backups share no object but the empty
file's; mtimes stay the filesystem's own, except where the value is the test
(F6). Every set's member
directories, and whether a backup must publish or refuse it, derive from the
same table (`setDirs`), so the build, the brief and the checker agree without a
file on disk between them.

It is committed code rather than a chat because run 1's corpus is **gone** —
staged by hand, and its harness "was a session artifact and is not preserved"
([run 1](../../docs/format-spec-audit.md)). The value of a re-run is diffing its
ambiguity list against the last one, and that comparison needs the same fixtures
underneath. Every run that builds fixtures by hand throws them away again.

Which fixtures, and why each one, is each entry's `why`, naming the audit
finding it covers; the three findings a corpus *cannot* provoke (F4, F12, F15)
are named in the module's header rather than quietly dropped so the table looks
complete.

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

`edge` also carries what the audits of the backup side found silent: an
unreadable file among twenty readable siblings, so a backup that drops its
`#error` row shifts every later hash by one; links into the backup, dangling,
and out of it to a file and to a directory (and on Windows a junction out of it,
the one link every machine there can make, which Python's `os.walk` descends
into); a hard-link pair; a FIFO; mtimes before 1970 and after 2262, off Windows
until the `statSync` wrap in [proposals/bugs.md](../../proposals/bugs.md)
is fixed, and the later one Linux's alone; the names Windows reserves (`CON`, `aux.txt`, `nul.txt`), which exist
on every platform and are hostile to a plain-path open on Windows; the names
Windows forbids (`: * ? " < > |`, a backslash) on POSIX only; and Windows' own
trailing dot, hidden and system files, and a case pair in a folder `fsutil` makes
case-sensitive. Two sets a backup must **refuse** rather than publish: `scans`,
one name with no UTF-8 form (a lone surrogate on Windows, a stray byte
elsewhere), and `ledger`, a tab in a name, POSIX only. s3cab refuses both with
exit 1 and no snapshot. They are named like ordinary data on purpose: the
backup room is told each set's name and nothing else, and a label saying what
is wrong with a set would hand it the refusal the spec is meant to make it find.

The exclude patterns are the seed's, where s3cab snapshots the trees. The backup
clean room gets none: excluding is the tool's own, not the format's
([ADR-0107](../../docs/adr/0107-the-spec-is-the-public-repository-format.md)),
so there `spread`'s near misses and `edge`'s `ignored.*` are ordinary files, and
the lone surrogate is the `scans` set rather than an `#excluded` row. `spread`'s
give each rule in [guide/exclude.md](../../guide/exclude.md) a path it drops
and a near miss it keeps; `edge`'s is the file a Windows editor leaves, CRLF
endings and no final newline, which the spec says travel into the bucket byte
for byte and are trimmed when read. Its middle line keeps a second copy of the
no-UTF-8 name out of s3cab's `edge`, so the restore fixtures carry the
`#excluded` row the spec describes, U+FFFD and all. `edge` now exits 1 under
s3cab by design, for its `#error` rows, so every script that runs s3cab on it
accepts that exit only with a snapshot written (`mustWrite` in
`cleanroom.mjs`): exit 1 is also what any other failure gives.

What a platform can't hold is declared per entry, not guessed from the OS — for
macOS, as its runners' APFS holds it: the case and NFC/NFD pairs fold, names must
be UTF-8, and no mtime past 2262 — and what it refuses anyway is found by the
read-back: a symlink Windows won't make without Developer Mode, a case-sensitive
folder `fsutil` won't make, an unreadable file that root reads.
Whatever fails is removed with everything sharing its `why` and named in a loud
notice, because a partial corpus that reads as a complete one is the same
silent-shortening failure the exercise exists to hunt; a set with nothing left is
removed too, so a refused set never becomes an empty one that publishes. The
seed refuses to run after any such notice. Keep them in the corpus permanently
anyway — for a Windows restorer the POSIX names *become* the point, where one
that refuses them is behaving correctly and one that silently strips the
trailing space and reports success is not.

## build-backup-cleanroom.mjs

Builds a backup sandbox: the clean room, whose `ENVIRONMENT.md` names each set's
member directories in `fixtures\`, and the trees. Nothing of s3cab's reaches the
room: no set files, no exclude patterns, no snapshot of the trees. s3cab's own
snapshot of them is taken afterwards, by the checker. The session is handed
every set this platform could build, the ones a backup must refuse included,
and told nothing of what makes any of them hard. The bucket starts its turn
empty, so the session's claim is the first thing in it. Run it on each platform
in turn, as with a restorer: the session writes and tests its program on the
machine the sandbox is built on.

The brief fixes the program's command line, `s3cab-backup.py <bucket> <set>
<dir>...`, so a harness can run it, and has the session finish on an emptied
bucket and one run per set with exactly that command line, so a set the program
refuses can't reach the bucket some other way. Nothing else about the program's
shape is fixed: what it does with a set it can't back up is the spec's to say
and the report's to discuss. `faults` and `corrupt` are ordinary trees here;
their names describe damage only the restore fixtures have.

```sh
node --env-file=.env.test scripts/cleanroom/build-backup-cleanroom.mjs <root>
```

## check-backup.mjs

Checks the bucket a backup clean room left. Restoring it can't stand in: no
restore reads a set's `.info`, a restore can't say whether the session refused
the sets it should have, and a snapshot that restores can still have recorded
the trees differently from s3cab. So, in order:

- every key is in the layout the spec documents, with no deletion record and
  nothing in s3cab's `.s3cab/` folder; what the session put in a folder of its
  own is a note;
- every object hashes to its key, which means downloading every one;
- every set the room was handed is as the fixture table expects it: a set s3cab
  backs up has a snapshot published, and its latest is compared with s3cab's
  (below); a set a backup must refuse has none;
- every published snapshot, the earlier ones of a set too, keeps the format's
  rules, and every object it names is stored;
- no object or snapshot carries a `Content-Encoding` or `x-amz-meta-*`;
- every set with a published snapshot has a `snapshots/<set>.info` of `OWNER`,
  `CLAIMED` and `CREATED` lines, each once and ending LF, the two instants in
  `mtime`'s form and equal, since every claim in an empty bucket is a new one,
  and no `.info` claims a set the session wasn't handed;
- s3cab reattaches every set with a published snapshot or a `.info`, and
  restores each published snapshot.

Some things are readings rather than rules, so they are notes:

- a refused set has nothing to publish, so whether the session claimed it
  before its walk stopped;
- a key of the session's own in a `.info`, which the reading rule skips;
- a header on a `.info`, which the checklist doesn't name;
- an `OWNER` other than this `user@machine`, since what "user" and "machine"
  mean is itself a reading.

```sh
node --env-file=.env.test scripts/cleanroom/check-backup.mjs <root>
```

## compare-snapshot.mjs

The checker's row comparison: a published snapshot, downloaded, against
`s3cab snapshot` of the same trees, taken there and then in a throwaway home
whose set names the backup bucket, so `@SET BUCKET` compares like with like.
It compares what ADR-0096 lists: file rows exact by path, the `@SET DIR` rows,
the `#excluded` and `#error` paths, and nothing of the names and instants that
differ by run. It holds the session's file to the format's rules: five fields a
line, LF endings, UTF-8 with no BOM, the heading row first, the `.` last, and
`FILES` and `SIZE` agreeing with the file rows where it writes them. The
padding and `SIZE`'s readable form are the format's recommendations, so a file
that departs from them gets a note, not a mismatch.

Two more differences come back as notes, because the spec leaves them to the
writer: `@SET BUCKET` left out, which the spec makes optional, so it is compared
only when written; and the time zone in `@SNAPSHOT START`, which Python's
standard library can't name. Paths print JSON-quoted, so a stray CR or one of
the fixtures' control characters shows instead of printing as nothing.

## seed-restore-cleanroom-bucket.mjs

Seeds the restore bucket with the **golden set**: the backup sets made by s3cab
from the fixtures (every set but the two a backup must refuse), then
deliberately damaged, once by each platform. Only the workflow runs it, in
three steps:

- `--empty`, only when the stamp below no longer matches: unstamps the bucket and
  empties it;
- `<root>`, each platform's turn: its sets, each suffixed with its name
  (`edge-linux`, `edge-windows`, `edge-macos`);
- `--stamp`, once every platform's sets are there.

The platforms take turns because two deletes finishing in the same minute
collide on the deletion record. Every file's content carries its platform's
name: an object's key is its hash, so without it two platforms' backups of the
same file would share an object, and `faults`' torn object or `corrupt`'s wrong
bytes would reach the other platforms' sets, or be undone by the next upload. A
turn backs up what `fixtures.mjs` declares for its platform, builds it before
touching the bucket, and stops if any group was skipped, since a golden set
missing one would be partial for every run after it.

The stamp is a hash of what made the golden set: the spec's date (`This is the
spec of …` at the top of `format.md`), `fixtures.mjs` and the seed script. The
date and not the file, because it changes when the format does and never for a
change of wording. Hashing the spec alone let a build accept a golden set from
older fixtures, and a run measured against a corpus missing what was added since
passes without saying so. The stamp is a bucket tag, not a key, because a
restorer works out the bucket's contents from a listing and would report a key
the spec doesn't describe. It is removed first and written last, so a seed that
fails halfway leaves a bucket every restore build refuses.

**It empties the bucket for you**, when the bucket is its own to empty. A seed
needs an empty repository — snapshots are immutable and a set name belongs to
whoever claimed it first — and there is never a reason to keep the previous
golden set, so the question worth asking is not "may I clear this?" but "is
this bucket mine to clear?": a variable pointing somewhere forgotten, a live
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

## build-restore-cleanroom.mjs

Builds a restore sandbox from the golden set: the clean room, with the
`reference\` trees a restorer's output is compared to, one per snapshot of every
platform's sets. It refuses a bucket stamped from another spec or other
fixtures, or missing any platform's sets, which is the cue to reseed. It
follows the bucket to its own region and names that one in `ENVIRONMENT.md`,
whatever `AWS_REGION` says: the restore bucket is CI's, in `us-east-1`. The same command
on every OS, and it has to run on the OS under test: s3cab's Windows restore
refuses the case-colliding pair and can't create the control-character names —
each a difference `compare.py` would charge a restorer for, against a reference
built elsewhere.

`reference\` holds what **s3cab itself restored**, not the fixtures. A correct
restore legitimately differs from its source — no empty directories, no
symlinks, no permissions, mtimes rounded to the millisecond
([guide/format.md](../../guide/format.md)) — so comparing against the sources
would fail a restorer for being right. The script drives the real CLI as a
subprocess to produce them, with `S3CAB_HOME` pointed at the sandbox's `.s3cab\`
so your own `~/.s3cab` is untouched while `~/.aws` keeps working. It reattaches
each set first.

The brief fixes the restorer's command line, `s3cab-restore <bucket> <set> <dir>
[<snapshot>]` (`.exe` on Windows), and the layout under `<dir>` as s3cab's own, so the
checker can run it. Each restore's exit goes to `reference-exits.json`, beside the clean
room, for the checker to compare.

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

## check-restore.mjs

Runs the session's `s3cab-restore` against every reference tree; what it checks is in
its doc comment.

```sh
node --env-file=.env.test scripts/cleanroom/check-restore.mjs <root>
```

## compare.py

The differential verifier: walks two restored trees with **raw byte paths** and
compares the path set, per-file SHA-256, and mtimes to the millisecond. Preserved
because run 1's equivalent wasn't — that harness "was a session artifact and is
not preserved", which is half the reason its findings could never be re-tested.

Three details are the whole point. Byte paths, because a comparator that decodes
to `str` can normalise NFC/NFD apart or choke on the `\v`, `\f` and U+0085
fixtures. Mtimes charged at the millisecond and only counted below it (`N below
1 ms` in the summary line), because the reference is s3cab's own restore, and
s3cab is the imprecise side: it sets times through float seconds, which ext4
records tens of ns off — run 2's finding 2, resolved in
[proposals/bugs.md](../../proposals/bugs.md) by promising the millisecond and
no finer ([guide/format.md](../../guide/format.md)). Charging it failed every
tree of an exact Linux restorer; dropping it would hide what the count keeps.
And directory mtimes reported separately, since both tools create directories
implicitly at restore time, so those reflect the run rather than the format.

**To be rewritten in JavaScript as `compare-restore.mjs`** when the CI matrix is
built, beside the backup checker above. It is Python only because run 2's
session wrote it that way: Node reads byte paths too (`readdir` with `encoding: "buffer"`), and
nanosecond mtimes (`lstat` with `bigint: true`).

```sh
python3 scripts/cleanroom/compare.py <my-restore-dir> <reference-dir>
```

On Windows, run it as `python`, as check-restore.mjs does.
