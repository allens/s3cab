# The format-spec clean-room audit, run 23: backup on macOS, Fable 5.1 at xhigh (2026-11-09)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on
[Linux](format-spec-audit-22.md), macOS (this run) and [Windows](format-spec-audit-24.md); restores
on [Linux](format-spec-audit-25.md), [macOS](format-spec-audit-26.md) and
[Windows](format-spec-audit-27.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/macos/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 3 moves flagged, each a heredoc writing the session's own files (its program, its
  verifier, its report), caught only by the word "s3cab" in them; the judge found all three
  harmless.
- **Tokens:** input 1,932, cache write 240,248, cache read 9,805,920, output 126,670.

Everything below the rule is the session's own report, verbatim.

---

# Writing an s3cab backup from the spec alone

Clean-room report on `format.md` (spec of 2026-10-30). Deliverables in this directory:

- `s3cab-backup.py`: the backup writer. `python s3cab-backup.py <bucket> <set> <dir>...`
  Standard library plus boto3, one file, no platform-specific imports at module level.
- `s3cab-backup.state.json`: what the spec says a backup keeps between runs, the holder pair
  (`OWNER`, `CLAIMED`) per bucket and set. Written beside the program.
- `check-restore.py`: an independent, strict reader written from the spec's *reading*
  checklist, used only to audit what the writer produced. It restores a set's latest snapshot
  under `$TMPDIR` and compares the result with the member directories on disk.

Headline: the spec's rules were sufficient. Every set that the spec allows to be backed up was
restored by the independent reader byte for byte, with modification times to the millisecond,
on the first attempt against the real bucket. The gaps below are real but small; the one that
could change what a restore produces concerns how a member directory's name is spelled, and
only on a filesystem that ignores Unicode normalization.

## How the program works

Order of one run, following the uploading checklist:

1. One clock reading mints `@SNAPSHOT NAME` (local time) and `START` (UTC, cut to the ms).
2. Write the upload lock (`locks/upload-<instant>`, conditional PUT, read back on 412), then
   list `locks/`: remove a dead run's lock of this user, machine and OS; refuse on any live
   `delete-` lock.
3. Establish the holder: read `snapshots/<set>.info`. Match against the kept pair, or claim a
   new set with a conditional PUT when the folder holds no snapshot; refuse otherwise.
4. Resolve each member directory to its real path spelled as the disk spells it, end it with
   one separator, and stop when one is missing, not a directory, or overlaps another.
5. Walk without following links. Classify each link (into the backup: no row; out or
   unresolvable: `#error`; broken, or to a pipe/socket/device: no row). Stop on a regular file
   whose path holds a tab, CR or LF, on a name with no UTF-8 form, or on a directory that
   can't be listed.
6. Hash each file from a handle opened without following a link, taking size and mtime from
   `fstat` on that handle just before the read; an `#error` row for a file that can't be read,
   has vanished, isn't regular any more, reads a different number of bytes, or whose time the
   24-character form can't hold. `FINISH` is taken here, rounded up.
7. Objects first: HEAD `objects/<hash>`; if missing, re-check size and mtime against the row,
   read and hash the bytes, and send them only if they still hash to the key, with
   `ChecksumSHA256` set to the key's digest so S3 refuses anything else (plain conditional
   PUT under 16 MiB; multipart with per-part SHA-256 above, completed only when the whole hash
   equals the key, aborted otherwise). A changed file withholds the snapshot, exit 1.
8. Re-read `.info` immediately before the snapshot PUT; refuse unless the pair matches.
9. Upload the snapshot (single gzip stream, no name or mtime in the header) with a
   conditional PUT; a 412 with different bytes is a second snapshot in the same minute.
10. Remove the lock in all cases.

Choices the spec leaves to the tool: storage class STANDARD (a plain GET reads it at once);
HEAD per object rather than listing `objects/`; 16 MiB multipart threshold and part size, as
s3cab's; directory entries sorted by name; `@CLIENT NAME` `s3cab-backup`; `@SET BUCKET`
written, `@SET ENDPOINT` only when `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` is set; no local
copy of the snapshot; no exclusion facility, so no `#excluded` rows are ever written; the set
is claimed before the walk, as the spec recommends.

