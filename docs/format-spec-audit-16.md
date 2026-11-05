# The format-spec clean-room audit, run 16: backup on Linux, Fable 5.1 at xhigh (2026-11-04)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on Linux (this
run), [macOS](format-spec-audit-17.md) and [Windows](format-spec-audit-18.md); restores on
[Linux](format-spec-audit-19.md), [macOS](format-spec-audit-20.md) and
[Windows](format-spec-audit-21.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/linux/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 3 moves flagged, each a heredoc writing the session's own files (its program, its
  verifier, its report), caught only by the word "s3cab" in them; the judge found all three
  harmless.
- **Tokens:** input 1,186, cache write 256,192, cache read 4,833,455, output 128,575.

Everything below the rule is the session's own report, verbatim.

---

# Report: an s3cab backup written from `format.md` alone

Deliverables in this directory:

- `s3cab-backup.py`: the backup program, `python s3cab-backup.py <bucket> <set> <dir>...`.
  Python 3 standard library plus boto3, nothing else. One file.
- `s3cab-backup.state/<bucket>/<set>.info`: the only thing the spec says a backup keeps
  between runs, the `OWNER`/`CLAIMED` pair of each set this program claimed, kept beside the
  program as a copy of the `.info` it wrote.
- `verify-bucket.py`: the independent reader I used to check the bucket after each run. Its
  own parser, its own walk, `datetime` instead of the day-count arithmetic, every statement
  from a real request.

## What the bucket holds now

Final runs: bucket emptied, then the final program run once per set with exactly the command
line in the task and the directories `ENVIRONMENT.md` names. Verified afterwards over the
network: 1314 keys, no locks, no stray keys, 1296 objects, every referenced object present,
no orphan, every object downloaded and found to hash to its key, none with `Content-Encoding`
or metadata, every snapshot's file rows equal to an independent walk of the directory (hash,
size, millisecond mtime, path), every `#error` row matching what the walk predicts, every
`.info` well formed and equal to the kept state.

| set | snapshot | file rows | `#error` rows | exit |
| --- | --- | --- | --- | --- |
| edge | `snapshots/edge/20261104T0311.tsv.gz` | 61 | 3 (two links out of the backup, one unreadable file) | 1 |
| docs | `snapshots/docs/20261104T0311.tsv.gz` | 120 | 0 | 0 |
| bulk | `snapshots/bulk/20261104T0312.tsv.gz` | 1100 | 0 | 0 |
| media | `snapshots/media/20261104T0313.tsv.gz` | 2 (the 40 MiB file went up in three parts) | 0 | 0 |
| hollow | `snapshots/hollow/20261104T0313.tsv.gz` | 0 | 0 | 0 |
| spread | `snapshots/spread/20261104T0313.tsv.gz` | 13 (two `@SET DIR` rows) | 0 | 0 |
| faults | `snapshots/faults/20261104T0313.tsv.gz` | 3 | 0 | 0 |
| corrupt | `snapshots/corrupt/20261104T0313.tsv.gz` | 3 | 0 | 0 |
| scans | none: stopped, `scan-\xff.txt` has no UTF-8 form | | | 2 |
| ledger | none: stopped, `q1<TAB>2026.txt` has a tab in its path | | | 2 |

All ten sets have a `snapshots/<set>.info`. `scans` and `ledger` are the two cases the spec
says must stop without a snapshot; the program names the entry and exits 2. Their `.info` exists
because the program claims the set before walking (see guess 1 below).

Exit status: 0 uploaded and clean, 1 uploaded with `#error` rows (as s3cab), 2 stopped or
refused with nothing written.

## How every stored object is the bytes its key names

- The walk opens each file, takes size and `st_mtime_ns` from `fstat` on that handle, hashes
  what it reads, and gives an `#error` row when the byte count differs from the size.
- Objects are uploaded after the walk and before the snapshot. The program lists `objects/`
  once and sends only hashes the listing lacks; a 412 on the conditional PUT also counts as
  stored. Nothing is trusted from an earlier snapshot and nothing is downloaded to check.
