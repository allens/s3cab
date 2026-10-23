# The format-spec clean-room audit, run 10: backup on Linux, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on Linux (this run), [macOS](format-spec-audit-11.md)
and [Windows](format-spec-audit-12.md); restores on [Linux](format-spec-audit-13.md),
[macOS](format-spec-audit-14.md) and [Windows](format-spec-audit-15.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/linux/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 1 move flagged, a heredoc writing the session's own notes file; the judge found it
  harmless.
- **Tokens:** input 1,186, cache write 208,463, cache read 4,296,837, output 103,441.

Everything below the rule is the session's own report, verbatim.

---

# Report: writing an s3cab backup from the spec alone

Spec read: `format.md`, "the spec of 2026-10-23". Nothing else about the format was consulted.

## What was delivered

- `s3cab-backup.py` — the backup program. Python 3 standard library plus boto3. One file.
  Usage exactly as asked: `python s3cab-backup.py <bucket> <set> <dir>...`
- `check-bucket.py` — an independent reader written from the spec's *Reading* checklist, sharing
  no code with the backup program. It is how every claim below about the bucket was checked.
- `notes-guesses.md` — the running log of guesses, written as they were made.
- `s3cab-backup.state/` — what the spec says a backup keeps between runs (the `OWNER`/`CLAIMED`
  pair per bucket and set, in `state.json`) plus a local copy of each uploaded snapshot. Kept beside
  the program as asked.
- `final-run.log` — the transcript of the final runs and the audit that followed them.

Toolchain on this machine: Python 3.12.3, boto3 1.34.46, botocore 1.34.46, Linux. Nothing else.

## Outcome of the final runs

The bucket was emptied, then the final program was run once per set with exactly the command line
above and every directory `ENVIRONMENT.md` names. The transcript is in `final-run.log`.

| Set | Result | Exit |
| --- | --- | --- |
| edge | snapshot, 61 file rows, 55 objects, 3 `#error` rows (two links out of the backup, one unreadable file) | 1 (spec: any `#error` row exits 1 after the snapshot is written) |
| docs | snapshot, 120 file rows | 0 |
| bulk | snapshot, 1100 file rows | 0 |
| media | snapshot, 2 file rows (40 MiB and 512 KiB) | 0 |
| hollow | snapshot with no file rows (legal: an empty set) | 0 |
| spread | snapshot, 13 file rows under two `@SET DIR`s | 0 |
| faults | snapshot, 3 file rows | 0 |
| corrupt | snapshot, 3 file rows | 0 |
| scans | **stopped**: `scan-\xff.txt` has no UTF-8 form. `.info` claimed, no snapshot. | 1 |
| ledger | **stopped**: `q1<TAB>2026.txt` has a tab in its path. `.info` claimed, no snapshot. | 1 |

`scans` and `ledger` stop because the spec's writer checklist says a run must "stop without writing
a snapshot" for a name with no UTF-8 form and for a tab in a path a file row would hold, and the
only way past is to leave the entry out, which the fixed command line offers no way to ask for.
Both sets therefore end as the spec describes "a set not yet backed up, or whose first backup
stopped": a `.info` and nothing else.

The independent reader then took every snapshot in the bucket and found **no problems**:

- each snapshot is one gzip stream with nothing after it, strict UTF-8, no BOM, LF endings, the
  heading row first and `.` last, five fields a line, `FILES` and `SIZE` exact;
- every file row's hash is 64 lowercase hex, its size digits, its time a real instant, its path
  absolute and under a `@SET DIR` by whole segments, no path in two rows, none running through
  another;
- every object a snapshot names was downloaded and **re-hashed: all 1296 hash to their key**;
- objects and snapshots carry no `Content-Encoding` and no metadata; the content type is S3's
  default `binary/octet-stream`; SSE is `AES256`; HEAD reports a `FULL_OBJECT` SHA-256 checksum,
  meaning S3 itself verified the bytes against the key on receipt;
- against the disk: every row's size, SHA-256 and millisecond-rounded mtime match the file, and
  every regular file reachable without following a link has a row (`-` or `#error`). In `edge`,
  62 regular files: 61 `-` rows and one `#error` (the mode-000 file);
- every `.info` has `OWNER`, `CLAIMED`, `CREATED` as instants, LF endings.

## How the program meets the rules

In the order the spec's checklists give them:

- **Member directories** are resolved with `os.path.realpath(strict=True)` (on Windows through
  `\\?\`, prefix stripped, drive letter uppercased), then each name is looked up in its parent's
  listing so the on-disk case is used. A missing or non-directory member, two that are the same,
  or one inside another, stops the run.
- **One clock reading** gives `START` (cut to the millisecond) and the name (cut to the local
  minute). The zone is read from `/etc/localtime`, `TZ`, `/etc/timezone`, or on Windows `icu.dll`.
- **Second snapshot in the same minute** is refused twice over: a listing of `snapshots/<set>/`
  before any work, and `If-None-Match: *` on the final PUT (a 412 then compares bytes: identical
  means already uploaded, different means a conflict).
- **Holder**: with no `.info` and no snapshot in the folder, the set is claimed by a conditional
  PUT and the pair kept in `state.json`. With a `.info`, `OWNER` and `CLAIMED` must equal the kept
  pair as text, else the run refuses and forgets the pair. With snapshots but no `.info`, refuse.
  The check is repeated immediately before the snapshot's upload. Takeover is never done.
- **Walk**: `os.scandir`, never following links; a junction (`os.path.isjunction`) counts as a
  link. Entries are visited in code-point order. A link's final target is `realpath`ed: into a
  member directory means no row; broken (`ENOENT`, `ENOTDIR`, `ELOOP`, winerror 2/3/1921) no row;
  pipe/socket/device target no row; otherwise an `#error` row naming the target as the link holds
  it, the path ending in a separator when the target is a directory. Pipes, sockets and devices
  get no row. A directory that can't be listed stops the run. A name with no UTF-8 form stops the
  run. A file whose path holds a tab, CR or LF stops the run.
- **Hashing**: each file is opened with `O_NOFOLLOW | O_NONBLOCK` (where they exist), `fstat`
  confirms it is still a regular file and gives size and `st_mtime_ns` in one check just before
  the content is read. The mtime is rounded to the nearest millisecond on the integer nanosecond
  count, ties to the later, and formatted by an own calendar routine that covers years 0000 to
  9999 (Python's `datetime` cannot hold year 0). Outside that range, an `#error` row. A file that
  can't be opened or read gets an `#error` row among the file rows.
- **Rows** are laid out in canonical form: column 1 unpadded, column 2 right-padded to 64,
  column 3 left-padded to 12, column 4 right-padded to 24, in code points, column 5 verbatim.
  Tabs, CRs and LFs in `@SET DIR` and `#error` fields are spelled `␉ ␍ ␊`. Order: heading,
  `@S3CAB SPEC`, `@CLIENT NAME`/`VERSION`, `@SET NAME`/`BUCKET`/`DIR…`, `@SNAPSHOT
  NAME`/`BY`/`START`, link `#error` rows, file rows (with read-failure `#error`s among them),
  `FILES`, `SIZE` (exact number then the readable form, computed in `Decimal` with half-up
  rounding), `FINISH` (rounded up, with the duration), `.`. The text is gzipped as one stream with
  `GzipFile(filename="", mtime=0)`.
- **Objects first**: `objects/` is listed once; every hash not listed is sent with
  `If-None-Match: *` (added in a `before-call` handler, since this boto3 has no `IfNoneMatch`) and
  `ChecksumSHA256` set to the key's digest, so S3 refuses with `BadDigest` and stores nothing if
  the bytes don't match. Just before sending, size and `st_mtime_ns` are compared with the values
  taken at hash time; a change stops the run with no snapshot. The body is wrapped in a reader
  that hashes the bytes botocore actually sends, restarting whenever botocore rewinds for a retry,
  and the result is compared with the key as well. Files above 4 GiB go as multipart: each part
  with its own `ChecksumSHA256`, the whole hashed from the same bytes, `CompleteMultipartUpload`
  (also with `If-None-Match: *`) only if the whole hash equals the key, else abort.
- **Snapshot last**, byte for byte, conditional PUT, no content type, no encoding, no metadata.
- **Exit**: 1 if the run stopped or any `#error` row was written; 0 otherwise.

## Choices the spec leaves open (not gaps)

- Claim `.info` before the walk, after the member directories are validated. The spec allows
  "whenever you like before the first snapshot's upload". A stopped run therefore leaves a `.info`
  with no snapshot, which the spec names as a legitimate state.
- Storage class STANDARD (the rule only requires a class a plain GET reads at once); SSE `AES256`
  requested as s3cab does on AWS.
- `@CLIENT NAME` is `s3cab-backup`, version `0.1.0`. `@SET BUCKET` is written; `@SET ENDPOINT` is
  not, since the default AWS endpoint is used.
- No exclusion mechanism, so no `#excluded` rows are ever written and the tool's own folder is not
  special-cased (it lives beside the program, outside the fixture trees).
- Kept state is `s3cab-backup.state/state.json`, keyed by `<bucket>/<set>`; a local copy of each
  snapshot is kept with exclusive-create so it can never overwrite one.
- Retries: botocore `standard` mode, 3 attempts (legacy mode retries a `BadDigest` five times,
  as the spec's hint says; measured below).

## Would leave a backup that can't be restored correctly

Ranked, most serious first. The spec is thorough; only two points reached this list, and both are
narrow.

1. **The heading row's exact bytes are not given.** The spec says its five fields "padding aside"
   are exactly `@S3CAB FORMAT size time https://…`, and separately that the heading row is
   something "every reader already matches exactly". The canonical form section never shows the
   heading line as a string, the way it does for a file row and a `@SET DIR` row. I guessed that
   the heading is padded like any other row (`FORMAT` to 64, `size` left-padded to 12, `time` to
   24), which agrees with the example's right-aligned `size`. A reader that follows the five
   reading rules trims the fields and is unaffected. A reader that takes "matches exactly"
   literally and compares the first line byte for byte with s3cab's would refuse every snapshot
   this program writes, whole, if s3cab lays the heading out differently. One JSON string in the
   canonical-form section would close this. Checked: my heading line is
   `"@S3CAB\tFORMAT<58 spaces>\t        size\ttime<20 spaces>\thttps://s3cab.plantegral.com/guide/format\n"`
   and my independent reader, which trims, accepts it; I could not check it against s3cab's bytes.
2. **"A file that changes while it is hashed is caught on upload" is only true when the file is
   uploaded.** The size/mtime check is specified "just before sending a file", and an object that
   is already stored is never sent. A file that changes between its stat and the end of its read,
   whose read bytes happen to hash to an object already in the bucket (most plausibly: the file was
   replaced by a copy of another backed-up file during the read), is published with the old size
   and mtime against the new content. The restored content is a real stored object, but its mtime
   never belonged to those bytes. Not exercised by the fixtures; found by reading the two sentences
   together. A re-stat after hashing, for every file rather than only the ones sent, would close it;
   I did not add one because the spec says where the check is.

## Would inconvenience the implementer

Ranked by how long each cost or how likely a different reader is to choose differently.

1. **A tab, CR or LF in the name of a link that gets an `#error` row.** The writer checklist says
   stop when "a file you would give a row has a tab, CR or LF in its path"; the "No row holds a
   tab" section says such a name "can still appear" in an `#error` row and is spelled out there.
   Guess: stop only for entries that would get a `-` row (regular files, including one that ends
   up as `#error` for being unreadable); spell out in a link's `#error` row. Not exercised: the
   fixtures' tab is in a regular file (`ledger`), which stopped as required.
2. **Hashing "the bytes as you send them" when the SDK retries.** botocore rewinds the body
   (`seek(0)`) and re-reads it on a retry. A naive hasher fed by `read()` then hashes both passes
   and reports a mismatch for a correct upload, and a writer that then obeys "leave nothing
   stored under that key" deletes a good object and refuses its own snapshot. The spec says
   nothing about retries on the writer side. Solved by restarting the hash whenever the stream is
   rewound to 0, and by relying on `ChecksumSHA256` as the real guard (S3 refused wrong bytes with
   `400 BadDigest`, and a HEAD then returned 404: nothing stored).
3. **Columns 3 and 4 of an `#error` row for an unreadable file.** The size and mtime are known
   from `stat`, but the column table says column 3 holds "a `#deleted` row's size; otherwise
   blank" and column 4 "an instant, where the row has one". Left blank. A sentence under
   `#error` would settle it.
4. **Where "the same file turns up under two member directories" is detected.** The checklist
   phrases it as something that happens during the walk; the causes listed (one inside the other,
   or both the same) are decidable from the real paths before walking. Decided before walking.
   Whether two *hard links* to one inode under two member directories are "the same file" is not
   said; treated as two files, as the hard-link paragraph implies.
5. **When to refuse a second snapshot in the same minute.** The rule says refuse; it doesn't say
   whether to check before the walk (saving the work) or at the upload (closing the race). Did
   both. The early check was exercised: a rerun of `hollow` inside the same minute stopped with
   "already exists".
6. **The size column when the bytes read differ from the stat size.** The rule says the size is
   the one "when its modification time was read, just before its content was hashed"; it does
   not say what to do when the read then yields a different count. Recorded the stat size and
   left it to the upload check, as the spec's design implies.
7. **Member directory given as a relative path.** The spec speaks only of absolute paths.
   Resolved against the working directory through `realpath`.
8. **Windows `os.readlink` returns `\\?\`-prefixed targets for absolute links.** The `#error`
   message must name the target "as the link holds it"; whether the prefix is part of that is not
   said. Stripped it. Untested here (no Windows).
9. **When multipart applies.** The multipart section explains how, not when; the implementer
   has to know S3's 5 GiB single-PUT ceiling from elsewhere. Chose 4 GiB. Exercised only by
   lowering the threshold to 8 MiB on the 40 MiB fixture (5 parts): the stored object re-hashed
   to its key, HEAD showed a composite checksum ending `-5`, and a second multipart over the
   existing key hit 412 on complete and aborted cleanly, leaving no open uploads.
10. **The kept pair "per set".** A tool used against two buckets with a set of the same name in
    each needs the bucket in the key as well; the spec says only "per set".
11. **`realpath` case fixing when the parent can't be listed.** The spec gives `F_GETPATH` for
    macOS only; on other systems the typed case is all there is. Fell back to the typed case.
12. **Reproducing s3cab's row order needs two passes over the tree** (every link `#error`
    before the first file row, but a read failure's `#error` among the file rows). It is only a
    recommendation, but the paragraph reads as a description of a single walk.
13. **A member directory on a Windows volume without a drive letter** (`\\?\Volume{GUID}\…`) fits
    the spec's definition of a Windows path as a share with server `?` and share `Volume{…}`.
    The spec is silent. Untested and not handled specially.

## Hints that would have helped

- **`strftime("%Y")` doesn't zero-pad years below 1000** on glibc/Python, so a 24-character
  instant built from a `datetime` comes out 23 characters for year 399. Hit this writing the test
  oracle; the program formats with `%04d`.
- **Python's `datetime` starts at year 1**, while the form allows year 0000. An own
  days-to-civil conversion is needed, and the common C algorithm's era shift double-corrects
  under Python's floor division. Hit this: my first version gave `0000-01-02` for the first
  millisecond of year 0; a round trip over every day from 0000-01-01 to 9999-12-31 now passes.
- **botocore reads a `put_object` body exactly once when `ChecksumSHA256` is supplied** (no
  `Content-MD5` pre-pass), and rewinds it with `seek(0)` before a retry. Knowing this makes
  hash-while-sending straightforward; without it the wrapper is guesswork.
- **botocore retries `BadDigest` only in legacy mode.** Measured on this bucket:
  `RetryAttempts = 5` in legacy mode, `0` in standard mode. The spec's hint names the five
  attempts; adding "use `retries={'mode': 'standard'}`" would save the reader a search.
- **`head_object(ChecksumMode="ENABLED")`** shows the stored SHA-256 and a `ChecksumType` of
  `FULL_OBJECT` for a single PUT, or a composite ending `-<parts>` for multipart. It is a one-line
  way to confirm S3 checked the bytes, and a demonstration of the multipart warning.
- **On Linux and macOS, `os.path.realpath("/etc/localtime")` yields the IANA zone** (here
  `…/zoneinfo/Etc/UTC`). The spec's "Python's standard library can't name the local IANA zone"
  is true of the `time`/`zoneinfo` modules but a reader stops looking too soon.
- **`os.scandir` entries plus `is_symlink()`, `is_dir(follow_symlinks=False)` and
  `is_file(follow_symlinks=False)`** classify every fixture correctly on POSIX, including the
  FIFO, and `os.open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` then `fstat` makes the open itself the
  type check. The spec hints at the flags; naming `scandir` would help.
- **boto3 1.34's `put_object` accepts any object with `read`, `seek` and `tell`** as a body and
  sends a plain (non-chunked) body with `ContentLength`, so the hashing wrapper needs nothing
  more.

## Environment notes, not the format

- Python 3.12.3, boto3/botocore 1.34.46 (Ubuntu packages), aws CLI 2 present, Linux 6.17 (Azure VM).
- Credentials come from `credentials.env`, sourced at the start of every command; they are a
  session triple with an expiry of 2026-10-23T08:25:37Z. All work finished well inside it.
- Building a boto3 client **without** the environment credentials makes botocore probe the EC2
  metadata endpoint (169.254.169.254), which the sandbox refuses and reports as a violation. Not a
  bucket or format problem; it happened once, on a client built only to read the service model.
- Egress goes through the proxy in `HTTPS_PROXY`; boto3 and the aws CLI honour it with no
  configuration. Virtual-hosted addressing to `us-east-1` worked.
- The bucket has a lifecycle rule (`expire-test-objects`, visible in every HEAD response) that
  expires objects on 2026-10-25. Anything restored from this bucket after that date will find every
  object gone.
- The runs were made as uid 1001, not root. That is what makes `edge/unreadable/locked.txt`
  (mode 000) unreadable and produces its `#error` row; as root it would be read and backed up.
- S3's conditional PUT (`If-None-Match: *`) and full-object SHA-256 verification behaved as the
  spec describes: 412 on an existing key, `400 BadDigest` with nothing stored on wrong bytes.
- Throughput was not the point; a 40 MiB single PUT and 1100 small PUTs each completed within a
  minute through the proxy.

## What was checked, and what was not

Checked by running (all against the real bucket):

- The ten final runs and the independent audit described above (`final-run.log`).
- Development runs before the bucket was emptied: a rerun in the same minute refused; a tampered
  kept pair refused and forgotten, then refused again with no pair; `.info` deleted from a set with
  snapshots, then a run refused; a second run of `docs` a minute later reused all 120 objects and
  its two snapshots differed only in `@SNAPSHOT NAME`, `START` and `FINISH`, as the spec says they
  must.
- Multipart (with a lowered threshold), 412 on an existing object, 412 on
  `CompleteMultipartUpload`, `BadDigest` with nothing stored, and the changed-file guard, by
  calling the program's functions directly.
- The gzip header of a snapshot: flags 0 (no name), mtime 0, one stream, no trailing bytes.
- Unit checks: the instant formatter agrees with `datetime` over 20000 random values in years
  1 to 9999 and round-trips every day of years 0000 to 9999; rounding ties go to the later
  millisecond for positive and negative times; readable sizes give `999.9kB` for 999,949 and
  `1.0MB` for 999,950; the canonical file row and `@SET DIR` row equal the spec's JSON examples
  byte for byte.

Not checked, and stated as such:

- The Windows and macOS branches (`\\?\`, junctions, `icu.dll`, case fixing on a
  case-insensitive filesystem, lone surrogates): written from the spec's hints, never run.
- Files above the 4 GiB multipart threshold at their real size.
- A file vanishing between listing and reading, an entry whose type can't be determined, a
  directory that can't be listed, and a link whose target can't be resolved for a reason other
  than being broken: the code paths exist, no fixture reaches them.
- Takeover of a set: not implemented, since the spec says to do it "only when asked" and the
  command line has no way to ask.
