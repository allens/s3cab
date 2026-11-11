# The format-spec clean-room audit, run 17: backup on macOS, Fable 5.1 at xhigh (2026-11-04)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on
[Linux](format-spec-audit-16.md), macOS (this run) and [Windows](format-spec-audit-18.md); restores
on [Linux](format-spec-audit-19.md), [macOS](format-spec-audit-20.md) and
[Windows](format-spec-audit-21.md).

- **Program:**
  [`s3cab-backup.py`](https://github.com/allens/s3cab/blob/039e3085dd33c5fa38612a94fc307221710bc94f/scripts/cleanroom/backup/macos/s3cab-backup.py),
  Python with boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 3 moves flagged, each a heredoc writing the session's own files (its notes, its
  program, its report), caught only by the word "s3cab" in them; the judge found all three harmless.
- **Tokens:** input 1,442, cache write 210,102, cache read 5,418,939, output 124,723.

Everything below the rule is the session's own report, verbatim.

---

# Writing an s3cab backup from the spec alone

Clean-room result for `format.md` (spec of 2026-10-30). The program is `s3cab-backup.py`; the
raw running log of guesses and observations is `findings-log.md`; `check-snapshot.py` is the
independent reader I wrote to verify the bucket by the spec's reading rules. All verification below
was done over the network against `s3://test-s3cab-ci-cleanroom-backup`.

## What was built

`python s3cab-backup.py <bucket> <set> <dir>...` does, in order: validates the set name; resolves
each member directory to its real path spelled as the disk spells it, and stops if one is missing,
not a directory, nested in or equal to another; takes one clock reading for the snapshot name
(local minute) and `START` (UTC millisecond, cut down); writes `locks/upload-<instant>` with a
no-overwrite PUT and then lists `locks/`, removing this machine's dead locks and refusing on any
`delete-` lock; claims `snapshots/<set>.info` with a conditional PUT when the set has no `.info`
and no snapshot, or checks the kept OWNER/CLAIMED pair; refuses if a snapshot of this minute
already exists; walks every member directory without following links, classifying each entry as
the spec's tables say; hashes each file from one open handle (`fstat` for size and `st_mtime_ns`,
the read count checked against the size); lays out every row in canonical form; self-checks the
text against the "refuse whole" rules; lists `objects/` and uploads each missing object once (from
the first row naming it) after re-checking size and millisecond mtime, with `ChecksumSHA256` set to
the key's digest so S3 itself stores nothing that doesn't hash to the key, and `If-None-Match: *`;
files at or above 256 MiB go as a multipart upload whose completion is sent only when the whole
file's hash equals the key; re-reads `.info` immediately before the snapshot upload; uploads the
gzip bytes conditionally; removes the lock. Exit 1 for any `#error` row (after the upload) or a
stop; 0 otherwise.

State kept between runs, beside the program: `s3cab-backup.state.json` holds the OWNER/CLAIMED pair
written to each set's `.info`, keyed by bucket and set, as the spec says a writer must keep it.
Two environment knobs exist because the command line is fixed: `S3CAB_BACKUP_TAKEOVER=1` asks for
a takeover, and `S3CAB_BACKUP_PART_THRESHOLD` lowers the multipart threshold (used in testing).

Not implemented for lack of a portable way: nothing. Everything the spec asks of a writer had a
standard-library or boto3 route on all three platforms. Windows-specific code (`\\?\` prefixes,
junction detection via `is_junction`/reparse tags, `OpenProcess` for lock PID checks, `icu.dll`
for the zone name) is written from the spec's hints but could not be run here; macOS only.

## Final runs

Bucket emptied, local state removed, then one invocation per set, with exactly the command line
asked for and the directories ENVIRONMENT.md names. `python` is not on this machine's PATH, so
`/opt/homebrew/bin/python3` (Python 3.15.2, boto3 1.43.123) ran the same command line.

| Set | Snapshot key | File rows | Size (bytes) | `#error` rows | Objects uploaded | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| edge | `snapshots/edge/20261104T0348.tsv.gz` | 56 | 1050891 | 3 | 51 | 1 |
| docs | `snapshots/docs/20261104T0348.tsv.gz` | 120 | 37870 | 0 | 120 | 0 |
| bulk | `snapshots/bulk/20261104T0348.tsv.gz` | 1100 | 20890 | 0 | 1100 | 0 |
| media | `snapshots/media/20261104T0350.tsv.gz` | 2 | 42467328 | 0 | 2 | 0 |
| hollow | `snapshots/hollow/20261104T0350.tsv.gz` | 0 | 0 | 0 | 0 | 0 |
| spread | `snapshots/spread/20261104T0350.tsv.gz` | 13 | 425 | 0 | 13 | 0 |
| faults | `snapshots/faults/20261104T0350.tsv.gz` | 3 | 95 | 0 | 3 | 0 |
| corrupt | `snapshots/corrupt/20261104T0351.tsv.gz` | 3 | 112 | 0 | 3 | 0 |
| ledger | none | | | | 0 | 1 |

`ledger` stopped, as the spec requires, at `ledger/q1<TAB>2026.txt`: a file row's path may not hold
a tab. Its `.info` was claimed before the walk, so the bucket holds `snapshots/ledger.info` with no
snapshot, the state the spec calls "a set not yet backed up, or whose first backup stopped".
`edge`'s three `#error` rows are the two links leading out of the backup (`link-out-dir/`, with the
directory separator, and `link-out-file`) and the unreadable `unreadable/locked.txt`; its pipe,
dangling link and two links into the backup have no row, and its hardlink and dedup pairs are two
rows each naming one object.

