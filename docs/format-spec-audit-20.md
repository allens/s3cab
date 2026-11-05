# The format-spec clean-room audit, run 20: restore on macOS, Fable 5.1 at xhigh (2026-11-04)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on
[Linux](format-spec-audit-16.md), [macOS](format-spec-audit-17.md) and
[Windows](format-spec-audit-18.md); restores on [Linux](format-spec-audit-19.md), macOS (this run)
and [Windows](format-spec-audit-21.md).

- **Program:** [`swiftrestore/`](../scripts/cleanroom/restorers/swiftrestore/), Swift with
  Foundation and CryptoKit, and the system's libcurl and zlib through a bridging header; no S3
  library. The reconcile phase left it unchanged; its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 1 move flagged, a heredoc writing the session's own Swift source; the judge found it
  harmless.
- **Tokens, both phases:** input 3,048, cache write 300,875, cache read 18,978,964, output 167,500.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out. Among them, it corrected this
report's count of the bucket: 36 snapshots, 30 of them restored, not 42 and 36.

---

# Clean-room restorer for the s3cab format: report on `format.md` (spec of 2026-10-30)

Written from `format.md` and `ENVIRONMENT.md` only. No s3cab source, documentation site, package or issue
tracker was consulted. The raw, chronological guess log I kept while reading is in `GUESSES.md`; this report
is the ranked version of it, with every entry audited against something that was run.

## Summary

- `./s3cab-restore <bucket> <set> <dir> [<snapshot>]` is built from `src/` by `./build.sh` with the
  Swift 6.1.2 that ships in Xcode 16.4's command-line tools, in Swift 6 language mode. It links only
  libcurl, zlib, CryptoKit and Foundation from the macOS SDK. No AWS SDK, no S3 library, no package manager,
  nothing from Homebrew. It never runs another program.
- AWS Signature Version 4 was written from what I already knew. The `aws` CLI was run once, before any code
  existed, as the connectivity check `ENVIRONMENT.md` suggests, and was never used for signing, for
  comparison traces, or by the restorer. The one signing bug was my own typo in the `x-amz-date` format
  string, diagnosed from libcurl's verbose trace and S3's error message.
- Every one of the bucket's 42 snapshots across 24 sets was restored over the network, each into its own
  directory. 36 parsed and restored; 6 were refused whole because they have no `.` line, which is what the
  spec says must happen. An independent Python checker re-derived every destination path from the
  decompressed snapshot text and confirmed hash, size and millisecond mtime of all 3,972 restored files.
  Every discrepancy it found was a row the restorer had itself reported (collision twins, a clamped time,
  a withheld corrupt object, missing and deleted objects, refused rows).
- The format held up well. The two findings that could make two conforming readers disagree about whether a
  restore is complete are a repeated `@SNAPSHOT START` row and a deletion record with CRLF endings. The rest
  are inconveniences and hints.

## What was built

| File | Purpose |
| --- | --- |
| `src/bridge.h` | C inline wrappers for the variadic `curl_easy_setopt`/`curl_easy_getinfo`, the `inflateInit2` macro, `renamex_np(RENAME_EXCL)` and `futimens` |
| `src/S3.swift` | SigV4 signing (CryptoKit HMAC/SHA-256), libcurl transport, retry policy, ListObjectsV2 paging via Foundation's `XMLParser`, GET with miss detection |
| `src/Gzip.swift` | zlib inflate of every gzip stream in turn; zero byte after a stream ends the file; other bytes, cut streams and bad CRCs are damage |
| `src/Bytes.swift` | strict UTF-8 validation, LF-only line split, five-field split at the first four tabs, the exact JavaScript trim set, the 24-character instant check (proleptic Gregorian, year 0000 is leap) |
| `src/Paths.swift` | Windows/POSIX path kind by first characters, segment splitting, `@SET DIR` matching by whole segments with `lowercased(with: nil)` for Windows paths, destination layout (`C/`, `UNC/`, none), run-through check |
| `src/Snapshot.swift` | heading row and `.` checks, row typing, per-row refusals, duplicate and run-through refusals, deletion-record reading as one set |
| `src/Restore.swift` | raw POSIX writer: destination checked before any fetch, folders made only when a verified file lands and removed if it then fails, temp name + `renamex_np` without replacing, `futimens` then read-back, written-file identity by device and inode |
| `src/main.swift` | the command line; latest-snapshot rule; the restore loop and exit status; development modes `--list`, `--parse <file>`, `--local <file> <bucket> <dir>`, `--records <files>` |

