# The format-spec clean-room audit, run 18: backup on Windows, Fable 5.1 at xhigh (2026-11-04)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on
[Linux](format-spec-audit-16.md), [macOS](format-spec-audit-17.md) and Windows (this run); restores
on [Linux](format-spec-audit-19.md), [macOS](format-spec-audit-20.md) and
[Windows](format-spec-audit-21.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/windows/s3cab-backup.py), Python with
  boto3, and `ctypes` for the Windows calls. Its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged. The transcript it read didn't survive:
  `gather` stopped on the session's own test links, after the check, the audit and the judge had
  run, so CI reads the run as failed. [PR #500](https://github.com/allens/s3cab/pull/500) fixed
  `gather` for later runs.
- **Tokens:** input 1,026, cache write 243,202, cache read 4,910,665, output 129,448.

Everything below the rule is the session's own report, verbatim.

---

# Writing an s3cab backup from the spec alone

`s3cab-backup.py` in this directory was written from `format.md` (the spec of 2026-10-30) and
nothing else, on Windows Server 2025 with Python 3.12.10 and boto3 1.43.123, and run against
the real bucket `s3://test-s3cab-ci-cleanroom-backup`. Every finding below names what I ran to
check it; the scripts are in `scratch/`.

## What the program does

`python s3cab-backup.py <bucket> <set> <dir>...` resolves each member directory to its real
path, writes an upload lock, refuses on a delete lock and removes a dead run's lock of its
own, claims or checks `snapshots/<set>.info`, walks the directories without following links,
hashes every file from an open handle (size and mtime from `fstat` on that handle), writes the
snapshot in canonical form to a local copy, lists `objects/`, uploads every missing object
with a no-overwrite PUT that carries the key's own SHA-256 for S3 to check (parts of 16 MiB
with their own checksums above 16 MiB, completed only once the whole hash equals the key),
re-reads `.info`, uploads the snapshot byte for byte with a no-overwrite PUT, and removes the
lock. It excludes nothing, so it never writes `#excluded`; it keeps the `OWNER`/`CLAIMED` pair
in `s3cab-backup.holders.json` beside itself and a copy of each snapshot under `snapshots/`.
`--take-over` is the only option, for the one thing the spec says must be asked for.

## How it was checked

An independent reader, `scratch/verify.py`, downloads a set's latest snapshot and applies the
spec's reading rules: strict UTF-8, LF splitting, the heading row and the `.`, five fields,
canonical padding, the row grammar, each path in one row, every file row under a `@SET DIR`,
`FILES` and `SIZE` against the rows. It then fetches every object the snapshot names, hashes
it against its key, checks the stored headers, and compares every row with the file on disk
(hash, size, mtime rounded to the millisecond). It reported no problem for any set.

| Set | Rows | Objects | Result |
| --- | --- | --- | --- |
| edge | 31 file rows, 3 `#error` rows | 27 distinct, all hash to their key | exit 1 (links out of the backup), snapshot uploaded |
| docs | 120 | 120 | exit 0 |
| bulk | 1100 | 1100 | exit 0, two LIST pages |
| media | 2 | 2, one of them 40 MiB in 3 parts (`COMPOSITE`, `-3`) | exit 0 |
| hollow | 0 | 0 | exit 0, a legal empty snapshot |
| spread | 13 under two `@SET DIR` rows | 13 | exit 0 |
| faults | 3 | 3 | exit 0 |
| corrupt | 3 | 3 | exit 0 |
| scans | none | none | exit 1, run stopped: `scan-���.txt` has no UTF-8 form; `.info` left, no snapshot |

Other things run against the real bucket, each behaving as the spec asks:

- A foreign `.info` makes the run refuse; `--take-over` rewrites `OWNER` and `CLAIMED` and keeps `CREATED`.
- A `locks/delete-…` key makes the run refuse and remove its own lock. A `locks/upload-…` key with my `BY` and `OS` and a dead PID is removed and the run goes on.
- A second run in the same minute with the local copy deleted gets 412 from the bucket, compares bytes, and refuses the conflict.
- A file appended to between the walk and its upload stops the run: no snapshot is uploaded, the lock is removed.
- A member directory that is a symlink, and one that is a junction, are walked and recorded as their real paths. A member typed as `DOCS\` is recorded as `docs\`.
- A junction member and its target, a link member inside another member, and two spellings of one directory are refused as overlapping.
- A file held open with no sharing gets an `#error` row; a subdirectory with listing denied stops the run.
- Relative links out of the backup are written with the target as the link holds it; loops and links through a file get no row; links into the backup get no row.
- Files dated 1950, the last millisecond of 9999, a half-millisecond tie that rounds into the year 10000, and the year 10000 itself: two file rows and two `#error` rows.

## Would leave a backup that can't be restored correctly

Ranked by how likely a writer is to get it wrong and how much a restore loses.

1. **A file row's path must be built on the member directory's real path, and the spec never says so on the writer's side.** The writer checklist asks for "its absolute path" and, separately, for `@SET DIR` as the real path; only the reader's validity rules say every file row must lie under a `DIR`. A writer that joins names onto the path as typed records `…\edge\link-to-sub\dedup-b.txt` under `@SET DIR …\edge\sub\`, or `C:\S3CAB.SANDBOX\…` under `C:\s3cab.sandbox\…`: on a POSIX path every row is refused as under no `DIR`, and on Windows the link, `subst` and short-name cases are refused even after the case-insensitive match. Guess: every path is the real path of the member directory plus the names the listing reports. Checked: the `linktest` run (member `edge\link-to-sub`, rows under `…\edge\sub\`) and the `docs` run typed as `DOCS\` (rows under `docs\`), both read back clean by `verify.py`.

2. **"The same file turns up under two member directories … or both are the same directory" doesn't say to compare real paths.** Two members that are one directory through a junction, a symlink or a case difference pass a comparison of the typed strings. The snapshot then holds two identical `@SET DIR` rows and every file twice, and the rule "each path in at most one per-path row" makes a reader refuse both rows of every file: the whole tree is lost on restore. Guess: resolve each member first and compare by whole segments, exactly. Checked: `edge\junction` with `outside`, `edge\link-to-sub` with `edge`, and `spread\alpha` with `SPREAD\Alpha` each stopped with "member directories overlap".

3. **A name the format can't hold may be left out by the tool on its own, with exit 0.** The rule is that a lone surrogate, or a tab, CR or LF in a file's path, stops the run, and that "leaving it out gets past it"; but "Leaving entries out is optional, and how a tool chooses them is its own business", and only `#error` rows make a backup exit 1. A writer that reads those together may exclude such a name automatically, write the `#excluded` row with U+FFFD, and exit 0: the file is missing from every restore and nothing reported it. Guess: never leave anything out unasked; the run stops, exits 1 and names the entry. The spec should say an exclusion is the user's choice, or that an exclusion the tool chose itself is an `#error`. Checked: the `scans` run stopped with `scan-���.txt`, exit 1, no snapshot.

## Would inconvenience the implementer