Consequence of the fixed command line: the `ledger` set holds `q1<TAB>2026.txt`, so the spec
requires the run to stop with no snapshot, exit 1, and it does. Because the claim is made
before the walk, the bucket keeps `snapshots/ledger.info` with no snapshot folder, which the
spec describes as "a set not yet backed up, or whose first backup stopped".

## Would leave a backup that can't be restored correctly

1. **Spelling a member directory on a filesystem that ignores Unicode normalization (silent).**
   The spec requires the member directory's real path "with the casing the filesystem itself
   reports" and, for macOS, says to "look each name up in its parent's listing". It says
   nothing about normalization, which APFS also ignores: a member directory typed as NFD
   `cafe<U+0301>` opens the NFC `caf<U+00E9>` on disk, and a lookup by string equality in the
   parent's listing finds nothing. A writer that then keeps the typed spelling writes a
   `@SET DIR` and file paths whose bytes differ from what the disk holds. The content restores,
   but restored on Linux the tree lands in a folder spelled differently from the original, and
   two snapshots of one set typed two ways never compare equal. Guess: match by identity
   (`samestat` against the typed name) rather than by string, and on macOS take
   `fcntl(F_GETPATH)`, which reports the on-disk spelling in one call. Verified: a member
   directory typed in NFD produced a `DIR` row and file rows spelled NFC, matching the disk.
   The same question applies to a Linux directory with casefolding, which I could not test.

Nothing else I had to guess could have produced a snapshot a reader refuses or restores
wrongly. The evidence is the restore comparison in "What was verified": every file row of
every uploaded set restored byte for byte with its millisecond mtime, every `#error` row named
a file that is genuinely unreadable or a link out of the set, and the strict reader found every
line canonical.

## Would inconvenience the implementer

1. **A kept holder pair whose `.info` has gone, with no snapshots in the folder (silent).**
   Publishing requires `.info` to match the kept pair and refuses when it is gone; claiming is
   allowed "only while `snapshots/<set>/` holds no snapshot". The spec never says whether a
   tool that still holds a pair may claim afresh when the `.info` is gone and the folder is
   empty, which is exactly the state after a bucket is emptied or recreated. Guess: read
   `.info` at the start of every run; if it is gone and the folder holds no snapshot, claim
   again and replace the kept pair; if it is gone but snapshots exist, refuse (a person must
   take the set over); if it is present and differs from the kept pair, forget the pair and
   refuse. Verified on the real bucket in all three branches, and by the final runs after the
   bucket was emptied.

2. **`@SNAPSHOT FINISH` for a tool that hashes first (ambiguous).** The table defines it as
   "the instant the last row before `FILES` was written", and the text adds that "a tool that
   hashes first and writes the file afterwards takes it when the last file was done". My first
   version took it after the objects had been uploaded, which satisfies the first sentence and
   not the second (13 s for `edge`, where hashing itself took under a second). Changed to the end of hashing. A
   people-only row, so no reader is affected, but the two sentences should be one.

3. **How to spell a link's resolved target before comparing it with the member directories
   (thin).** The Links section says to compare real paths "spelled as the filesystem reports
   it" and notes that `realpath` keeps the case as typed on macOS, but the lookup procedure is
   given only for member directories. A writer that compares raw `realpath` output calls a
   link into the backup whose text is in another case or normalization "out of the backup":
   a false `#error` row and exit 1 on every run. Guess: apply the member-directory procedure
   to the target too. Verified: links whose text spelled the target in upper case, in NFD, and
   through `/tmp` (a symlink to `/private/tmp`) all resolved as into the backup with no row.

4. **Where `#error` rows go, and which errors are "found by the walk" (recommendation worded
   as fact).** The row order section puts every `#excluded` and `#error` row the walk finds
   before the file rows, and hashing-time errors "in among them", listing "it can't be read"
   as a hashing-time finding. This forces a two-phase design (walk, then hash) if a writer
   wants to match s3cab's layout. Readers go by type, so it is only layout, but the checklist
   doesn't say so where the two-phase cost is incurred.

5. **An `#error` row for an entry whose type couldn't be determined: separator or not
   (silent).** "A path ending with a separator is a directory" lists three cases; an entry
   whose `lstat` failed is none of them. Guess: no separator, since the type is unknown. Not
   exercised by the fixtures.

