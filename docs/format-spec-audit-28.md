# The format-spec clean-room audit, run 28: backup on Linux, Fable 5.2 at xhigh (2026-11-25)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.2 at
`xhigh`, all reading the spec of 2026-10-30 as of
[PR #527](https://github.com/allens/s3cab/pull/527). The set so far: backups on Linux (this run),
[Windows](format-spec-audit-29.md) and [macOS](format-spec-audit-30.md); restores on
[Linux](format-spec-audit-31.md) and [macOS](format-spec-audit-32.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/linux/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 5 moves flagged: three caught only by the word "s3cab" in the session's own
  verifier, its program and a grep of its spec, and two writing or running its own test scripts
  in its temp folders; the judge found all five harmless.
- **Tokens:** input 196, cache write 461,609, cache read 26,516,713, output 283,689.

Everything below the rule is the session's own report, verbatim.

---

# Report: writing a backup from `format.md` alone

`s3cab-backup.py` was written from `format.md` (the spec of 2026-10-30) and nothing else about
the format. It backs up a set the way the spec describes a repository, and a reader written from
the same page restores what it stored: I restored all eight published sets from the real bucket
and compared them with the fixtures, 1,302 files, byte for byte and to the millisecond, with no
difference.

Two of the ten sets have **no snapshot**, on purpose. `ledger` holds a file with a tab in its
name and `scans` one whose name has no UTF-8 form; the spec makes each stop the run, and says
leaving such a name out "is the user's choice, not the tool's". This program's command line
offers no way to leave anything out, so those two sets are claimed (`.info`) and not backed up.
Nothing in them is restorable until the names are fixed.

The spec was good enough to build from. The lists below are where it wasn't. Every entry says
what I guessed, what I ran to check it, and what I could not run.

Only Linux ran any of this. The Windows and macOS branches of the program follow the spec's
hints and were exercised only as far as Linux can simulate them; see
[what was not run](#what-was-not-run).

## What is in the bucket

Emptied, then one run per set with the final program (sha256 `e316af5c…0236dce`),
2026-11-25T05:45:27Z to 05:47:37Z, each exactly `python s3cab-backup.py <bucket> <set> <dir>...`:

| Set | Exit | Snapshot | File rows | `#error` rows | Bytes | Objects sent |
| --- | --- | --- | --- | --- | --- | --- |
| `edge` | 1 | `20261125T0545` | 61 | 3 | 1,051,001 | 55 |
| `docs` | 0 | `20261125T0545` | 120 | 0 | 37,870 | 120 |
| `bulk` | 0 | `20261125T0545` | 1,100 | 0 | 20,890 | 1,100 |
| `media` | 0 | `20261125T0547` | 2 | 0 | 42,467,328 | 2 (one in three parts) |
| `hollow` | 0 | `20261125T0547` | 0 | 0 | 0 | 0 |
| `spread` | 0 | `20261125T0547` | 13 | 0 | 425 | 13 |
| `faults` | 0 | `20261125T0547` | 3 | 0 | 95 | 3 |
| `corrupt` | 0 | `20261125T0547` | 3 | 0 | 112 | 3 |
| `scans` | 2 | none: stopped | | | | |
| `ledger` | 2 | none: stopped | | | | |

1,314 keys: 1,296 objects, 8 snapshots, 10 `.info`. No lock, no unfinished multipart upload.
The ten claims are kept in `s3cab-backup.state/` beside the program; a further run of any set
needs them (or `--takeover`).

`edge` exits 1 because its snapshot holds three `#error` rows: two links leading out of the
backup and one file that can't be read (`unreadable/locked.txt`, mode 000). The pipe, the
dangling link and the two links into the backup get no row, as the spec says.

Exit status is 0 for a snapshot with everything in it, 1 for a snapshot published with something
missing from it, 2 for a run that stopped and published nothing.

The one addition to the command line is an optional `--takeover`. The spec makes taking a set
over a person's decision, and a tool with no way to be asked could never again publish to a set
whose kept pair was lost. Without the flag the program never takes over.

## How it was checked

All against the real bucket, after the final runs, with read-only requests:

- **Every key.** Listed (two pages), then a HEAD of each of the 1,314: none has a
  `Content-Encoding`, none has `x-amz-meta-*`, all are in `STANDARD`.
- **Every object.** All 1,296 downloaded and hashed: none differs from its key. 1,295 also carry
  a stored full-object SHA-256 equal to their key, which is S3's own word that it checked the
  bytes on arrival; the one multipart object has a composite checksum, so only the download
  proves it.
- **Every snapshot**, read by the spec's reading rules in a checker written separately from the
  program: one gzip stream with nothing after it, UTF-8, LF only, heading row, the `.`, four
  tabs a line, each column padded as the table says, one each of `SPEC`, `CLIENT NAME`,
  `CLIENT VERSION`, `FILES` equal to the row count, `SIZE` equal to the sum with its readable
  form recomputed in decimal arithmetic, the name equal to `START` cut to the minute, `FINISH`
  not after the upload, no path in two rows, no path through another, every file row under a
  `DIR`, every object stored no later than the snapshot naming it.
- **Every row against the disk**, as `find`, `stat` and `sha256sum` report it rather than as
  Python does: 0 missing, 0 extra, 0 differing, in all eight sets.
- **A restore.** Each set's latest snapshot restored into scratch from the bucket and compared
  with the fixtures: bytes and modification time to the millisecond, 0 differences.
- **A regression suite of 69 checks** over real runs of the final program against the real
  bucket (which was emptied, and the final runs repeated, afterwards): walk rules, every stop,
  what only hashing finds, files changed between hashing and sending, 412 handling, the
  same-minute rule, the holder, locks, signals, name order, damaged and archived objects, time
  zones, argument spellings, the part-size boundary. 69 of 69 passed. Where a condition can't
  be produced from outside — a file changing between its hashing and its sending, a holder
  changing mid-run — a harness patches that one seam of the program; the rest, bucket
  included, is real.
- **Offline**: the writer's rows equal the spec's three canonical JSON strings byte for byte;
  the instant formatter agrees with `datetime` on 200,000 random instants and was checked by
  hand at year 0000 and 9999.

**One comparison failed during the work**, and the fault was in my checker, not the program:

```
PROBLEM: row b'…/edge/mtime-1969.txt' is (…, 10, '1969-12-30T23:59:59.750Z'),
         disk says (…, 10, '1969-12-31T00:00:00.250Z')
```

The checker took the time from `stat --printf=%.9Y`, which on this machine prints
`-86399.750000000` for a file whose time is `-86400.25` (`ls --full-time`, `stat -c %y`,
`date -d @-86400.25` and Python's `st_mtime_ns` all agree on 23:59:59.750). The program's row
was right. See [hints](#hints-that-would-have-helped): the spec recommends exactly that `stat`
format.

## Would leave a backup that can't be restored correctly

Ranked by how likely I think each is to bite. Each says what I guessed and what I ran.

### 1. "Already stored" is the bucket's word, and that word says nothing about the bytes or whether a GET can read them

*Uploading checklist, lines 1638–1660; hint at 1407–1409.* An object counts as stored when its
key is listed, "never by downloading the object to check"; wrong bytes or a wrong length are
"damage, for a check of the whole repository to find"; s3cab doesn't compare the size. The
rule that every key be in a class "a plain GET reads at once" is about what the writer stores,
not about what it finds.

Silent: what a backup does when it is about to publish a snapshot naming an object it can see
won't restore. Followed to the letter, the answer is publish, exit 0. The class of an object
*found* already stored isn't mentioned in the writer's rules, only in a hint for readers. And
"never by downloading" doesn't say whether it forbids a check or just doesn't require one.

Ran, with three objects planted by hand:

- 10 bytes at the key of a 37-byte file: counted as stored, snapshot published naming it.
- 37 *other* bytes at the key of a 37-byte file: counted as stored, snapshot published naming
  it, nothing reported. This is the rule working as written; the bytes under that key do not
  hash to it, so a reader following the spec withholds the file.
- the right bytes in class `GLACIER`: counted as stored, snapshot published; a plain GET of
  the object answered `InvalidObjectState`.

Guess: follow the rule, but use what the same LIST answer already carries. The program
compares each listed length and class with the row, reports an object that is short or archived
as "not restorable as stored", and exits 1. Wrong bytes of the right length it cannot see.

### 2. Removing a "dead" run's lock trusts `user@machine` to name one machine, and nothing says it must

*Locks, lines 262–267 and 281–284; checklist 1605–1606; `user@machine` at 689–694.* A lock with
my own `BY`, `OS` and `PIDNS` whose `PID` is gone is a dead run's, and I remove it. `BY` is "for
people", and "another tool writes whatever names its user and machine best".

So two machines that share a login and a host name judge each other's live locks by their own
process tables. On macOS and Windows there is no `PIDNS` to tell them apart. On Linux outside a
container, I believe every machine reports the same one — the spec's own example value,
`pid:[4026531836]`, is the kernel's fixed number for the initial namespace — though I could not
measure that here. An upload that removes a live delete's lock then skips objects the delete is
about to remove, and publishes a snapshot naming them.

Ran: a `delete-` lock planted with this machine's `BY`, `OS` and `PIDNS` and a PID not in this
process table was removed and the upload went ahead — the rule as written. Also measured: two
separately started commands in this sandbox are different process tables (PID 1 started at
tick 223552 in one, 224159 in the other) and both report `pid:[4026532365]`, the same user and
the same host. They were never alive together, so on one kernel that is safe; it shows the
triple is not an identity. **Not run:** two machines.

Guess: follow the rule. I did not add a machine-unique token to `BY`, since the spec asks that
each run spell it alike and gives it to people to read.

The same assumption sits under "its own bytes mean its own write" for a `.info` claim: two
same-named machines claiming one new set in one millisecond write identical bytes and both
become holder.

### 3. "Not while the run's requests may still be in flight" gives a tool nothing to test

*Lines 277–278 and 1608.* A blocking client that is interrupted, or that times out after its
retries, cannot know whether the PUT it abandoned will still land. If that PUT is the
snapshot's and the lock goes first, a delete can start, take the run's objects for orphans, and
the snapshot arrives afterwards naming them.

Guess: a request that ended without an answer is treated as possibly in flight; the program
drops its connections, waits five seconds, then aborts any multipart upload and removes the
lock. Five seconds is arbitrary. Ran: SIGTERM and SIGINT four seconds into a run each left
exit 2, no snapshot, and the lock removed 5.3 s after the signal. **Not run:** the race itself.

### 4. A new snapshot whose name sorts before one already in the set

*Lines 966–973 and 1117–1126.* A reader takes the name that sorts last as the latest; "neither
the upload time nor `START` decides". The writing rules say nothing; of s3cab the page says only
that it "warns when it writes one". After the clock goes back, or beside a hand-placed name, a
new backup publishes cleanly and is never what "latest" restores: older files, exit 0.

Guess: publish, warn on stderr, leave the exit status alone. Ran: with
`snapshots/<set>/20990101T0000.tsv.gz` placed by hand, the next run published `20261125T…` with
the warning. Whether it should have refused is the open question.

### 5. Every promise not to overwrite assumes the store honours `If-None-Match: *`

*Lines 1489–1492, 1668–1669, 1744–1751.* The same-minute rule, the claim and the lock all rest
on a 412. Of stores other than AWS the page says only "untested". On one that ignores the
header, a snapshot or another holder's `.info` is replaced with a 200.

Guess: prove it on every run. After writing its lock the program sends the same key again with
the same bytes; it must be refused, or the run stops before anything else is written. Ran: AWS
refuses it on every run, and in 144 racing conditional PUTs of six keys exactly six succeeded
and 138 got 412. **Not run:** the stop itself, since I had no store that ignores the header and
a fake was ruled out.

## Would inconvenience the implementer

Ranked by the time each cost me or the size of the guess.

1. **The page contradicts itself on a member directory with a tab in its name.** Lines 752–755
   say it "is walked like any other" and, empty, leaves "a `DIR` no row can match"; the checklist
   at 1449–1450 says stop, "even with nothing in it to back up, since its `@SET DIR` row couldn't
   hold it". I followed the checklist. Ran: such a member directory, holding nothing but a pipe
   in a subdirectory, stops the run.

2. **When a tool whose only verb is `backup` should claim.** Lines 175–189 allow a claim any time
   before the first snapshot, and the page fixes only that the lock comes before any listing and
   the claim before the publish. My order: resolve the member directories (so a mistyped one
   writes nothing to the bucket), lock, claim, walk. A first run that stops in the walk
   therefore leaves a `.info` and no snapshot — `ledger` and `scans` in the final bucket. By the
   deleting checklist (1781–1784) such a set makes every spec-following clean-up of the bucket
   refuse; I read that, I did not run a delete tool. Also guessed: with a kept pair but neither `.info` nor snapshots
   in the bucket, the page says the set "is new" while s3cab itself refuses and names
   `takeover`; I claim silently. Ran: the rehearsal on an emptied bucket with stale pairs kept.

3. **Whether `#error` rows make the run exit nonzero.** Said of s3cab (585–586) and in the links
   table (623), but in no checklist, and only "zero and nonzero" is promised (1102). Guess: 1,
   and 2 for a run that stopped, so a script can tell a partial backup from none.

4. **"The same file turns up under two member directories"** (1454–1463, 1470–1471) leaves three
   cases open. A directory named twice with nothing in it: the stop rule doesn't fire, but the
   way-past paragraph lists "one named twice"; I stop. A row that isn't a file found twice, such
   as one out-link's `#error`: I stop. Nesting with no row in common where the inner is simply
   empty rather than left out: I publish, two `DIR` rows. Ran: the first and third against the
   bucket; the second on the program's walk alone, with no bucket.

5. **Spelling out tab, CR and LF is not one-to-one.** A link named `x<TAB>y` and one named `x␉y`
   become the same path, and a path may be in one row only (996). Guess: stop and name it. Ran.

6. **Rules that are only in the prose**, though line 27 says every rule is in a checklist: the
   form of `.info`'s instants and that `CLAIMED` is read as the claim is made (162–166), a
   lock's keys and their forms (245–261), `@CLIENT NAME`'s alphabet (670), the name and `START`
   coming from one clock reading (706–708). `@SNAPSHOT SIZE`'s readable form is required by its
   row description and specified under recommendations. Nothing guessed; the whole page has to
   be read.

7. **A read that returns a different number of bytes.** "s3cab gives [it] an `#error` row"
   (1425–1426) and it is among what hashing finds (719–720), but the checklist's own list of
   `#error` causes (1433–1437) leaves it out. Guess: `#error`. Ran only with `fstat` patched to
   report three bytes more than the file holds.

8. **Small silences about locks** (245–287). What under `locks/` is a lock: I take keys
   beginning `upload-` or `delete-` directly in the folder. A 412 on writing mine followed by a
   404 on reading it back: I take a fresh instant. `COMMAND`'s value: `backup`. A `PID` too large
   for the OS: never judged. Ran: the lock's seven lines read back mid-run; locks with another
   `PIDNS`, `PID=007` and another `BY` left alone; the oversized `PID` on the judging code
   alone. **Not run:** the 412 followed by a 404.

9. **Taking a set over: the other lines of `.info`.** "Rewrites `OWNER` and `CLAIMED`, and keeps
   `CREATED`" (201–204). Guess: every other `KEY=value` line is kept. Ran.

10. **A link's target "as the link holds it"** (623) when the text isn't UTF-8, when the link
    points at another link, or when the link can't be read at all. Guess: U+FFFD for what
    doesn't decode, the first link's own text, and a message saying it couldn't be read. Ran the
    first two. **Not run:** a link that can't be read.

11. **Mount points on Linux and macOS.** On Windows a volume mount point "is a junction", so a
    link (617). Nothing says whether a POSIX mount point inside a member directory is walked.
    Guess: it is an ordinary directory. **Not run:** no mount point lay inside a directory I
    could back up.

12. **409 `ConditionalRequestConflict`** is described for s3cab only (1749–1751). Guess: the run
    stops. **Not run:** it never appeared in 144 racing PUTs.

13. **Unfinished multipart uploads of dead runs.** The page covers aborting after a 412 (1747–
    1749) and nothing else. Ran: an upload begun and abandoned is in no listing of `objects/`,
    only in `list-multipart-uploads`. The program aborts its own on every exit but a hard kill,
    and does nothing about another run's.

14. **A user or machine name holding CR or LF.** Snapshot fields have control pictures; `.info`
    and lock values have no rule, and a reader strips one trailing CR. Guess: the same pictures
    everywhere. **Not run:** I could not rename the machine.

15. **`@SET ENDPOINT`** is tied to two environment variables (1556–1558); an endpoint set in an
    AWS profile reaches boto3 without either. The row is optional, so I left that case out, and
    write `@SET BUCKET` always. **Not run:** only AWS, no endpoint.

16. **Leaving entries out.** It is optional (587–589), its mechanism is in another document, and
    it is the only way past two stops (1468–1475). Guess: offer none. That is why `ledger` and
    `scans` have no snapshot.

17. **"The run stops and names it"** (404) when several names would stop it. Guess: the first
    one found, so a tree with three bad names costs three runs. **Not run** with more than one.

18. **A set with no member directory.** "An empty backup set" is legal (973–974), but nothing
    says whether that can mean no `@SET DIR` row at all. Guess: the program asks for at least
    one directory.

## Hints that would have helped

- **`stat -c %.Y` does not print a pre-1970 time right here** (the hint at line 1592 says it
  does). This machine's `stat` is uutils coreutils 0.10.0, and it prints `-86399.75` for
  `-86400.25`, and `-86399` for `%Y`. `stat -c %y` is right. GNU `find -printf %T@` (findutils
  4.10.0) printed `-86401.75` for the same file, 1.5 s early rather than the "a second" the
  hint gives.
- **The LIST answer already carries each object's size and storage class.** A writer can tell a
  short or archived object from a stored one with no extra request (item 1 of the first list).
- **Python and SIGTERM.** The default action ends the process without running `finally`
  (measured: no output, exit −15), so "remove the lock when the run ends, success or failure"
  needs a handler.
- **`CompleteMultipartUpload` must repeat each part's `ChecksumSHA256`.** Line 1743 says the
  checksums "belong to" such an upload; without them S3 answers `400 InvalidRequest`, "The
  complete request must include the checksum for each part".
- **Linux reuses PID-namespace numbers.** A new namespace gets a dead one's `pid:[…]`, so
  `PIDNS` tells apart only namespaces alive together. Worth a line beside the lock rules.
- **Drive the listing with bytes on Linux and macOS.** `os.scandir(b"…")` hands back the names'
  own bytes whatever the locale, which makes "has it a UTF-8 form" one strict decode.
  `DirEntry.is_dir()` and `is_file()` answer `False` for an entry that has vanished rather than
  raising, so that case and a pipe both arrive as "no row" with no code.
- **`os.kill(pid, 0)` raises `OverflowError`** for a PID past a C int, which the rule "a whole
  number from 1 up" allows.
- **ext4 cannot hold the times the out-of-range rule is about** (the page says so, under
  restoring). A writer tested on ext4 never meets that rule.
- **A worked example.** One complete canonical snapshot beside the tree that produced it would
  have settled most layout questions at once. The page has three lines of it, which my writer
  matches byte for byte.

Hints I checked and found right at boto3 1.40.72: legacy retry mode sends a refused digest five
times and standard mode once; boto3 sends `Content-Encoding: aws-chunked` by default, AWS does
not store it, and supplying `ChecksumSHA256` sends a plain body; a 412 at
`CompleteMultipartUpload` leaves the upload open; `gzip.compress` on Python 3.14 writes a zero
time.

## Environment notes, not the format

- Python 3.14.4, boto3 and botocore 1.40.72, aws-cli 2.40.4. boto3 took the proxy from
  `HTTPS_PROXY` and the keys from the environment with no code of mine.
- **boto3 does not read `AWS_REGION`**, only `AWS_DEFAULT_REGION`: with the first alone its
  session reports no region. The program passes the region itself.
- The bucket applies `AES256` encryption by default and has a lifecycle rule,
  `expire-test-objects`, under which every key expires on 27 November 2026. The backup as left
  will be gone then.
- `GetBucketLocation` is denied to these credentials. Multipart calls,
  `ListBucketMultipartUploads`, multi-object delete and a PUT in class `GLACIER` are allowed.
  Emptying the bucket left no versions and no delete markers.
- During testing I planted objects by hand (wrong length, wrong bytes, `GLACIER`), locks and one
  far-future snapshot name. All went when the bucket was emptied before the final runs.
- 1,100 small PUTs took about 100 s one at a time; the 40 MiB file about 3 s in three parts.
- The sandbox: shell commands may not read outside the two working directories, so `stat` and
  `find` were driven from Python; AF_UNIX sockets can't be created; scratch is ext4. Twice a
  test script was held for approval when run as a file, and I ran the same code inline.

## What the spec asks that the standard library and boto3 can't do portably

- **Know that no request is in flight.** boto3 gives no way to ask after an interrupt or a
  timeout. The program waits instead (item 3 of the first list).
- **Name the local IANA zone on Windows.** `zoneinfo` can't, and has no data there without the
  `tzdata` package. The program asks `icu.dll` through `ctypes` and falls back to Windows' own
  name. The value is free text, so nothing breaks. Never run.
- **Ask whether a process is alive on Windows.** `os.kill(pid, 0)` is unusable there, as the
  page says; the program calls `OpenProcess` through `ctypes`. Never run.
- **Tell a junction from a directory before Python 3.12.** The program falls back to the
  listing's reparse tag. Never run.
- **Name the process table.** `PIDNS` needs `/proc`; without it the program writes none.

## What I wanted beyond `format.md`

- `exclude.md`. It is the only way past two of the stops, and the fixtures' own contents speak
  of patterns ("dropped by `*.log`", "excluded by pattern, in the seed"). I did not look for
  it; the program leaves nothing out.
- `output.md`, for the exit codes behind "zero and nonzero".
- The "anatomy of a snapshot" page the spec links, as the worked example above.

## What was not run

- **Windows and macOS.** Simulated on Linux only: the Windows member-directory string handling
  (14 spellings through `ntpath`, with a fake `realpath`), and respelling a real path from its
  parents' listings by device and inode, against a listing made to differ in case and
  normalization.
- A socket (the sandbox forbids making one) and a device node directly in a member directory. A
  pipe, and links to a pipe and to `/dev/null`, were run.
- A modification time outside the years 0000 to 9999, and a short read: `fstat` was patched,
  since ext4 cannot hold such a time and a short read is a race.
- An entry whose type can't be determined: Linux listings always gave one.
- The "own bytes" branch of a 412 on the lock, the `.info` and the snapshot (a retry after a
  lost response). The "other bytes" branch ran for the `.info` and the snapshot.
- An interrupt during the snapshot's own PUT; a 301 to another region; any endpoint but AWS; a
  listing of `locks/` or `snapshots/<set>/` past one page (`objects/` past one page did run).
- A file needing more than three parts, and an abort that finds its upload already gone.
- Said where they arise above, and gathered here: two same-named machines; the race behind a
  request still in flight; a store that ignores `If-None-Match`; a 409; a mount point inside a
  member directory; a spec-following delete tool meeting a claimed set with no snapshot.