1. **The spec assumes the tool has a way to be "asked" to take a set over and to leave entries out, and the task fixes the command line.** I invented `--take-over`; I offer no excludes, so a set holding a name the format refuses (`scans`) can't be backed up by this tool at all, and a directory it can't list stops the set for good. Checked: `scans` and the `denied` set both stop, exit 1.
2. **When to claim `.info`: "whenever you like before the first snapshot's upload".** I claim right after the lock check, before the walk, so a run that stops leaves a `.info` with no snapshot. The spec names that state as normal ("or whose first backup stopped") but gives no preference. Checked: `snapshots/scans.info` and `snapshots/denied.info` exist with no snapshot.
3. **When to write the lock relative to the walk.** The checklist says before anything that decides what to skip; walking and hashing decide nothing, so the lock could come after a walk of hours. I hold it for the whole run, so a clean-up waits or refuses for the whole backup. Either reading is valid; the spec could say which s3cab does.
4. **"The instant the run started" names three things**: the lock's id, `START`, and the snapshot's name. I take one clock reading for all three; after a 412 on the lock with foreign bytes the lock's instant is re-minted and no longer equals `START`. The spec doesn't say whether that matters (I assume not).
5. **After "don't send it", what next?** The upload rule says a changed file isn't sent and the snapshot isn't uploaded, but not whether the run stops at once or carries on sending the other objects first. I stop at once; the objects already sent are the orphans the spec calls harmless. Checked: `scratch/test_change.py`.
6. **Which `#error` rows go "near the top" and which "in among" the file rows.** The order is a recommendation, but the spec words it as what s3cab writes, and "a file that failed while being read" is the only kind placed among the file rows. I put link, resolution and type errors at the top, and read, size-mismatch and mtime-range errors in the body. Checked: `edge`, `locked` and `times` snapshots.
7. **`@SNAPSHOT FINISH` for a set with no file rows**: "the instant the last file's row was written" has no file row to point at. I take the instant after the (empty) body. Checked: `hollow`.
8. **"Into the backup" means a member directory of this run**, I assume, not any set's in the bucket. A link into another set's tree gets `#error` and exit 1 from my tool; a different reading writes no row. Neither loses data.
9. **`OS` values.** Python's `sys.platform` equals Node's `process.platform` on `win32`, `linux` and `darwin` but not elsewhere (`freebsd14`, `aix`, `sunos5`), so a Python tool and s3cab on such a machine would never judge each other's dead locks. Harmless by the spec's own rule, but a table of canonical values would remove the guess.
10. **Multipart threshold and part size** are s3cab's choice (16 MiB); the rule only says S3 takes a single PUT of up to 5 GiB. I copied s3cab's numbers. Checked: `media`, 3 parts.
11. **Storage class.** The rule is "a class a plain GET reads at once"; s3cab's Glacier Instant Retrieval has a 128 KB minimum billable size and a 90-day minimum that a writer copying s3cab would inherit without warning. I use the provider's default (`STANDARD` on AWS). Checked: `StorageClass` absent on HEAD, which is S3's way of saying `STANDARD`.
12. **"Already stored" for a multipart object.** With `objects/` listed, the HEAD the hint recommends before a multipart upload is redundant; I do both, since the hint reads as advice to a writer that doesn't list.
13. **Where to keep the `OWNER`/`CLAIMED` pair.** "Per set" — but the same set name can live in two buckets, so I key the state by bucket and set.
14. **How a writer detects "a second snapshot in the same minute" without a local copy.** Only the bucket's 412 can; I keep a local copy and refuse on either. The spec says keeping a local copy is a choice but builds the same-minute rule on top of it without saying so.
15. **`@SET BUCKET` when the bucket is given as `s3://…`.** I accept both spellings and always write `s3://<bucket>`.
16. **`BY` in the lock and `OWNER` in `.info`** are both `user@machine`; the spec doesn't say they must agree. I write the same string in both and in `@SNAPSHOT BY`.
17. **The zone name on Windows.** The hint about `icu.dll` works (`Etc/UTC` here); I did not test the case where `TZ` is set, which the C runtime's `localtime` honours and ICU does not, so the name and the zone could disagree.

## Hints that would have helped