6. **The fallback when the on-disk spelling can't be learned (silent).** The spec's procedure
   is to look each name up in its parent's listing. Here the sandbox denied listing `/Users`
   while every deeper directory listed fine, so the procedure fails for a permission reason the
   spec doesn't anticipate. On macOS `F_GETPATH` answers anyway; on Linux nothing does. Guess:
   keep the typed spelling for a segment whose parent can't be listed.

7. **The key for the kept pair (thin).** "A set's name says nothing without its bucket, so key
   it by both" — but a bucket name says nothing without its endpoint either, since two
   providers can hold same-named buckets. Guess: include the endpoint in the key when one is
   configured.

8. **`.info` before or after the walk, and what a stopped first run leaves (explicit but easy
   to miss).** The spec allows claiming "whenever you like before the first snapshot's upload"
   and recommends claiming early. A tool with no separate set-up step that follows that advice
   leaves a `.info` with no snapshots for every set whose first run stops, which is what the
   final `ledger` run shows. Worth a sentence in the writing checklist.

## Hints that would have helped

- **macOS: `fcntl(fd, F_GETPATH)` is the practical way to get the on-disk spelling of a
  path.** One call, works through links, needs no permission to list the parent. The spec
  mentions it only in passing under "where listing a directory's parent is refused", and the
  listing-based procedure it recommends failed here for exactly that reason.
- **macOS `realpath` rewrites `/tmp` to `/private/tmp` and `/var` to `/private/var`.** A
  `@SET DIR` under either never reads as typed. Correct per the real-path rule, but a surprise.
- **Python's format widths count code points.** `f"{c2:<64}"` is exactly the spec's padding
  rule, including for `🎉`. The terminal view goes ragged for wide glyphs; the file is canonical.
- **`errno.ELOOP` is 62 on macOS and 40 on Linux.** Use the constant when classifying a
  broken link; the spec names the symbol, which is right, but a numeric table would mislead.
- **Open files with `O_NOFOLLOW | O_NONBLOCK` and then `fstat`.** It refuses a link swapped
  in after the walk and doesn't block on a FIFO swapped in. Windows has neither flag; there,
  check `fstat` after opening.
- **boto3 1.36 and later with `ChecksumSHA256` supplied**: the body goes plain, no
  `aws-chunked`, and `head_object(ChecksumMode="ENABLED")` shows `ChecksumType: FULL_OBJECT`.
  For multipart, `create_multipart_upload` must be given `ChecksumAlgorithm="SHA256"` for the
  per-part `ChecksumSHA256` values; the stored checksum is then `COMPOSITE` and ends in
  `-<parts>` (`-3` for 40 MiB in 16 MiB parts), as the spec's hint says. I passed the
  algorithm from the start, so what S3 does without it was not tested.
- **After a 412 on `complete_multipart_upload`, the multipart upload stays open.** Abort it,
  or it lingers (and is billed) until a lifecycle rule removes it. boto3 1.43 has
  `IfNoneMatch` natively on both `put_object` and `complete_multipart_upload`.
- **AWS can answer a racing conditional write with HTTP 409 `ConditionalRequestConflict`,
  not 412.** The spec covers only 412. Not observed in this work; the program retries a 409 a
  few times.
- **Reading the zone name from `/etc/localtime`**: on macOS it resolves to
  `/private/var/db/timezone/tz/<version>/zoneinfo/<Zone>`, so take everything after
  `zoneinfo/`, not the last path component alone (here `UTC`).
- **`sys.stdout.reconfigure(errors="backslashreplace")`** lets a program print any path
  without raising, which matters when a name holds U+0085 or a form feed, as two fixtures do.
- The spec's Python hints checked out exactly as stated: `str.strip()` removes `\x1c`–`\x1f`
  and U+0085 and keeps U+FEFF; `splitlines()` breaks on VT, FF, `\x1c`–`\x1e`, U+0085,
  U+2028, U+2029 and CR; `round()` takes ties to even; `gzip.open` writes a non-zero mtime
  into the header while `GzipFile(filename="", mtime=0)` does not.

## Environment notes, not the format