Final bucket contents: 1309 keys: 1292 under `objects/` (all 64-hex names), 8 snapshots, 9 `.info`
files, nothing under `locks/`, nothing else, no in-progress multipart uploads.

## How it was verified

`check-snapshot.py` reads each set's latest snapshot by the spec's reading rules: every gzip stream
in turn with nothing after; strict UTF-8, no BOM, no CR; split on LF alone; heading row exact in
all five fields; the `.` last with nothing after; five fields per line; leading fields trimmed with
the JavaScript trim set and the last taken verbatim; each file row's hash, size and 24-character
instant checked (calendar included); each path strictly inside a `@SET DIR` by whole segments; no
path in two rows; no path running through another's; `FILES` and `SIZE` recomputed; the canonical
widths checked on every row. It then GETs every object and checks its SHA-256 against the key,
and compares the file rows (hash, size, millisecond mtime, path) with an independent `os.walk`.
All eight snapshots: RESULT OK, 0 objects missing, 0 wrong. The raw `edge` text was also dumped
and read by eye against the spec's JSON examples of the heading, file and `@SET DIR` rows.

Behaviours tested live, beyond the final runs (details in `findings-log.md`, O04 to O14): a second
run in the same minute refused; a planted `delete-` lock refused and our own lock removed; a dead
`upload-` and a dead `delete-` lock of this machine removed, a foreign one left; tampered `.info`
refused and the kept pair forgotten; takeover keeping `CREATED`, setting it when empty, and creating
`.info` with `CREATED` = `CLAIMED` when absent; a file grown after hashing stopped before sending;
same-size same-mtime different bytes refused by S3 (`400 BadDigest`, nothing stored) on the single
PUT path, and aborted with nothing stored on the multipart path; a file deleted after hashing
stopped the run; a re-run with every object already stored uploaded nothing. The invalid first
attempt at the change tests (content already stored, so correctly not re-checked) is recorded too.

## Would leave a backup that can't be restored correctly

1. **A member directory that is a filesystem root.** The rules say `@SET DIR` is "its real path
   ending in a separator" and a `#` row for a directory "ends its path with one separator". For
   `/`, `C:\` or `\\server\share\` the real path already ends in one, and a writer that appends
   another writes `//`, `C:\\` or `\\server\share\\`. The reader rules then refuse every file row:
   a `DIR` "with a doubled separator anywhere after its root matches nothing", and a POSIX path
   starting with two separators "is taken for a Windows share". The spec never mentions the case.
   I guessed: add a separator only when the real path doesn't already end with one (G14). Not
   exercised by the fixtures; checked by a unit test that `/` resolves to a `@SET DIR` of exactly `/`.

That is the only guess I made whose wrong answer would, on its own, make a snapshot unrestorable.
Every other place I had to guess leaves the file rows and objects intact.

## Would inconvenience the implementer

Ordered by how much time each cost or how wrong a plausible alternative reading is.

1. **"Both are real paths, so where the disk ignores case they already agree" (Links) is false
   for Python on macOS and in case-insensitive Linux directories.** The Paths section admits
   `os.path.realpath` "keeps the case as typed", but the Links rule relies on the opposite. A
   writer that compares a link target against a member directory by exact segments without the
   parent-listing fix-up writes a spurious `#error` and exits 1 for a link into the backup typed
   in another case; the content is still recorded where it lies, so the backup restores. The
   same fix-up is needed on both sides, and when the parent can't be listed, `F_GETPATH` on
   macOS. Both facts are in the spec, but as a trap and a hint, under different headings, while
   the rule reads as if nothing were needed (G10, O02).
