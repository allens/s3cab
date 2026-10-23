# The format-spec clean-room audit, run 12: backup on Windows, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on [Linux](format-spec-audit-10.md),
[macOS](format-spec-audit-11.md) and Windows (this run); restores on
[Linux](format-spec-audit-13.md), [macOS](format-spec-audit-14.md) and
[Windows](format-spec-audit-15.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/windows/s3cab-backup.py), Python with
  boto3, and `ctypes` for the Windows calls. Its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens:** input 1,866, cache write 260,870, cache read 10,294,370, output 142,346.

Everything below the rule is the session's own report, verbatim.

---

# Clean-room backup writer for the s3cab format: report on the spec

Spec read: `format.md`, "the spec of 2026-10-23". Nothing else about the format was consulted.
Platform: Windows Server 2025, PowerShell 7, Python 3.12.10, boto3 1.43.118. Bucket:
`s3://test-s3cab-ci-cleanroom-backup` in `us-east-1`.

## What was built

`s3cab-backup.py` takes `<bucket> <set> <dir>...`, and in this order:

1. reads one clock value, from which `@SNAPSHOT START` (floored to the millisecond) and the
   snapshot name (local wall clock, floored to the minute) both come;
2. resolves each member directory to its real path (through `\\?\` on Windows, `realpath(strict=True)`,
   drive letter uppercased) and stops if one is missing, is not a directory, is given twice, or lies
   inside another;
3. lists `snapshots/<set>/`; refuses if `<name>.tsv.gz` is already there; reads `snapshots/<set>.info`
   and either claims the set (conditional PUT, only when there is no snapshot yet) or checks that the
   `.info` still carries the OWNER/CLAIMED pair kept from the claim; refuses otherwise;
4. walks the member directories with `os.scandir` without following links; links get rows only per the
   spec's table; a name with no UTF-8 form, or a file path holding tab/CR/LF, or a directory that can't
   be listed, stops the run;
5. hashes each file after one `fstat` (size and `st_mtime_ns` from the same call), mtime rounded to the
   nearest millisecond with ties later, formatted by its own proleptic-Gregorian routine (years 0000 to
   9999) so Python's `datetime` limits never apply;
6. composes the snapshot in canonical form, gzips it as one stream with an empty name and mtime 0,
   writes a local copy beside the program (never over an existing one);
7. lists `objects/`, and for every hash not listed sends the file with `If-None-Match: *` and
   `x-amz-checksum-sha256` set to the key's digest, after a fresh size/mtime check and while hashing
   the bytes as they go out; any change stops the run before the snapshot is uploaded;
8. re-reads `.info`, checks the pair, uploads the snapshot with `If-None-Match: *` and its own checksum.

Exit status: 0 complete; 1 stopped without a snapshot, or a snapshot written that holds an `#error` row;
2 bad command line. State kept between runs lives beside the program in `s3cab-backup.local/`:
`holder.json` (the pair per bucket/set) and `snapshots/<set>/<name>.tsv.gz` (byte-identical copies).

The program has no exclusion feature and no takeover command, because the fixed command line has no
room for either. Consequences are in the findings below.

## Final state of the bucket

The bucket was emptied (1286 versions and markers deleted, 0 keys left), the local state beside the
program was removed, and the program was run once per set in ENVIRONMENT.md order with exactly
`python s3cab-backup.py test-s3cab-ci-cleanroom-backup <set> <dir>...`. Logs: `final-<set>.log`.

| Set | Snapshot uploaded | File rows | Objects sent | `#error` rows | Exit |
| --- | --- | --- | --- | --- | --- |
| edge | `snapshots/edge/2026-10-23T0137.tsv.gz` | 31 | 27 | 3 (links out) | 1 |
| docs | `snapshots/docs/2026-10-23T0137.tsv.gz` | 120 | 120 | 0 | 0 |
| bulk | `snapshots/bulk/2026-10-23T0137.tsv.gz` | 1100 | 1100 | 0 | 0 |
| media | `snapshots/media/2026-10-23T0140.tsv.gz` | 2 | 2 | 0 | 0 |
| hollow | `snapshots/hollow/2026-10-23T0140.tsv.gz` | 0 | 0 | 0 | 0 |
| spread | `snapshots/spread/2026-10-23T0140.tsv.gz` | 13 | 13 | 0 | 0 |
| faults | `snapshots/faults/2026-10-23T0140.tsv.gz` | 3 | 3 | 0 | 0 |
| corrupt | `snapshots/corrupt/2026-10-23T0140.tsv.gz` | 3 | 3 | 0 | 0 |
| scans | none: the run stopped | – | 0 | – | 1 |

Every set, `scans` included, has its `snapshots/<set>.info`. The bucket holds 1268 objects, 8 snapshots
and 9 `.info` files and nothing else. The final verification result is at the end of this section.

`verify_bucket.py` (described below) was then run over all nine sets against the bucket; its full output
is `verify-final.log`. It reported **0 problems**: 1285 keys all within the layout; for each of the eight
snapshots the bucket bytes identical to the local copy, one gzip stream with nothing after it, the heading
row, every line canonical (47, 133, 1113, 15, 13, 27, 16 and 16 lines), FILES and SIZE exact, every file row
matching an independent listing of the regular files and the live size and mtime, the three `edge`
`#error` paths real reparse points with the right trailing separator, and all 1268 objects fetched, each
hashing to its key, carrying `ChecksumSHA256` of the key, with no `Content-Encoding` and no metadata,
STANDARD class, SSE `AES256`; every `.info` matching the kept pair. For `scans`: `.info` present, no
snapshot.

After the final runs, `probe_body.py` PUT one scratch object to observe the SDK and deleted it
(versioning is off; a HEAD afterwards confirmed it gone), and the verifier only read. The bucket is
therefore exactly as the final runs left it.

## How the results were checked

Everything below was checked against something that ran; the files are beside this report.

- `test_helpers.py` (75 checks, all pass): the instant formatter against `datetime` over 20,000 random
  instants plus the boundaries (epoch, -1 ms, year 0000, year 9999, 2038, leap day); millisecond
  rounding with ties later for positive and negative values; the readable size at the spec's own
  boundaries (999,949 B, 999,950 B); the two canonical rows from the spec reproduced byte for byte;
  padding by code point for `🎉*.txt`; Windows-vs-POSIX path classification and whole-segment matching;
  Python's `lower()` giving the Final_Sigma result the spec quotes; member-directory resolution on the
  live fixtures (wrong case repaired, forward slashes, relative path, a junction and a symlink followed,
  a missing path, a file, a dangling link, nested and duplicate members all stopping); the walker on
  `edge` (31 files, exactly three `#error` links, no row for links into the backup or dangling ones,
  `scans` stopping).
- `test_bucket_rules.py` (17 checks, all pass, real requests): `If-None-Match` on an existing key gives
  412 and leaves the object untouched; a body that doesn't hash to the supplied `x-amz-checksum-sha256`
  is refused with `BadDigest` and HEAD then finds nothing; a file whose mtime changed since its row is
  caught before sending; a file rewritten with different bytes under the same size and mtime is refused
  by S3 and nothing is stored; the unchanged file then uploads with the key's checksum stored and no
  `Content-Encoding` or metadata; the holder check refuses a mismatched pair and a missing `.info` and
  passes a matching pair; a claim is refused when snapshots exist without `.info`; a fresh claim writes
  the three LF-terminated lines and keeps the pair; a taken-over set is refused at the start of a run and
  the pair is forgotten.
- `verify_bucket.py` (an independent reader built from the spec's reading checklist, real requests):
  for every set, lists the snapshot folder, downloads the latest, checks one gzip stream with nothing
  after it and a header with no name and mtime 0, strict UTF-8, no BOM, no CR, LF-terminated, heading
  row, `.` last, re-renders every line from its trimmed fields and compares it with the raw line
  (canonical form), checks exactly one SPEC/NAME/VERSION, FILES against the count, SIZE against the sum
  and its readable form, every file row's hash/size/mtime shapes, segments, strict placement under a
  DIR, no path in two rows, no path through another, compares the file rows with an independent
  listing of regular non-reparse files under the member directories and each row's size and mtime with
  a live stat, checks each `#error` path is a reparse point with the right trailing separator, GETs
  every object and hashes it, HEADs it for `ChecksumSHA256`, `Content-Encoding`, metadata, storage
  class and SSE, and parses `.info` against the kept pair. Also checks that every key in the bucket is
  one the layout allows.
- Running `hollow` twice in one minute: the second run stopped with
  `snapshots/hollow/2026-10-23T0133.tsv.gz already exists: a second snapshot in the same minute is refused`.

What `edge` recorded, from the dumped snapshot (all confirmed against the live tree by the verifier):

| Fixture | Row |
| --- | --- |
| ` both ends.txt `, ` leading.txt`, `trailing.txt ` | file rows, names verbatim |
| `CON`, `aux.txt`, `nul.txt`, `notes.` | file rows, read through `\\?\` |
| 12 nested `aaaaaaaaaaaaaaaaaaaaaaaa` + `deep.txt` (339 chars) | file row |
| `café.txt` NFC and `café.txt` NFD | two file rows, different hashes, no normalization |
| `case\Case.txt`, `case\case.txt` (case-sensitive directory) | two file rows |
| `hidden.txt` (H), `system.txt` (H+S) | file rows |
| `hard-a.txt`, `hard-b.txt` | two file rows, one object |
| `dedup-a.txt`, `sub\dedup-b.txt` | two file rows, one object |
| `empty.txt` | file row, size 0, hash `e3b0…b855` |
| `mtime-1970s.txt` | `1970-01-02T00:00:00.000Z` |
| `mtime-2038.txt` | `2038-01-19T03:14:08.000Z` |
| `mtime-rounds-up.txt` (…000.9996 s) | `2017-07-14T02:40:01.000Z` |
| `next\x85line.txt` (U+0085) | file row, character kept |
| `🎉 emoji 🎉.txt`, `日本語.txt` | file rows |
| `junction` → outside | `#error … C:\…\edge\junction\` |
| `link-out-dir` → outside | `#error … C:\…\edge\link-out-dir\` |
| `link-out-file` → outside\beyond.txt | `#error … C:\…\edge\link-out-file` |
| `link-to-plain`, `link-to-sub` (into the backup) | no row |
| `link-dangling` | no row |

`scans` holds `scan-\ud800.txt`, a lone surrogate. The run stopped as the spec requires:

```
stopped, no snapshot written: entry 'C:\\s3cab.sandbox\\fixtures\\scans\\scan-���.txt' has a name with no UTF-8 form; it can't be written into a snapshot
```

`snapshots/scans.info` exists (claimed at set-up, as s3cab does) with no snapshot under `snapshots/scans/`,
which the spec describes as "a set not yet backed up, or whose first backup stopped".

## Would leave a backup that can't be restored correctly

Ranked by how likely a careful implementer is to produce a wrong snapshot. Each is a guess I had to
make; a guess that turned out right is still listed.

1. **A member directory on a volume with no drive letter.** The real-path rule says to pass `\\?\` plus
   the path to `realpath` and "strip the `\\?\` it hands back, or turn `\\?\UNC\` back into `\\`". For a
   directory on a volume mounted only under a folder, `GetFinalPathNameByHandle` (which `realpath` uses)
   returns `\\?\Volume{GUID}\…`. Stripping the prefix leaves `Volume{GUID}\…`, which the spec's own
   grammar classifies as neither a Windows path nor an absolute POSIX path, so a reader finds every
   file row "under no DIR" and refuses them all. The spec covers a mount point met *inside* a walk (a
   junction, so an `#error`), but not one named as the member directory itself, which is followed. I
   had no such volume to test on; my program would write the broken form. The spec needs a rule for
   this case (write the GUID form whole, or refuse the member directory).
2. **The pre-send check's resolution.** "Check its size and modification time against its row" does not
   say at what resolution. The row holds milliseconds; the live file reports 100 ns ticks. Compared raw,
   every file would read as changed and no snapshot could ever be uploaded; compared after rounding to
   the millisecond, as I did, a rewrite inside the same millisecond passes the check and is caught only
   by the hash-as-you-send rule. I guessed "rounded the same way as the row". The test harness confirms
   the guess is at least internally consistent (an unchanged file uploads; an mtime moved by two
   seconds is refused).
3. **Case-sensitive directories on Windows.** The spec compares Windows paths ignoring case everywhere a
   writer compares them: a link's target against the member directories, and (by implication) one
   member directory against another. NTFS directories can be case-sensitive, and `edge\case` is one.
   Two member directories differing only in case inside such a directory are different directories, but
   a writer following the mapping stops the run as "the same directory"; a link whose target differs
   from a member directory only in case, in such a directory, is recorded as into the backup when it
   leads out, so its content looks saved and isn't. The fixture holds only two *files* in that state,
   which recorded correctly as two rows; the directory case is untested and is a hole in the rule.
4. **"The instant the last file's row was written" for `FINISH`.** A tool that hashes first and composes
   the file afterwards has no such instant; I used the end of hashing, before any object was uploaded.
   `FINISH` is "for you", so this is a people-only field, but the spec also promises that two snapshots
   of an unchanged set "differ in NAME, START and FINISH, and nowhere else", which only holds if every
   tool reads FINISH at an equivalent point. Low impact on restore, listed here because the promise is
   stated as a rule.

## Would inconvenience the implementer

1. **A set that can't be backed up without a feature the spec leaves optional.** A name with no UTF-8
   form stops the run, and "leaving it out gets past it, if the tool offers a way". A tool with the
   command line this exercise fixes offers no way, so `scans` has no backup at all, and never will. The
   spec should say plainly that an exclusion mechanism is practically required, or give a minimal
   writer a rule it can follow (an `#error` row with the U+FFFD spelling would have been one).
2. **The heading row's padding.** The canonical rule gives widths for columns 2 to 4 of "every row", and
   the example shows `size` right-aligned and `time` left-aligned, but the example also says it narrows
   the columns. I guessed `FORMAT` padded right to 64, `size` padded left to 12, `time` padded right
   to 24. Nothing in the spec states it; no reader depends on it, but "canonical" is checked by people
   and by diff.
3. **"The bucket's word".** Three ways count: a listing of `objects/`, a 412 from a conditional PUT, or an
   earlier snapshot plus valid deletion records. A HEAD is not among them (it appears only in the
   deletion-record sub-case), so the only way to avoid uploading everything is to list the whole
   `objects/` prefix every run, which grows with the repository. I list it; 1268 keys took one page.
   Say whether HEAD counts.
4. **When to claim, and what a stopped first run leaves behind.** "Claim whenever you like before the
   first snapshot's upload" leaves two reasonable designs with different visible results: a `.info` for
   a set whose first backup stopped (mine, and s3cab's), or none. A reader comparing two tools' buckets
   sees a difference the spec doesn't adjudicate.
5. **A set with snapshots but no `.info` can never be backed up by a rule-following tool** without a
   takeover, and a takeover happens "only when asked". A minimal tool has no "asked" path, so the
   spec should state what a writer without one does (refuse, which I do, with a message naming the fix).
6. **Whether the snapshot is still uploaded when `#error` rows exist.** "Any #error row makes s3cab's
   backup exit 1, after the snapshot is written" and "the snapshot is still written" never say
   *uploaded*. I upload and then exit 1 (the links table says "the backup exits nonzero", which reads
   as the whole run, upload included).
7. **`CLAIMED`'s precision.** START is "cut down", mtime is "rounded". `CLAIMED` is "in the same form"
   with no word on which. I truncated. Only ever compared as text, so harmless, but it is a guess.
8. **"The target named in the message as the link holds it".** A Windows link holds two names: the
   substitute name (`\\?\C:\…`, which Python's `readlink` returns) and the print name (`C:\…`). I wrote
   the print form by stripping the prefix. Free text, but the phrase implies one answer.
9. **Member directory given as a root** (`C:\`, `/`). "Always ending in a separator" is already true of
   the root; the writer section never shows a root DIR, only the restore section does. I kept one
   separator (`C:\`, not `C:\\`). Untested here (no spare drive to back up whole).
10. **`.info` writing rules are thinner than reading rules.** Readers strip one trailing CR and skip
    unknown lines; writers are told "LF endings" and nothing about a BOM, a trailing LF after the last
    line, or encoding. I wrote UTF-8, no BOM, each line LF-terminated.
11. **Which `#error` block an undeterminable entry goes in.** The order rule puts "every #excluded and
    #error row" near the top, then "an #error in among them for a file that failed while being read".
    An entry whose `stat` failed is neither; I put it in the top block. Order is a recommendation, but a
    writer still has to choose.
12. **The exit status for a bad command line** is unspecified (I use 2) and for a stopped run is "nonzero;
    s3cab's exits 1" (I use 1). Fine, but a table would save a reader the search.

## Hints that would have helped

Traps met on this platform that the spec could have named beside its checklists.

- **`UnicodeEncodeError` is not an `OSError`.** The "no UTF-8 form" case surfaces from `encode()` as a
  `ValueError` subclass, so a walker's `except OSError` never sees it, and `print()` of such a path
  raises too unless the stream was reconfigured with an error handler. `-X utf8` does not help for a
  lone surrogate. (My first probe died exactly there.)
- **`os.readlink` on Windows returns the `\\?\` substitute name** (Python 3.8+), so the target "as the
  link holds it" carries the prefix; the spec says to strip it for `realpath` only.
- **A junction's `lstat` mode is `S_IFDIR`, not `S_IFLNK`.** `S_ISLNK` is False; test
  `st_reparse_tag == 0xA0000003` or `DirEntry.is_junction()`. `os.scandir` plus
  `DirEntry.stat(follow_symlinks=False)` gives the tag without a second call.
- **botocore reads a file-like Body twice when you supply `ChecksumSHA256`.** Observed with
  `probe_body.py` (boto3 1.43, a 62,000-byte body, real PUT): `tell, seek(0,2), tell, seek(0)`, then a
  full pass of `read(1048576)` calls, then `seek(0)` and the length dance again, then the send itself
  in `read(131072)` blocks. The first pass is the payload hash for request signing. A "hash the bytes
  as you send them" wrapper must therefore restart its digest whenever the body is rewound to 0, or it
  reports a doubled stream; and a large file is read from disk twice. The spec's hint on
  `ChecksumSHA256` could say so. (botocore's retry handler also rewinds to 0 before a retry; no retry
  happened here, so that part is from its documentation, not observed.)
- **`datetime.fromtimestamp` raises `OSError` on Windows for a negative timestamp**, so a check of any
  pre-1970 instant through it fails there (my reference test died on the first random instant before
  1970); build from `datetime(1970,1,1) + timedelta` or do the civil arithmetic yourself, which also
  covers year 0000, which `datetime` can't hold at all.
- **HEAD with `ChecksumMode="ENABLED"` returns the stored `ChecksumSHA256`**, a one-request way to
  confirm that S3 checked the key's digest on the way in.
- **With long paths enabled system-wide, a plain 339-character path opens fine on Windows** (it did
  here), so the 260-character failure the spec warns about won't show up in testing on such a machine.
  The `\\?\` rule still has to be followed; a test machine can hide the bug.
- **`time.localtime()` and `strftime` mint the snapshot name without `tzdata`.** The zone hint reads as
  if the name were in doubt too; only the zone's *name* needs ICU (`ucal_getDefaultTimeZone` gave
  `Etc/UTC` here through `ctypes.WinDLL("icu")`).
- **A Python docstring that mentions `\\?\` must be a raw string**: `\U` starts an escape and the module
  fails to compile. Trivial, but it is the first thing a Windows implementer types.

## Environment notes, not the format

- **Sandbox.** The shell refused PowerShell subexpressions `$(...)`, script blocks, `$LASTEXITCODE`
  inside strings, `python -c`, and `Format-Table`/`Write-Output` with anything it judged a computed
  path; every helper therefore lives in a script file, and exit codes were read from the tool's own
  report. Environment variables could only be set by dot-sourcing `credentials.ps1` at the start of a
  command. The `aws` CLI worked with literal arguments only.
- **Toolchain.** Python 3.12.10 (python.org, MSC v.1943, 64-bit); boto3 and botocore 1.43.118; no
  `tzdata`, `zoneinfo.available_timezones()` empty; `icu.dll` present; machine zone UTC
  (`time.tzname` = "Coordinated Universal Time"), so every snapshot name equals its START minute.
  Long paths are evidently enabled system-wide. The `edge\case` directory is case-sensitive NTFS.
- **Bucket.** Started empty. Accepted `If-None-Match: *` (412 observed), `x-amz-checksum-sha256`
  (`BadDigest` observed on a mismatch), `ServerSideEncryption=AES256` (echoed on HEAD); default
  `Content-Type` stored as `binary/octet-stream`; storage class STANDARD. Emptied before the final
  runs with `list_object_versions` + `delete_objects`: 1286 versions and markers deleted, 0 keys left.
  The session credentials expire at 2026-10-23T07:11:45Z; no 403 was seen.
- **Timings** of the final runs (sequential, no caching, from `final-timing.log`):

  | Set | Wall time |
  | --- | --- |
  | edge (31 files, 27 objects) | 5.3 s |
  | docs (120 objects) | 18.6 s |
  | bulk (1100 objects) | 2 m 36 s |
  | media (42 MB in 2 objects) | 3.3 s |
  | hollow, faults, corrupt, scans | 1 to 2 s each |
  | spread (13 objects, 2 directories) | 3.4 s |

  Verifying `bulk` (1100 GETs and 1100 HEADs) took about 3 minutes.
- **Program limits, stated plainly.** Single-part uploads only, so a file over 5 GiB would fail at S3
  (the multipart dance in the spec's hints is not implemented). The whole `objects/` prefix is listed
  on every run. No exclusions, no takeover. Only the Windows paths ran here: the POSIX branches
  (`/etc/localtime`, `O_NOFOLLOW`, the case repair from parent listings for case-insensitive POSIX
  filesystems) are written to the spec's hints but untested. On Windows a file is opened without
  `O_NOFOLLOW`, so a symlink swapped in between listing and open would be followed (a race; not
  observed). Python 3.10 or later is required for `realpath(strict=True)`.

## Guesses about recommendations (not reported as gaps)

Listed only so the choices are visible: rows in `os.scandir` order, descending into a directory where
it is met; link `#error` rows before the file rows; `@SET BUCKET` written; `@CLIENT NAME`
`cleanroom-backup`, `@CLIENT VERSION` `0.1.0`; duration as `9s` / `12m 05s` / `3h 04m`; STANDARD
storage class and SSE-S3 on every PUT including `.info`; no `Content-Type`.

## Files beside this report

- `s3cab-backup.py` — the program.
- `s3cab-backup.local/` — the kept holder pairs and the local copies of the final snapshots.
- `verify_bucket.py`, `test_bucket_rules.py`, `test_helpers.py` — the checks described above.
- `probe.py`, `probe_body.py`, `survey.py`, `tools_versions.py`, `dump.py`, `empty_bucket.py` — scratch
  tools (`probe_body.py` PUT one scratch object to observe the SDK and deleted it; versioning is off, so
  nothing of it remains).
- `run1-*.log`, `verify1-*.log` — the first (pre-emptying) runs; `final-*.log`, `final-timing.log`,
  `verify-final.log` — the final runs and their verification.