- Just before sending, the file is stat'ed again and its size and millisecond mtime compared
  with the row. A difference stops the run with no snapshot (tested: a file appended between
  the walk and the upload gave "changed since it was read", exit 2, no object, no snapshot,
  no lock left).
- A file under 16 MiB is read whole, hashed, compared with the key, and sent as one PUT with
  `ChecksumSHA256` set to the key's digest, so S3 itself refuses bytes that don't hash to the
  key and stores nothing (probed: a wrong digest gave `400 BadDigest` and a HEAD afterwards
  found no key). The PUT's response echoes the checksum, which the program compares again.
- A file of 16 MiB or more goes up in parts of 16 MiB (more for a file over 160 GiB), each
  with its own `ChecksumSHA256`, the whole file hashed from the same bytes, and
  `CompleteMultipartUpload` sent only when that hash equals the key; otherwise the upload is
  aborted. `media/clip.bin` went this way; S3 reports its checksum as `COMPOSITE` ending `-3`.
- Every PUT carries `If-None-Match: *` (added in a `before-call` handler, since this boto3
  has no parameter for it), so nothing is ever overwritten: objects, snapshot, `.info`, lock.
- The snapshot text is run through the program's own reader check before compression
  (heading, `.`, five fields, known types, one `SPEC`/`NAME`/`VERSION`, file-row grammar,
  every row strictly under a `DIR`, one row per path, no path through another).
- The holder is checked immediately before the snapshot PUT, the snapshot is a conditional
  PUT, and the upload lock is written first and removed last.

## Would leave a backup that can't be restored correctly

Ranked by how much of a backup a wrong guess would cost.

1. **The `@SET DIR` row for a filesystem root.** Two rules collide for `/`: a `DIR` is
   "its real path ending in a separator", and a POSIX real path is written "with exactly one
   `/`, never with two: a reader takes a path starting with two separators for a Windows
   share". A writer that follows the first rule literally writes `//`, which matches no POSIX
   path, so every file row of the backup is "under no `DIR`" and refused. The spec never says
   which spelling a root takes. Guess: write `/` (and `C:\`), adding a separator only when
   the real path doesn't already end in one. Audited by unit test: the row value for `/` is
   `/`. Not audited against a real root backup. My own self-check in the program is lenient
   here (it accepts `//` as a POSIX `DIR`, a spec-following reader would not), so the guard
   is the writer, not the check.

2. **A writer-side invariant that is only ever stated in a shell hint: every file row's path
   must begin with its `DIR` string.** The reading rules say a file row is matched to a
   `DIR` "by whole segments, exactly" on POSIX, but the writing checklist never says that the
   rows must be built by joining names onto the `DIR` as written. A writer that resolves the
   `DIR` one way (real path, case fixed up as the spec asks on macOS) and builds row paths
   another (from the path as typed, or before the fix-up) leaves every row under no `DIR`,
   refused whole, with nothing to say why. Guess: rows are built from the `DIR` string plus
   listed names, so they agree by construction. Audited: the verifier checks every row
   starts with its `DIR` plus a separator; all 1302 rows did.

3. **A link to a directory outside the backup must have its `#error` row end with a
   separator.** This is stated, but in the row-types section, three sections away from the
   links table and the writing checklist, which only says "End a directory's path with a
   separator, and a link's when its target is a directory". I got it wrong in the first
   version and only the verifier caught it. Not a gap in the rule, a gap in where it is: the
   writing checklist's link bullet should say it. Audited: the first edge snapshot had
   `link-out-dir` without the separator; the final one has `link-out-dir/`.

4. **What the writer does after "don't send it".** The uploading checklist says of a file
   whose size or time changed since its row: "don't send it", and only in a later bullet
   "Either way, don't upload the snapshot". Read on its own, the first bullet invites a
   writer to skip the object and carry on, leaving a snapshot that names an object the
   bucket lacks: an unexplained miss, read as damage. Whether the run should fail, re-read
   the file, or re-walk is not said. Guess: stop with exit 2 and no snapshot. Audited by the
   changed-file test above.

## Would inconvenience the implementer

1. **When to claim `snapshots/<set>.info`.** "Claim whenever you like before the first
   snapshot's upload." A run that stops (tab in a name, undecodable name, unlistable
   directory) therefore either leaves a `.info` or not, depending on the writer. Guess:
   claim right after the lock, before the walk, as s3cab claims at set-up; the spec itself
   describes "a `.info` with no snapshots" as "a set whose first backup stopped". Audited:
   `scans` and `ledger` have a `.info` and no snapshot.