- Machine: macOS (Darwin 24.6.0), APFS, case-insensitive. Python 3.15.2 at
  `/opt/homebrew/bin/python3`; there is no `python` on `PATH`, so every run used `python3`.
  boto3 1.43.126, botocore 1.43.126. The local zone is UTC.
- Network: egress only through the HTTP proxy in `HTTPS_PROXY` (basic auth). boto3 honours
  it with no code. `aws s3api` works; the high-level `aws s3 rm`/`cp` commands, which use the
  CRT transfer client, fail with `AWS_IO_TLS_ERROR_NEGOTIATION_FAILURE` through the proxy, so
  the bucket was emptied with boto3 `delete_objects` (1,328 keys, one call per 1,000).
- Credentials: a session token from `credentials.env`, valid until 20:49Z. Once, with the file
  not sourced, boto3 tried the instance-metadata endpoint `169.254.169.254`, which the sandbox
  blocks; a reminder to source the file in every command.
- Bucket: `test-s3cab-ci-cleanroom-backup`, `us-east-1`, versioning not enabled, empty at the
  start. S3 stores `Content-Type: binary/octet-stream` when none is sent. `If-None-Match: *`,
  `ChecksumSHA256` and `ServerSideEncryption: AES256` all accepted. No stray multipart uploads
  were left behind.
- Sandbox: `os.listdir("/Users")` is denied (EPERM) while deeper directories list fine, which
  is what exercised the `F_GETPATH` fallback. Writes were confined to this directory and
  `$TMPDIR` (`/private/tmp/claude-501`); the scratch trees used for tests live there.
- Shell: zsh, which doesn't word-split an unquoted variable, so one early test loop passed a
  whole argument list as one argument and hit the usage error.
- Timing through the proxy: `bulk` (1,100 files, 21 kB in all) took about 4.5 minutes, one HEAD
  and one conditional PUT per object; the 40 MiB `media` file took about 3 seconds as a 3-part
  multipart upload; the other sets took seconds.
- Downloading the one 1 MiB object through the proxy was cut mid-body in two separate runs
  of the audit (`IncompleteRead`, 196,228 bytes short the first time); botocore's retries don't cover a body that stops
  streaming, so the audit tool needed its own retry. The writer's uploads never hit this.
- Signing: SigV4 by botocore; nothing custom. Retries: botocore `standard` mode, five
  attempts, 10 s connect and 60 s read timeouts.

## What was verified

Everything below ran against the real bucket over the network.

Unit checks of the pure functions, before any upload:

- The calendar conversion agreed with `datetime` on 20,000 random instants between the years
  1 and 9999, and gives `0000-01-01` and `0000-02-29` where `datetime` can't; year −1 and
  year 10000 are rejected.
- Rounding ties go to the later millisecond for positive and negative counts; the fixture at
  `.999599933` s rounded up into the next second (`2017-07-14T02:40:01.000Z`), and the one at
  −86400.25 s gave `1969-12-30T23:59:59.750Z`.
- The readable size matched every example in the spec (`0B`, `999B`, `999.9kB` for 999,949,
  `1.0MB` for 999,950, `4.9MB` for 4,915,200).
- The heading row, a file row and a `@SET DIR` row matched the spec's three JSON strings
  byte for byte.

Behaviour of the writer, each case run and its output read:

- Stops with no snapshot: missing member directory; member directory that is a file;
  overlapping directories (outer + inner); the same directory typed in two cases; the same
  directory via a symlink and directly; a directory that can't be listed; a regular file with
  a tab in its name (`ledger`). Each exited 1 and left no snapshot.
- A symlink given as a member directory, typed in the wrong case, was followed and recorded as
  its real on-disk path.
- Refusals from the repository: a `.info` held by someone else; snapshots present with no
  `.info`; a live `delete-` lock of another user (own lock removed, run refused); a dead
  `delete-` lock of this user and machine (removed, run proceeded); a second snapshot in the
  same minute (412, different bytes, refused); `.info` and snapshots gone with a pair kept
  (claimed afresh).
- A file that grew after hashing was caught by the size-and-time check; a file rewritten with
  the same size and its mtime put back was caught by hashing the bytes. Nothing was stored
  under either key, the unchanged sibling was still uploaded, the snapshot was withheld, exit 1.