Development modes touch nothing the documented command line does; `--parse` and `--records` make no
network requests, `--local` reads a snapshot from disk but fetches its objects from the real bucket.

## Results against the bucket

The bucket holds 24 sets, eight fixtures on three operating systems, 42 snapshots, and six deletion records
(`objects.deleted-1,3,4,6,7,9.tsv`, one `#deleted` row each). Each snapshot was restored with
`./s3cab-restore $BUCKET <set> <dir> <snapshot>`, then checked by `verify.py`, which parses the decompressed
text itself and compares every file row with the disk.

| Set (×linux, macos, windows) | Snapshots | File rows | What happened | Exit |
| --- | --- | --- | --- | --- |
| bulk | 1 | 1100 | all restored and verified | 0 |
| docs | 1 | 120 | all restored and verified | 0 |
| media | 1 | 2 (40 MiB and 512 KiB) | all restored and verified | 0 |
| spread | 1 | 6 under two `@SET DIR`s | all restored and verified | 0 |
| hollow | 1 | 0 | nothing written, no output directory made | 0 |
| corrupt | 1 | 3 | 2 restored; `b-corrupt.txt`'s object hashes to `b8a2…fd48`, not its key: withheld | 1 |
| edge-linux | 2 | 59 | 57 restored; `café.txt` (NFC and NFD) and `case/Case.txt`+`case.txt` are one file each on APFS: first row restores, second reported as a collision; `mtime-2300.txt` clamped by APFS to 2262, reported as not held | 1 |
| edge-macos | 2 | 54 | all restored and verified (no twins possible on the source disk) | 0 |
| edge-windows | 2 | 29 | 27 restored, same two collisions; `notes.`, `CON`, `aux.txt`, hidden and system files restored | 1 |
| faults, snapshots 1 and 3 | 2 | – | refused whole: no `.` line (one cut after the file rows, one ending in a stray `@S3CAB VERSION` row) | 1 |
| faults, snapshot 2 | 1 | 8 | refused: a row beside the DIR (`faultsX/`), the same path twice (both refused), a `..` segment, and `FAULTS/case.txt` on linux and macos (POSIX paths match exactly) but restored on windows (case-insensitive DIR match); `deleted.txt` deliberately deleted (record later than START, exit unaffected); `torn.txt` missing with no record: damage; `recoverable.txt` restored | 1 |
| faults, snapshot 4 | 1 | 3 | `deleted.txt` deliberate, `torn.txt` damage, `recoverable.txt` restored | 1 |

Other things the edge sets exercised, all restored byte for byte with the right mtime: names with leading
and trailing spaces, `\`, `"`, `*`, `:`, `<`, `>`, `?`, `|`, form feed, vertical tab, U+0085, CJK, emoji,
a deep path of repeated 24-character segments, an empty file (`e3b0…b855`), 1 MiB, mtimes in 1969 (negative time), 1970, 2038,
and a `.sss` that rounds up.

Crafted files on disk (44 snapshot cases, 4 deletion-record cases, plus scenario snapshots run with
`--local` against real objects) covered the refusal rules the bucket does not: CRLF, BOM, multi-stream gzip,
zero byte and garbage after a stream, cut stream, bad CRC, blank line, unknown types, `.` in the middle,
`.` with a tab, non-UTF-8, duplicate and run-through paths, `.`/`..`/empty segments, a tab or NUL in a path,
malformed hash/size/time, Windows case-insensitive DIRs, share paths, a DIR with a doubled separator, a
relative DIR, pre-existing files (skipped, exit 0), a folder or link or file in the way, a START before,
equal to, after, and absent for a recorded deletion, and a rerun into the same directory (120 skipped, exit 0).

