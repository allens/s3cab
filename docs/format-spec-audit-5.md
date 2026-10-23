# The format-spec clean-room audit, run 5: backup on macOS, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on [Linux](format-spec-audit-4.md), macOS (this run) and
[Windows](format-spec-audit-6.md); restores on [Linux](format-spec-audit-7.md),
[macOS](format-spec-audit-8.md) and [Windows](format-spec-audit-9.md).

- **Program:** [`s3cab-backup.py`](https://github.com/allens/s3cab/blob/a2cb93351d5e293123a9fac096d42409ef3749ce/scripts/cleanroom/backup/macos/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens:** input 114, cache write 276,567, cache read 9,218,509, output 179,766.

Everything below the rule is the session's own report, verbatim.

---

# An s3cab backup written from format.md alone — report

## Outcome

`s3cab-backup.py` uses only the Python 3 standard library and boto3. It does a run in this order:

1. Claims the set, or checks that this machine holds it.
2. Walks the member directories and builds the snapshot in canonical form.
3. Reads the snapshot back as a reader would.
4. Stores every missing object at `objects/<sha256>`.
5. Re-checks the holder.
6. Uploads `snapshots/<set>/<name>.tsv.gz` with `If-None-Match: *`.
7. Keeps a byte-identical local copy.

The `OWNER`/`CLAIMED` pair it wrote and the snapshot copies are kept in `cleanroom-backup-state/`, beside the program.

**The bucket now** holds what the final runs left, after I emptied it and ran the program once per set (07:33–07:37Z, log in `final-runs.log`):

- 8 snapshots, 9 `.info` files and 1292 objects, with nothing else in the bucket.
- **`ledger` is not backed up.** Its one file is named `q1<TAB>2026.txt`. The spec says such a run stops and writes no snapshot, and this tool has no way to leave an entry out. So it stopped with exit 2 and named the file; the set has its `.info` claim but no snapshot. It can only be backed up once that file is renamed, or with a tool that can exclude it.
- **`edge` exited 1.** It has three `#error` rows: the two links that lead out of the backup (`link-out-dir/`, `link-out-file`) and the mode-000 file `unreadable/locked.txt`. Its snapshot was uploaded, as the spec requires.
- The other seven sets exited 0.
- I ran `python3 s3cab-backup.py …`, not `python …`, because this machine has no `python` on PATH.

**Audit of that final state** (`final-audit.log`; `audit-bucket.py` shares no code with the program, and every result comes from real requests): **0 problems.**

- **Snapshots:** all eight passed every whole-file rule and every path rule, and each row matches its canonical layout.
- **Objects:** all 1292 referenced objects were downloaded and re-hashed against their keys, and none carries `Content-Encoding` or `x-amz-meta-*`. Every object is older than the snapshot naming it, and there are no orphans.
- **`.info`:** every one is well-formed and was written before its set's first snapshot.
- **Rows vs disk:** each set's rows equal an independent walk of the directories, using `os.walk`, Python's own `open` for hashing and `decimal` for rounding.
- **Independent hashing:** `shasum -a 256` (not Python) agrees with all 1297 file rows.
- **Local copies:** each kept copy is `cmp`-identical to its snapshot in the bucket.

The audit was itself checked: it flagged every fault I planted in a copy of a snapshot (see *What I checked*).

## How each stored object is made to hold the bytes its key names

- **Files up to 16 MiB:** the program re-reads the file into memory and re-hashes it, and refuses if the bytes no longer hash to the row. It then PUTs exactly those bytes with `x-amz-checksum-sha256` and `If-None-Match: *` (`s3cab-backup.py:805`, `:786`). S3 recomputes the checksum and stores nothing on a mismatch; I tested that with a wrong checksum, which got 400 BadDigest and left HEAD at 404. The program also requires S3's echoed checksum to equal the one it sent.
- **Files above 16 MiB** (here `media/clip.bin`, 40 MiB, 3 parts): multipart upload with `ChecksumAlgorithm=SHA256` (`s3cab-backup.py:821`). Each part is sent with its own SHA-256, which S3 checks, and the whole-file hash is computed from those same bytes. `CompleteMultipartUpload` is sent only if that hash equals the key; otherwise the upload is aborted and nothing is stored.
- **A file that changed after hashing:** the snapshot is not uploaded. Where other paths with the same hash exist, they are tried first. Tested both ways: nothing was stored under either key, no snapshot appeared, and no multipart upload was left open.
- **Supplying the checksum also avoids aws-chunked:** with the checksum given, boto3 sends a plain body (no `Content-Encoding`). I confirmed that on the wire, and the audit confirms it on every stored object.

---

## Would leave a backup that can't be restored correctly

1. **The same directory named twice isn't covered by the stop rule.**
   - *Where:* Writing a snapshot, "Stop … when the same file turns up under two member directories, because one is inside the other".
   - *The gap:* two arguments with one real path aren't "one inside the other" on a literal reading. Examples: `/tmp/x` and `/private/tmp/x`, a symlink and its target, or the same path given twice.
   - *Why it breaks a restore:* a writer that walks both writes every path in two `-` rows. The reader rule ("both rows are refused, so no reader guesses") then refuses both rows of each pair, so no file in that directory can be restored, and the backup that wrote it reported success. "Give each path at most one per-path row" catches this only for a writer that checks its own output.
   - *My guess:* the same real path, or the same `(st_dev, st_ino)`, counts as nested, and the run stops (`s3cab-backup.py:599`).
   - *Tested:* `t-dup` (`$T/nest` and `$T/../trees/nest`) stopped with exit 2.

2. **A file that changes while it is being hashed.**
   - *Where:* the spec covers a file changing after the snapshot recorded it (Uploading) and a file that "couldn't be read". It is silent on a file that changes *during* the read.
   - *Why it breaks a restore:* a writer that hashes a file mid-write records, stores and later restores bytes that never existed as one version of the file. They are restored "faithfully", with no error anywhere. If the writer takes the size from `stat`, the size column also disagrees with the bytes hashed.
   - *My guess* (`s3cab-backup.py:443`): `fstat` before and after the read, and accept only if size and mtime are unchanged and the bytes read equal the size. Retry three times, then write `#error` "kept changing while it was read". The size column is the count of bytes actually hashed.
   - *Tested locally:* an 8 MiB file appended to by a thread during hashing got that `#error`; once quiet, it got the right hash and size.

3. **"Into the backup" doesn't say how to compare.**
   - *Where:* Links, "the place it finally resolves to … is a member directory or lies inside one". Neither the path comparison (which spelling, what case?) nor identity is specified.
   - *What makes it hard on macOS:*
     - `realpath` keeps a link target's case as typed.
     - Firmlinks give one directory two real paths. `/Users/Shared` and `/System/Volumes/Data/Users/Shared` have the same `st_dev`/`st_ino`, and `realpath` leaves each as it is.
   - *Why it breaks a restore:* a comparison that is too strict gives spurious `#error`s (exit 1, but the content is saved). One loosened to cope with macOS, for example case-insensitive, will on a case-sensitive disk call a link to `/data/Photos` "into" a member `/data/photos`. That link then gets no row and its target is recorded nowhere: content silently missing.
   - *My guess* (`s3cab-backup.py:588`): "into" means a whole-segment match of the true-cased real path, **or** the target (or one of its ancestors) has a member directory's `(st_dev, st_ino)`. I use the same identity test for nesting (item 1).
   - *Tested:* links whose targets were typed in the wrong case or reached through a chain got no row; links out got `#error` rows.

4. **How a writer finds out an object is "already at its key".**
   - *Where:* Uploading, "Count an object already at its key as stored, without downloading it to check". It doesn't say how.
   - *The gap:* S3's 403 for a missing key, when the caller can't list the bucket, is explained only in the Reading checklist.
   - *Why it breaks a restore:* a writer that treats any non-404 HEAD as "present" skips the upload and publishes a snapshot naming objects the bucket doesn't hold.
   - *My guess:* HEAD, where only 404 means absent and any other error stops the run before the snapshot. Every PUT is also conditional, with 412 meaning present.
   - *Not tested:* these credentials can list the bucket, so the 403 case never arises here.

## Would inconvenience the implementer

Most consequential first. Each one is a guess I made while writing; the `G` numbers refer to the dated log in `NOTES-findings-log.md`.

1. **A contradiction in "Valid and invalid files"** (G22). "Every segment of a path past its root a name: not empty, so no trailing or doubled separator" contradicts the rule that a directory's path ends with a separator. That rule is mandatory for `#excluded` directories and for the `#error` rows of links to directories. Read literally, every such row makes the file invalid. *Guess:* the segment rule applies to file rows only, which is what "refuse one path … for a file row" enforces.
2. **Tab, CR or LF in the name of an entry that gets no row** (G3): a FIFO, socket, broken link, link into the backup, or empty directory. The checklist's "a name holds a tab, CR or LF → stop" says any name; the stated reason (row grammar) says only names that would be written. *Guess:* any name stops the run. Tested: a FIFO named `pipe\ttab` stopped it.
3. **Claiming and the kept pair.**
   - *When to claim:* "whenever you like before the first snapshot's upload". *Guess:* first thing, before the walk, so a set whose first backup stops (`ledger`) still has a `.info` (G4).
   - *What "`snapshots/<set>/` is empty" means:* *Guess:* no key at all under the prefix (G17).
   - *A kept pair whose `.info` is gone* (the bucket was emptied): *Guess:* if `snapshots/<set>/` is also empty, it's a new set, claimed afresh; if snapshots remain, refuse (G5). Both tested.
   - *Keying of the kept pair* (per set, per bucket and set, per endpoint): *Guess:* per bucket and set (G26).
   - *Reading `.info`:* the four reading rules' BOM forgiveness explicitly doesn't apply, and repeated keys aren't covered. *Guess:* strip a BOM; a key repeated with different values fails the holder check (G18).
   - *Precision of `CLAIMED`/`CREATED`:* only "same form as mtime". *Guess:* truncated (G12).
4. **Where things fall in a run.**
   - *FINISH* is "when the run finished" but is inside the snapshot, which is uploaded last. *Guess:* FINISH is at the end of the walk, before the object uploads (G11).
   - *The run's start* (for the name and START): *Guess:* the program's first instruction, before claiming (G27).
   - *Local copy:* "the two are identical", but if it's written before the holder check, a refused run leaves a local snapshot that was never published. *Guess:* keep it only after upload (G29). My first version got this wrong.
5. **Entries that change after being checked** (G8, G9). An entry that lstat found but that then fails to open with ENOENT: "vanished" (no row) or "couldn't be read" (`#error`)? *Guess:* `#error`. A subdirectory that vanishes before it is listed: "can't be listed" (stop) or "vanished"? *Guess:* stop.
6. **Exit status of a run that stops** (G24). Only s3cab's "exit 1 for `#error`" is given. *Guess:* 2 for a stop or refusal, 1 for `#error` rows after the upload, 0 otherwise.
7. **Set-name alphabet** (G2). "Lowercase letters, digits and hyphens": ASCII only, or `é`/`ß`? Empty? *Guess:* `[a-z0-9-]+`.
8. **The member directory's own path** (G20). It could hold a tab, CR or LF, or have no UTF-8 form, and every row would inherit it; the rule speaks only of "a name". *Guess:* the same stop applies.
9. **Deduplicated files when the first copy changed before upload** (G21). *Guess:* try the other paths with that hash.
10. **Writers and deletion records** (G28). "Presence always wins … backed up afresh" implies a backup simply re-uploads deleted content that is still on disk, but the uploading checklist says nothing. *Guess:* ignore the records and HEAD every object.
11. **Unspecified headers and forms** (G13, G25).
    - *Content-Type* for objects, snapshots and `.info`: only `Content-Encoding` is ruled out. *Guess:* send none; S3 stores `binary/octet-stream`.
    - *The form of `@SET ENDPOINT`:* *Guess:* the full endpoint URL, written only when one is configured.
12. **Identity strings for another tool** (G1). The spec says `@CLIENT NAME` names "the tool", and only that tool's rows give extra `@CLIENT` rows their meaning. *Guess:* `cleanroom-backup`, with no `@CLIENT HOME`. The `user` and `machine` of `OWNER`/`BY` are undefined. *Guess:* login name and short host name.
13. **Wording** (G31). Links are "never followed and never recorded", yet a link out of the backup *is* recorded, as an `#error` row.

## Hints that would have helped

- **macOS: you may not be allowed to list a parent.** The spec's fix for `realpath` keeping typed case ("look each name up in its parent's listing") failed here: listing `/Users`, `/Users/Shared` and `/Users/Shared/s3cab.sandbox` returns EPERM in this sandbox. `fcntl(fd, F_GETPATH)` on an opened *directory* returns its on-disk spelling with no listing at all (`/USERS/SHARED/…/EDGE` → `/Users/Shared/…/edge`). I don't use it on files, because a hard-linked file may report its other name. That's a precaution, not something I observed.
- **macOS firmlinks** (`/Users` vs `/System/Volumes/Data/Users`): `realpath` doesn't unify them, so compare `(st_dev, st_ino)` for nesting and for "into the backup" (see item 3 of the first list).
- **POSIX: build every row's path from the `@SET DIR` string itself.** Readers match DIRs exactly off Windows, so file paths walked from a differently spelled argument land under no DIR, and every row is refused.
- **APFS refuses non-UTF-8 names outright** (`EILSEQ` on create), so "a name has no UTF-8 form" can't be exercised on a Mac; it needs Linux.
- **"An entry whose type couldn't be determined" arises on POSIX** from a directory that is readable but not searchable (mode `r--`): its names list, and every `lstat` fails with EACCES. Naming this would have saved hunting for a test case.
- **Don't hang on a FIFO swapped in after `lstat`.** Open with `O_NOFOLLOW | O_NONBLOCK` and confirm `S_ISREG` with `fstat`.
- **botocore retries `400 BadDigest`.** A part with a wrong checksum was sent 5 times before boto3 raised. Not wrong, but a changed file costs several uploads before the error shows.
- **When the command line is fixed, `-X utf8` isn't available.** `sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")` does the same job from inside the program. I couldn't test this on Windows.
- **Testing the stop rule from a shell:** `$(printf '\n')` yields nothing, because command substitution strips trailing newlines. My first "LF" test file was really named `linefeed.txt`. Make such names from Python.

## Environment notes, not the format

- No `python` on PATH, only `python3` (3.14.7). The final runs used `python3 s3cab-backup.py …`; the program is unchanged.
- boto3/botocore 1.43.117 has native `IfNoneMatch`. A `before-call` handler covers older versions; I checked that it sends the header and gets 412, but on 1.43. botocore reads `AWS_DEFAULT_REGION`, not `AWS_REGION`, so the program passes `AWS_REGION` itself. The proxy in `HTTPS_PROXY` was honoured with no configuration. `~/.aws` is unreadable in the sandbox, and boto3 didn't need it.
- The bucket was never versioned. It applies SSE-S3 (AES256) by default; I requested no encryption myself.
- Speed: `bulk` (1100 files of ≤20 bytes) takes about 3 minutes, one HEAD and one PUT per object, sequentially, through the proxy.
- The file-writing tool I used turned `\uXXXX` escapes in my source into literal invisible characters. I re-escaped them, and the program is pure ASCII.
- `aws s3api list-objects-v2 --query KeyCount` printed `null` for the emptied bucket; `aws s3 ls --recursive` confirmed 0 keys. The shell is zsh, so one log line's `PIPESTATUS` printed blank.
- Probe keys under my client folder `.cleanroom-backup/` and test sets `t-*` existed during testing. All were removed when I emptied the bucket before the final runs.
- The credentials never expired during the work.

## What I checked, and how

Unless stated, all of this was against the real bucket, before the final emptying, using test sets named `t-*` and trees in `$TMPDIR`.

| Case | Result |
| --- | --- |
| All 9 sets, the first time and again in the final runs | Final runs as above; audit 0 problems both times |
| Audit's power: planted faults in a snapshot copy (no `.`, narrowed padding, wrong FILES, wrong SIZE readable form, duplicate path, missing object, two gzip streams, CRLF, file name in the gzip header, bad mtime form, path outside every DIR) | Each one flagged. A trimmed trailing space in a path is invisible to a snapshot-only check; only the comparison with the disk catches it, which is why the audit does that comparison |
| File changed after hashing: single PUT and multipart | Exit 2; nothing stored under either key; no snapshot; no open multipart upload |
| Same content at two paths, first one changed | Stored from the second; downloaded bytes hash to the key |
| `.info` rewritten by "another machine" between the walk and the upload | Refused at the holder check; the next run is refused too |
| Different bytes planted at the snapshot's key | Refused and left untouched; no local copy kept |
| Lost reply to the snapshot PUT | Same bytes found at the key and accepted |
| A second run in the same minute | Refused |
| `.info` deleted, snapshots kept | Refused (no takeover) |
| The whole set gone from the bucket, with a stale local pair | Claimed afresh |
| Links: loop, through a file, dangling, to `/dev/null`, to a FIFO | No rows |
| Links: wrong-case target and a chain, both into the backup | No rows |
| Link to a target behind a mode-000 directory | `#error` "can't resolve", no trailing `/` |
| Link to a folder outside | `#error` with a trailing `/` |
| Link into the program's state folder | `#error` (outside) |
| Member directory typed `…/REALCASE/sub` | Recorded as `…/RealCase/Sub/` |
| Member directory reached through `/tmp` | Recorded under `/private/tmp/…` |
| Nested members, duplicate members, an unlistable subdirectory, names with TAB/CR/LF | Stop, exit 2, each offending path named |
| A directory with mode `r--` | `#error` "can't tell what this is" per entry |
| A link target containing TAB and LF | Spelled out as `␉`/`␊` in the message |
| A file dated in the year 10000 (injected) | `#error`; its sibling backed up |
| A later-named snapshot planted | Warning that the new name won't sort last |
| The program's state folder inside a member directory | No rows for it |
| Pure functions: mtime rounding (ties to later, before 1970, 2038, .9996 rounding up into the next second), the readable SIZE form (999,949 → `999.9kB`, 999,950 → `1.0MB`), trim (keeps U+0085, strips BOM/U+3000) | All as the spec's examples |

## Not tested, or not testable here

- **Windows and Linux.** The `\\?\` handling, junctions, drive-letter case, the `icu.dll` zone name, `winerror`-based link classification, non-UTF-8 names (stop and U+FFFD) and case-insensitive Linux directories are written from the spec but have never run.
- **Untested sizes:** files over 5 GiB and the part-size scaling for files over about 140 GiB.
- **The 403 HEAD path** (item 4 of the first list) and S3's `409 ConditionalRequestConflict` under concurrent writers.
- **A real boto3 1.34:** only the handler mechanism was exercised, on 1.43.

## Files here

- `s3cab-backup.py` — the program.
- `cleanroom-backup-state/` — the kept claim pairs and snapshot copies.
- `audit-bucket.py` — the independent checker.
- `final-runs.log`, `final-audit.log` — the final runs and their audit.
- `NOTES-findings-log.md` — the guesses as I made them, dated by phase.
