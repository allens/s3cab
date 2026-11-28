# The format-spec clean-room audit, run 30: backup on macOS, Fable 5.2 at xhigh (2026-11-25)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.2 at
`xhigh`, all reading the spec of 2026-10-30 as of
[PR #527](https://github.com/allens/s3cab/pull/527). The set so far: backups on
[Linux](format-spec-audit-28.md), [Windows](format-spec-audit-29.md) and macOS (this run); restores
on [Linux](format-spec-audit-31.md) and [macOS](format-spec-audit-32.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/macos/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 2 moves flagged: one caught only by the word "s3cab" in notes it appended to its own
  report, and one running its own test script, which named a made-up `.invalid` endpoint, in its
  temp folder; the judge found both harmless.
- **Tokens:** input 158, cache write 428,329, cache read 20,021,766, output 266,839.

Everything below the rule is the session's own report, verbatim.

---

# REPORT — a backup written from `format.md` alone (the spec of 2026-10-30)

## Outcome

`s3cab-backup.py` is written and the bucket holds what its final runs left. It follows every rule
I could find in the *Writing a snapshot* and *Uploading* checklists. It was run on macOS only; the
Linux-only and Windows-only branches are written but have never executed (listed under
[What was not run](#what-was-not-run)).

One set has no snapshot, and that is the spec's outcome, not a failure of the run: **`ledger`**
holds a file named `q1<TAB>2026.txt`. The spec says the run stops and names it, and that leaving
it out is the user's choice, never the tool's. The command line gives no way to make that choice,
so `ledger` has its `.info` and nothing else.

Final runs, bucket emptied first, in `ENVIRONMENT.md`'s order, each as
`python3 s3cab-backup.py test-s3cab-ci-cleanroom-backup <set> <dir>...` (`python` is not on this
machine's PATH):

| Set | Exit | Snapshot | File rows | `#error` rows | Objects |
| --- | --- | --- | --- | --- | --- |
| `edge` | 1 | `20261125T1357` | 56 | 3 | 51 |
| `docs` | 0 | `20261125T1357` | 120 | 0 | 120 |
| `bulk` | 0 | `20261125T1357` | 1100 | 0 | 1100 |
| `media` | 0 | `20261125T1359` | 2 | 0 | 2 (one sent in 3 parts) |
| `hollow` | 0 | `20261125T1359` | 0 | 0 | 0 |
| `spread` | 0 | `20261125T1400` | 13 | 0 | 13 |
| `faults` | 0 | `20261125T1400` | 3 | 0 | 3 |
| `corrupt` | 0 | `20261125T1400` | 3 | 0 | 3 |
| `ledger` | 1 | none: the run stopped | – | – | – |

`edge` exits 1 because its snapshot, which was uploaded, holds three `#error` rows: two links
leading out of the backup and one file with no read permission.

Nothing is left out on purpose. The spec makes leaving entries out optional and this command line offers no
way to ask for it, so files whose names suggest an exclude list (`edge/ignored.tmp`,
`edge/ignored.swp`, `spread/alpha/run.log`, `spread/beta/build/out.o` and the like) are backed up
as the ordinary files they are, and no snapshot has an `#excluded` row.

The bucket holds 1,309 keys: 1,292 objects, 8 snapshots, 9 `.info`. No lock, no open multipart
upload, no other key.

What I checked afterwards, with requests that only read (`check-bucket.py`, a separate reader I
wrote from the Reading checklist; it shares no code with the backup):

- All 1,292 objects were downloaded and each hashes to its key. For 1,291 of them S3's own stored
  full-object SHA-256 equals the key; the 40 MiB `clip.bin` has a composite checksum instead.
- All 8 snapshots are one gzip stream, strict UTF-8, LF only, heading first, `.` last, every row
  in canonical form, `FILES` and `SIZE` exact, every file row strictly inside a `@SET DIR`.
- Every object was stored before the snapshot that names it; no key has a `Content-Encoding` or
  metadata; every key is in `STANDARD`.
- Against the disk: `find <DIR> -type f` and the file rows plus `#error` rows name the same
  paths, and every file row's size, rounded mtime and content match the file.
- A restore of every file row into scratch matches the fixtures file for file (bytes, size, mtime
  to the millisecond): 1,297 files. Not restored, as the spec has it: `edge`'s five links, its
  pipe, its unreadable `locked.txt`, and `ledger`'s file.

That check proves the bucket agrees with *my* reading of the spec twice over. It can't prove my
reading is s3cab's: I had no s3cab to read the bucket with.

Files in this directory: `s3cab-backup.py` (sha256 `b9ea20de…76e56` at the final runs),
`s3cab-backup.state.json` (the nine `OWNER`/`CLAIMED` pairs, the one thing kept between runs),
`check-bucket.py`, this report. To repeat the audit, which only reads the bucket:
`. ./credentials.env; python3 check-bucket.py "$BUCKET" --restore <an empty scratch folder>`.

## How an object is made sure to be the bytes its key names

- **Under 16 MiB:** the file is checked against its row on the open handle (size exactly, mtime
  to the millisecond), read whole from that handle, hashed, and compared with the key. Only then
  are those same bytes sent, as a no-overwrite PUT carrying the *key's* digest as
  `x-amz-checksum-sha256`, so S3 also refuses anything else and stores nothing.
- **16 MiB and over:** sent in parts, each with its own SHA-256, which S3 checks. The whole is
  hashed from those same bytes, and `CompleteMultipartUpload` is sent, conditionally, only if that
  hash is the key. It carries the composite checksum, so S3 refuses any other set of parts. On any
  other outcome the upload is aborted.
- **Already stored** only on the bucket's word: a full listing of `objects/` taken under the
  lock, or a 412.
- **Before the snapshot goes up:** `objects/` is listed again, every hash the snapshot names must
  be there, and each one this run sent must have its row's size.

Ran on the real bucket: a wrong digest on a PUT, on a part and on a completion each came back
`400 BadDigest` with nothing stored. A file changed after hashing (new mtime) and a file changed
with the same size and mtime both stopped the snapshot's upload, with nothing stored under the
old or the new hash.

---

## Would leave a backup that can't be restored correctly

Ranked by how bad and how silent the outcome is.

**1. Whose lock it is, is decided by names that two machines can share.**
The rule: a run whose `BY`, `OS` and `PIDNS` are the lock's own removes the lock once its `PID`
is gone. But `BY` is `user@machine`, "for people", and "another tool writes whatever names its
user and machine best". Nothing makes it unique to one machine.

- Two machines that spell `BY` alike (cloned VMs, `pi@raspberrypi`, `ubuntu@ubuntu`) judge each
  other's live locks, find the PID missing from *their own* process table, and remove them.
- An upload that removes a live delete's lock this way lists `objects/`, skips what the delete is
  about to remove, and publishes a snapshot naming objects that are then deleted.
- A delete that removes a live upload's lock takes what that upload has stored, and not yet
  named in a snapshot, for orphans.
- `PIDNS` doesn't separate two hosts. As far as I know every Linux host's first PID namespace has
  the number in the spec's own example, `pid:[4026531836]`; macOS and Windows write none.

What I did: followed the rule as written. What I ran: a `delete-` lock holding this machine's
`BY` and `OS` and a PID not running here was removed and the upload went ahead. Those bytes are
all a judge has, and a same-named machine with a live run would write the same ones. **Not run:**
two real machines, and anything on Linux.

**2. A damaged object already at its key counts as stored, and nothing says to report it.**
The spec says to count a listed key as stored and that s3cab doesn't compare the listing's size
with the file's, because the conditional PUT couldn't replace it anyway. So a backup of that
content succeeds, the snapshot names an object that can't restore, and so will every later one.
The listing gives the length for free.

What I guessed: still count it as stored and upload the snapshot, as the rule says, but say so
and exit 1. Ran: I put 5 bytes at the key of a 42-byte file; the snapshot was uploaded, the
program warned and exited 1, and the key still held those 5 bytes afterwards. I did not run the
checker or a restore against that snapshot.

**3. When the clock goes back, the newest backup is not the "latest" snapshot, and no rule for a
writer covers it.**
A reader takes the name that sorts last, and "neither the upload time nor `START` decides". The
spec notes that s3cab warns; the writing checklist says nothing. So a restore of the latest
returns older content and exits 0, for up to an hour after daylight saving ends and for as long
as the time difference after a move west.

What I guessed: warn and upload. Ran: with `TZ=Pacific/Honolulu` a second snapshot holding
"version two" was named `20261125T0335` and sorts before `20261125T1335`, which holds "version
one".

**4. Whether a snapshot with `#error` rows must end in a nonzero exit is not a rule.**
It is stated as what s3cab does, and once in the links table ("the backup exits nonzero"). The
checklist's only exit rule is for a run that stops. A tool that exits 0 leaves unreadable files
out of every backup with nothing but a row to say so. What is recorded still restores correctly;
what is lost is the signal. What I guessed: exit 1 for any `#error` row. Ran: `edge` exits 1.

**5. Nothing says `START` must not be read before the run's own lock is up.**
`START` is "the instant the run started"; the lock is written "before the walk"; their order is
left open. A deletion counts as deliberate for a snapshot when its row is later than `START`. So
a delete that finishes between a run's `START` and its lock leaves a row later than `START` for
content that the run then stores again, and a later loss of that object reads as deliberate. The
spec names this outcome for a fast clock, not for this ordering.

What I guessed: `START` is the first thing the run reads, as the row is defined. Ran: in the
eight final snapshots the claim, which follows the lock, came 0.61 to 0.82 s after `START`, so
the gap is real; a first request stuck in retries would widen it. **Not run:** a delete landing
in it. I have no delete tool, so this is reasoning from the text.

---

## Would inconvenience the implementer

Ranked by how much each cost, or would cost the next person.

**1. The spec contradicts itself on a member directory whose real path holds a tab, CR or LF.**
The writing checklist says stop without a snapshot, "since its `@SET DIR` row couldn't hold it".
*No row holds a tab or a line ending* says a `@SET DIR` value is spelled out with `␉`, and that
such a member directory leaves "a `DIR` no row can match". Guessed: the checklist wins. Ran: the
program stops.

**2. Whether a backup may claim a set, and what a claim that never gets a snapshot costs.**
- The rules say "claim whenever you like before the first snapshot's upload". The same passage
  says s3cab's backup never claims and refuses instead; its set-up step is in `backup.md`, which I
  don't have. Guessed: the first backup claims, after its lock and before the walk.
- The spec doesn't say whether to keep the pair before or after the claim's PUT. After, a crash
  between the two strands a set the tool claimed and can't prove it holds. Guessed: before. Ran:
  a claim beaten by another (412) forgets the pair; a claim whose answer was lost is read back
  and kept.
- An early claim whose run then stops leaves a `.info` with no snapshot. By the *Deleting*
  checklist that makes every clean-up of the bucket refuse until someone retires the set. `ledger`
  is in that state now. **Not run:** a clean-up.
- "A claim needs no lock", but a set with a `.info`, no snapshot and no upload lock naming it is
  what a retire may remove. A claim made before the lock could be retired under the run, which
  then fails its last check. Guessed: lock first. **Not run:** there is no retire here.
- A set claimed by its own first backup has `CREATED` a moment *after* that snapshot's `START`
  (0.6 to 0.8 s in the final runs). The spec mentions a `CREATED` later than the first snapshot
  only as the trace of a race.

**3. "Keyed by set, bucket and endpoint" doesn't say what the endpoint is when none is set.**
Guessed: the empty string, and otherwise the URL exactly as given. Ran: a set claimed with
`AWS_ENDPOINT_URL_S3=https://s3.us-east-1.amazonaws.com` is refused as "held by another" when the
same bucket is reached with no variable set. Also a guess: an endpoint counts as set only through
`AWS_ENDPOINT_URL_S3`, then `AWS_ENDPOINT_URL`; boto3 would also take one from the shared config
file, which the program ignores on purpose (ran: with one in a config file the program's client
still goes to AWS).

**4. Overlapping member directories: the rule is worded around files, the remedy around names.**
The stop is for "the same file" turning up under two member directories; the next paragraph
lists "one named twice" as something to fix by changing the set. Guessed, and ran each:
- one real path named twice stops, even when empty;
- nested directories with nothing in common don't stop;
- any path that would get two rows stops, an `#error` row's included.

**5. One directory can have two real paths, and the spec's overlap test compares paths.**
On macOS `/private/tmp/x` and `/System/Volumes/Data/private/tmp/x` are one directory, and
`os.path.realpath` returns each as typed. "Compare the paths you build" passes both. Ran: by paths
alone the walk records the file twice, which the spec says "collides or restores twice". Guessed:
also stop when a directory already listed under another member directory, by device and inode,
holds anything that would get a row. Ran: it stops.

**6. Is "its read returns a different number of bytes" an `#error` rule, and what of a file seen
to change while it is read?**
The first is given as what s3cab does and is missing from the checklist's own list of `#error`
cases. The second is covered only at upload, "if it is sent". Guessed: `#error` for the first;
for the second, read again up to three times, then `#error`. Ran both with a doctored `fstat`.

**7. Locks: the grammar of what you find is thinner than the grammar of what you write.**
- Which keys under `locks/` are locks? Guessed: any key directly there starting `delete-` or
  `upload-`, whatever follows; the console's `locks/` key, other names and keys in folders below
  are ignored. Ran.
- A lock listed but gone when read. Guessed: its run has ended, carry on. Ran.
- A lock's bytes: guessed the keys in the order listed, LF after each, `COMMAND=backup`.
- A dead run's lock whose PID a live process now holds is never removed: nothing but the PID
  says whose process it is. Ran: a lock with this machine's `BY` and a live PID (1) is taken as
  alive, and the upload refuses.
- A 409 `ConditionalRequestConflict`: s3cab stops. Guessed: three more tries, then stop.
  **Not run**; I couldn't provoke one.

**8. A spelled-out `#error` path can be the same string as a real name.**
A link named `a<TAB>b` leading out is written `a␉b`; a file may really be named `a␉b`. "Each path
in at most one per-path row" then has no way to be met. Guessed: stop. Ran.

**9. A directory that vanishes stops the backup; a file that vanishes gets a row.**
Both are clear, but with leaving entries out optional, a tool that does only what the checklist
requires can't finish a tree with one unlistable or short-lived directory. Ran both.

**10. Mount points are covered for Windows only.** There they are junctions, so links. For Linux
and macOS the spec says nothing. Guessed: an ordinary directory, walked. **Not run.**

**11. Is `@SNAPSHOT FINISH` just before the `.` a rule?** "The line before it, in a snapshot, is
`@SNAPSHOT FINISH`" and the checklist's "End with …" read as rules; the row-order paragraph says
only the heading and the `.` are. Guessed: write it there.

**12. Small silences**, each guessed and none run beyond the final snapshots: the space in
`4915200 (4.9MB)` is shown only by the example; an entry that is none of file, directory, link,
pipe, socket or device (guessed: no row); a file larger than the store accepts.

---

## Hints that would have helped

Each is something I ran, unless marked.

- **macOS: a listing's inode is not `lstat`'s for a firmlink or a mount point.** The spec says
  to find a name's on-disk spelling by matching device and inode in the parent's listing. In `/`,
  `DirEntry.inode()` for `Users`, `private`, `Library` and five others differs from what `lstat`
  reports. Using it left `/users` uncorrected; `lstat` each entry instead.
- **macOS: `F_GETPATH` on the member directory itself returns the whole path as the disk spells
  it.** Needed here, because the sandbox lets `/Users/Shared/…` be neither listed nor opened. Check
  the answer has the same depth and names the same directories: for a path typed through
  `/System/Volumes/Data` it returns the shorter one.
- **Python: `os.kill(pid, 0)` raises `OverflowError`, not `OSError`, for a PID of 2³¹ or more.**
  A lock's PID is "a whole number from 1 up" with no ceiling.
- **Python: `int()` is no test of "decimal digits".** It accepts `+12`, ` 12\n`, `1_2` and
  full-width digits. The spec warns of C's `strtoull` and Swift's `Int("+12")` only.
- **Python: `\d` and `$` in a regex.** `\d{8}T\d{4}\.tsv\.gz$` matches a name in full-width
  digits and one with a trailing LF. Use `[0-9]` and `fullmatch`. The spec warns for .NET only.
- **Python: `getpass.getuser()` follows `$LOGNAME` and `$USER`.** Under another environment the
  same user spells `BY` differently, and a lock's `BY` must be spelled alike by every run. Ask
  `pwd.getpwuid(os.getuid())`. **Not run:** I believe a Mac's hostname also changes with its
  network, which would do the same.
- **boto3 never reads `AWS_REGION`.** With only that set, as `credentials.env` sets it, a session
  reports no region. The spec gives s3cab's order (`AWS_REGION`, `AWS_DEFAULT_REGION`,
  `us-east-1`) in the reading checklist; pass it as `region_name`.
- **The retry hint is out of date for this boto3.** The spec says the default mode is legacy and
  sends a `BadDigest` body five times. With botocore 1.44.11 a client made with no configuration
  reports `standard` and sent it once; asked for `legacy`, it sent five.
- **S3 checks a composite checksum at completion if you send one.** Pass
  `ChecksumSHA256="<base64 of the SHA-256 of the parts' digests>-<parts>"` to
  `complete_multipart_upload`: a wrong one is `400 BadDigest` and nothing is stored. The spec's
  multipart hint stops at per-part checksums.
- **A test suite can't back up one set twice inside a minute.** The second run is refused, as it
  should be. Give each case its own set name.

The spec's own Python and macOS hints that I could run here all held, apart from the retry mode
above: `realpath` keeping the case as typed, `/tmp` being a link, `F_GETPATH`, APFS refusing a
name that isn't UTF-8 and clamping a time to April 2262 and to `1677-09-21T00:12:43.145Z`,
U+0130 as the only character that lowercases to two, the zone at the end of `/etc/localtime`,
`gzip.open` writing a name and time where `GzipFile(filename="", mtime=0)` writes neither,
`gzip.decompress` joining streams and reading past zeros, `splitlines`, `strip`, `round`,
`mimetypes`, `os.walk` on a missing top, three U+FFFD for a lone surrogate, `ChecksumSHA256`
sending a plain body where the default sends `aws-chunked`, the 412 and the open upload left by
a refused conditional completion, and botocore's `'404'` for a HEAD that misses.

---

## Environment notes, not the format

- **Interpreter:** `python3` is Homebrew's 3.15.2 with boto3 and botocore 1.44.11. There is no
  `python`.
- **Proxy:** botocore honours `HTTPS_PROXY` unaided. `aws s3api` worked through it every time.
  `aws s3 cp` worked once and failed once with `AWS_IO_TLS_ERROR_NEGOTIATION_FAILURE`; I didn't
  look into why, and the checks use boto3.
- **Sandbox:**
  - `/Users`, `/Users/Shared` and `/Users/Shared/s3cab.sandbox` can't be listed or opened
    (`EPERM`), though the fixtures below them can.
  - A Unix socket can't be created (`EPERM`), so no socket entry was walked.
  - A boto3 client made with no region and no credentials tries `169.254.169.254`, which is
    blocked; the program always passes a region.
  - **An empty `.claude/.cc-writes` folder now sits in `fixtures/`, beside the sets.** The
    session's own tooling made it when one of my first commands changed directory there. Neither I
    nor the program wrote it, it is inside no member directory, and I left it alone rather than
    delete something in a folder I was told not to write to.
- **The bucket:**
  - Answers show `AES256` server-side encryption by default; every key is in `STANDARD`.
  - Versioning has never been enabled.
  - **A lifecycle rule expires every object after 1 day** and aborts unfinished multipart uploads
    after 1 day, so what the final runs left will remove itself.
  - These credentials may not read the bucket's location or encryption settings.
- **Time:** the machine is on UTC, so a snapshot's local-time name equals its UTC minute here.
  Another zone was reached only through `TZ`.
- **Speed:** 1,100 sequential PUTs took about two minutes.
- **Scratch:** test trees, test scripts and their output are in `$TMPDIR/s3cab-work`. Every test
  set (`t-…`) was removed when the bucket was emptied before the final runs.

---

## What was not run

- **Windows:** nothing. Unexercised: `\\?\` paths, junction and link handling, the winerror test
  for a broken link, the drive-letter and share check, `OpenProcess` for a lock's PID, `icu.dll`
  for the zone's name. Only the string helpers were run, with the platform flag forced.
- **Linux:** nothing. Unexercised: `PIDNS`, and a name that isn't UTF-8 (APFS refuses to create
  one, which I did run).
- **A socket entry**, an entry whose type can't be determined, a POSIX mount point inside a
  member directory, a file over 5 GiB, a 409 from S3, a lock that can't be removed, a second
  machine, a delete or a retire running beside a backup, and any s3cab tool reading this bucket.
- **A modification time outside the years 0000 to 9999** was run only with a doctored `fstat`:
  APFS stored a year-10000 time as April 2262.

Nothing the spec asks for needed a library beyond the standard library and boto3. Where the two
fall short, the program does the nearest thing and says so in a comment:

| The spec asks | What stood in the way | What the program does |
| --- | --- | --- |
| A name spelled as the disk spells it where its parent can't be listed | Only macOS has `F_GETPATH` in `fcntl` | macOS: `F_GETPATH`. Elsewhere the name stays as typed, as the spec says s3cab does |
| Not following a link when opening a file | Windows has no `O_NOFOLLOW` | `lstat` first, then `fstat` on the handle; a link swapped in between is followed |
| Telling a junction from a folder | Needs Python 3.12 | Refuses to start on Windows with an older Python |
| Whether a lock's process is alive, on Windows | `os.kill(pid, 0)` is a console event there | `OpenProcess` through `ctypes` |
| The local zone's IANA name, on Windows | No zone data without `tzdata` | `icu.dll` through `ctypes`, else the name `time` gives |

## What I wanted and didn't have

- **`backup.md`**, for how s3cab sets a set up and claims it, and what its `@CLIENT HOME` and
  `@CLIENT EXCLUDE` rows mean. Carried on by claiming at the first backup and writing neither row.
- **`exclude.md`**, to know whether a writer is expected to offer leaving entries out. Without
  it, `ledger` can't be backed up by this command line at all.
- **A real snapshot** to compare against byte for byte. The spec links one; I didn't follow it,
  and relied on the three canonical lines printed as JSON, which my formatter reproduces exactly.
- **A Linux and a Windows machine.**

---

## Appendix: guesses in the order they were made

Logged while working; the ranked lists above are drawn from these.

Before any code ran:

1. Member directory with a tab in its real path: stop, not spell out.
2. A member directory named twice, even with no file in it: stop.
3. An `#error` path found twice: stop, like a file found twice.
4. A spelled-out `#error` path colliding with a real name: stop.
5. A read returning another number of bytes: `#error`, as s3cab.
6. A file seen to change while hashed: read again up to three times, then `#error`.
7. Exit 1 whenever the snapshot holds an `#error` row.
8. A lock is any key directly under `locks/` starting `delete-` or `upload-`.
9. A lock listed but gone when read: its run ended.
10. A lock's bytes: the keys in the spec's order, LF after each.
11. `COMMAND=backup`.
12. A backup may claim a new set itself.
13. Order: lock, then claim, then walk.
14. The endpoint of the kept pair is the empty string when none is set.
15. `FINISH`'s duration as `9s`, `12m 21s`, `3h 04m`, seconds rounded to nearest; `START`'s zone
    as the IANA name.
16. An entry of no known type: no row.

While the code was written and run:

17. One directory under two real paths: also compare device and inode across member directories.
18. Keep the pair before the claim's PUT.
19. A kept pair that no longer matches: keep it, refuse.
20. Clock gone back: warn and upload.
21. An object at its key with another length: upload the snapshot, warn, exit 1.
22. A lock's PID too large for the system: gone.
23. A 409 on a conditional PUT: three more tries.
24. A POSIX mount point: an ordinary directory.
25. Region: `AWS_REGION`, `AWS_DEFAULT_REGION`, `us-east-1`.
26. An endpoint is set only by the two environment variables.
27. `FINISH` goes immediately before the `.`.
28. `START` is read first, before the lock, as "the instant the run started".
29. The lock is written before the claim, so a retire can't remove a claim that has no snapshot.