## Would corrupt a restore

Ranked by how badly two conforming readers could diverge. "Corrupt" here means a restore that ends with a
different exit status or different contents while both readers follow the text.

1. **A repeated `@SNAPSHOT START` row: the spec never says which one counts.** The "exactly one" list names
   `@S3CAB SPEC`, `@CLIENT NAME` and `@CLIENT VERSION` only, the `.info` section says "the last one counts"
   for its keys, and START is the single `@` value a restore acts on: it decides whether a missing object is
   "deliberately deleted, exit 0" or "damage, exit 1". A reader taking the first row and one taking the last
   can end a restore with different exit codes and one of them has let a partial restore pass. My guess: the
   first row whose column 4 is a valid instant wins; later ones are ignored. Audited with a crafted
   two-START snapshot (`--parse` reports the first). Suggested rule: either "the first counts" or "more than
   one START is no START", which is the safe side.
2. **A deletion record with CRLF line endings: refused whole, or distrusted with its rows counting?** The five
   reading rules say a CRLF file "is refused whole". The record section says a record is the exception, "it
   is distrusted instead, and its well-formed rows still count", and that a `#deleted` row's last field
   "isn't checked". Under the second reading every `#deleted` row of a CRLF record is well-formed (the CR
   sits in the unchecked last field, or in column 4 where the trim set removes it) and explains an absence;
   under the first the same absence is damage. Exit 0 versus exit 1 for the same missing object. My guess:
   the record section is the more specific text, so the rows count. Audited with a crafted CRLF record
   (`--records`: both rows counted, no malformed lines). Not present in the bucket.

Nothing else I met could change bytes, destinations or times silently. Every other divergence below is
reported by both readers.

## Would inconvenience the implementer

1. **Parents of `<output>` are never mentioned.** The spec says `<output>` itself is made when the first
   file lands and never when nothing is written, and says nothing about `<output>`'s own missing parents. A
   writer that makes only `<output>` reports every row as a failed write, which is what mine did on the
   first batch run (1100 "could not create folder" lines). Guess: make the missing parents at the same
   moment, as a tool decision.
2. **`@SET DIR` ending in a doubled separator (`C:\foo\\`).** "Ignore the separators it ends with" and "a
   `DIR` with a doubled separator anywhere after its root matches nothing" give different answers; one
   reader restores every row under it, the other refuses them all (reported). Guess: strip all trailing
   separators first, then look for an empty segment. Audited with crafted case 28 (restored).
3. **Hash verification before any folder is made.** Three rules together, "fetch, then check that what you
   downloaded hashes to that key", "folders are made only as files land" and "a file that fails, missing or
   withheld or refused, leaves none of the folders made for it", force the implementer to either hold the
   whole object in memory, write it somewhere else first and then move it (which cannot cross filesystems),
   or make the folders and remove them again on failure. The Linux `O_TMPFILE` hint covers only Linux. I
   hold the object in memory (a 40 MiB object was fine) and remove folders on a failed write. A sentence
   saying which s3cab does, and that buffering is acceptable, would save a design round.
4. **The BOM is "may forgive".** Two valid readers then differ on a file with a BOM: one refuses it whole,
   one restores it. Both report. I forgive it, for snapshots and records alike (crafted cases 05 and
   `bom-noheading-nodot`).
