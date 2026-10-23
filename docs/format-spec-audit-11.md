# The format-spec clean-room audit, run 11: backup on macOS, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on [Linux](format-spec-audit-10.md), macOS (this run)
and [Windows](format-spec-audit-12.md); restores on [Linux](format-spec-audit-13.md),
[macOS](format-spec-audit-14.md) and [Windows](format-spec-audit-15.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/macos/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 4 moves flagged, each a heredoc writing the session's own files (its program, its
  notes, its verifier, its report), caught only by the word "s3cab" in them. The judge could not
  rule: Opus 5.5's safeguards refused the request in CI and again on a rerun outside it. Claude Opus
  5.5 read the four moves by hand instead, in the maintainer's session, and found each harmless;
  that reading is kept with the run as `judge-manual.txt`.
- **Tokens:** input 774, cache write 252,156, cache read 3,744,428, output 145,916.

Everything below the rule is the session's own report, verbatim.

---

# Report: an s3cab backup written from the spec alone

`s3cab-backup.py` in this directory is a clean-room writer for the s3cab repository format,
built from `format.md` (the spec of 2026-10-23) and nothing else. Python 3 standard library plus
boto3; one file; meant to run unchanged on Linux, macOS and Windows (only macOS was available
here, see *What was not tested*). It keeps one thing between runs, as the spec requires: the
OWNER/CLAIMED pair it wrote when it claimed each set, in `s3cab-backup.state.json` beside the
program.

    python s3cab-backup.py [--take-over] <bucket> <set> <dir>...