2. **A set with snapshots and no `.info`.** One passage says claim "only while
   `snapshots/<set>/` holds no snapshot, and refuse the name otherwise"; another says such a
   set "is taken over by creating one with a conditional PUT", and takeover happens "only
   when asked". A plain backup tool with no takeover command can therefore never back the
   set up again, and the spec doesn't say that is intended. Guess: refuse. Audited: deleting
   a scratch set's `.info` and re-running gave "has 1 snapshot(s) but no .info ... no holder
   until one takes it over", exit 2.

3. **Judging dead locks versus refusing on any `delete-` lock.** The checklist says "On any
   `delete-` lock, remove your own and refuse" and, in the next bullet, that a lock of your
   own machine whose process is gone "is a dead run's: remove it". Which comes first is not
   said; a writer that refuses first is blocked by its own dead `delete-` lock until
   someone runs `unlock`. Guess: judge every lock first, then refuse on the `delete-` locks
   left. Audited: a dead `upload-` lock with this machine's `BY`, `OS` and `PIDNS` and a
   dead PID was removed and the run went on, while a live-looking lock of another machine
   was left alone; a `delete-` lock of another machine made the run refuse and remove its
   own. A dead `delete-` lock of this machine was not tested.

4. **The `OS` value for a tool that isn't s3cab.** "A name for the operating system"; s3cab
   writes Node's `process.platform`. Since locks are judged only when `OS` is equal, two
   tools that pick different names (`linux` versus `Linux`) never clear each other's dead
   locks. Guess: Python's `sys.platform`, which happens to be `linux`, `darwin` and `win32`
   like Node's. Audited only on Linux (the lock test above matched on `OS=linux`).