5. **`\\?\C:\…` paths.** The text says they are Windows paths by the two-separator rule, whose root is "the
   two separators for a share", so a reader lands `\\?\C:\a.txt` at `<output>/UNC/?/C:/a.txt`, deterministic
   but surely not intended. Since s3cab strips the prefix when writing, say that a reader may strip
   `\\?\` and `\\?\UNC\` too, or that such a row is a hand edit and lands where the rule puts it. Not
   exercised; I apply the rule literally.
6. **Destinations can clash across path kinds.** `/C/a.txt` (POSIX) and `C:\a.txt` both land at
   `<output>/C/a.txt`; `/UNC/nas/x` and `\\nas\x` likewise. Only a hand-edited snapshot mixes kinds, and the
   collision rule reports the second row, but the layout section presents the mapping as collision-free.
7. **`<output>` itself as a symbolic link.** The in-the-way rule covers a link "where one of its folders
   inside `<output>` should be". Whether `<output>` may be a link is unsaid. Guess: it may, the user named
   it; links below it are in the way (tested: a link where a folder should be is reported, nothing fetched).
8. **"Blank line" is undefined.** An empty line refuses the file by the blank-line rule; a line of spaces
   refuses it by the unknown-type rule (its type trims to nothing, which starts with neither `@` nor `#`).
   Same outcome by two routes; one word ("empty") would settle it. Crafted case 13 covers the empty line.
9. **"Later than START" and equality.** I read it as strictly later, so a `#deleted` instant equal to START
   is damage. The millisecond coincidence is unlikely but the word "strictly" would remove the question.
   Audited against the bucket with `--local` (probe-equal: damage; probe-before: deliberate).
10. **Listing the deletion records.** "Read every `objects.deleted-<n>.tsv` key" leaves the implementer to
    work out that a root listing with delimiter `/` returns them beside the folder prefixes, and that
    `objects.deleted-01.tsv` must be filtered out by hand. Minor.
11. **Objects referenced by several rows.** The spec says a hash that failed its check is not fetched again;
    it is silent on whether a good one may be cached. I re-download (dedup-a and sub/dedup-b fetched twice).

## Hints that would have helped

Traps in Swift or macOS the spec could warn about, beside the hints it already has (which were accurate and
saved time: `curl_global_sslset`, the `curl_easy_setopt` wrappers, `inflateInit2(15 + 16)`, `Z_BUF_ERROR`,
`renamex_np`, `futimens`/`st_mtimespec`, CRLF as one `Character`, `lowercased(with: nil)` for Final_Sigma,
which I confirmed gives `οδος` and `οδοσ.txt` exactly as described).

- **APFS has a floor as well as a ceiling.** "APFS keeps a time before 1970 exactly" is true down to
  1677-09-21 only (signed 64-bit nanoseconds); a year-0000 row lands at 1677-09-21T00:12:43.145Z with no
  error, exactly as 2300 lands at 2262-04-11. Read-back catches both (two "time not held" lines in the
  scenario run), but a reader who believed the hint could skip the read-back for pre-1970 times.
- **The floor-division hint applies to Swift too.** It sits under "Times in C"; Swift's `/` and `%` also
  truncate toward zero, so a 1969 time split naively lands a second early. The `mtime-1969.txt` row
  (1969-12-30T23:59:59.750Z) restored correctly only because I used floor division.
- **Swift 6 language mode refuses `stdout`/`stderr`.** They are mutable globals and strict concurrency
  rejects them; write with `FileHandle.standardError` or `write(2)`.
- **`inflateInit2` is a macro**, so it needs a C wrapper in the bridging header exactly like
  `curl_easy_setopt`; the hint names the call but not that it cannot be called from Swift directly.
- **The CRLF-as-one-`Character` trap also bites outside the format.** I split HTTP response headers on `"\n"`
  and got one long line; S3's `x-amz-request-id` went missing from every error message until I split bytes.
- **Hashing and HMAC for signing come from CryptoKit** (`SHA256.hash(data:)`, `HMAC<SHA256>`), which ships
  with macOS; the spec names no Swift hashing library.
- **Foundation's `XMLParser` is enough for ListObjectsV2**, and the "Listing a folder" hint could add that
  the result pages at 1000 keys and needs `continuation-token`, since a `bulk` set already has 1100 objects.
- **`FileManager.createFile(atPath:)` can fail silently** (it returned false in this sandbox even in a
  writable directory); the raw-byte POSIX calls the spec recommends for restored files are worth using for
  everything.