Exit 0: snapshot uploaded with no `#error` row. Exit 1: the run stopped with nothing uploaded, or
the snapshot was uploaded but holds `#error` rows (the spec's rule). Exit 2: the program's own
snapshot failed the reader-side check it runs on itself before uploading.

## What the bucket holds now

The bucket was emptied, then the final program ran once per set with exactly the command line
above (as `python s3cab-backup.py test-s3cab-ci-cleanroom-backup <set> <dirs>`; `python` was a
shell function for `python3`, this machine having no `python`). Nothing was run afterwards
except read-only verification (`verify.py`), which passed for all eight snapshots: 1292 objects, all
referenced, none unreferenced, and `ledger` reported as the expected stop.

| set | snapshot | file rows | `#error` rows | objects | exit | notes |
| --- | --- | --- | --- | --- | --- | --- |
| edge | `2026-10-23T0433` | 56 | 3 | 51 | 1 | mode-000 file (EACCES), link to a folder outside, link to a file outside |
| docs | `2026-10-23T0433` | 120 | 0 | 120 | 0 | |
| bulk | `2026-10-23T0433` | 1100 | 0 | 1100 | 0 | 38 s, one PUT per object through the proxy |
| media | `2026-10-23T0434` | 2 | 0 | 2 | 0 | 40 MiB file streamed and hashed as sent |
| hollow | `2026-10-23T0434` | 0 | 0 | 0 | 0 | empty set: `FILES 0`, `SIZE 0 (0B)` |
| spread | `2026-10-23T0434` | 13 | 0 | 13 | 0 | two `@SET DIR` rows |
| faults | `2026-10-23T0434` | 3 | 0 | 3 | 0 | |
| corrupt | `2026-10-23T0434` | 3 | 0 | 3 | 0 | |
| ledger | none | | | 0 | 1 | stopped: `q1␉2026.txt` has a tab in its name; only `snapshots/ledger.info` exists |

1292 objects in all. Every one was fetched by an independent reader and hashed to its key.

`ledger` is the spec's rule, not a failure of the run: "a file you would give a row has a tab, CR
or LF in its path" is one of the five reasons to stop without writing a snapshot, and this tool has
no exclude mechanism to get past it. The set was claimed before the walk (the spec allows a claim
any time before the first upload, and describes exactly this state: "a `.info` with no snapshots
is a set not yet backed up, or whose first backup stopped").

## How every stored object is the bytes its key names

Six layers, each checked against a real request:

1. The hash in the row is SHA-256 of the bytes read at hashing time; size and mtime come from
   `fstat` on the same open handle, immediately before the read (one check, as the spec says).
2. Just before sending, the file is `lstat`ed again and refused if its size or nanosecond mtime
   differs from the hashing-time values (tested: a rewritten file was refused, nothing sent).
3. The body handed to boto3 is a wrapper that hashes what boto3 reads, restarting on `seek(0)`
   because boto3 reads the body several times; the digest is compared with the key after the PUT,
   and on a mismatch the key is deleted (never triggered on AWS, by design of layer 4).
4. Every PUT carries `x-amz-checksum-sha256` equal to the key's digest, so S3 itself refuses a
   body that doesn't hash to the key and stores nothing (tested: a same-size, same-mtime content
   change produced `400 BadDigest` and a `404` on the key afterwards).
5. Every PUT is conditional (`If-None-Match: *`), so an existing object is never replaced; 412 is
   taken as "already stored, on the bucket's word", as the spec allows.
6. The snapshot is uploaded only after every object it names is stored; if any object fails, the
   snapshot is withheld and the run exits 1.

Before upload the program also reads its own snapshot back as a reader would: one gzip stream,
strict UTF-8, no BOM or CR, heading row, `.` last, five fields, known types, every line in
canonical form, hash/size/time grammar, paths absolute and strictly inside a `@SET DIR`, no path in
two rows, no path running through another, exactly one SPEC/NAME/VERSION, FILES and SIZE
consistent. A failure there is a bug in the program, exits 2, and uploads nothing.

## Would leave a backup that can't be restored correctly

Ranked by how badly a wrong guess hurts a restore. The writer-side rules are tight; only one
silence found here lets a writer produce a snapshot that looks complete and isn't.

1. **A directory that vanishes (or can no longer be entered) between being listed as a directory
   and being walked.** The spec settles three neighbours but not this one: an entry that vanishes
   before its type is known gets no row; a *file* that vanishes after that gets `#error` "since it
   was there to back up"; a directory that *can't be listed* stops the backup. A directory that
   was there and is gone when `scandir` runs is none of these. My first guess, "no row", uploads a
   snapshot with exit 0 that silently lacks a subtree, and no reader can tell. Final guess, by
   analogy with the vanished file: an `#error` row for the directory, path ending in a separator,
   exit 1. Tested by raising ENOENT from `scandir` for one subdirectory; the self-check accepts the
   row. The spec should say which of the three it wants, because the three writers it allows
   produce three different bucket states, one of which hides data loss.

2. **An object listed under `objects/` whose listed size differs from the row's size.** The spec
   says a listing is the bucket's word that the object is stored and that wrong bytes at a key are
   "damage, for a check of the whole repository to find". A writer therefore references it, and the
   file is unrestorable from this snapshot (a reader withholds a download that doesn't hash to its
   key). The writer has the listed size in hand for free; the spec could say whether a size
   mismatch is grounds to refuse the snapshot, or at least to warn. Not implemented as a refusal,
   since the text is explicit; this is a note that the explicit rule has a cost. Not observed with
   these fixtures.

## Would inconvenience the implementer

Each is a point where the spec was silent or ambiguous and a guess was needed. The guess is given.
None changes what a restore produces.

1. **HEAD is not "the bucket's word".** The three ways to count an object as stored are a listing,
   a 412 on a conditional PUT, and an earlier valid snapshot; a HEAD of `objects/<hash>` is absent,
   yet a HEAD is what the same paragraph prescribes for a hash a deletion record lists. A writer
   facing a large repository wants to probe per key rather than list everything. Guess: list the
   `objects/` prefix once, then conditional PUT for the rest. The listing path is explicitly allowed,
   so this is safe but slow for big buckets.
2. **The pre-send check's resolution.** "Check its size and modification time against its row":
   the row holds milliseconds, the filesystem nanoseconds. Guess: compare the raw nanosecond
   mtime kept from hashing time, which is stricter. Either reading is safe given the checksum.
3. **Is the takeover rewrite of an existing `.info` conditional?** The spec makes the *claim* a
   conditional PUT and says a takeover "rewrites OWNER and CLAIMED and keeps CREATED" without
   saying how. Guess: `If-Match` on the ETag just read, refusing if it changed. Also: a `.info`
   with no CREATED line, taken over, gets CREATED equal to the new CLAIMED (not stated).
4. **A `.info` that isn't UTF-8.** The `.info` has "a simpler rule of its own" with no word on a
   decode failure. Guess: treat as not matching and refuse to publish.
5. **Exit status when the snapshot key already holds identical bytes** ("already uploaded"). Not
   stated. Guess: 0.
6. **The year 0000.** The 24-character form allows it and the spec requires `#error` only
   *before* year 0000, but Python's `datetime` (and .NET's) start at year 1. A writer using the
   library's formatter would have to deviate (refuse year 0000) or write date arithmetic by hand.
   This program does the arithmetic (proleptic Gregorian, days-to-civil), tested against `datetime`
   over 20 000 random instants in years 1 to 9999 plus the 0000 and 9999 boundaries. A sentence
   either permitting a writer to refuse year 0000 or pointing at the algorithm would save an hour.
