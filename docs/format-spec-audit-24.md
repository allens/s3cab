# The format-spec clean-room audit, run 24: backup on Windows, Fable 5.1 at xhigh (2026-11-09)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on
[Linux](format-spec-audit-22.md), [macOS](format-spec-audit-23.md) and Windows (this run); restores
on [Linux](format-spec-audit-25.md), [macOS](format-spec-audit-26.md) and
[Windows](format-spec-audit-27.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/windows/s3cab-backup.py), Python with
  boto3, and `ctypes` for the Windows calls. Its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged. The session hit the plan's 5-hour limit in a
  last edit of its report, after the program and the report were finished, so CI reads the run as
  failed; the check, the audit and the judge ran on what it left.
- **Tokens:** input 1,154, cache write 253,612, cache read 5,183,171, output 145,097.

Everything below the rule is the session's own report, verbatim.

---

# Report: an s3cab backup written from `format.md` alone

Spec read: `format.md`, "the spec of 2026-10-30". Nothing else about the format was consulted.
Program: `s3cab-backup.py` in this directory. State it keeps between runs: `s3cab-backup-state/`
beside it (the `OWNER`/`CLAIMED` pair per bucket and set in `holders.json`, and a local copy of
each snapshot it wrote). Helper scripts and the raw outputs quoted below are in `scratch/`.

## What was built

`python s3cab-backup.py <bucket> <set> <dir>...` does, in this order:

1. Checks the set name, reads one clock value for `START` and the snapshot name, resolves each
   member directory to its real path through `\\?\` (trailing dot kept, on-disk case, drive
   letter upper-cased), and stops if one is missing, isn't a directory, lies inside another, or
   is the same directory twice.
2. Writes `locks/upload-<instant>` with a conditional PUT, then lists `locks/`: removes a lock of
   its own `BY`/`OS`/`PIDNS` whose process is gone (checked with `OpenProcess` on Windows,
   `kill(pid, 0)` elsewhere), and refuses on any other `delete-` lock.
3. Lists `snapshots/<set>/`, then claims or checks `snapshots/<set>.info` against the kept pair.
   A set held by someone else, or with snapshots but no `.info`, is refused unless `--take-over`
   is given (an optional flag beyond the required command line; the final runs didn't use it).
   Refuses early if this minute's snapshot name already exists.
4. Walks every member directory with `os.scandir` through `\\?\`, never following links. Stops on
   a name with no UTF-8 form, a regular file whose path holds a tab, CR or LF, or a directory it
   can't list. Links get a row only per the spec's table (`#error` for one leading out of the
   backup, path ending in a separator when the target is a directory; nothing for broken links
   or links into the backup). Pipes, sockets and devices get no row.
5. Hashes each file from an open handle: `fstat` for size and `st_mtime_ns`, nanoseconds rounded
   to the millisecond with ties later, year checked against 0000..9999, bytes counted against the
   size. Failures become `#error` rows among the file rows.
6. Lays the snapshot out canonically (column 2 padded to 64 code points, column 3 left-padded to
   12, column 4 to 24, last column verbatim), gzips it as one stream with an empty name and
   mtime 0, reads it back the way a reader would (heading, `.`, no blank line, known types) and
   refuses to upload its own output if that check fails, then writes the local copy with
   `O_EXCL`.
7. Lists `objects/` and sends each content not listed, from the first path that holds it: re-checks
   size and millisecond mtime against the row, hashes the whole body before sending, sends it
   with `ChecksumSHA256` of the key's digest and `If-None-Match: *` (files of 16 MiB or more go in
   16 MiB parts, each with its own SHA-256, and the upload is completed only if the whole-file
   hash equals the key, otherwise aborted). Nothing is stored under a key its bytes don't hash to.
   A file that changed is reported, the rest are still sent, and the snapshot is not uploaded.
8. Reads `.info` again immediately before the snapshot upload and refuses unless `OWNER` and
   `CLAIMED` match the kept pair. Uploads the snapshot with `If-None-Match: *`; on 412, the same
   bytes count as uploaded, different bytes are a refused conflict.
9. Removes the lock in a `finally`, success or failure. Exit 0 only when the snapshot was
   uploaded and holds no `#error` row; 1 otherwise.

Every PUT on AWS asks for `ServerSideEncryption: AES256`, sets no `Content-Type`, no
`Content-Encoding` and no metadata, and uses the default storage class (STANDARD, which a plain
GET reads at once; Glacier Instant Retrieval was not copied because of its billing minimums,
which the spec itself flags).

