# The format-spec clean-room audit, run 6: backup on Windows, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on [Linux](format-spec-audit-4.md),
[macOS](format-spec-audit-5.md) and Windows (this run); restores on [Linux](format-spec-audit-7.md),
[macOS](format-spec-audit-8.md) and [Windows](format-spec-audit-9.md).

- **Program:** [`s3cab-backup.py`](https://github.com/allens/s3cab/blob/a2cb93351d5e293123a9fac096d42409ef3749ce/scripts/cleanroom/backup/windows/s3cab-backup.py), Python
  with boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens:** input 176, cache write 280,353, cache read 14,984,652, output 174,313.

Everything below the rule is the session's own report, verbatim.

---

# Clean-room backup for the s3cab format: report

Written from `format.md` (spec of 2026-10-20) alone. I didn't consult the s3cab source, docs,
tracker or package. Work was done natively on Windows Server 2025, with PowerShell 7, Python 3.12.10
and boto3/botocore 1.43.117. Every bucket result below comes from real requests to
`s3://test-s3cab-ci-cleanroom-backup`. The guess log I kept while working is
`scratch/guesses.md` (G1–G24). This report is that log, ranked and audited.

## Outcome

`s3cab-backup.py` (`python s3cab-backup.py <bucket> <set> <dir>...`):

1. Resolves each member directory to its real path through `\\?\`.
2. Claims the set (or checks it already holds the claim).
3. Refuses a second snapshot in the same minute.
4. Walks without following links. It reads each file once, stores its content at
   `objects/<sha256>`, and then writes, self-checks and uploads the snapshot.
5. Keeps the claim pair and a copy of each snapshot beside itself, in `s3cab-backup.state/`.

Exit codes: 0 for a clean backup; 1 when the snapshot was written but holds `#error` rows; 2 when
the run was refused or failed.

**Final state.** I emptied the bucket, then ran the program once per set, with exactly the
documented command line and the `ENVIRONMENT.md` directories:

| set | exit | result |
| --- | --- | --- |
| edge | 1 | 31 files, 27 objects; 3 `#error` rows (a junction and 2 symlinks leading out of the backup) |
| docs | 0 | 120 files |
| bulk | 0 | 1,100 files |
| media | 0 | 2 files (the 40 MiB one sent multipart) |
| hollow | 0 | empty snapshot (FILES 0, SIZE `0 (0B)`) |
| spread | 0 | 13 files under 2 `@SET DIR`s |
| faults | 0 | 3 files |
| corrupt | 0 | 3 files |
| scans | 2 | **refused, by rule:** `scan-\ud800.txt` has no UTF-8 form, and the tool offers no exclusion. `snapshots/scans.info` exists with no snapshot, the state the spec describes as "a set … whose first backup stopped". |

The bucket is left with 1,285 keys: 1,268 objects, 8 snapshots and 9 `.info` files. All are
STANDARD storage class, and no multipart upload is open.

**How the stored bytes are made to match their keys:**

- **Files up to 16 MiB** are read once into memory, and that buffer is both hashed and sent. The
  PUT carries `x-amz-checksum-sha256` and `If-None-Match: *`. A deliberately wrong checksum got
  `BadDigest` and a following HEAD returned 404, so S3 stored nothing.
- **Larger files** are hashed in a first pass. Then each part is sent with its own checksum, the
  whole-file hash is rebuilt from exactly the bytes sent, and `CompleteMultipartUpload` (also
  `If-None-Match: *`) goes only if that hash equals the key. Otherwise the upload is aborted.
- **Changed files:** `fstat` is taken before and after each read and must agree.
- **Objects first:** before the snapshot goes up, every hash it names must have been confirmed
  stored during this run.

**How it was verified:**

- **`scratch/verify.py`.** An independent reader written from the Reading checklist that shares no
  code with the program. It downloaded all 1,268 objects and hashed each against its key, and
  checked no `Content-Encoding` or metadata on any key. For each snapshot it checked: byte equality
  with the local copy; one gzip stream; strict UTF-8 with no BOM; LF only; the heading row; the `.`
  terminator; 5 fields; known types; canonical form; every validity rule; every named object
  present and older than the snapshot. It also checked each `.info` against the kept pair.
  Result: OK.
- **`scratch/xcheck.ps1`.** A .NET-only enumeration that skips reparse points, then SHA-256, size
  and mtime of every file, compared with every file row of every set: 1,272 files, 0 differences.
- **A re-run of `edge`.** It uploaded 0 objects (27 already stored), and a second run in the
  same minute was refused. Diffing the two snapshots showed only NAME, START and FINISH changed,
  as the spec promises.
- **Scratch fixtures I built for rules the given sets don't reach** (since deleted):

  | case | result |
  | --- | --- |
  | symlink loop (EINVAL/winerror 1921) | no row |
  | link through a file (winerror 3) | no row |
  | chains of links in and out | out → `#error` on each hop |
  | relative link and junction into the backup | no row |
  | UNC link to a dead host (winerror 53, raised as `FileNotFoundError`) | `#error`, no trailing separator |
  | link to an ACL-denied folder | `#error`, no trailing separator |
  | unreadable file; file held open with no sharing | `#error` |
  | mtime in year 11476; mtime that only rounds into year 10000 | `#error` |
  | exact .5 ms tie / just under it | `.001` / `.000` |
  | unlistable subdirectory | run stopped |
  | `dotdir.` member beside a `dotdir` | backed up the right tree |
  | member given as a junction, a wrong-case relative path, or an 8.3 short name | DIR recorded as the real path |
  | overlapping members (nested, or a junction to another member) | refused |
  | set held by someone else; kept pair 1 ms off; snapshots but no `.info` | all refused |
  | multipart file changed between hash and upload | aborted; HEAD on the stale key → 404; 0 open uploads; retry stored the final bytes |
  | combining-accent path printed through a cp1252 pipe | no crash |

**Not tested:**

- **Linux and macOS.** The POSIX branches run on neither: on-disk case lookup, errno
  classification, zone name, collapsing `//`, and names holding tab/CR/LF or bytes that aren't
  UTF-8 (these can't exist on NTFS).
- **Windows cases:** `subst` and mapped drives, volume mount points, OneDrive placeholders, and
  DST (the machine runs on UTC).
- **Concurrency and libraries:** concurrent writers (a 409 `ConditionalRequestConflict` would end
  the run with exit 2), boto3 older than 1.35 (my `If-None-Match` header fallback is untested),
  and takeover (not offered).

## Would leave a backup that can't be restored correctly

Ranked, worst first.

1. **The writing checklist never requires `@SET DIR`, or most other whole-snapshot rows** (G1).
   The checklist claims to hold every rule. It names only `@S3CAB SPEC`, `@CLIENT NAME`,
   `@CLIENT VERSION` and the closing `@SNAPSHOT FINISH`; the rest come in via a link to "the
   whole-snapshot rows", and only the table marks `BUCKET`/`ENDPOINT` "optional". Yet readers
   refuse every path "under no `@SET DIR`". A writer that follows the checklist literally, with no
   `DIR` rows, produces a snapshot whose every file row is refused, so nothing restores. I wrote
   every row in the table except `ENDPOINT`. The checklist should say: "one `@SET DIR` per member
   directory, its real path, ending in a separator", and say which of `@SET NAME`,
   `@SNAPSHOT NAME/BY/START/FILES/SIZE` are required.
2. **No rule on the storage class objects are written in.** Archive tiers come up only as a hint
   about lifecycle rules. A writer that uploads straight to an archive class (a natural cost
   saving for backups) makes every GET fail with a non-404. The Reading checklist then says to
   stop the whole restore. The rule is needed: "store objects and snapshots in a class a plain
   GET can read". I used the default; all 1,285 keys are STANDARD.
3. **The "into the backup" link test has no comparison rule** (part of G10). Into versus out is
   decided by whether the final target "is a member directory or lies inside one", but the spec
   never says how the paths compare. The only rule it gives is the reader's: Windows `DIR`s match
   case-insensitively. A writer that borrows it misjudges a link into `Photos\` as "into" a
   member `photos\` when both exist in a case-sensitive directory (the `edge\case\` fixture shows
   NTFS twins like these are real). That link gets no row, its target is recorded nowhere, and
   the run exits 0. I compared real paths exactly, by whole segments. I didn't build twin
   *directories* to show the failure; the reasoning is from the text.
4. **A POSIX path starting with exactly two slashes is read as a Windows share** (G21). The
   reader's Windows test is "a drive letter followed by `\` or `/`, or a share starting `\\` or
   `//`". POSIX allows `//` (its meaning is implementation-defined), and `posixpath.normpath`
   keeps it (checked: `'//srv/data/x'` stays as is, while `'///srv/data/x'` becomes
   `'/srv/data/x'`). A Linux name containing `\` under such a `DIR` is then split into folders,
   so it restores under the wrong name with no error. Nothing tells writers to avoid a leading
   `//`. My program collapses it (untested on POSIX).

## Would inconvenience the implementer

Ranked.

1. **Directory `#` rows contradict the segment rule** (G11). "Every segment of a path past its root
   a name: not empty, so no trailing … separator", yet "a path ending with a separator is a
   directory" in `#excluded`/`#error` rows, and the spec's own example has
   `#error … C:\Users\me\Photos\Shared\`. I apply the segment rule after dropping a directory
   row's one trailing separator. File rows may not end with one.
2. **Nested member directories contradict themselves** (G4). The way past "the same file under
   two member directories" is to leave the inner one out of the outer walk. But "anything left
   out on purpose gets an `#excluded` row", and a per-path row may never be "any `DIR` itself, a
   nested one included". My tool has no exclusion and stops.
3. **"Don't upload the snapshot" after a hash mismatch** (G12) doesn't say whether to abort the
   run or re-read the file. I abort that upload and retry the file, up to 3 tries. If it never
   holds still it becomes an `#error`, so the snapshot no longer names the object.
4. **Claiming versus a stale kept pair** (G6, G8, G24). "Claim whenever you like before the
   first snapshot's upload" leaves the timing open. I claim before the walk, so a first backup
   that stops (`scans`) leaves the described `.info` with no snapshot. Also unaddressed:
   - a tool holding a pair for a set whose `.info` and snapshots are gone (a bucket emptied). I
     treat it as a new claim, not a takeover;
   - whether to keep the pair before or after the PUT. I keep it before, so a published claim
     is never one I lost.
5. **Where the pair lives, and per what** (G7). The pair belongs to a bucket (and endpoint), not
   just a set name. I key it by bucket and set.
6. **`.info` reading is underspecified** (G19): duplicate keys, a BOM (the BOM forgiveness is only
   for snapshots and records), the case of keys, a malformed file at check time. I refuse when
   `OWNER` or `CLAIMED` is missing or repeated with different values.
7. **Which "target" to name in a link's `#error` message** (G10): the link's literal text, or
   where it finally resolves? I give the resolved real path, with a separator for a directory;
   for an unresolvable link, its literal text.
8. **Which instants START and FINISH are** (G15). "When the run started/finished", but FINISH
   sits inside the snapshot, so the true end (the snapshot's own upload) is after it. I take
   START at entry and FINISH after the last object is stored.
9. **Forbidden characters in names that get no row** (G3). For a tab/CR/LF or non-UTF-8 name on a
   broken link, socket or pipe, does it stop the run? I stop on any name met.
10. **The same directory named twice** (G5), possibly under two spellings. I treat it as "one
    inside the other" and stop.
11. **Which Windows reparse points are links** (G17). "Symbolic link or junction" doesn't settle
    volume mount points, which carry the same `MOUNT_POINT` tag (Python's `isjunction()` is True
    for them), or WSL's `LX_SYMLINK`. I treat `SYMLINK` and `MOUNT_POINT` as links and everything
    else as ordinary. Untested.
12. **Canonical form versus free text.** A people-only column-2 value with a leading or trailing
    space (or another trimmed character) reads back trimmed. Its line can then never be
    canonical, and the spec doesn't tell writers to trim. I trim messages myself.
13. **Set-name charset** (G9): ASCII only? Empty, leading hyphen, length? I accept
    `[a-z0-9-]+`.
14. **"Write a row per entry"** sits beside "no empty directories" and offers no row type for an
    ordinary directory (G2). I write none.
15. **Mtimes before year 1** (POSIX) are as unholdable as years past 9999, but only the latter
    is named (G20). I treat both as `#error`.
16. **Metadata in the S3 sense.** "Objects carry no metadata", yet S3 always stores a
    Content-Type. Nothing says whether a writer may set one (say `application/gzip` for
    snapshots), or whether it should request SSE the way "s3cab already requests it" (I relied
    on the bucket default, AES256).
17. **Smaller points:** whether object PUTs should also be conditional (I made all PUTs
    conditional); a directory that vanishes between being listed in its parent and being listed
    itself (G16, which I treat as vanished, no row); and that the spec gives exit codes only for
    s3cab's own `#error` case.

## Hints that would have helped

- **PowerShell compares strings case-insensitively by default.** I hit this with `@{}`
  hashtables: my own .NET cross-check first reported `case\Case.txt` and `case\case.txt` as one
  file and flagged a false mismatch, until I switched to a `Dictionary` with
  `StringComparer.Ordinal`. `-eq`, `-contains` and `Sort-Object -Unique` do the same (checked in
  `scratch/audit_hints.ps1`). The spec warns about Swift's equality but not about the shell its
  own recovery section uses.
- **.NET enumeration skips hidden and system files by default.** `EnumerationOptions`' default
  `AttributesToSkip` is `Hidden, System`, and neither it nor `Get-ChildItem` without `-Force` sees
  `edge\hidden.txt` (checked). The rule says these are ordinary files. I set `ReparsePoint` only,
  so it didn't bite me, but a .NET or PowerShell writer on defaults would drop them silently.
- **`os.path.normpath` doesn't make a path absolute.** The hint's "absolute path made with
  `os.path.normpath` (not `abspath`)" leaves out how. Join with `os.getcwd()` first, and resolve a
  drive-relative `D:foo` against that drive's own current directory.
- **Python's `open()` reports a sharing violation as plain `EACCES` with no winerror.** A file
  held open with no sharing is then indistinguishable from an ACL denial in the `#error` text.
  Both are correctly `#error`; only the wording suffers.
- **botocore's default (legacy) retry mode retries `BadDigest`.** In my probe a wrong
  `x-amz-checksum-sha256` was sent 5 times before failing. A writer that relies on the checksum to
  catch a file that changed mid-read pays that delay each time.
- **Hints that held, as checked here:**
  - `os.walk(followlinks=False)` does descend into a junction on 3.12.10.
  - `islink()` is False and `isjunction()` True for a junction.
  - A link loop is `EINVAL` with winerror 1921, and through a file is winerror 3.
  - A dead UNC host is winerror 53 raised as `FileNotFoundError`.
  - `abspath` drops `notes.`'s dot and `normpath` keeps it; a plain open of `notes.` fails as
    not found.
  - `realpath(strict=True)` on `\\?\` input keeps the prefix, keeps the trailing dot, fixes case
    and expands 8.3 names.
  - Supplying `ChecksumSHA256` makes boto3 1.43 send a plain body with no `Content-Encoding`.
  - `icu.dll` gives an IANA zone name (`Etc/UTC` here).

## Environment notes, not the format

- **Sandbox command checks.** It refused inline `python -c`, echoing `$LASTEXITCODE`, nested
  `pwsh`, and `Select-Object`/`Format-Table`/`Select-String` on computed paths. Every probe and
  check became a script in `scratch\`.
- **Sandbox path checks.** These are case-sensitive and prefix-based. They refused
  `c:\S3CAB.SANDBOX\…` and the 8.3 spelling `C:\S3CAB~1.SAN\…` as "outside the working
  directories", so those spellings were tested through a wrong-case relative path and an
  in-process harness. Stdlib source (`ntpath.py`) was unreadable, so `realpath` behaviour was
  measured instead.
- **`PYTHONIOENCODING=utf-8:surrogateescape` is set on this machine.** It hides the cp1252
  printing trap unless Python runs with `-I`. Under `-I` the program printed `cafe\u0301-out`
  without crashing (it sets `errors="backslashreplace"` itself).
- **The machine's zone is UTC**, so local-time naming and DST behaviour were not exercised.
- **The bucket:** unversioned, default SSE-S3 (AES256), with ListBucket allowed (so a HEAD on a
  missing key returns 404, not 403). The probe object I uploaded first was deleted when I emptied
  the bucket. Credentials held throughout; the window closes at 14:36Z.
- **The file-writing tool turned `\uXXXX` escapes into literal characters** in one source file
  (U+2028, U+2029, U+FEFF and the control pictures). Python read them identically, but I replaced
  them with `chr()` so the program's source is plain ASCII.
- **Admin rights.** I ran as an administrator, which made symlink creation possible; the deny ACEs
  for the fault tests apply even so. All scratch fixtures, ACEs and test keys were removed before
  the final runs.