7. **A file that is no longer a regular file when opened** (replaced by a FIFO or directory between
   `lstat` and `open`). "No row for a pipe" and "`#error` for a file that couldn't be read" both
   apply. Guess: `#error`, the safe side.
8. **"Leave nothing stored under that key" on a store without SHA-256 verification.** On AWS the
   checksum header meets the rule. Elsewhere a plain PUT is visible before the writer can compare
   hashes. Staging under the client's own `.<name>/` folder and copying is permitted by the
   layout rule, but the spec doesn't connect the two.
9. **The heading row's canonical spelling.** The task requires canonical form, the spec's examples
   narrow the columns, and the JSON examples cover only a file row and a `@SET DIR` row. Applied
   the general rule: `size` right-aligned to 12, `time` left-aligned to 24. Both JSON examples
   reproduce byte for byte from the program's `row()` function.
10. **Where to claim.** "Claim whenever you like before the first snapshot's upload" is clear, but
    the consequence for a tool without an exclude mechanism is worth a sentence: a stopped first
    run leaves a `.info` with no snapshot folder (see `ledger` above), which a human listing the
    bucket may read as an error.
11. **`@CLIENT NAME` for another tool.** Only the alphabet is given. Used `s3cab-backup`; whether a
    name starting with `s3cab` is reserved isn't said.
12. **Order of `@SET DIR` rows and of `#error` rows that are neither link errors nor read
    failures** (type undeterminable, mtime out of range). Position isn't a rule; kept command-line
    order for DIRs, top block for everything known before a file is read.

## Hints that would have helped

Traps met in Python 3.14, boto3 1.43 and macOS that the spec's hint lists don't cover, plus two
spec hints audited here.

- **boto3 reads the body more than once.** A 3 MB `put_object` read the body in seven full passes
  (seek to end for the length, then repeated `seek(0)` + reads). "Hash the bytes as you send them"
  therefore needs a wrapper that restarts its hash on `seek(0)` and invalidates on any other seek,
  or the digest is of the wrong pass. With `ChecksumSHA256` supplied the body goes plain, as the
  spec says, and the final pass is what goes on the wire.
- **BadDigest retries depend on the retry mode.** The spec's "five attempts" warning holds for the
  default *legacy* mode even in botocore 1.43 (measured: 4 retries, 9.4 s). `Config(retries=
  {"mode": "standard", "max_attempts": 3})` sends once (measured: 0 retries) and still retries
  5xx and dropped connections.
- **botocore reports a HEAD miss as error code `'404'`**, not `NotFound` or `NoSuchKey`
  (`get_object` gives `NoSuchKey`). A reader following "a miss is a 404 whose S3 error code is
  `NoSuchKey` or `NotFound`" literally would stop the whole restore on every HEAD miss.
- **macOS on-disk case without listing the parent.** The spec's `F_GETPATH` needs the directory
  opened; a sandbox or permissions can refuse that as well as the listing (here `/Users` and
  `/Users/Shared` could be neither listed nor opened). `getattrlist` with `ATTR_CMN_NAME` through
  `ctypes` needs only search permission and returned `Users`, `Shared`, `s3cab.sandbox` for paths
  typed in the wrong case. The spec's claim that `realpath` keeps the typed case on macOS was
  confirmed (`/users/shared/S3CAB.SANDBOX/fixtures/EDGE` came back as typed except where the
  parent could be listed).
- **Take size and mtime from `fstat` on the handle you hash.** `os.scandir`'s `DirEntry.stat()`
  (and `os.walk`) hand back cached directory data; on NTFS that lags for files another process
  holds open. The spec's "one check, just before hashing" is `fstat` on the opened file.
- **`O_NOFOLLOW` and `O_NONBLOCK` on `open`** close the gap between `lstat` and `open`: a symlink
  or FIFO swapped in during that window fails or is caught by `fstat` instead of being followed or
  blocking. Neither flag exists on Windows.
- **`round()` is banker's rounding.** `round(0.25, 1)` is `0.2`; the readable size's "rounded half
  up" needs `decimal` with `ROUND_HALF_UP`, and the mtime's "tie to the later" needs integer
  arithmetic on nanoseconds: `(ns + 500_000) // 1_000_000` is right for negative times too
  (−86400.25 s gave `1969-12-30T23:59:59.750Z`; 1500000000.999599933 s gave `…02:40:01.000Z`).