## What was verified, against the real bucket

The bucket was emptied (`scratch/empty_bucket.py`, 1290 keys deleted) and the program run once per
set with exactly the task's command line (`scratch/final-runs.ps1`, output in
`scratch/final-runs.txt`). The bucket was left as those runs left it.

| set | member directories | exit | file rows | bytes | result |
| --- | --- | --- | --- | --- | --- |
| edge | fixtures\edge | 1 | 31 | 1050347 | uploaded; 3 `#error` rows (junction and two links out of the backup) |
| docs | fixtures\docs | 0 | 120 | 38110 | uploaded |
| bulk | fixtures\bulk | 0 | 1100 | 23090 | uploaded; `objects/` listing paged past 1000 |
| media | fixtures\media | 0 | 2 | 42467328 | uploaded; the 40 MiB file went as 3 parts |
| hollow | fixtures\hollow | 0 | 0 | 0 | uploaded; an empty set is a legal snapshot |
| spread | fixtures\spread\alpha, fixtures\spread\beta | 0 | 13 | 451 | uploaded, two `@SET DIR` rows |
| faults | fixtures\faults | 0 | 3 | 101 | uploaded |
| corrupt | fixtures\corrupt | 0 | 3 | 118 | uploaded |
| scans | fixtures\scans | 1 | – | – | stopped: `scan-\ud800.txt` has no UTF-8 form; `.info` claimed, no snapshot |

Checks run afterwards, all by real requests:

- `scratch/verify.py` (a reader written from the spec's reading checklist) fetched every snapshot
  and every `.info`: gzip framing with `zlib.decompressobj(31)` stream by stream, strict UTF-8,
  split on LF only, heading row, `.` last, five fields, trimmed leading fields, canonical layout
  recomputed from each row's fields and compared with the line, hash/size/instant grammar, every
  file row under a `@SET DIR` by whole segments, one row per path, no path running through
  another, `FILES` and `SIZE` recomputed. Then it downloaded every referenced object and hashed
  it. Result (`scratch/verify-final.txt`): 1285 keys, 1268 objects, 1272 file rows, "no problems
  found", 0 missing, 0 wrong. Every stored object and snapshot shows `ContentType=binary/octet-stream`,
  `SSE=AES256`, a `FULL_OBJECT` SHA-256 (the 40 MiB object shows `COMPOSITE` and an ETag ending
  `-3`), no `Content-Encoding`, no metadata.
- `scratch/crosscheck.py` re-hashed every one of the 1272 recorded files from disk through `\\?\`
  and compared hash, size and millisecond-rounded mtime with its row: 0 mismatches. A fresh
  `os.walk` with reparse points pruned counted the same number of regular files per set.
- `scratch/localvsbucket.py`: all 8 local snapshot copies are byte-identical to the bucket's.
- `locks/` is empty; no multipart upload is left open.

Rows worth pointing at in the `edge` snapshot (`scratch/edge-final.tsv.txt` is the final one,
decompressed, tabs shown as `⇥`): ` both ends.txt ` and `trailing.txt ` keep their spaces;
`notes.` keeps its dot; `CON`, `aux.txt` and `nul.txt` are read through `\\?\`; the 339-character
`deep.txt` path is recorded;
`café.txt` appears twice (NFC and NFD), `case\Case.txt` and `case\case.txt` both appear (the
directory is case-sensitive, confirmed with `fsutil`); `hard-a.txt` and `hard-b.txt` are two rows
with one hash; `empty.txt` is `e3b0…b855`; `next\x85line.txt` holds U+0085; `mtime-1970s.txt` is
`1970-01-02T00:00:00.000Z`, `mtime-2038.txt` is `2038-01-19T03:14:08.000Z`, and
`mtime-rounds-up.txt` (NTFS value …0.9996 s) is `2017-07-14T02:40:01.000Z`. `link-dangling`,
`link-to-plain` and `link-to-sub` have no row; `junction\` and `link-out-dir\` have `#error` rows
ending in a separator, `link-out-file` one without.

Scenario harness (`scratch/scenarios.py`, `scenarios2.py`, `units.py`; outputs in
`scratch/scenarios-1.txt` and `scenarios-2.txt`): 72 checks. Four failed on their first run, all
four because of the harness itself (three Python traps listed under hints, and one wrong
expectation about which of two refusals comes first); each was rewritten and passes. They cover: missing, file, nested and same-in-two-spellings
member directories; bad set names; a symlink and a junction as member directory recorded as
their targets; a relative argument to a trailing-dot directory; a live foreign `delete-` lock
refusing the run and leaving no `.info`; own dead `upload-` and `delete-` locks removed; locks
never judged when `OS` differs or is absent or `PID` has a leading zero; a foreign `upload-` lock
not blocking; a foreign `.info` refusing before the walk; `--take-over` keeping `CREATED`;
snapshots with no `.info` refused and taken over with `CREATED` equal to `CLAIMED`; `.info` swapped
between the walk and the publish refusing the snapshot and forgetting the pair; a stale kept pair
forgotten; three files changed between hashing and upload (grown, same-size rewrite with the
mtime restored, and a 20 MiB same-size rewrite) all refused with nothing stored under their
keys and the multipart upload aborted while the unchanged file was still sent; a second run in
the same minute refused; a re-run of `docs` sending nothing; a file denied by ACL getting an
`#error` row with the snapshot still uploaded and exit 1; a planted snapshot with different bytes
at this minute's key refused on the 412; the same bytes counting as uploaded; and the pure
functions (calendar for years 0000..9999 against `datetime` where it exists, rounding ties, the
readable size at every boundary the spec names, path kinds, segment matching, canonical widths in
code points, the trim set, `.info` parsing).

Not exercised, so not claimed: the Linux and macOS branches (case fix-up from the parent listing,
`/etc/localtime`, `kill(pid, 0)`, `PIDNS`) only compile; UNC, mapped and `subst` member
directories; a volume with no drive letter (only that `realpath` raises for a fake GUID path);
a file another program holds open without sharing (winerror 32); names with a tab, CR or LF
(Windows won't create them); a size mismatch during hashing (only a change between hashing and
upload was simulated); a lock that can't be removed; a 409 conflict on a conditional PUT; two
backups running at once.

## Would leave a backup that can't be restored correctly

Ranked by how likely a second implementer, reading the same text, would diverge from s3cab's
reader in a way that loses or misrecords content. Each entry says what I guessed. The list is
short because the spec pins down nearly every rule; every backup written here restored cleanly
under my own reader, so these are divergence risks, not known faults.

1. **The two vanish windows are defined by API shape, so the same event is recorded differently
   per platform and per design.** "An entry that vanishes between being listed and its type being
   known gets no row; a file that vanishes after that gets an `#error`." With `os.scandir` on
   Windows the type arrives with the listing, so the first window is empty and every vanished
   file is an `#error` with exit 1; on POSIX the `lstat` that discovers the type can fail, and the
   same file is silently absent with exit 0. A two-pass tool (walk, then hash) widens the
   `#error` window further. The spec doesn't say which outcome it wants for a file the walk saw
   and the hasher didn't, so one tool reports a silent omission that another reports as an
   error. Guessed: whatever the OS reports; after the walk everything is `#error`.
2. **Nested or duplicate member directories must be compared as real paths, but the checklist
   reads as if the arguments were compared.** One sentence says "a link, a junction or a difference
   in case makes two spellings one directory"; the checklist item says only "compare their real
   paths". A writer that compares what was typed would write one tree twice when a member
   directory is a link into another, and the reader then refuses every duplicated row. Guessed:
   resolve each argument first, then compare by whole segments; refuse equal or nested.
   Verified: `edge` and `edge\sub`, and `edge` spelled two ways, are refused; a symlink and a
   junction given as member directories are recorded as their targets.
3. **Alternate data streams, extended attributes and file attributes aren't in the list of what
   isn't stored.** The spec rules out links, hardlink identity, empty directories, permissions and
   ACLs. It is silent on NTFS alternate data streams, macOS resource forks and xattrs, and the
   hidden/system/read-only bits. Guessed: main-stream content only, as "file content, not the
   filesystem around it" implies. A user who reads the spec's list expects those to be kept, and
   a restore from this backup loses them without a word.
4. **The row for an entry whose type can't be determined.** The checklist asks for an `#error`; the
   row-types table doesn't say whether its path ends in a separator (the writer can't know).
   Guessed: no separator. A reader doesn't check a `#` row's segments, so only a tool that acts on
   `#error` paths would see the difference.

## Would inconvenience the implementer

1. **A local copy of a snapshot whose upload was refused.** When a file changes between hashing and
   sending, the spec says not to send it and not to upload the snapshot; the file already written
   locally names a hash the repository doesn't hold. The spec is silent on whether to keep it.
   Guessed: keep it (a person can read the rows) and never let a local copy prove anything is
   stored; the spec does say an earlier snapshot counts only when "still in the bucket", but in a
   subordinate clause. It also means a retry in the same minute is refused by the local copy.
