# The format-spec clean-room audit, run 31: restore on Linux, Fable 5.2 at xhigh (2026-11-25)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.2 at
`xhigh`, all reading the spec of 2026-10-30 as of
[PR #527](https://github.com/allens/s3cab/pull/527). The set so far: backups on
[Linux](format-spec-audit-28.md), [Windows](format-spec-audit-29.md) and
[macOS](format-spec-audit-30.md); restore on Linux (this run).

- **Program:** [`crestore/`](../scripts/cleanroom/restorers/crestore/), C23 with OpenSSL, zlib,
  expat and ICU over its own HTTP client; no S3 library. The reconcile phase left it unchanged; its
  notes, logs and test tools stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 7 moves flagged: one running its own restorer through a dead proxy port on
  `127.0.0.1` to test a refused connection, and six caught only by the word "s3cab" while editing
  its own report and test scripts; the judge found all seven harmless.
- **Tokens, both phases:** input 286, cache write 518,922, cache read 43,907,228, output 315,869.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# The s3cab format spec of 2026-10-30, read cold: a clean-room restorer and what it found

## The short version

- **The claim holds.** A restorer written in C from `format.md` alone restored every snapshot
  in the bucket that the spec says can be restored: right bytes, right names, right place,
  modification times to the millisecond. An independent checker agrees on all 60 restores
  (36 snapshots by name, 24 sets by "latest").
- **Nothing from the vendor was needed to read.** No SDK, no S3 library, and the `aws` CLI was
  never run, not even to look at the bucket. Request signing (SigV4 with a session token)
  was written from what I already knew and the first signed request came back 200.
- **I found no rule in the spec that the bucket contradicts.** The gaps below are edge cases
  and questions of classification, not holes in the main path. The one that matters most is
  a safety rule that lives outside every checklist (first item of the first list).
- **One departure from the brief.** You asked for a general-purpose HTTP client. This machine
  has headers for none (libcurl's shared library is installed, its headers are not), so the
  HTTP layer is about 450 lines of my own on OpenSSL's TLS. Details under *Environment
  notes*.

## What was built

`./s3cab-restore <bucket> <set> <dir> [<snapshot>]`, built by `make` from `restore.c`,
`s3.c`, `snapshot.c`, `util.c` (about 2,600 lines of C23, of which about 870 are the HTTP
client, the signing and the two S3 calls). It links OpenSSL (TLS, SHA-256, HMAC), zlib
(inflate), expat (S3's XML) and ICU (the Windows-path lowercase mapping), all from Ubuntu's
own packages.

It lays files out as the spec says s3cab's restore to a chosen directory does, never
overwrites, and prints one line per file row. Exit status: 0 a full restore (files already
there and files deliberately deleted don't count against it); 1 something was refused,
missing, withheld, in the way or not kept, and the rest restored; 2 the snapshot was refused
whole, or the restore had to stop.

## What was run, and what came back

Every line here is from the final build; the transcripts are in `tests/results/`, and
`tests/run_all.sh` reproduces all of it.

| What | Result | Transcript |
| --- | --- | --- |
| Every snapshot in the bucket restored by name (36), and every set with no snapshot named (24), each into an empty folder, each tree checked by `tests/check_restore.py` | all 60 pass | `restore_all.txt` |
| Parser, on files on disk: 156 hand-written snapshots, one per rule | 156 pass | `parser_cases.txt` |
| Deletion-record reader, on files on disk: 19 cases | 19 pass | `record_cases.txt` |
| Destination rules: 45 hand-edited snapshots on disk, objects and records fetched from the real bucket | 45 pass | `destination_cases.txt` |
| The same with device-and-inode identity switched off, so the path fallback has to find the collisions | 45 pass | `destination_cases_forget_ids.txt` |
| Paging, a second restore, bad names, another region, bad credentials, a dead proxy | 19 checks pass | `bucket_misc.txt` |
| The spec's canonical form, `FILES` and `SIZE` against the 36 real snapshots | every line of all 36 is canonical; the six cut-short ones lack only their `.` | `canonical_check.txt` |

The checker shares no code with the restorer: Python's zlib, its own row split, its own
layout rule, `hashlib`, `os.lstat`. For each restore it checks that every row the restorer
calls restored is a regular file at the spec's destination whose bytes hash to the row and
whose mtime, rounded to the millisecond, is the row's; that no other row left anything;
that the tree holds nothing else, not even an empty folder; and that the exit status is
nonzero exactly when a problem was reported.

What the bucket holds, and what the restorer made of it:

| Sets (×3: linux, macos, windows) | Snapshots | Outcome |
| --- | --- | --- |
| `bulk-*` | 1 each, 1,100 files | all restored, exit 0 |
| `docs-*` | 1 each, 120 files | all restored, exit 0 |
| `media-*` | 1 each, a 40 MiB and a 512 KiB file | both restored, exit 0 |
| `spread-*` | 1 each, two `@SET DIR`s, 6 files | all restored, exit 0 |
| `edge-*` | 2 each: 59, 54 and 29 files with awkward names and times | all restored, exit 0 |
| `hollow-*` | 1 each, no file rows | exit 0, and no folder made, not even `<dir>` |
| `corrupt-*` | 1 each, 3 files | 2 restored; 1 withheld, its object hashing to something else; exit 1 |
| `faults-*` | 4 each | two refused whole (no `.` line: the text was cut before it was compressed), exit 2, nothing written; one with hand-added rows: 1 restored, 1 deliberately deleted, 1 missing with no record, and 5 rows refused (4 on windows): a string-prefix neighbour of the `DIR`, one path twice, a `..`, another case of the `DIR`; exit 1; the latest: 1 restored, 1 deleted, 1 missing, exit 1 |

Two things the bucket tests that deserve a line each, because a plausible wrong reader
would pass everything else:

- **Presence wins.** `objects.deleted-1.tsv` lists the hash of `edge-linux`'s `dedup-a.txt`
  and `sub/dedup-b.txt`, dated between that set's two snapshots, and the object is in the
  bucket again. Both snapshots restore both files; a reader that consulted records first
  would skip them and exit 0.
- **The cut-short snapshots are complete gzip.** `gunzip` exits 0 on both; only the missing
  `.` says so.

And what its fixtures don't reach, which I tested only on disk or with hand-edited
snapshots, is listed under *What was not tested*.

## Would corrupt a restore

Ranked by how likely a careful reader is to guess the other way, times what it costs.
"Audited" says what I ran. One caution covers both ranked lists: **the bucket never goes
where these guesses are.** Its snapshots are as s3cab wrote them, and its hand-made faults
sit squarely on explicit rules. So every guess is tested for doing what I meant, and none
for agreeing with s3cab.

1. **What counts as "in the way", and that a link inside the output folder must not be
   written through, is in no checklist.** The spec says every rule is in a checklist
   (format.md:27). The Reading checklist has the skip and collision rules (1192–1209) and
   ends "Never write outside your destination" (1217). But the list of obstacles — a file at
   `<output>` itself, a folder where the file should land, a file where a folder should be,
   a link where a folder inside `<output>` should be, each reported with exit 1 — is at
   906–915, inside the passage that opens "What s3cab itself does is written down here for
   one reason only" (860) and closes "None of this binds you" (917). How not to follow such
   a link is in a hint (about 1345), and hints are "never a requirement" (34). So a reader
   built from the checklist keeps its promise only if its author happens to think of a link
   already sitting in the output folder: `mkdir -p` and an ordinary open both go through one,
   the file lands wherever it points, and the row is reported restored with exit 0.
   *Guessed:* all four are rules; the row fetches nothing and the exit is 1.
   *Audited:* the four "in the way" cases and "a link at the file's own name is a file
   already there" in `destination_cases.txt`; the link case checks the link's target stayed
   empty.

2. **A `@SET DIR` with no trailing separator.** A writer always ends one with a separator
   (675); a reader ignores the separators it ends with (841). Neither says whether a
   hand-edited `@SET DIR /home/me/Photos` is a directory. If it isn't, every row under it is
   refused; if it is, they restore. *Guessed:* it is, since after "ignore every separator it
   ends with" the two spellings are the same segments, and the page's own example of a `DIR`
   that must not claim its neighbour is written without one (`…\trees\edge`, 838). *Audited:* parser case "DIR with no
   trailing separator". No snapshot in the bucket has one.

3. **A 404 with no error code is a miss "when the SDK's XML parser accepts its body"**
   (1164). That defines a format rule by a program the reader of this page is not supposed to
   need. It decides between consulting the deletion records, where a listed hash then reads
   as deliberately deleted with exit 0, and stopping the restore. *Guessed:* an empty body,
   or any one well-formed XML document that has no `<Error><Code>`, is a miss; anything expat
   refuses stops the restore. That agrees with the two examples given (plain text, and
   nginx's page with its open `<hr>`), but I can't know it agrees elsewhere: expat refuses a
   body of only whitespace, and whether the SDK does is not something the page says.
   *Audited:* `errbody.txt` for the parsing; against the bucket only the coded case exists
   (a missing object answers `NoSuchKey`, seen in every `faults-*` restore).

4. **Minutes.** An instant must be a real one: "a day the proleptic Gregorian calendar has,
   hours `00` to `23`, seconds `00` to `59`" (508–513). Minutes are never mentioned, nor
   months in so many words. A reader that takes the list as complete accepts `12:75:00`,
   and what time the file then gets depends on its date library — the very trap the same
   paragraph warns about for 30 February. *Guessed:* minutes `00` to `59`, months `01` to
   `12`. *Audited:* parser cases "time minute 60", "time month 13", "time month 00".

5. **The fallback for a disk that numbers files anew: which written paths are twins.** "Take
   each path you wrote that differs from the twin only in letter case, Unicode normalization
   or trailing dots" (1196–1200). Which case mapping, which normalization form, dots on the
   last name or on every folder, and what of trailing spaces, which the same page says
   Windows drops too (1307)? Choose too narrowly and a collision reads as a file that was
   already there: skipped, exit 0, for a row that never restored. *Guessed:* be generous,
   since the spelling only picks what to read again: NFKC_Casefold of every segment, less
   its trailing dots and spaces. *Audited:* only by switching identity off on ext4
   (`destination_cases_forget_ids.txt`), where the fallback finds every collision the
   identity check finds. Not run on FAT, exFAT or any disk that ignores case.

6. **A row type that starts with `-` but isn't `-`** (`-x`, `--`). "A row's first character
   says what it is: … `-` a file" (571) reads one way; "take the first tab-separated field
   and trim it, and compare it" (602–610) and "an unknown type starting with neither `@` nor
   `#`" (1006) read the other. One reading restores the row, the other refuses the whole
   snapshot. *Guessed:* only exactly `-` is a file row; `-x` refuses the file, which is the
   side that can't pass a partial restore off as a full one. *Audited:* parser cases "type
   -x", "unknown type +".

7. **Which Unicode.** `@SET DIR` matching on Windows paths lowercases "by Unicode's full
   default case mapping … as JavaScript's `toLowerCase()` does" (816). The mapping grows with
   each Unicode version and none is named, so a `DIR` hand-edited into another case in a
   script cased only recently is over its rows for one reader and not for another.
   *Guessed:* whatever the platform's ICU has (78.2 here). *Audited:* only that Final_Sigma,
   U+0130 and no-normalization behave as described (parser cases "windows final sigma",
   "non-final sigma", "dotted I", "never normalized"). I did not go looking for two
   versions that disagree, so this one is an inference from how the mapping is defined, not
   something I ran.

8. **"A drive letter"** (799). Not said to be ASCII. *Guessed:* `A` to `Z`, `a` to `z`.
   Unaudited beyond the ordinary cases; `É:\x` is then not a Windows path, and not
   absolute.

## Would inconvenience the implementer

1. **There is a fourth kind of statement, and the checklists are full of it.** The page
   sorts itself into rules, recommendations and hints (23–37), but much of the Reading
   checklist is a description of s3cab: "Asked for a set's latest snapshot, s3cab takes…",
   "It ignores…", "It doesn't fall back…" (1117–1130); "s3cab takes the newest" (307);
   "s3cab fetches neither again" (1160); "s3cab checks the destination first" (1208); "s3cab
   sets its access time to the same instant" (1211); the retry timings (1179–1186). For each
   I had to decide whether another reader must match it. I took as rules: every latest-snapshot
   bullet, the newest row, destination-first, the modification time. As habits: the access
   time (matched anyway), the retry timings (matched roughly), not fetching a bad hash twice
   (matched). Nothing on the page says which is which.

2. **The destination's behaviour is written down twice, differently.** Once under *Paths*
   (858–915): layout, folders, skip, collision, things in the way, links. Once in the
   checklist (1192–1209): identity, the renumbering fallback, skip, collision. Neither is a
   superset, and the first disclaims itself (item 1 of the list above). I built from the
   union.

3. **A hash already found missing, against something in the way that was there before the
   restore.** The order is given for a skip (it wins, 1208) and for obstacles this restore
   made (the known-bad hash is reported, "not as a collision", 834, 901–903). For a folder
   that was already where the file should land, it isn't. It changes the exit status when
   the hash was deliberately deleted: 0 or 1. *Guessed:* the same order — the hash is
   reported. *Audited:* "my guess: a hash already found deleted is reported as that, before a
   folder that was already in the way" in `destination_cases.txt`.

4. **"A malformed file row" is never said in one place** (1014). I assembled it from *The
   columns* (499–517), the valid-file list (983–999) and the C hint that a fifth tab refuses
   the row (1270): hash not 64 lowercase hex, size not all ASCII digits, time not a real
   instant, each after trimming; no path. *Audited:* 40-odd parser cases.

5. **A restore asked for a set whose name is no set name** (`photos_2025`, `my--photos`).
   Such a folder "holds no set" (109), and a snapshot in it still protects objects; what a
   restore named for it does is not said. *Guessed:* refuse before any request. *Audited:*
   `bucket_misc.txt`.

6. **Something at the file's own name that is not a file, a folder or a link**: a FIFO, a
   socket, a device. *Guessed:* "a file already there" — skipped, exit 0. *Audited:* "my
   guess: a FIFO at the file's own name is a file already there".

7. **A failure to write that isn't about a name**: no permission to make a folder, a full
   disk. "A name the destination won't create is reported, exit 1, and the rest restore"
   (1405) covers names only. *Guessed:* the same — report the row, exit 1, carry on.
   *Audited:* "my guess: no permission to make a folder…"; a full disk was not exercised.

8. **An invalid deletion record is "distrusted", and nowhere does it say that for a restore
   this changes nothing.** The word appears in the reading rules (54–55, 1012, 1136) and is
   explained through what `backup`, `status` and `cleanup` do (1043–1061). I had to work out
   that a restorer does exactly one thing either way: count the well-formed rows before the
   first `.`. *Audited:* `record_cases.txt`. Every record in the bucket is valid, so this
   is tested on disk only.

9. **A snapshot's name is defined under "The last line"** (966), which is where the reading
   checklist's link for it lands (1118), and "digits in those places" (1119) doesn't say
   ASCII. *Guessed:* `0` to `9`.

10. **Words used before they mean anything.** "Withheld" first appears at 834 and is defined
    at 1406, in a hint. "Per-path row" (494, 983, 996) is never defined; I took it as a file
    row or an `#excluded` or `#error` row. "The first row in the file that lands" (833, 899):
    the file is the snapshot, not the destination, which I got on the second read.

11. **The BOM.** A reader "may forgive" one (48). But U+FEFF is in the trim set (67) and the
    heading's first field is trimmed, so a reader following the rules can't decline to: the
    "may" describes no choice. The trim also removes more than "one at the start": any number,
    before any row's type. *Audited:* "BOM at start is read past" passes in a parser with no
    line of code about BOMs.

12. **"Off by less than 2 seconds"** (1213): between the raw times or the rounded ones? The
    paragraph at 920–928 says to compare rounded, so I rounded both to the millisecond first.

13. **Finding the reader's path through 1,800 lines.** By my estimate a third of the page
    binds a restorer; the rest is writing, uploading, deleting, locks, and hints for Python, .NET,
    Swift and PowerShell, interleaved with the ones for C. Hints grouped by language, and a
    reader's page separate from a writer's, would have shortened the reading most.

Not a gap, but asked for: I never wanted anything beyond `format.md`. The page links to
`backup.md`, `exclude.md`, `maintenance.md`, `output.md`, `aws.md`, a snapshot-anatomy page
and a challenge page; I opened none, and nothing a restore needed was behind them.

## Hints that would have helped

1. **Following S3's 301.** The checklist says a tool that starts in another region "must
   too" follow one (1171), and stops there. The 301 has no `Location` header, so an HTTP
   client's own redirect-following does nothing. The region is in the `x-amz-bucket-region`
   response header; the body's `<Endpoint>` says only `s3.amazonaws.com`. And the request has
   to be signed again, because the region is part of what is signed. *Seen:* the real
   response, with `AWS_REGION=eu-west-1`; `bucket_misc.txt` has the us-west-2 run.
2. **In C, a lowercased name can be longer than the name.** The hint says U+0130 is the only
   character that lowercases to more than one (1292). In code points, yes; in UTF-8 bytes
   several others grow — U+023A is two bytes and its lowercase U+2C65 three — so a buffer
   the size of the input overflows. *Audited:* parser case "windows lowercase that grows in
   UTF-8 bytes".
3. **In C, compare paths with their lengths, not `strcmp`.** A path holding a NUL is refused,
   but "every file row takes part in the check for one path in two rows, a malformed one
   included" (1018). With `strcmp`, `/d/a␀x` equals `/d/a`, and a good row is refused as
   the twin of a bad one. *Audited:* "paths that differ only after a NUL are different paths
   to the duplicate check".
4. **`O_TMPFILE` with `O_EXCL` can never be given a name.** The hint recommends `O_TMPFILE`
   then `linkat`, and a few lines on recommends `O_CREAT | O_EXCL` for a named temp file
   (1339–1352). Carry the `O_EXCL` habit over and `linkat` fails with `ENOENT`. *Audited:*
   `linux_hints.txt`.
5. **ext4 drops the fraction in its first and last second.** The limits hint gives the clamp
   (1360); a time inside the boundary second itself, `1901-12-13T20:45:52.001Z`, reads back
   as `.000`. Harmless — under 2 seconds, so it is the disk's rounding — but it surprised
   me. *Audited:* `linux_hints.txt`, and "times before 1970" in `destination_cases.txt`.

The hints that were there and that I could test were all right: driving zlib's `inflate`
(every refusal in the gzip parser cases is the one the hint predicts: "incorrect header
check", "unknown header flags set", "header crc mismatch", "incorrect data check",
"incorrect length check"); `O_DIRECTORY | O_NOFOLLOW` failing with `ENOTDIR`; `O_TMPFILE`
and `linkat` with `AT_EMPTY_PATH`, unprivileged here on Linux 7.0; ext4 clamping year 0000
to exactly `1901-12-13T20:45:52Z` and 9999 to exactly `2446-05-10T22:38:55Z`; `strsep` or
`memchr`, not `strtok`; ICU's root locale for Final_Sigma and U+0130; ListObjectsV2 with a
delimiter, 1,000 keys a page (the 3,821 objects came in 4).

## Environment notes, not the format

**Signing.** SigV4 for `s3`, written from memory, right on the first request. I did not need
the `aws` CLI and never ran it, for signing or for anything else; the bucket was explored
with my own listing code. What it took: the canonical request (method, path, query sorted
by name with every value percent-encoded, the four signed headers, the payload hash), the
`x-amz-content-sha256` header S3 insists on, and the session token both sent and signed.
That S3 was really checking: the same code with a wrong secret gets `403
SignatureDoesNotMatch`, and with the token left out `403 InvalidAccessKeyId`
(`bucket_misc.txt`). Listing a key a page exercised real continuation tokens, which hold
`+`, `/` and `=` and have to be encoded in the query and in what is signed.

**The HTTP transport, and the departure from the brief.** Ubuntu 26.04 here has `curl` the
program and `libcurl.so.4`, but not libcurl's headers, and no other HTTP library's either
(I probed libcurl, neon, libsoup, serf, libevent, libuv, libwebsockets and a few C++ ones
through the compiler). I did not try to install any: the proxy reaches only AWS, and
writing outside this directory was off limits. Nor would I declare libcurl's ABI by hand
from memory. OpenSSL ships a small HTTP client
(`OSSL_HTTP_*`), but its header declares no way to read a response's status code or a
response header, and a restore needs both. So the transport is my own HTTP/1.1 on OpenSSL's
TLS. If you would rather it were libcurl, the change is confined to the first 450 lines of
`s3.c`, on a machine that has libcurl's headers.

What reading turned out to need from an HTTP client, which is the answer to your second
question: a `CONNECT` tunnel through the proxy with Basic credentials; TLS with SNI and the
certificate checked against the host name and the system's CA store; `GET` with custom
headers; the status code; four response headers (`Content-Length`, `Transfer-Encoding`,
`Connection`, `x-amz-bucket-region`); bodies by length and by chunks, because objects come
with a length while listings and every error come chunked; the body of a 404 kept, since
its `<Code>` is what tells a missing object from a missing bucket; and reconnecting quietly
when a kept-alive connection is closed between requests, which happens after every 100
(1,102 requests took 12 connections). No redirects, no content decoding, no HTTP/2, no
`Accept-Encoding`.

**The proxy.** `HTTPS_PROXY` carries a user and password in the URL; they go in
`Proxy-Authorization` on the `CONNECT`. TLS runs end to end inside the tunnel and verified
against the system store. With the variable unset a direct connection did not answer in the
20 seconds I gave it. Other regional S3 endpoints are reachable through the proxy, which is
how the 301 could be tested. A request takes about 70 ms, one after another: the 1,100
files of `bulk-linux` took 77 seconds.

**The toolchain.** GCC 15.2, whose default is already C23; built with `-std=c23 -Wall
-Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion`, no warnings. OpenSSL 3.5.5, zlib 1.3.1, expat
2.7.4, ICU 78.2, found through `pkg-config`. `_GNU_SOURCE` for `O_TMPFILE`, `renameat2` and
friends. No toolchain trouble.

**The sandbox.** The session's permission rules stopped most of my shell commands reading
anything outside this directory, `$TMPDIR` included, so after the first few runs all
scratch went under `./scratch`. Nothing was written outside this directory and `$TMPDIR`.

**The bucket.** 24 sets, 36 snapshots, 3,821 objects, 6 deletion records (1, 3, 4, 6, 7, 9),
no locks. Only GET and ListObjectsV2 were sent, only to this bucket. I listed the names
under `.s3cab/` and the `.info` keys while finding my way round, and fetched none of them:
only snapshots, the objects they name, and the deletion records.

**Test aids in the binary.** Four environment variables, none needed to restore:
`S3CAB_RESTORE_DEBUG`, `S3CAB_RESTORE_MAX_KEYS`, `S3CAB_RESTORE_SNAPSHOT_FILE` (read the
snapshot from disk instead of the bucket; objects and records still come from the bucket)
and `S3CAB_RESTORE_FORGET_IDS`. The third is how the destination rules were tested without
writing to the bucket; say if you would rather it were compiled out.

## What was not tested

Rules the bucket's own fixtures never reach, so that a reader could get them wrong and
still restore the whole bucket correctly. All are tested here, but only on disk or with a
hand-edited snapshot:

- **No falling back from a refused latest snapshot.** In every set the latest snapshot is a
  whole one, so a reader that fell back to "the last one that parses" would pass.
- **A deletion record dated before the snapshot's `START`** (the miss is then damage). Every
  record that explains a miss in the bucket is later than every snapshot naming the hash.
- Several gzip streams, zero padding, a bad CRC; CRLF, a BOM, a blank line, an unknown row
  type, rows after the `.`.
- Two rows landing on one file, and anything in the way.
- Hand-edited Windows spellings: a `DIR` in another case, mixed separators, shares, `\\?\`.
  The bucket's Windows snapshots are exactly as s3cab wrote them.
- An invalid deletion record. All six in the bucket are valid.

Not tested at all:

- A 404 `NoSuchBucket`: it would mean naming a bucket other than the one I was given.
- A 5xx, and a connection dropped in mid-body: neither happened. The retry code for a
  dropped connection ran only against a dead proxy port (gave up after 121 s) and for the
  kept-alive close.
- Any destination but ext4: nothing that ignores case, no FAT or exFAT, no disk without
  `O_TMPFILE` (so the named-temp-file path has never run), no Windows or macOS.
- A deletion record listed but gone by the time it is read.
- A bucket name with a dot (path-style addressing), and any endpoint other than AWS.
- Overwriting: the command line has no way to ask for it, so it isn't implemented.
- A set with more than 1,000 snapshots; paging was tested by asking for one key a page.

## Clean-room statement

I read `format.md`, `ENVIRONMENT.md` and the task. I did not look for s3cab, its source, its
documentation or its package, and did not open any link in the spec. Everything I know about
the format beyond the page comes from the bucket's own snapshots and records, which I first
looked at after the parser and the restore were written and had run.

When each guess was recorded: the minutes, the drive letter, the `DIR` with no separator,
the known-bad hash against an obstacle, the set name and the malformed row went into this
file before any code or any request. The FIFO, the 404 with no code, the twins, the 301 and
the digits were decided as the code was written, before I had read a snapshot, but went
into this file only after the first full run. The rest — the type `-x`, the Unicode
version, a failure that isn't a name, the 2 seconds, and the C traps — I met while writing
tests, after I had seen the bucket's snapshots, and wrote down then. None of them was
settled by what I saw there.

For scale, since the claim is "an afternoon": from first opening the spec to all 36
snapshots restored and checked was about half an hour of this session; the destination's
edge rules, the tests and this report took the rest of it, about as long again. I am not a
person, so read that as a floor on the reading, not as a measure of the afternoon.

## Files

- `s3cab-restore` — the restorer, built from the final source by `make`.
- `restore.c`, `s3.c`, `snapshot.c`, `util.c`, their headers, `Makefile`.
- `tools/` — development aids in C (`s3probe`, `snapcheck`, `errbody`), built into `build/`
  by `make tools`. Not part of the restorer.
- `tests/` — the test scripts, and `tests/results/` with the transcripts of the final run.
  `. ./credentials.env; tests/run_all.sh` builds from clean and runs all of it again, in
  about five minutes, leaving 335 MB of restored trees under `./scratch`. I removed that
  folder after the final run.

## Differences from the reference

This section was added after the report above and below it was finished and copied out. The
rest is as it stood, but for one bullet in the short version, one row in the table of runs,
a sentence in the clean-room statement and the list of files.

**What was compared.** Each of the 36 folders in `reference/` against the same snapshot
restored again by `./s3cab-restore` into an empty folder (`tests/reference_all.sh`,
transcript `tests/results/reference.txt`). `tests/compare_reference.py` compares the set of
paths as bytes, files and folders alike; each entry's type; each file's bytes, by hashing
both sides; and each file's modification time to the nanosecond. Permission bits and link
counts are compared for information. Folders' own times are not: the spec says s3cab sets
nothing on a folder, so they are whenever each restore ran.

| Compared | In common | Differences |
| --- | --- | --- |
| Files, by path | 3,980 | none only in the reference, none only in mine |
| Folders, by path | 234 | none either way; no empty folder in either tree |
| The 9 empty reference folders (6 snapshots refused whole, 3 with no file rows) | | mine made no folder for any of them, which RECONCILE.md says matches |
| Type of each entry | 4,214 | none |
| Bytes of each file | 3,980 | none |
| Modification time, rounded to the millisecond | 3,980 | none |
| Modification time, to the nanosecond | 3,980 | **3,914 differ, by at most 119 ns** |
| Permission bits, link counts (information) | 4,214 | none: files `644`, folders `755`, one link each, in both |

### The one difference: modification times below the millisecond

*What.* Every one of my 3,980 mtimes is a whole number of milliseconds, the row's. The
reference's is the same millisecond for 66 files and up to 119 ns away for the other 3,914:
below it for 1,955, above it for 1,959.

*Cause.* The reference's times are what a floating-point count of seconds makes of the
row's. I checked that rather than assumed it: `tests/reference_times.py` takes each row's
millisecond, carries it through an IEEE double of seconds, splits it back into seconds and
nanoseconds with the fraction cut, and gets the reference's mtime exactly, for 3,980 files
of 3,980. (With the
fraction rounded instead, only 2,163 match, so it is cut.) A double holding a number of
seconds near 1.76 × 10⁹ resolves 238 ns, and half of that is the 119 ns seen.

*Whose.* Neither a bug in my restorer nor a gap in the spec: the spec says this will happen.
"A fraction like `.674` has no exact representation in a floating-point count of seconds …
so a restored file can land up to about a hundred nanoseconds off its row. s3cab's own
restore does, where the filesystem keeps nanoseconds; setting the time through a nanosecond
interface is exact" (format.md:1319–1322). Mine goes through `futimens`. And the rule for
anyone comparing is at 920–928: to the millisecond, "not finer: below the millisecond two
restores can disagree without either being wrong", and "rounded to the nearest millisecond,
not truncated".

*That rule is carrying weight.* Rounded to the millisecond, the reference gives the row's
time for 3,980 of 3,980 files. Cut to the millisecond instead, it would read a millisecond
early for 1,955 of them: half of s3cab's own restore would fail a truncating comparison
against its own snapshot.

*What I changed.* Nothing. I did not make the restorer imitate the conversion: the spec
calls the exact value right, and the imitation would come from the reference rather than
from the page. One consequence you should know rather than discover: read literally,
RECONCILE.md's "byte-for-byte, including paths and modification times" cannot hold below
the millisecond for any restorer that sets the stored time exactly, so a check finer than
the spec's own rule will flag all 3,914 files here and would flag any correct exact
restorer. If you do want a tree identical to the nanosecond, the conversion that reproduces
all 3,980 is `t = ms / 1000.0; sec = floor(t); nsec = (long)((t - sec) * 1e9)`; say so and
it is a three-line change, which I would put behind a switch and leave off.

### Nothing else differed, and what that does and doesn't settle

It confirms my reading of the explicit rules the bucket's fixtures sit on, because s3cab's
trees show the same choices:

- of two rows for one path, neither restores (`faults-*`: no `twice.txt` in either tree);
- a string-prefix neighbour of the `DIR`, a `..`, and on a POSIX path another case of the
  `DIR`, each cost only their own row (`faultsX/beside.txt`, `escaped.txt` and
  `FAULTS/case.txt` are in neither tree, and `recoverable.txt` is in both);
- an object that doesn't hash to its key is not written (`corrupt-*`: two files, not three);
- a missing object leaves nothing, deliberately deleted or not, and no folder made for it;
- presence wins over a deletion record (`edge-linux`'s `dedup-a.txt` and `sub/dedup-b.txt`
  are in both snapshots' trees);
- a snapshot with no `.` restores nothing, and neither it nor an empty snapshot gets a
  folder;
- the layout: a drive's root as a folder named by its letter (`C/s3cab.seed/…`), a POSIX
  path as it stands, every name byte for byte, down to the trailing space, the trailing
  dot, the two spellings of `café`, and `a\b` as one folder name;
- times before 1970 and after 2038, and the permissions a new file and a new folder get.

It settles none of my guesses. The reference restores are of the same 36 snapshots, into
empty folders, and none of them goes where the ranked lists below are. Those lists stand
exactly as written, still tested only for doing what I meant.

### What the reference can't show

- **Exit statuses and messages.** `reference/` holds trees only. Mine: 21 snapshots exit 0,
  9 exit 1 (the `corrupt-*` and the restorable `faults-*`), 6 exit 2 (refused whole).
  Whether s3cab's agree is not something I could compare.
- **Skips, collisions, things in the way.** Every reference restore went into an empty
  folder.
- **Access times.** Not among what RECONCILE.md asks for, and I can no longer measure them:
  comparing two trees reads every file, which moves them. What I saw first, in one listing
  taken before anything was read (`edge-linux-20261125T0022`, its top folder): six files
  whose access time was the time of the restore, not their own — `dedup-a.txt`,
  `hard-a.txt` and four of the five `mtime-*.txt` — and every other file's equal to its
  modification time. Each of the six is a file whose content a later row repeats, and the
  last of each group that the listing shows (`hard-b.txt`, `mtime-rounds-up.txt`) was
  untouched. That fits the hint that a second row with the same
  content "can be copied from where the first landed" (1354): s3cab reads what it already
  wrote, and the read moves the access time it had just set. My restorer fetches each row's
  object again and leaves every access time at the row's instant. So "s3cab sets its access
  time to the same instant" (1211) is true of what it sets and not always of what it
  leaves, which the page half-says already ("s3cab doesn't read the access time back").

### Was anything mine to fix?

No. The restorer is the program the first phase left: the sources are untouched, and
rebuilt from clean it is the same binary, byte for byte (`tests/results/phase1.sha256`,
taken before the rebuild, matches after it).