- **Shell verification strips names.** `while read f` loses leading and trailing spaces, so
  ` both ends.txt ` compares against the wrong file; use `find -print0` with
  `IFS= read -r -d ''`. zsh doesn't word-split an unquoted variable, so a `set -- $args` loop
  passes one argument.
- **The spec's Python hints checked here and found right:** `str.strip()` removes U+0085 and
  `\x1c` and keeps U+FEFF; `gzip.open` writes a name and time into the header where
  `GzipFile(filename="", mtime=0)` doesn't; `ljust`/`rjust` count code points, which is exactly
  the canonical width rule.
- **The local zone name.** `/etc/localtime` is a symlink into `zoneinfo/` on macOS and most Linux,
  and its tail is the IANA name (`UTC` here). `TZ` may hold one too.

## Environment notes, not the format

- No `python` on PATH. `python3` resolves to Homebrew Python 3.14.7 with boto3/botocore 1.43.118.
  `/usr/bin/python3` (3.9.6) and `/usr/local/bin/python3` (3.14.7) have no boto3. The final runs
  used a shell function `python() { python3 "$@"; }` so the command lines read as specified.
- Credentials and region come from `credentials.env` (a session token); botocore picked them up
  from the environment, and honoured `HTTPS_PROXY` without configuration. Every request in this
  report went through the proxy to AWS.
- The `aws` CLI with no credentials in its environment probes the EC2 metadata address, which the
  sandbox denies; that is noise from a mis-sourced env file, not a bucket problem.
- The sandbox denies listing and opening `/Users` and `/Users/Shared`, which is what exercised the
  case-correction fallback above.
- The bucket has a lifecycle rule (`x-amz-expiration` names `expire-test-objects`, expiry
  2026-10-25), so what the final runs left will not outlive that date.
- This boto3 has `IfNoneMatch`, `IfMatch` and `ChecksumSHA256` as native `put_object` parameters;
  no `before-call` header injection was needed. A PUT with no `Content-Type` is stored as S3's
  default `binary/octet-stream`; SSE `AES256` is accepted and reported back; an object stored
  without an explicit checksum carried no `Content-Encoding` either (the aws-chunked encoding
  isn't stored, as the spec says).
- The machine's zone is UTC, so every snapshot name equals the UTC minute of its `START`.
- Throughput through the proxy, one object at a time: 1100 small PUTs in 38 s; a 40 MiB PUT in
  about 2 s.

## What was tested, and how

- **Unit checks** of the pure parts: the 24-character instant against `datetime` (20 000 random
  instants, no mismatch) and at the 0000/9999 bounds; nearest-millisecond and ceiling rounding;
  the two JSON canonical examples in the spec reproduced byte for byte; readable sizes `0B`,
  `999B`, `1.0kB`, `999.9kB`, `999.95 kB→1.0MB`, `4.9MB`; the trim set versus `str.strip()`.
- **Dry walks** (no bucket) of every fixture set plus a scratch tree of link cases: tab and CR in a
  link's name (spelled `␉`/`␍` in the `#error` path), a link to a FIFO, a two-link loop, a chain
  ending inside the backup, a link to the other member directory, a link through a file, a link
  whose target sits behind a mode-000 directory ("somewhere this computer can't resolve"), a
  relative target written as held, a target with a trailing space. Rows matched the spec's link
  table in every case. Stop cases: nested members, same directory via a link and `..`, missing
  member, member that is a file, the tab-named file in `ledger`, a vanished subdirectory.
- **Real runs** against the bucket of every set, then the final emptied-bucket runs. The holder
  rules on a throwaway set: claim; second run in the same minute refused; `.info` rewritten by
  "another machine" refused and the kept pair forgotten; `--take-over` rewrote OWNER/CLAIMED and
  kept a CREATED of `2026-01-01…`; `.info` deleted with snapshots present refused, and
  `--take-over` then created one with CREATED equal to CLAIMED; the pre-upload check refused on
  both a foreign `.info` and a missing one and passed again when restored.
- **Change-during-upload**: a file rewritten with a new size and mtime was refused before sending;
  a file rewritten to the same size with its mtime put back passed the pre-send check, was sent,
  and S3 refused the bytes (`BadDigest`); a HEAD on the key then returned 404.
- **Independent verification** (`verify.py` in this directory, written separately and sharing no code with the
  program): lists the bucket and checks the layout; parses each set's latest snapshot by the five
  reading rules; checks one gzip stream, heading, `.`, canonical form of every line, FILES, SIZE,
  START/FINISH order, name = START's minute, `@SET DIR` rows = the real member paths with trailing
  separators; for every file row HEADs and GETs the object, checks no `Content-Encoding` and no
  user metadata, hashes the download to the key, compares its bytes with the original file,
  compares the original's mtime rounded to the millisecond with the row, restores it under
  `<out>/<set>/<DIR name>/…` with the stored mtime and reads the mtime back; and walks the member
  directories independently to confirm every regular file has a `-` or `#error` row and nothing
  else has a `-` row. Final result: all checks passed for the eight sets with snapshots; `ledger`
  reported "no snapshot", which is the expected stop.

## What was not tested

Only macOS (APFS, case-insensitive, UTC) was available, so these paths in the program are written
from the spec and Python's documentation and unexercised: Windows (`\\?\` prefixes, junctions and
`is_junction`, drive-letter casing, UNC shares, `icu.dll` zone lookup), Linux case-folding
directories, names with no UTF-8 form (APFS refuses them; the stop path was only unit-reasoned),
mtimes outside what APFS keeps (years before 1678 or after 2262, so the year-0000 `#error` was
tested on the formatter alone), FAT/exFAT, and a store other than AWS (the `@SET ENDPOINT` row and
the no-SSE branch).

