# The format-spec clean-room audit, run 29: backup on Windows, Fable 5.2 at xhigh (2026-11-25)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.2 at
`xhigh`, all reading the spec of 2026-10-30 as of
[PR #527](https://github.com/allens/s3cab/pull/527). The set so far: backups on
[Linux](format-spec-audit-28.md), Windows (this run) and [macOS](format-spec-audit-30.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/windows/s3cab-backup.py), Python with
  boto3, and `ctypes` for the Windows calls. Its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens:** input 154, cache write 369,103, cache read 18,166,003, output 218,246.

Everything below the rule is the session's own report, verbatim.

---

# REPORT — writing an s3cab backup from `format.md` alone

Clean-room run of 2026-11-25 on Windows Server 2025 (10.0.26100, NTFS), Python 3.12.10,
boto3/botocore 1.44.11. The only format source was `format.md` (spec of 2026-10-30). Nothing
about s3cab was looked up anywhere else.

Deliverables: `s3cab-backup.py` (the program), this report, and `s3cab-backup.state.json`
(the OWNER/CLAIMED pairs the spec says a backup keeps, beside the program). `scratch\` holds
every script and transcript this report cites.

## Outcome

The bucket was emptied (checked: 0 keys, 0 open multipart uploads; versioning is not enabled,
so no old versions) and the final program run once per set with exactly
`python s3cab-backup.py test-s3cab-ci-cleanroom-backup <set> <dir>...`. Transcripts:
`scratch\final-run-<set>.txt`.

| Set | Exit | Snapshot | File rows | `#error` rows | Objects sent |
| --- | --- | --- | --- | --- | --- |
| `edge` | 1 | `snapshots/edge/20261125T0852.tsv.gz` | 31 | 3 (links out of the backup) | 27 |
| `docs` | 0 | `snapshots/docs/20261125T0852.tsv.gz` | 120 | 0 | 120 |
| `bulk` | 0 | `snapshots/bulk/20261125T0853.tsv.gz` | 1100 | 0 | 1100 |
| `media` | 0 | `snapshots/media/20261125T0856.tsv.gz` | 2 | 0 | 2 (the 40 MiB one in parts) |
| `hollow` | 0 | `snapshots/hollow/20261125T0856.tsv.gz` | 0 | 0 | 0 |
| `spread` | 0 | `snapshots/spread/20261125T0856.tsv.gz` | 13 | 0 | 13 |
| `faults` | 0 | `snapshots/faults/20261125T0856.tsv.gz` | 3 | 0 | 3 |
| `corrupt` | 0 | `snapshots/corrupt/20261125T0856.tsv.gz` | 3 | 0 | 3 |
| `scans` | 1 | **none** — the run stopped | – | – | 0 |

The bucket now holds 1,285 keys: 1,268 under `objects/` (43,579,465 bytes), nine
`snapshots/<set>.info`, eight snapshots, no `locks/` key, no open multipart upload, everything
in `STANDARD`.

**Two sets did not end with exit 0, both by the spec's rules:**

- `edge` exits 1 *after* its snapshot is uploaded: `junction\`, `link-out-dir\` and
  `link-out-file` lead out of the backup and each gets an `#error` row. `link-dangling`,
  `link-to-plain` and `link-to-sub` get no row.
- `scans` has **no snapshot**, only its `.info`. Its one file, `scan-\ud800.txt`, has a name with
  no UTF-8 form, and the checklist says to stop without writing a snapshot. The spec's only way
  past is leaving the name out, which it calls the user's choice, and this command line gives the
  user no way to make it. The claim made before the walk stays, as the spec says it does.

**How the final bucket was checked** (`scratch\verify.py`, run by `scratch\final_audit.py`,
output in `scratch\final-audit.txt`). It is a separate reader that shares no code with the
program and makes only GET, HEAD and LIST requests. For each set it:

- takes the latest snapshot the way the reading checklist says, decompresses it strictly as one
  gzip stream, and checks UTF-8, LF, the heading row, the `.`, five fields a line, every rule of
  "valid and invalid files", and that each line is byte for byte its canonical form;
- downloads every object a file row names and hashes it against its key, and HEADs it for
  `Content-Encoding`, metadata, storage class and the checksum S3 holds;
- walks the member directories again through `\\?\` and compares path, hash, size and rounded
  mtime with the rows.

Result: all eight snapshots valid and canonical, every object present and hashing to its key,
rows equal to the disk, no stored `Content-Encoding` or metadata.

## What the program does

One run, no parallelism, no cache. A file not yet in the bucket is read twice: once to hash it
for its row, once to send it. In order:

1. One clock reading gives `START` (cut to the millisecond) and the name (local time, cut to the minute).
2. Each member directory is resolved once to its real path (through `\\?\` on Windows).
3. The set's `.info` is read. The program must hold the matching pair, or the set must be new
   (no `.info`, no snapshot), in which case it claims it with a no-overwrite PUT.
4. An upload lock is written, then `locks/` is listed. A dead run's lock is removed; a live
   `delete-` lock stops the run.
5. The walk, never following a link. Then the same-minute check, then hashing (size and mtime
   from `fstat` on the handle being hashed).
6. `FINISH`, the snapshot text, gzip, and the program's own reading of that snapshot by the
   valid-file rules. A fault there stops the run before anything is uploaded.
7. `objects/` is listed (every page) and what is missing is sent.
8. `.info` is read again, then the snapshot goes up with a no-overwrite PUT, then the lock is removed.

**How every stored object is the bytes its key names:**

- Just before sending, the file is reopened and its size and millisecond-rounded mtime compared
  with its row. A change means it isn't sent.
- A file under 16 MiB is read whole and hashed in memory; those same bytes are sent only if the
  hash is the key. The PUT also carries `x-amz-checksum-sha256` set to the key's digest, so S3
  refuses any other bytes (measured: 400 `BadDigest`, nothing stored).
- A larger file goes in 16 MiB parts, each with its own SHA-256 that S3 checks. The whole-file
  hash is taken from the bytes of those same parts, and `CompleteMultipartUpload` is sent only if
  it equals the key. Otherwise the upload is aborted, so nothing ever becomes visible.
- Every PUT and every completion carries `If-None-Match: *`. A 412 counts as already stored.
- If an object can't be stored, the rest are still sent, the snapshot is not uploaded, exit 1.

## Would leave a backup that can't be restored correctly

Ranked, worst first. Each says what the spec says, what I guessed, and what I ran.

1. **A volume mount point inside a member directory is skipped without a row, exit 0.**
   The spec (lines 614–625) says a mount point is a junction, never followed, and gets a row only
   by the links table; a link whose real path lies inside a member directory is "into the backup"
   and gets none, because "the target is recorded where it lies". Measured
   (`scratch\mount-noletter.txt` lines 21–25): the mount point lists as a junction (tag
   `0xA0000003`) and `os.path.realpath` returns **its own path**. So by the table it leads into
   the backup, and everything on the volume is recorded nowhere. By the same reading, any other
   link pointing beneath it is "into the backup" too.
   *Guess:* a link that resolves to itself or beneath itself gets `#error` ("recorded nowhere
   else"), with a separator, and the run exits 1.
   *Ran:* `scratch\faults-11-12.txt` (s11): a 64 MB VHD mounted on a folder in a member directory.
   The program wrote the `#error` row and no row for the two files on the volume. By the table as
   written the mount point would have had no row either.

2. **The spec's test for a broken link calls a link to a live directory broken.**
   Lines 646–652: a link is broken "when nothing exists where it points", and "as a test" on
   Windows that is winerror 2, 3 or 1921. A broken link gets no row. Measured: a junction and a
   symlink to a directory on a volume with no drive letter and no mount folder both fail
   `os.path.realpath(strict=True)` with **winerror 3**, while `os.stat` through the link succeeds
   and the directory lists. The definition says "out of the backup" (`#error`); the test says
   broken (no row, exit 0).
   *Guess:* on 2, 3 or 1921 the program asks `os.stat` through the link before believing it; if
   something is there, the link gets `#error`.
   *Ran:* `scratch\mount-noletter.txt`, lines 41–49.

3. **Going through `\\?\` on Windows is filed as a hint, and hints are "never a requirement"
   (line 34), yet a writer that keeps every rule and skips it stores wrong content.**
   The writing checklist's rules never mention it. Measured (`scratch\probe3.txt` lines 4–8,
   `scratch\probe_win.txt`):
   - listing `dotdir.` by its plain path returns the files of its neighbour `dotdir`;
   - opening `dotdir.\plain-twin.txt` by plain path returns the neighbour's bytes under the dotted name;
   - `dotdir.\in-dot.txt`, and the fixtures' `notes.` and `trailing.txt `, are "not found".

   So rows carry the right hash for the wrong name and real files get none.
   *Guess:* treated it as a rule: every filesystem call goes through `\\?\`.
   *Ran:* s1 and s12 in `scratch\faults-1-5.txt` and `faults-11-12.txt`; the `edge` audit shows
   `notes.`, `trailing.txt `, ` both ends.txt `, `CON`, `aux.txt`, `nul.txt` and the 343-character
   path each with its own bytes.

4. **A lock can be judged dead by another machine with the same names.** *(From the text; not run — it needs two machines.)*
   Lines 262–283: a run whose `BY`, `OS` and `PIDNS` equal the lock's may remove it once its `PID`
   is gone. `PIDNS` on an ordinary Linux host is, as far as I know, the same constant everywhere
   (the spec's own example, `pid:[4026531836]`; not measured here). Two machines with one `user@machine` — clones, or default host
   names — therefore each judge the other's lock by their own process table. An upload can then
   remove a live delete's lock and run beside it, which is exactly what the locks exist to
   prevent. The spec names the clone problem for the `.info` pair and is silent on it for locks.
   *Guess:* followed the rule as written.

5. **An object found stored but archived.** *(From the text; not run.)*
   Lines 1638–1653 count a key listed under `objects/` as stored; line 1654 only governs the class
   of keys the writer stores. An object a lifecycle rule moved to an archive class is "stored",
   the conditional PUT can't replace it, and the snapshot names content a plain GET can't read.
   The listing shows the class, but the spec gives an uploader nothing to do with it.
   *Guess:* counted as stored, as written; no warning.

## Would inconvenience the implementer

Ranked, most costly first.

1. **Leaving entries out is called optional ("nothing requires it", line 1418), but two stop
   rules make it necessary.** A tool with no way to leave a name out can never back up:
   - a tree holding one name with no UTF-8 form — `scans` ends with no snapshot;
   - the root of the NTFS volume tried here — measured in s11 (`faults-11-12.txt` lines 3 and
     17–18): the walk stops at `System Volume Information` with WinError 5 ("a directory that
     can't be listed … stops the backup", line 735), though the spec calls a drive's root a legal
     member directory.

   How to leave something out is in `exclude.md`, which this exercise doesn't include.
   *Guess:* offered no exclusion and stopped.

2. **The spec contradicts itself on a member directory with a tab, CR or LF in its path.**
   Lines 752–755 say it is "walked like any other" and, empty, leaves "a `DIR` no row can match"
   (spelled with `␉`). Line 1449 says to stop without writing a snapshot "even with nothing in it
   to back up". *Guess:* stop, as the checklist says. *Not run:* NTFS can't hold such a name.

3. **"A volume mounted only under a folder" does have a real path with a drive letter.**
   Lines 1464–1466 say such a member directory's real path has "no drive letter and no share" and
   the run must stop. Measured (`scratch\mount-noletter.txt` line 30): `realpath` returns the
   mount folder's own path, `C:\…\vol\`, which a reader accepts. Only a volume with no mount point
   at all behaves as the spec says (winerror 3, and the program stops: line 50 of the same
   transcript). The spec's hint at its line 1511 is right for that second case only.

4. **When may a tool with one command claim a set?** Lines 175–189 describe s3cab claiming at
   set-up and its `backup` refusing a set with neither `.info` nor snapshots, yet also say "claim
   whenever you like before the first snapshot's upload". *Guess:* this program's backup claims a
   set that has neither, before the walk, replacing any pair kept from before; it never takes a
   set over. *Ran:* s4 (another holder, snapshots without `.info`, taken over mid-run, `.info`
   gone mid-run, claimed afresh).

5. **Keying the kept pair "by all three" locks a holder out of its own set when only the
   endpoint's spelling changes.** Measured in s10: a set claimed with no endpoint set is refused
   as another holder's once `AWS_ENDPOINT_URL_S3=https://s3.us-east-1.amazonaws.com` is set,
   though it is the same bucket. The spec doesn't say how two endpoint texts compare.
   *Guess:* as text, exactly as given; empty when none is set.

6. **"The same file turns up under two member directories" says nothing about a directory with
   no file in it.** Line 1471 lists "one named twice" among the stops; lines 1454–1463 define the
   overlap by a file found twice. *Guess:* two member directories with one real path stop the run
   even when empty; nesting stops only when a path is found twice, so an empty directory nested in
   another gives two `DIR` rows. *Ran:* s5.

7. **A share makes one directory two.** Line 1458 says a link, junction or case difference
   "can't make one directory two". Measured (`scratch\probe-unc-subst.txt`):
   `\\localhost\C$\s3cab.sandbox\fixtures\hollow` resolves to a share path and
   `C:\s3cab.sandbox\fixtures\hollow` to a drive path. Named together they would be two `DIR`s and
   two rows per file, with no overlap detected. *Not run as a backup*, only the resolution.

8. **What a lock holds beyond the listed keys.** `COMMAND` has no vocabulary (line 252); line
   order isn't given, though "your own bytes" compares bytes; nothing says what a key under
   `locks/` that isn't `<kind>-<instant>` is. *Guesses:* `COMMAND=backup`; lines in the order the
   spec lists them; a key directly under `locks/` starting `delete-` is a delete lock whatever
   follows, any other is ignored, and so are keys in folders below. A lock naming this process's
   own PID that isn't its lock is "alive" by the rule and is never removed. *Ran:* s3.

9. **`user@machine` for a tool that isn't Node** (lines 689–694 give Node's calls only, and "each
   run must spell it alike"). *Guess:* `os.getlogin()` on Windows, the effective uid's passwd name
   elsewhere, `socket.gethostname()`. Here that gives `runneradmin@runnervmbpeip`.

10. **Is "a read that returns a different number of bytes" a rule?** Line 1426 words it as what
    s3cab does, and the checklist's `#error` list (lines 1433–1437) leaves it out, while line 720
    lists it among what hashing finds. *Guess:* `#error`. *Ran:* `scratch\probe3.txt` line 10 (a
    file growing between the size check and the read).

11. **`@SET ENDPOINT` when the endpoint comes from somewhere else.** Lines 674 and 1556 name two
    environment variables; boto3 also takes one from the shared config file. *Guess:* the two
    variables in the SDK's order, handed to boto3 explicitly; otherwise whatever moved boto3 off
    its default. *Ran:* s10, with AWS's own regional URL only — no other provider.

12. **409 `ConditionalRequestConflict`** (line 1750): s3cab stops; nothing says whether a retry
    is allowed. *Guess:* retry up to five times, then stop. *Not run* — I had no way to provoke one.

13. **What a writer does with a fault in its own snapshot.** The uploading rules (lines
    1670–1675) are written for a tool handed a snapshot it may not have made: never upload one a
    reader refuses whole, but upload one whose rows are refused a path at a time "like any other".
    For a program that builds and uploads in one run, a refused row can only be its own bug.
    *Guess:* any fault its own reading finds, of either kind, stops the run before anything is
    uploaded. It never fired in any run here.

## Hints that would have helped

Traps in Python or Windows the spec doesn't mention, each measured here unless marked.

- **`os.path.realpath` of a mount point returns the path with a trailing `\`**
  (`mount-noletter.txt` line 23; and `Q:\` once the volume also has a letter, `mount-letter.txt`).
  Building `DIR` or a row by appending a separator gives a doubled one, which a reader refuses in
  every file row. The spec warns only about `C:\` and `/`.
- **Ask `os.stat` through a link before calling it broken** (item 2 of the first list).
- **A sharing violation has no `winerror` in Python 3.12.10.** Line 1577 says "PermissionError
  with winerror 32". Both `open()` and `os.open()` raise errno 13 with `winerror` `None`
  (`scratch\probe2.txt`), so it can't be told from a permissions fault that way. `os.stat` and
  `os.lstat` succeed on such a file.
- **`DirEntry.stat(follow_symlinks=False)` on Windows already carries `st_file_attributes` and
  `st_reparse_tag`** from the listing. One test separates symbolic links and junctions from every
  other reparse point, with no further call and without `is_junction()` (Python 3.12).
- **`OpenProcess` ignores the low two bits of a PID.** `pid+1` to `pid+3` of a live process open
  it and read as alive (`scratch\probe2.txt` line 5), so "error 87 means gone" (line 1708) never
  fires for them. The error is on the safe side.
- **A freshly formatted NTFS volume's root already holds `System Volume Information`**, which an
  administrator couldn't list here: that volume's root as a member directory stopped the run (s11).
- **NTFS holds a modification time past the year 9999.** `os.utime(ns=…)` set year 12000 and it
  read back, so the "time the form can't hold" `#error` is reachable on Windows (s1).
- **`zlib.compressobj(9, zlib.DEFLATED, 31)` writes a gzip header with no name and a zero time**,
  without the `gzip` module's traps. `verify.py` checks the first eight bytes
  (`1f8b0800 00000000`: deflate, no flags, no time) of every snapshot in the bucket. Only this
  Python was tried.
- **S3 allows 10,000 parts.** 16 MiB parts (line 1733) stop at about 156 GiB; the program grows
  the part size past that. *Not run.*
- **`getpass.getuser()` reads `LOGNAME`, `USER` and `USERNAME` first**, which anything can set,
  so it isn't a stable `BY`. *From Python's documentation, not measured: both calls give
  `runneradmin` here.*

**Hints in the spec that were right and saved real time** (all measured):

- `normpath` not `abspath`, and `realpath` only through `\\?\` — plain, `dotdir.` resolves to `dotdir`.
- Stripping `\\?\` from `os.readlink`; winerror 2 for a dangling link.
- `icu.dll` for the zone name (`Etc/UTC`).
- `ChecksumSHA256` set to the key's digest, and `COMPOSITE` for a multipart object's stored checksum.
- The `before-call` handler for `If-None-Match` (it works on boto3 1.44 too, so one code path serves every version).
- Printing a lone surrogate: this machine sets `PYTHONIOENCODING=utf-8:surrogateescape`, and
  printing the `scans` name raw raises `UnicodeEncodeError` exactly as described.
- Three U+FFFD for a lone surrogate.

## Environment notes, not the format

- **The sandbox refuses several command shapes**: inline `python -c`, `$env:` or `$(…)` inside a
  command, .NET method calls, expandable strings and script blocks. Everything ran from script
  files under `scratch\`.
- **boto3 doesn't read `AWS_REGION`**, which is what `credentials.ps1` sets
  (`boto3.session.Session().region_name` is `None`, `scratch\probe3.txt` line 9). The program
  reads `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the profile, then `us-east-1`.
- No proxy variables were set; requests went straight to `https://s3.amazonaws.com`. Signing and
  transport are boto3's defaults with the standard retry mode, six attempts.
- The bucket is in `us-east-1`, unversioned, and was empty at the start. It was emptied with
  `aws s3 rm --recursive` and checked for keys and open uploads each time, and for versions the
  first time.
- 1,100 small objects took about three minutes one at a time.
- The machine's zone is UTC, so the name and `START` always fall in the same minute. A non-UTC
  zone and a daylight-saving change were never exercised.
- `diskpart` ran with administrator rights. The VHD and its mount folder lived under `scratch\`
  and were detached and removed.
- The program sets `sys.dont_write_bytecode` so that Python writes nothing outside this directory.

## What I wanted beyond `format.md`

- **`exclude.md`** — whether s3cab leaves anything out by default, and how a user leaves out a
  name that stops a run. The fixtures hold `ignored.tmp`, `ignored.swp`, `*.bak`, `.log`, `build`
  and `cache.bin`, which look like exclusion cases. *Guess:* everything gets a file row.
- **`backup.md`** ("where a set lives", "its copy in the bucket") — what a set-up step is and
  where the pair is kept. *Guess:* a JSON file beside the program.
- **`output.md`** — exit codes. *Guess:* 0, 1 for `#error` rows or a stop, 2 for usage.
- **`maintenance.md`** — whether a backup waits for a delete lock. *Guess:* refuse at once.

## What was run, and what was not

**Run against the real bucket**, with the final program:

- 68 checks in `scratch\faults.py`, all passing (`scratch\faults-1-5.txt`, `faults-6-10.txt`,
  `faults-11-12.txt`). They cover:
  - odd names and every kind of link, a locked file, an out-of-range mtime;
  - a second run in the same minute;
  - a file changed between hashing and sending (same size and time, time only, size);
  - delete locks alive, unjudgeable and dead;
  - the holder checks, and nested, repeated, missing and non-directory member directories;
  - real 412s on a single PUT and on a multipart completion, with no upload left open;
  - a vanished file and a vanished directory; an endpoint; a re-run that sends nothing;
  - a mount point; member directories typed with a trailing dot, through a junction, relative.
- Two earlier partial runs each show one FAIL that was the harness's assumption, not the program:
  - `scratch\faults-10.txt`: s7 expected three read-backs and saw two
    (`['locks/upload-…', 'snapshots/t-s7/…']`), because `t-s7` was already claimed by the run before.
  - `scratch\faults-regress.txt`: s2 expected one snapshot in `t-s2b` and found two, for the same reason.

  Both pass on the emptied bucket.

**Run locally, with no request to the bucket:**

- `scratch\unit.py` (output in `unit.txt`): the spec's three canonical lines byte for byte, its
  `SIZE` and duration examples, rounding, and 200,000 random instants against `datetime`.
- The probes: `probe_win.txt`, `probe2.txt`, `probe3.txt`, `probe-unc-subst.txt`,
  `mount-noletter.txt`, `mount-letter.txt`.

**Simulated, not provoked:** a lost response on the claim, the lock and the snapshot. The
program's PUT really landed and the harness reported it as a 412; the read-back that follows was
a real request.

**Not run:**

- Everything that needs Linux or macOS: names with a tab, CR, LF or bytes that aren't UTF-8;
  pipes, sockets and devices; spelling a real path from listings; `PIDNS`; `kill(pid, 0)`;
  `/etc/localtime`. That code is written and has never executed.
- Two real writers racing for one lock instant or one `.info`.
- A 409; a file past 156 GiB; an endpoint other than AWS's; a zone other than UTC.
- An entry whose type can't be determined (it can't happen on NTFS).