1. **`os.kill(pid, 0)` on Windows terminates the process.** The dead-lock rule needs "is this PID alive", and the obvious POSIX idiom kills it on Windows. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` with `GetExitCodeProcess` works: error 87 is no such process, error 5 is one you can't open, exit code 259 is still active. Checked: `scratch/probe.py` and the stale-lock test (PID 999999 judged gone, the lock removed).
2. **`DirEntry.is_dir(follow_symlinks=False)` is `True` for a junction**, so the junction check must come first; the spec's hints cover `os.walk` and `os.path.islink()` but not `scandir`, which is what the FIFO hint steers you to. Checked: `scratch/probe.py` (`junction=True dir_nf=True`).
3. **`os.scandir` on a `\\?\`-prefixed directory yields `entry.path` with the prefix**, so every open and recursion goes through the prefix for free, and `entry.name` is the on-disk spelling. Checked: the same probe; `CON`, `aux.txt`, `nul.txt`, `notes.`, `trailing.txt ` and the 343-character path all opened and hashed.
4. **The trailing-dot trap also fools `os.stat` and `os.path.realpath`**, not just `open`: with `notes` beside `notes.`, the plain path reports the neighbour's size and resolves to the neighbour. Checked: `scratch/probe3.py` (35 bytes through the plain path, 25 through `\\?\`).
5. **`os.utime(path, ns=…)` on NTFS accepts the year 10000 and 1950**, which is how to test the mtime-range rule. Checked: the `times` set.
6. **botocore reports a conditional PUT's 412 as `ClientError` with `Error.Code` `PreconditionFailed`**, and `complete_multipart_upload` takes `IfNoneMatch` in boto3 1.43. Checked: the same-minute conflict test and the `media` upload. `create_multipart_upload` was given `ChecksumAlgorithm="SHA256"` because the parts carry `ChecksumSHA256`; I did not test without it.
7. **Python's `PermissionError` for a file held without sharing says only "Permission denied"**; the winerror (32) is what tells a sharing violation from an ACL, so print it if the `#error` message is to be useful. Checked: the `locked` set.
8. **The printing trap in the hints bites test tooling too**: my unit script crashed printing `␉` to a cp1252 stdout. Checked: `scratch/unit.py` before `reconfigure`.

## Environment notes, not the format

- Windows Server 2025 Datacenter 10.0.26100; Python 3.12.10 (hostedtoolcache); boto3 and botocore 1.43.123; the AWS CLI. The local zone is UTC and ICU names it `Etc/UTC`. User `runneradmin`, host `runnervmhao91`.
- Credentials are temporary STS keys for the role `s3cab-ci/GitHubActions`, set per command by `credentials.ps1`, with `AWS_REGION=us-east-1`; the program passes that region to boto3 explicitly. No proxy variables; botocore's default SigV4 over HTTPS straight to S3. `s3:GetBucketLocation` is denied; list, get, put, delete, multipart and the lifecycle read are allowed.
- The bucket has a lifecycle rule `expire-test-objects`: every object expires after one day, and incomplete multipart uploads are aborted after one day. The final state below will be gone within a day of writing.
- S3 defaults seen: `Content-Type: binary/octet-stream` when none is sent; `ChecksumSHA256` stored as `FULL_OBJECT` for single PUTs and as a `COMPOSITE` value ending `-3` for the 3-part upload; no `Content-Encoding` and no metadata on anything.
- The sandbox shell refuses `$(…)`, expandable strings, `$LASTEXITCODE`, `python -c`, comma lists in cmdlets, and paths spelled in another case than the allowed directories, so every probe and test is a script in `scratch/`, and `scratch/runit.py` prints the program's exit status.
- Throughput, sequential and uncached: 1100 single PUTs in 150 s; the 40 MiB file in 3 parts in about 2 s; the whole `edge` set in 5 s.

## Spec claims checked on this machine