- **Hold the row's path as bytes end to end.** With `[UInt8]` paths and `open(2)`, NFC and NFD `café.txt`
  reached the disk as two different byte strings and APFS merged them; the second showed up as a collision
  by device and inode, as the spec says s3cab reports it. Any detour through `String` or `URL` equality
  would have merged them in the parser instead, silently.

## Environment notes, not the format

- **Toolchain.** Xcode 16.4 command-line tools, Swift 6.1.2 (`swift-driver 1.120.5`), macOS 15.8.2. Built by
  calling the toolchain's `swiftc` directly with `-sdk`, `-swift-version 6`, `-O`, a module cache under
  `$TMPDIR`, `-import-objc-header src/bridge.h`, `-lcurl -lz`. Going through `swift`/`xcrun` prints
  "couldn't create cache file … xcrun_db (Operation not permitted)" because the sandbox blocks
  `/var/folders`; it is noise, the tools still work.
- **Libraries.** libcurl 8.7.1 with its LibreSSL 3.3.6 backend selected by `curl_global_sslset` before any
  other call (as `ENVIRONMENT.md` says), `CURLOPT_CAINFO` set to `/etc/ssl/cert.pem`; system zlib 1.2.12;
  CryptoKit; Foundation for `XMLParser`, `ProcessInfo`, `FileHandle` and `lowercased(with:)`.
- **Signing.** SigV4 from memory: canonical request with `host`, `x-amz-content-sha256` (the empty-body
  hash for every GET), `x-amz-date` and `x-amz-security-token` signed, query parameters RFC 3986-encoded and
  sorted, the key path encoded segment by segment, the HMAC chain over date, region, `s3`, `aws4_request`.
  Virtual-hosted addressing, `https://<bucket>.s3.us-east-1.amazonaws.com`. The first requests came back
  403 `AccessDenied` with the message "AWS authentication requires a valid Date or x-amz-date header"; the
  verbose trace showed `x-amz-date: 202611T042214Z`, a missing `%02d` in my format string. One edit later
  every request was accepted; no `SignatureDoesNotMatch` was ever seen. The `aws` CLI was not needed for
  signing.
- **Proxy.** `HTTPS_PROXY` is `http://<user>:<password>@localhost:49222`; libcurl reads it on its own, opens
  a CONNECT tunnel with Basic proxy authentication from the URL, then TLS 1.3 to S3 through it. `no_proxy`
  is also set and honoured. No `Accept-Encoding` is sent and `CURLOPT_HTTP_CONTENT_DECODING` is 0.
- **Retries.** Implemented as the spec describes (dropped connections for two minutes with a 0.5 s ceiling
  doubling to 2 s; 5xx three attempts, ceiling 0.1 s or 0.5 s when throttled, doubling to 20 s; 10 s connect
  timeout; 30 s without a byte). Not one retry fired during the run: no 5xx, no dropped connection.
- **Throughput.** About five requests per second through the proxy, one GET per file; a 1100-file set took
  about three and a half minutes, the whole batch of 42 snapshots (4,059 requests in the restore runs, plus the listings) about 14 minutes.
  Objects were held in memory; the 40 MiB `clip.bin` was no trouble.
- **The bucket.** Root: `.s3cab/` (ignored), `objects/`, `snapshots/`, the six records. `snapshots/` holds
  a `<set>.info` and a folder for each of the 24 sets. Every snapshot was written by `s3cab 0.2.0-alpha.2`
  with `@S3CAB SPEC 2026-10-30`, canonical widths exactly as the table in the spec gives them, zone `UTC`.
  Three of the six recorded hashes are back in `objects/` (re-uploaded by a later backup) and restore
  normally, which is the spec's "presence always wins" in practice.
- **Credentials.** Session credentials from `credentials.env`, token signed; no expiry was hit.
- **Sandbox.** File tools are confined to this directory, so dumps under `$TMPDIR` were read with shell
  tools; `/dev/fd` process substitution is blocked; local temp files and outputs went under `$TMPDIR`.