2. **Link kinds by reparse tag.** The spec gives the junction's tag (`0xA0000003`) but not the
   symlink's (`0xA000000C`, measured here), and says other reparse points are ordinary files and
   directories without saying how to recognise them from Python. Guessed: trust
   `DirEntry.is_symlink()` and `is_junction()` and treat everything else as ordinary. Only
   symlinks and junctions were available to test.
3. **When to claim `.info`.** "Claim whenever you like before the first snapshot's upload"; a run
   that stops before writing a snapshot then leaves a `.info` with no snapshot (the `scans` set
   here). The spec acknowledges the state but gives no recommendation. Guessed: before the walk,
   like s3cab.
4. **The `CLAIMED` instant.** "When the holder claimed the set": the moment of the PUT, or the
   run's `START`? Guessed: a fresh clock reading at the PUT.
5. **409 `ConditionalRequestConflict`.** S3 answers 409, not 412, when two conditional writes to
   one key overlap; the spec mentions only 412. Guessed: retry with a short back-off, then treat
   as a conflict. Not exercised.
6. **A 412 on `CompleteMultipartUpload` leaves the multipart upload open.** The spec counts that 412
   as "already stored" but doesn't say to abort the upload, whose parts are otherwise billed until
   a lifecycle rule removes them. Guessed: abort it.
7. **Keying the kept pair by bucket and set omits the endpoint.** The spec says "a set's name says
   nothing without its bucket, so key it by both", while its own `@SET ENDPOINT` text says a
   bucket name alone doesn't say where it is. Guessed: key by `s3://<bucket>/<set>`; two providers
   with one bucket name would collide.
8. **The lock's instant after a 412 with foreign bytes.** "Take a fresh one and write again" means
   the lock's instant no longer equals `START`, which the spec allows ("the lock's own") but a
   reader of `locks/` might expect to match `STARTED`. Guessed: `STARTED` carries the fresh instant.
9. **"Hash the bytes as you send them" reads as the rule, then the next sentences allow holding a
   plain PUT back whole.** The checklist would be clearer led with "compare the hash with the key
   before the object can become visible, by one of these means". Guessed: hash first, send whole,
   with `ChecksumSHA256` as belt and braces.
10. **The user name for `user@machine`.** `USER`/`USERNAME`, `getpass.getuser()` and `os.getlogin()`
    can disagree (service accounts, sudo), and `OWNER` must be spelled alike on every run of the
    same tool. The spec says "whatever names its user and machine best" without warning that the
    choice must be stable. Guessed: environment first, `getpass` second.
11. **The snapshot-name regex appears only in the reading section.** The claim rule says "no key
    directly there named like one"; the writer has to find "`YYYYMMDDTHHMM.tsv.gz`, digits in those
    places and nothing more" under "Asked for a set's latest snapshot". Guessed: that regex.
12. **The set-name grammar is prose twice, never a pattern.** Guessed `^[a-z0-9]+(-[a-z0-9]+)*$`, so a
    one-character name is allowed.
13. **`FINISH`'s "rounded up" instant when the clock reading is already a whole millisecond.** Round up
    only when a fraction exists; the spec's "upper bound" wording implies it. Guessed: ceiling.
14. **Listing all of `objects/` versus HEAD per object.** The spec names both and says what s3cab
    does; it doesn't say that a conditional PUT alone (no list, no HEAD) is enough for small files,
    though its own "already stored" list implies it. Guessed: one paged listing, then conditional
    PUTs.
15. **No exclude facility means some sets can never exit 0.** `edge` always exits 1 (links out of
    the backup) and `scans` can never be backed up by the required command line (a name with no
    UTF-8 form stops the run; "leaving out is the user's choice"). The fixtures also hold names
    that look like typical excludes (`*.tmp`, `*.swp`, `*.bak`, `.log`, `build`, `cache.bin`); with
    no patterns the spec says to back them up, so everything was backed up.
16. **What I wanted beyond the spec.** The real wording of s3cab's `#error` rows and `FINISH`
    durations (the "anatomy of a snapshot" page), s3cab's exit codes (`output.md`) and exclude rules
    (`exclude.md`). None was needed to write a valid snapshot; all are free text or s3cab's own.

## Hints that would have helped

- **`DirEntry.is_dir(follow_symlinks=False)` is true for a junction**, not just `os.walk`
  descending into one. Test `is_symlink()` and `is_junction()` before `is_dir()`.
- **`os.path.relpath` drops a trailing dot or space too**, because it is built on `abspath`. My
  harness lost `tdot.` that way. Pass the literal string.