Verified: `os.path.abspath` drops a trailing dot and `normpath` keeps it; `os.path.realpath(strict=True)` through `\\?\` returns the on-disk case with an uppercase drive and keeps the prefix; a dangling link fails with winerror 2, a link through a file with 3, a loop with `EINVAL` and winerror 1921; `os.readlink` returns `\\?\C:\…` for an absolute link and the relative text for a relative one; `os.walk(followlinks=False)` descends into a junction and yields nothing for a missing top; `os.path.islink` is `False` and `os.path.isjunction` `True` for a junction; a lone surrogate becomes three U+FFFD; `GzipFile(filename="", mtime=0)` writes a header with no name and a zero time; a file held without sharing raises `PermissionError`; `head_object` with `ChecksumMode="ENABLED"` shows the stored SHA-256 and whether it is composite; supplying `ChecksumSHA256` leaves no `Content-Encoding` stored.

Not tested here: a tab, CR or LF in a name (Windows forbids them); pipes, sockets and devices; a share or `\\?\Volume{GUID}` member; a non-AWS endpoint; a file changing while it is hashed (only between the walk and the upload); a `BadDigest` refusal; the POSIX true-case routine (no Linux or macOS here); 5xx retries; a `.info` with CRLF endings.

## Final state of the bucket

The bucket was emptied (`aws s3 rm --recursive`, then a LIST showing `KeyCount 0` and no
multipart upload in progress), the program's local `snapshots/` and holders file were removed,
and the nine commands were run once each, in this order, with exactly the command line the task
gives and every directory `ENVIRONMENT.md` names:

```
python s3cab-backup.py test-s3cab-ci-cleanroom-backup edge C:\s3cab.sandbox\fixtures\edge
python s3cab-backup.py test-s3cab-ci-cleanroom-backup docs C:\s3cab.sandbox\fixtures\docs
python s3cab-backup.py test-s3cab-ci-cleanroom-backup bulk C:\s3cab.sandbox\fixtures\bulk
python s3cab-backup.py test-s3cab-ci-cleanroom-backup media C:\s3cab.sandbox\fixtures\media
python s3cab-backup.py test-s3cab-ci-cleanroom-backup hollow C:\s3cab.sandbox\fixtures\hollow
python s3cab-backup.py test-s3cab-ci-cleanroom-backup spread C:\s3cab.sandbox\fixtures\spread\alpha C:\s3cab.sandbox\fixtures\spread\beta
python s3cab-backup.py test-s3cab-ci-cleanroom-backup faults C:\s3cab.sandbox\fixtures\faults
python s3cab-backup.py test-s3cab-ci-cleanroom-backup corrupt C:\s3cab.sandbox\fixtures\corrupt
python s3cab-backup.py test-s3cab-ci-cleanroom-backup scans C:\s3cab.sandbox\fixtures\scans
```

`edge` exited 1 with its snapshot uploaded (three `#error` rows for the links out of the
backup); `scans` exited 1 and uploaded no snapshot ("an entry's name has no UTF-8 form:
C:\s3cab.sandbox\fixtures\scans\scan-���.txt"); the other seven exited 0. `verify.py` then
read every set back from the bucket and reported `RESULT: OK` for the eight with a snapshot,
every object hashing to its key and every row matching its file on disk; for `scans` it
reported the expected "no snapshot for set".

What the bucket holds now, by real LIST requests (`scratch/count.py`):

| Prefix | Keys |
| --- | --- |
| `objects/` | 1268 (27 + 120 + 1100 + 2 + 0 + 13 + 3 + 3; no content is shared between sets) |
| `snapshots/` | 17: a `.info` for all nine sets, and one snapshot for each set but `scans` |
| `locks/` | none |
| root | none; no multipart upload in progress |

Snapshot keys: `snapshots/edge/20261104T0616.tsv.gz`, `snapshots/docs/20261104T0616.tsv.gz`,
`snapshots/bulk/20261104T0617.tsv.gz`, `snapshots/media/20261104T0619.tsv.gz`,
`snapshots/hollow/20261104T0619.tsv.gz`, `snapshots/spread/20261104T0619.tsv.gz`,
`snapshots/faults/20261104T0619.tsv.gz`, `snapshots/corrupt/20261104T0619.tsv.gz`.
Beside the program: `snapshots/<set>/<name>.tsv.gz`, byte for byte the uploaded files, and
`s3cab-backup.holders.json` with the nine `OWNER`/`CLAIMED` pairs, `scans` included.