## Running log of guesses, as recorded while writing

Kept verbatim for the record; the lists above are the ranked version.

G1. Spec lists three ways to count an object as stored (listed under objects/, a 412 on a conditional PUT, or an earlier valid snapshot). A HEAD of objects/<hash> is not among them, though a HEAD is used elsewhere. Guess: use LIST + conditional PUT only.
G2. When to claim: "whenever you like before the first snapshot's upload". Chose: before walking, so a stopped run leaves `.info` with no snapshot, a state the spec says is normal.
G3. A subdirectory that vanishes between being listed and being walked: no rule. "A directory that can't be listed stops the backup" vs "an entry that vanishes ... gets no row". Guess: no row, continue; a *member* directory vanishing stops.
G4. Takeover of an existing `.info`: the spec says "rewrite OWNER and CLAIMED and keep CREATED" but not whether the rewrite is conditional. Guess: If-Match on the ETag read.
G5. The upload-time re-check "size and modification time against its row": compare raw nanosecond mtime from the hashing-time fstat (stricter than the row's millisecond text). Guess: raw.
G6. `#error` row position for errors that are not read failures (mtime out of range, not-regular-when-opened): put among file rows; link and type errors at the top. Position is not a rule.
G7. Exit status when the snapshot already exists with identical bytes: not stated. Guess 0.
G8. The spec hint for macOS case (F_GETPATH) needs the directory opened; sandbox refuses that for /Users. getattrlist(ATTR_CMN_NAME) works with search permission alone. Hint-level.
G9. `@CLIENT NAME` for a non-s3cab tool: used `s3cab-backup`. The spec only constrains the alphabet.
G10. Which `@SET` optional rows to write: BUCKET always; ENDPOINT only when AWS_ENDPOINT_URL(_S3) is set.
G11. Storage class: STANDARD (default). The spec says s3cab uses Glacier IR but only requires a class a plain GET reads.
G12. The heading row's canonical padding: applied the general rule (col 3 `size` right-aligned to 12, col 4 `time` left-aligned to 24). The spec's example narrows columns so it can't be checked against the text.
G3 (revised). A subdirectory that vanishes between being listed and being walked now gets an `#error` row with a trailing separator, by analogy with a vanished file; the earlier guess (no row) would hide a lost subtree with exit 0.
G13. boto3 reads the body several times (7 passes seen for a 3 MB PUT); the spec says "hash the bytes as you send them" without warning that an SDK re-reads the body, so a hashing wrapper must restart on seek(0).
G14. botocore's `standard` retry mode does not re-send on BadDigest (0 retries observed with botocore 1.43.118); the spec's five-attempt warning applies to the legacy mode.
G15. `.info` decoding when it isn't UTF-8: the spec gives no rule; treated as "not matching" and refused.
G16. Takeover of a `.info` lacking CREATED: not covered; CREATED set to the new CLAIMED.
G17. The year 0000 is allowed by the 24-character form but Python's datetime can't produce it; wrote the civil-date arithmetic by hand so a writer needn't refuse it.