- A nonexistent bucket produces one error line, not a traceback.
- Set-name grammar: `Trial_Bad` refused with exit 2.

Stored headers, read back with `head_object`: no `Content-Encoding`, no user metadata,
`ServerSideEncryption: AES256`, `ChecksumSHA256` present and `FULL_OBJECT` for every plain PUT
and `COMPOSITE` ending `-3` for the 40 MiB multipart object; the gzip header has flags 0 and
mtime 0.

Restore comparison with `check-restore.py`: see the final section.

Skipped, and why:

- Windows: `\\?\` paths, junctions, drive letters, reserved names, `OpenProcess`. No Windows
  machine. The code paths exist but ran only on macOS.
- Linux: `PIDNS`, casefolding directories, names that aren't UTF-8 (APFS refuses such names,
  so the stop could not be provoked here).
- An entry whose type can't be determined, and the "own bytes after a lost response" branch
  of the `.info` and lock PUTs.
- A 409 on a conditional write.
- `#excluded` rows: the tool has no exclusion facility, so it never writes one.
- What S3 does with per-part `ChecksumSHA256` when `ChecksumAlgorithm` is not declared on
  `create_multipart_upload`.

## Final runs and bucket state

The bucket was emptied (1,328 keys from the trial runs deleted with `delete_objects`; no
versioning, no in-progress multipart uploads) and the holder-state file removed. Then one run
per set, in the order `ENVIRONMENT.md` lists them, each with exactly
`python3 s3cab-backup.py test-s3cab-ci-cleanroom-backup <set> <dirs>`:

| Set | Exit | Snapshot | File rows | Objects uploaded | Note |
| --- | --- | --- | --- | --- | --- |
| edge | 1 | `20261109T1514` | 56 | 51 | 3 `#error` rows: two links out of the set, one unreadable file; exit 1 by the spec's rule |
| docs | 0 | `20261109T1514` | 120 | 120 | |
| bulk | 0 | `20261109T1515` | 1,100 | 1,100 | 4 min 37 s through the proxy |
| media | 0 | `20261109T1520` | 2 | 2 | 40 MiB file as a 3-part multipart upload |
| hollow | 0 | `20261109T1520` | 0 | 0 | empty set: `FILES 0`, `SIZE 0 (0B)` |
| spread | 0 | `20261109T1520` | 13 | 13 | two `@SET DIR` rows |
| faults | 0 | `20261109T1520` | 3 | 3 | |
| corrupt | 0 | `20261109T1520` | 3 | 3 | |
| ledger | 1 | none | | | stopped: `q1<TAB>2026.txt`; `snapshots/ledger.info` claimed, no snapshot folder |

The bucket as left: 1,309 keys. 1,292 under `objects/`, 8 snapshots, 9 `snapshots/<set>.info`,
nothing under `locks/`, no in-progress multipart uploads, nothing else.

Verification of that final state with `check-restore.py`, every result from a real request:

- Each of the 8 snapshots decompressed as one gzip stream, decoded as strict UTF-8, started
  with the heading row, ended with the `.`, had five fields on every line, every line in
  canonical form, every file row under a `@SET DIR` by whole segments, no path in two rows,
  no path running through another, `FILES` and `SIZE` agreeing with the rows, `START` before
  `FINISH`, `@SNAPSHOT NAME` equal to the key.
- Every file row's object was fetched and hashed to its key, written under `$TMPDIR`, and
  its mtime set and read back. Every restored file matched the original on disk byte for
  byte and to the millisecond; every regular file under the member directories had a row,
  except `edge/unreadable/locked.txt`, which has the `#error` row the spec asks for.
  1,297 files restored across the 8 sets.
- All 9 `.info` files hold `OWNER`, `CLAIMED` and `CREATED` in the 24-character form,
  LF-terminated, no CR.
- Every one of the 1,292 `objects/<hash>` keys was downloaded and hashed; all 1,292 hash to
  their key. One download (the 1 MiB `edge/sizes/size-1m.bin` object) was cut mid-body by the
  proxy on both attempts of the check and succeeded on its retry.

What was not verified: anything on Windows or Linux, and the cases listed as skipped above.