2. **Which process holds the pair.** The spec says the writer keeps the OWNER/CLAIMED pair but not
   what to do when `.info` exists, no pair is kept, and the set has no snapshot (state file lost,
   or another tool claimed it): I refuse unless asked to take over (G02). It also says s3cab
   "forgets" a pair that stops matching, but not how a rightful holder gets back in other than a
   takeover, which is "only when asked". With a fixed command line that had to become an
   environment variable.
3. **Tab, CR or LF in the name of a file that would get `#error`, not `-`.** The stop rule covers
   "a file you would give a `-` row". An unreadable or vanished file gets `#error`, whose path
   may spell the character out. I stop for any regular file with one, readable or not (G01).
4. **Lock instant versus `START`.** Both are "the instant the run started", but a lock whose
   instant is taken (412 with other bytes) must "take a fresh one", while `START` must be "before
   any member directory was walked". I let them diverge (G04). The lock rule also says to write
   it "before ... sending a conditional PUT"; whether the `.info` claim counts as such a PUT isn't
   said. I lock first, before any bucket write (G03).
5. **Dead locks of the other kind.** "Remove your own dead locks" and "refuse on any `delete-`
   lock" don't say whether this machine's own dead `delete-` lock still blocks an upload. I
   remove own dead locks of both kinds first, then refuse only if a `delete-` lock remains (G05).
   Tested live (O10).
6. **Where the writer's `#error` rows go, and which block.** The order is a recommendation, but
   the writer has to know which errors are known at walk time and which at hash time. A
   modification time outside 0000 to 9999 is only known at hash time, so I put that `#error`
   among the `-` rows; the spec lists it beside the walk-time ones (G12).
7. **`@SNAPSHOT FINISH` with no file rows.** Defined as "the instant the last file's row was
   written"; for an empty set there is none. I used the moment the `-` block ended, rounded up.
8. **Rounding of the instants that aren't `START`, `FINISH` or an mtime.** The lock id, `STARTED`,
   `CLAIMED` and `CREATED` are "to the millisecond" or "like `START`"; I cut all of them down
   (G15). The `.info` rule does say "cut down", the lock rule doesn't.
9. **A member directory whose own path holds a tab, CR or LF.** Not addressed. I spell it out in
   `@SET DIR` as for any property value and stop at the first file under it (G13). An empty one
   therefore yields a legal snapshot with a `DIR` no file row could ever match, which the
   reading rules explicitly tolerate.
10. **"Hash the bytes as you send them ... compare before the upload completes" is a rule, but the
    only ways to honour it with S3 (the `x-amz-checksum-sha256` header, or multipart with the
    completion held back) are hints.** With a plain single PUT the rule can't be met; a reader of
    the checklist alone would delete afterwards, which the same bullet forbids. The hint is right
    and I followed it (O05); the rule should name the mechanism.
11. **`@CLIENT NAME`.** Nothing says a replacement tool must not call itself `s3cab`, though
    s3cab-specific `@CLIENT` rows would then be attributed to it. I used `s3cab-backup-py` (G07).
12. **Object-store listing.** "Listed under `objects/`" doesn't say whether keys below it
    (`objects/x/y`) or non-hex names count. I count only 64-lowercase-hex names directly under
    it (G08).
13. **`BY` and `OS` across tools.** Dead-lock judgement needs `BY`, `OS` and `PIDNS` equal to the
    lock's own. The spec gives s3cab's spelling (Node's `os.userInfo().username`, `os.hostname()`,
    `process.platform`) but says another tool "writes whatever names its user and machine best",
    so two tools on one machine can never judge each other's dead locks. Python's
    `getpass.getuser()`, `socket.gethostname()` and `sys.platform` happen to match Node on
    darwin, linux and win32, not on the BSDs or Solaris.
14. **`@SET ENDPOINT` "when it isn't AWS's default".** How a boto3 program knows is unstated; I
    write it only when `AWS_ENDPOINT_URL[_S3]` is set, which it wasn't (G06).
15. **Where the per-path checks the writer must make are listed.** "Give each path at most one
    per-path row" is in the writing checklist with no indication that a plain walk already
    guarantees it once the member directories are distinct and non-nested; I added a self-check
    anyway before uploading.

## Hints that would have helped

- **`os.kill(pid, 0)` on Windows terminates the process** (Python's documented behaviour for any
  signal other than the console events). The lock rules ask you to test whether a PID is alive;
  on Windows that needs `ctypes` `OpenProcess` plus `GetExitCodeProcess`. One line in the locks
  hints would have saved a dangerous mistake for anyone porting a POSIX probe.