- **`gzip.compress()` stamps the current time** into the header, so two compressions of one text
  differ; use `gzip.compress(data, mtime=0)` or `GzipFile(mtime=0)`. The spec's hint covers
  `gzip.open` only.
- **`int(timedelta.total_seconds())` truncates toward zero**, like C's `/`: for a pre-1970 instant it
  is a second late. The spec gives this trap for C; Python has it too. Use `//` on the timedelta.
- **`datetime.strftime("%Y")` pads to four digits on Windows** (year 400 printed `0400` on this
  machine) and doesn't on glibc. The spec states the glibc behaviour as universal.
- **Printing a lone surrogate raises `UnicodeEncodeError` on Windows too**, even on a UTF-8 stream;
  the spec gives this for non-UTF-8 names on Linux. Reconfigure `stdout`/`stderr` with
  `errors="backslashreplace"` before the walk, or the stop message itself fails.
- **PowerShell's `Remove-Item -Recurse` cannot delete a child named with a trailing dot**
  ("Could not find a part of the path"). Python through `\\?\` can. Worth knowing when building
  fixtures on Windows.
- **botocore's names:** a 412 arrives as `ClientError` with `Error.Code == "PreconditionFailed"`;
  a missing key on `get_object` is `NoSuchKey`, on `head_object` `"404"`. `Config(request_checksum_calculation=
  "when_required")` exists only from botocore 1.36; passing `ChecksumSHA256` works before and after.
- **Per-part SHA-256 needs `create_multipart_upload(ChecksumAlgorithm="SHA256")`**; the stored
  checksum is then `COMPOSITE` and the ETag ends in `-<parts>`, so the key can't be compared with
  it, exactly as the spec says. `complete_multipart_upload` accepts `IfNoneMatch="*"`.
- **A Python reader needs `zlib.decompressobj(wbits=31)`** and its `eof` and `unused_data` to see
  where a gzip stream ends, find the next one, and refuse other trailing bytes. The spec gives the
  equivalent for C zlib and .NET; Python's `gzip.decompress` can't do it.
- **`icu.dll` works through `ctypes.WinDLL("icu.dll")`** with
  `ucal_getDefaultTimeZone(buf, capacity, byref(c_int))` on Windows Server 2025 and returned
  `Etc/UTC` here; Python's `time.tzname` gave "Coordinated Universal Time".
- **`os.O_NOFOLLOW` and `os.O_NONBLOCK` don't exist on Windows**; `getattr(os, name, 0)` keeps one
  `os.open` call portable.
- **boto3's `put_object` sends no `Content-Type`**, and S3 stores `binary/octet-stream`, which is
  the spec's "store keeps its own default". A hint would have saved a HEAD to confirm it.

## Environment notes, not the format

- The sandbox shell refuses commands its analyzer can't check: inline `python -c`, `$()`
  subexpressions, script blocks, `"$var"` interpolation, `cmd /c`, and `Format-Table`,
  `Select-Object`, `Select-String` with property arguments. Every step had to be a script file in
  `scratch/`, run as `python -I scratch\x.py`, with output redirected to a file where long.
- Credentials are a session token set by `credentials.ps1` per command, expiring
  2026-11-09T21:32:01Z; no 403 was seen. Region `us-east-1`; versioning off; the `aws` CLI worked
  for listing and an initial reachability check.
- The bucket has a lifecycle rule (`expire-test-objects`, expiry 2026-11-11) visible in every
  HEAD response, so the objects left in it will disappear on their own.
- Toolchain: Python 3.12.10 (so `realpath(strict=True)` and `DirEntry.is_junction()` are
  available), boto3 1.43.126 / botocore 1.43.126 with `IfNoneMatch` and `ChecksumSHA256` in the
  `PutObject` and `CompleteMultipartUpload` models and `request_checksum_calculation` defaulting to
  `when_supported`.
- Machine `runnervmm7ud1`, user `runneradmin`, clock in UTC; `fixtures\edge\case` is a
  case-sensitive NTFS directory and `hard-a.txt`/`hard-b.txt` are hard links (both confirmed with
  `fsutil`). No network drives, `subst` drives or volumes without a letter were available.
- Sequential single-threaded uploads of 1100 small objects took about 105 s; the 40 MiB
  multipart upload about 2 s. No retries or dropped connections were observed.
- Nothing was written outside this directory: program state in `s3cab-backup-state/`, scripts and
  outputs in `scratch/`; the scratch test sets and `__pycache__` were removed afterwards.