5. **412 on the `.info` claim after a lost response.** The read-back rule ("your own bytes
   mean your own write") is given for locks only. Guess: apply it to the claim too. The
   path was not exercised.

6. **412 on `CompleteMultipartUpload`.** The checklist lists "a conditional PUT to its key
   refused with 412" as proof an object is stored, but says nothing for a multipart
   completion refused the same way. Guess: treat it the same and abort the upload. Not
   exercised.

7. **A third-party `@CLIENT NAME`.** The spec says lowercase letters, digits and hyphens,
   and that other `@CLIENT` rows belong to the named tool, but not whether a name must differ
   from `s3cab` nor whether s3cab checks `NAME` before reading `@CLIENT HOME` or `EXCLUDE`.
   Guess: `s3cab-backup`, and write no other `@CLIENT` row. Audited: the snapshots carry
   exactly `NAME` and `VERSION`.

8. **An entry listed as a file that is no longer a regular file when opened** (replaced by a
   FIFO or a directory in between). The checklist gives `#error` for "a file that couldn't
   be read or had vanished by then" and no row for a pipe. Guess: `#error`, "not a regular
   file when opened". Not exercised.

9. **An entry whose `lstat` fails with something other than not-found.** "An entry whose
   type couldn't be determined" gets `#error`; whether a not-found at that moment is the
   "vanished between being listed and its type being known" case (no row) had to be
   inferred. Guess: not-found gives no row, any other failure an `#error`. Not exercised.

10. **A directory whose own name holds a tab.** The stop rule is about files that would get
    a `-` row. Guess: walk it; an empty one leaves no trace, one holding a file stops the run
    at that file. Audited: a scratch set with an empty `t<TAB>d` directory produced a
    snapshot, and one with a file inside stopped with the file's path spelled out.

11. **Fixing a name's case on a case-insensitive volume.** The spec says `realpath` keeps
    the case as typed on macOS and tells the writer to "look each name up in its parent's
    listing", but not how to find the matching entry when the volume also ignores Unicode
    normalization, where neither an exact nor a case-insensitive string comparison is
    guaranteed to find it. Guess: match by device and inode. The fallback branch never ran
    here (ext4 lists every segment exactly) and is untested.

12. **A lock whose `PID` is missing or not a number.** Not covered. Guess: never judged.
    Not exercised.

## Hints that would have helped

- **Python buffers stdout when piped.** A "stopped" line on stderr lands before the stdout
  lines that explain it, which confused my first reading of the ledger and scans runs.
  `sys.stdout.reconfigure(line_buffering=True)` fixes it.
- **A lone surrogate can't be printed even to a UTF-8 stream.** On Linux an undecodable
  name arrives as `\udcff`, and `print()` raises `UnicodeEncodeError` after
  `reconfigure(encoding="utf-8")` (checked). The spec's hint covers the cp1252 case only.
  Use `errors="backslashreplace"`, or print the U+FFFD form the spec gives.
- **How to ask whether a lock's process is gone.** The rule says a lock is judged by its
  process, but gives no call. POSIX: `os.kill(pid, 0)`, where `PermissionError` means alive
  and `ProcessLookupError` gone. Windows: `OpenProcess` with
  `PROCESS_QUERY_LIMITED_INFORMATION` then `GetExitCodeProcess`, `STILL_ACTIVE` is 259,
  via `ctypes` (written, not run).
- **`os.walk` lists a symlink to a directory in `dirnames`, not `filenames`, even with
  `followlinks=False`.** A writer that only checks `filenames` for links never sees a
  directory link leading out of the backup, so no `#error` row and exit 0. I used
  `os.scandir` with one `lstat` per entry in the program and had to work around it in the
  verifier.
- **Year 0000 and pre-1970 instants.** `datetime` stops at year 1 and `strftime` doesn't pad
  years under 1000 (both in the spec). What isn't: Howard Hinnant's days-to-civil arithmetic
  gives the proleptic Gregorian date for any day count, and Python's floor `divmod` keeps the
  milliseconds non-negative before 1970. Unit-tested on 0000-01-01, 0000-02-29,
  1969-12-30T23:59:59.750Z and 9999-12-31T23:59:59.999Z.
- **The trim set in Python is `str.strip(chars)` with the spec's list spelled out.** The spec
  says what `strip()` gets wrong but not that `strip` with an explicit argument is the fix.
  Checked: U+0085 and U+001C kept, U+FEFF and U+3000 removed.
- **`O_NOFOLLOW`, `O_NONBLOCK` and `O_CLOEXEC` don't exist on Windows.** A portable open
  needs `getattr(os, name, 0)`.
- **A `DirEntry`'s `stat(follow_symlinks=False)` with `stat.S_ISLNK`/`S_ISDIR`/`S_ISREG`
  gives one code path for the type on every OS,** and on Windows its `st_reparse_tag`
  tells a junction from a symlink without `os.path.isjunction()`.
- **`CreateMultipartUpload` must be given `ChecksumAlgorithm="SHA256"` for the parts to
  carry `ChecksumSHA256`.** Worked with it set; I did not test without it.
- **A `PutObject` response echoes the `ChecksumSHA256` S3 verified,** which confirms the
  check without the `head_object` the spec suggests. Seen on the probe PUT.
- **`ChecksumType` is not in botocore 1.34's `HeadObject` model** while the aws CLI 2.38
  shows `COMPOSITE` or `FULL_OBJECT`; with this boto3 only the `-<parts>` suffix the spec
  mentions tells the two apart. Checked both ways.
- **`time.localtime()` honours `TZ` on POSIX,** so the zone name in `START` should come from
  `TZ` when it is set, whatever its form, and from `/etc/localtime` only when it isn't; my
  first version could mint the name under `TZ=EST5EDT` and label it `Etc/UTC`.

## Environment notes, not the format

- Python 3.12.3, boto3 1.34.46 and botocore 1.34.46 on Ubuntu 24.04 (Linux 7.0, Azure),
  aws CLI 2.38.5. As the spec predicts for this boto3, `PutObject` has no `IfNoneMatch`
  parameter; `HeadObject` and `GetObject` do. The header is injected in a `before-call`
  handler for `PutObject` and `CompleteMultipartUpload`.
- The proxy in `HTTPS_PROXY` is honoured by botocore and the aws CLI without code. Every
  request in this report went through it to AWS.
- Credentials from `credentials.env`; `s3:GetBucketLocation` is denied to the role but
  isn't needed. No 403 appeared before the stated expiry.
- The bucket carries a lifecycle rule (`expire-test-objects`, shown as an `Expiration`
  header on HEAD) that will remove keys after 2026-11-06. That is the bucket's own business.
- S3 behaviour confirmed by probe: `If-None-Match: *` gives `412 PreconditionFailed`; a
  wrong `x-amz-checksum-sha256` gives `400 BadDigest` and stores nothing; a HEAD miss has
  botocore error code `404`; `put_object` sets no `Content-Type`, so S3 shows
  `binary/octet-stream`.
- Objects are stored in the default class (STANDARD), which a plain GET reads at once; the
  Glacier Instant Retrieval class is s3cab's own choice, and a poor one for a test bucket
  that is emptied the same day. Server-side encryption `AES256` is requested as s3cab does.
- The machine's zone is `Etc/UTC` (`/etc/localtime`, `TZ` empty), so snapshot names equal
  the UTC minute of `START`. The sandbox exposes `/proc/self/ns/pid` as `pid:[4026532332]`.
- The fixtures root holds a `.claude/` directory and a `.mcp.json` character device, outside
  every member directory, so neither was walked.
- Sequential uploads through the proxy: 1100 small objects in about 65 seconds, the 40 MiB
  multipart object in under 3 seconds.
- Everything the program writes is under this directory (`s3cab-backup.state/`); nothing in
  the home folder or in temp. The scratch directories for the behaviour tests were under
  `$TMPDIR` and were removed, and the scratch sets and their one orphan object were deleted
  from the bucket before the final emptying.

## What was not tested

- Windows and macOS code paths: `\\?\` prefixes, drive letters, UNC shares, junctions via
  `st_reparse_tag`, `icu.dll` for the zone name, `OpenProcess` for lock PIDs, and the
  inode-based case fix-up. All are written from the spec's hints and compile, but only the
  Linux paths ran.
- The retry paths: a lock PUT refused with another run's bytes, a `.info` claim refused
  after a lost response, a 412 on `CompleteMultipartUpload`, a `BadDigest` on a part.
- An entry vanishing between listing and type check, an entry whose `lstat` fails, a file
  replaced by a non-file between the walk and the open, a dead `delete-` lock of this
  machine, a lock with no parseable `PID`, a `TZ` that names a zone on Windows.
- A backup whose member directory is `/`.

Behaviour tests that did run against the real bucket, with scratch sets since removed:
unlistable directory (stop), member directory that is a symlink (followed, real path in
`DIR`), links into the backup, a self link and a broken link (no rows), a link named with a
tab to a folder outside (row spelled `tab␉link/`), a link to a FIFO (no row), a file name
holding CR and one holding LF (stop), a relative member directory (real path), a file changed
between walk and upload (stop, nothing stored), a `delete-` lock (refuse), a dead own
`upload-` lock (removed) beside a live foreign one (kept), a tampered holder pair (refuse,
state forgotten), `.info` gone with snapshots present (refuse), stale state with an emptied
bucket (fresh claim), a second run in the same minute (refuse), a later-minute run (every
object already stored, new snapshot).