- **`os.path.normcase` is a no-op on macOS**, so a case-insensitive comparison of two spellings
  of one path must go through `os.stat` and `os.path.samestat` (or lower-case both). This bit me
  when wiring the `F_GETPATH` fallback the spec recommends (O02).
- **The `stat` module's `IO_REPARSE_TAG_*` constants exist only on Windows builds of Python**, so
  portable code must use the literal values `0xA000000C` and `0xA0000003` or `getattr`.
- **Recursion depth and `PATH_MAX`.** A recursive walk hits Python's recursion limit at about a
  thousand levels; use an explicit stack. macOS limits an absolute path passed to a syscall to
  1024 bytes, Linux to 4096, and a tree can be deeper than that (made with relative paths), in
  which case no absolute-path writer can open it. The spec records absolute paths and says nothing.
- **`/tmp` is a symlink to `/private/tmp` on macOS**, so any test comparing a typed path with a
  recorded real path fails silently. My first change-detection tests never fired for that reason.
- **botocore 1.43 reads a `put_object` body once when `ChecksumSHA256` is supplied** (one
  `seek(0)`, two `tell()`), not the "two and seven passes" measured in the spec; the advice to
  reset the digest on `seek(0)` is still the right design (O04).
- **The exact S3 answers**, for anyone matching error codes: a wrong `ChecksumSHA256` is
  `400 BadDigest` "The SHA256 you specified did not match the calculated checksum", sent once in
  standard retry mode; `If-None-Match: *` on an existing key is `412 PreconditionFailed`;
  `head_object` on a missing key raises code `'404'`, `get_object` `NoSuchKey`; a multipart
  object's `ChecksumSHA256` reads `<base64>-3` with `ChecksumType COMPOSITE` (O05 to O08).
- **`str.ljust` counts code points**, which is what the canonical form defines a width as; a
  terminal shows `🎉` two columns wide, so the padded table looks misaligned and isn't wrong.
- **Already-stored content is not re-checked, so a change-detection test needs content the bucket
  has never seen.** The spec says this in passing in the writing checklist; a sentence under
  "what trips people up" would stop a tester from drawing the wrong conclusion (O09).
- **A deleted-then-recreated `.info`** has to be re-read by the writer anyway; the spec's "refuse
  when it is gone, too" is clear, but it would help to say the kept pair should be dropped then.

## Environment notes, not the format

- Requests reach AWS only through the proxy in `HTTPS_PROXY`; boto3 honours it with no code. The
  `aws s3 ls` command works through it, but `aws s3 cp ... -` failed with
  `AWS_IO_TLS_ERROR_NEGOTIATION_FAILURE` (the CLI's CRT transfer client), so every download in
  this exercise went through boto3 (N02).
- boto3 built without credentials in the environment tried the EC2 metadata endpoint
  `169.254.169.254`, which the sandbox denies; harmless, but it shows up as a sandbox violation
  if `credentials.env` isn't sourced first (N01).
- The sandbox refuses to list `/Users/Shared/s3cab.sandbox`, the fixtures' parent. That is what
  exercised the `F_GETPATH` fallback for a parent that can't be listed; the final runs name the
  directories in their on-disk case, so it didn't affect them (N05).
- `python` is not on PATH here; `python3` is 3.15.2 from Homebrew, boto3/botocore 1.43.123. The
  local time zone is UTC (`/etc/localtime` -> `/var/db/timezone/zoneinfo/UTC`), so every
  snapshot's `START` zone reads `UTC` and the names are UTC minutes.
- The fixtures volume is APFS: case-insensitive and normalization-insensitive, so a differently
  cased or NFD-spelled path opens the same file; names that aren't UTF-8 can't exist on it, so the
  "no UTF-8 form" stop rule could not be exercised, only unit-checked.
- zsh does not word-split an unquoted variable; my first `spread` loop passed both directories as
  one argument and the program correctly refused a non-existent directory. macOS `cat` has no
  `-A`. `os.makedirs` recurses per level, which broke my first deep-tree test, not the walker.
- The nine final runs took about two and a half minutes in all (first `.info` claimed 03:48:36Z,
  last 03:51:03Z), most of it the 1100 sequential PUTs for `bulk` (one request per object, no
  parallelism, as asked).
- Probe keys written during development went under `.s3cab-backup-py/probe/` (my client's own
  folder) and were deleted; the bucket was then emptied before the final runs.