## Spec statements checked and found accurate

Not gaps, but worth recording because they were verified against real files rather than assumed: the
canonical column widths (64, 12 right-aligned, 24) and the heading row byte for byte; `#excluded` rows with
U+FFFD, one per undecodable byte on Linux and three for a lone surrogate on Windows; `#error` rows for links
out of the backup naming the target as the link holds it, directory links ending in a separator; an
empty-set snapshot with zero file rows and the `.`; `NoSuchKey` as the code on a real miss; a truncated
snapshot being complete gzip that only the `.` catches; `FAULTS` matching the DIR on Windows and not on
Linux or macOS; the first row winning a collision on APFS by both case and normalization; Final_Sigma via
`lowercased(with: nil)`; `Z_BUF_ERROR` with `avail_in` at 0 on a cut stream and "incorrect data check" on a
bad CRC.

## Running it

```
. ./credentials.env
./s3cab-restore "$BUCKET" docs-linux /path/to/output            # latest snapshot
./s3cab-restore "$BUCKET" faults-linux /path/to/output 20261030T1730
./build.sh                                                      # rebuild from src/
```

Exit status is 0 when everything restored, or when only pre-existing files were skipped and deliberately
deleted files were withheld with their dates; 1 for a refused snapshot, refused rows, damage, collisions,
something in the way, or a time the disk would not hold; 2 for usage or missing credentials.

## Differences from the reference

`reference/` holds s3cab's own restore of each of the 36 snapshots. I compared each with my restorer's
output using a script that walks both trees as bytes and compares the set of entries (files and folders),
each entry's type, file contents byte for byte, permission bits, and modification times in nanoseconds.
Two of my runs were compared: the batch behind the results table above, and a fresh run of every snapshot
with the binary exactly as the first phase left it. Both runs compared identically.

**Entries, contents and permissions: no differences in any of the 27 non-empty references.** Same files,
same 234 folders with mode 0755, same bytes, same 0644 mode. The six references for refused snapshots and the three for
`hollow` sets are empty; my restorer makes no directory at all there, which `RECONCILE.md` says is the
same thing. The collision twins (`café.txt` in NFC and NFD, `case/Case.txt` and `case/case.txt`) were
resolved the same way on both sides: the first row's bytes are on disk. The `faults` snapshots left
exactly `recoverable.txt` on both sides.

**Modification times: identical to the millisecond everywhere; not identical to the nanosecond.** Of the
3,972 files, 88 match to the nanosecond and 3,884 differ by between −118 and +119 ns, always inside the
same millisecond, spread evenly across that range. The reference is the side that is off: its times are
the row's millisecond plus or minus a few dozen nanoseconds (`…871000051`, `…907999992`), mine are the
row's millisecond exactly. Whole-second rows, the `.250` of 1969, `.000` of 1970 and 2038, and the
2300 row clamped to the APFS maximum agree to the nanosecond on both sides.

Cause: the spec's own hint under "Setting a modification time". s3cab sets times through a
floating-point count of seconds, and "a restored file can land up to about a hundred nanoseconds off its
row … s3cab's own restore does, where the filesystem keeps nanoseconds; setting the time through a
nanosecond interface is exact". Mine goes through `futimens` with a `timespec`, so it is exact. The
observed bound of 119 ns is half the spacing of IEEE doubles near 1.79 × 10⁹ seconds (2⁻²² s, 238 ns), which
is why the offsets stop exactly there and why exactly representable fractions agree.

Verdict: neither a bug in my restorer nor a gap in the spec. The spec says to compare restored times
"rounded to the nearest millisecond, not finer: below the millisecond two restores can disagree without
either being wrong", and this is that case. I did not change the restorer; it keeps the exact value. One
refinement for the hint: "about a hundred nanoseconds" is half an ulp of a double, 119 ns for today's
dates, doubling to 238 ns in 2038 when the seconds count passes 2³¹.

No other difference was found, so no fix was needed and the binary left by the first phase is unchanged.
