# The format-spec clean-room audit, run 14: restore on macOS, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on [Linux](format-spec-audit-10.md),
[macOS](format-spec-audit-11.md) and [Windows](format-spec-audit-12.md); restores on
[Linux](format-spec-audit-13.md), macOS (this run) and [Windows](format-spec-audit-15.md).

- **Program:** [`swiftrestore/`](../scripts/cleanroom/restorers/swiftrestore/), Swift with
  Foundation and CryptoKit, and the system's libcurl and zlib through a bridging header; no S3
  library. It is the reconcile phase's program; its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 4 moves flagged: one writing the session's own Swift source, and three runs of its own
  restorer against a dead local proxy (`127.0.0.1:1`) to test its retries; the judge found all four
  harmless.
- **Tokens, both phases:** input 2,474, cache write 297,232, cache read 14,124,396, output 140,951.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# Clean-room restorer for the s3cab format: report on `format.md` (spec of 2026-10-23)

## What was done

`./s3cab-restore <bucket> <set> <dir> [<snapshot>]` is a Swift 6.1 program (Xcode 16.4
command-line tools, macOS 15.7) written from `format.md` alone. It talks to S3 over HTTPS with
the libcurl that ships with macOS, signs every request itself (AWS Signature Version 4, written
from memory; the `aws` CLI was not needed to get signing right), inflates snapshots with the
system zlib, hashes with CryptoKit, and writes files with POSIX calls on raw bytes. No AWS SDK,
no S3 library, no child processes. Source is in `src/`, `./build.sh` rebuilds it, and the binary
in this directory is built from the final source.

Against the real bucket it restored **all 42 snapshots of all 24 sets**, each named explicitly,
and then **every set's latest snapshot** with no snapshot argument, 66 runs in all. An
independent Python verifier (`tools/verify.py`, a second implementation of the layout rules
working from copies of the snapshots fetched with the CLI) checked every output tree: every file
present hashes to its row, has the row's size, and carries the row's modification time to the
millisecond; every file absent is explained by the restorer's log; nothing unexpected is on disk.
It found **no discrepancy in any of the 66 runs**. The spec's seeded faults all came out as the
spec says they should:

| Case in the bucket | Result |
| --- | --- |
| 36 well-formed snapshots (bulk, docs, media, spread, hollow, edge-macos, corrupt, faults ×2) | restored, exit 0 unless damage below |
| 6 snapshots cut before the `.` (faults-* 0056/0058, 0101/0103, 0059/0101) | refused whole, no output directory made, exit 1 |
| Hand-edited rows (faults-* 0057/0100/0102): `..` segment, path under no DIR (`faultsX` prefix trap, `FAULTS` case), one path in two rows | each row refused with its reason, rest restored, exit 1 |
| Object deliberately deleted and listed in a record (faults-* `deleted.txt`) | skipped with the record's date, not damage |
| Object missing with no record (faults-* `torn.txt`) | reported as damage, exit 1 |
| Object whose bytes hash to something else (corrupt-* `b-corrupt.txt`) | withheld, reported, exit 1 |
| Object listed in a deletion record but present again (edge-* `dedup-a.txt`) | restored: presence wins |
| Case twins and NFC/NFD twins on case-insensitive APFS (edge-linux, edge-windows) | first row restored, second reported as a collision, exit 1 |
| Year-2300 mtime (edge-linux) | set, read back as 2262-04-11T23:47:16.855Z, reported, file kept, exit 1 |
| 1969 mtime, 2038, 1970-01-02, names with leading/trailing spaces, `\v`, `\f`, U+0085, `\`, `:`, `"*<>?|`, `CON`, `aux.txt`, `notes.`, emoji, CJK, 12-deep path, 0-byte file, 40 MB file | restored exactly |
| Windows snapshots restored on macOS (`C:\s3cab.seed\fixtures\edge\` → `<dir>/edge/…`) | laid out as the spec describes |
| Two member directories (spread-*: `alpha/`, `beta/`) | `<dir>/alpha/…` and `<dir>/beta/…` |
| Empty set (hollow-*) | nothing written, no output directory, exit 0 |

Totals across the 66 runs: 7,802 files restored, 9 skipped as deliberately deleted, 15 damaged,
12 collisions, 14 rows refused, 6 snapshots refused whole; 7,922 signed requests, 0 retries.

Parser rules that the bucket doesn't exercise were tested on files on disk with the same code
(`tools/parsertest-main.swift`, 38 synthetic files): CRLF, BOM, missing `.`, `.` without LF,
blank lines after `.`, rows after `.`, a second `.`, unknown types, unknown `@`/`#` rows,
`@SET dir`, the trim set (NBSP trimmed, U+0085 not), a tab or CR in a path, nested DIRs with the
nested one landing beside its parent, Windows DIR matched case-insensitively, drive-root and
share DIRs, the `/` DIR, every malformed-row rule, DIR with doubled separator, DIR twice, empty
first field, heading with an extra tab, no file rows, invalid UTF-8; and for gzip: two streams
joined, a stream split mid-text, trailing garbage, trailing NUL, cut-short stream, missing
trailer, bad CRC, not gzip, text cut before compression. All behaved as the spec says.

The guesses below were written down as they were made, in `NOTES-guesses.md`; this report ranks
them.

## Would corrupt a restore

Ordered by how likely two careful readers of the spec are to leave different bytes on disk.

1. **One path running through another, on a Windows path with mixed separators.** The check is
   "exact … no separator unified", and the spec's own example (`C:\P\a` and `C:/P/a/b.txt`)
   says the destination rules sort those out, which is what a byte-prefix check does. But for
   `C:\P\x` and `C:\P\x/y.txt` (identical bytes, then the *other* separator) the spec doesn't
   say whether `/` after the prefix makes it "running through". A reader that takes any
   separator of the path's kind refuses **both** rows; a reader that takes only the same
   separator character restores `x` and reports `y.txt` as in the way. Different trees. I
   guessed the first (tested in `40-mixed-separators.tsv`: lines 5–6 both refused, the spec's
   own example on lines 3–4 both pass to the destination). Only a hand-edited snapshot can hold
   this, since s3cab never writes mixed separators.

2. **A `#` row repeating a `-` row's path.** "Each path in at most one per-path row, whatever its
   type" is in the validity list, and "a `#` row repeating a file row's path also makes the file
   invalid, but changes nothing a restore writes, so a reader that skips `#` rows needn't check
   for it." A reader that *does* check, and applies "refuse one path" to it, refuses the `-` row
   and writes nothing for that path; a reader that skips `#` rows writes the file. The second
   sentence implies the file is still written, but it never says so outright. I guessed: the
   `-` row restores (`41-hash-row-twin.tsv`). The bucket has no such row.

3. **The year-0000 leap day, and the calendar before 1582.** "A day the calendar has" plus "the
   24-character form allows the year 0000" leaves open whether `0000-02-29` is a day the
   calendar has (it is, in the proleptic Gregorian calendar; it isn't in some libraries) and
   whether October 1582's missing days exist. One reader refuses the row, another restores the
   file. I guessed proleptic Gregorian throughout (`42-year0-leap.tsv` restores it). Not in the
   bucket.

4. **Equality with a DIR ("never any DIR itself").** The spec says a file row's path must never
   be a DIR, nested ones included, but not how to compare for that: exactly, or by the same
   segment-and-case rules as matching. For a Windows DIR `C:\p\` and a file row `C:\P`, the
   case-insensitive reading refuses the row as a DIR; the exact reading refuses it as under no
   DIR. Same outcome here, so this is a message-only difference, but a reader that compares the
   raw strings (not stripping the DIR's trailing separator) would never find equality at all and
   might let `C:\P\` through as a file row if it didn't also apply the empty-segment rule. I
   guessed the matching rules (`15-nested.tsv` line 6, `16-windows.tsv` line 9).

Everything else I had to guess at either cannot change what lands on disk or is settled by the
spec once read closely (see the next list). That the list above is short, and entirely about
hand-edited files, is the main result: a reader that follows the checklist literally reproduces
s3cab's trees.

## Would inconvenience the implementer

1. **The NUL after the last gzip stream: rule or description?** "Bytes after a stream that don't
   start another make the file damaged, with one exception: s3cab, through Node's gunzip, stops
   at a zero byte there, and ignores it and everything after it." It reads as an aside about
   s3cab, but it sits inside a rule. A strict reader refuses a file s3cab restores. I
   implemented the exception (`34-trailing-nul.tsv.gz` accepted, `33-trailing-garbage.tsv.gz`
   refused). Say plainly whether every reader must stop at a NUL.

2. **The `.` and the heading's last field: trimmed or verbatim?** "Exactly `.`" and "its five
   fields, padding aside, are exactly …" could both be read as "after trimming". The spec settles
   it only indirectly, by saying a CRLF file is refused because its `.` and its heading's last
   field end in CR. I took both verbatim (`02-crlf.tsv` refused, `23-heading-extra-tab.tsv`
   refused). One sentence saying the heading's last field and the `.` line are compared byte for
   byte would save a re-read.

3. **"Rows after the `.`"** vs "skip a blank line … after the `.` included" vs "the last line is
   `.`". Together these mean: the last non-blank line must be `.`, and anything non-blank after
   the first `.` refuses the file. That needs assembling from three places. I did so
   (`06-blank-after-dot.tsv` accepted, `07-row-after-dot.tsv` and `10-second-dot.tsv` refused).

4. **An `@SET DIR` with five fields and an empty value.** The spec says a `DIR` with fewer than
   five fields "has no value" and is no directory; a row with all five fields and an empty fifth
   is not mentioned. I treated it the same (no directory).

5. **A `DIR` that doesn't end with a separator.** Writers must end it with one; readers "ignore
   the separators it ends with". I let a `DIR` without one match (`19-dir-no-trailing-sep.tsv`).
   Say whether a reader may, must, or must not.

6. **A non-blank line whose first field is empty** (a line starting with a tab). It is a type
   that is neither `@`, `#` nor `-`, so I refuse the file (`22-empty-first-field.tsv`). Worth a
   word, since a stray tab is an easy hand-edit.

7. **Which snapshot names count as snapshots.** "Named exactly `YYYY-MM-DDTHHMM.tsv.gz`" and
   "always local wall-clock time to the minute": is `2026-13-99T9999.tsv.gz` a snapshot? I took
   the shape (digits in those positions) and not the calendar. The bucket has only real names, so
   this was not exercised.

8. **A deletion record that isn't UTF-8 as a whole.** The reading rules refuse a non-UTF-8 file
   whole; a record is "distrusted instead" with its well-formed rows still counting. I decode a
   record line by line and count the rows that decode and are well-formed. The six records in
   the bucket are all valid, so this path was not exercised.

9. **"s3cab doesn't fetch again"** for a download that doesn't hash to its key: the same row, or
   that hash for every row that names it? I re-fetch for a later row. Not exercised (each corrupt
   hash appears once).

10. **The output directory's parents.** "A restore that writes nothing makes no `<output>`
    either" implies the tool creates `<output>` when the first file lands, but nothing says
    whether it creates missing parents. My first run failed on that; the restorer now creates
    them (and removes what it made if the write fails). A tool decision, but one sentence would
    help.

11. **Where the region and endpoint come from.** `@SET BUCKET` and `@SET ENDPOINT` are optional
    and "for people", so a reader is handed a bucket name and must learn the region or endpoint
    out of band. A line saying "a reader is told the bucket, region or endpoint, and credentials;
    the snapshot doesn't carry them" would set expectations.

12. **A `#deleted` row with four fields** ("missing with the tab before it"): under the five-field
    rule the time is then a leading field and is trimmed, not verbatim. Consistent, but worth
    stating since it's the one case where the fourth field is the last one on the line.

13. **A drive-root DIR's folder name** "is its letter": as written in the row, or always
    uppercase? s3cab always writes it uppercase; I used it as written. A share DIR with no
    segments (`\\` alone) has no stated name; I made it match nothing.

14. **The trim set includes tab, LF and CR**, but leading fields are split at tabs and lines at
    LF, and a CR anywhere refuses the file, so those three can never be trimmed in practice.
    Harmless, but a reader stops to wonder why they are listed.

## Hints that would have helped

Swift on macOS, in the order they cost time.

1. **Lowercasing with Final_Sigma.** The spec says Swift's `lowercased()` skips Final_Sigma but
   not what to use instead. Foundation's `lowercased(with: nil)` (NSString through ICU, root
   locale) gives `ΟΔΟΣ` → `οδος` and `İ` → `i` + U+0307, matching JavaScript; checked in a probe.

2. **libcurl from Swift.** Swift can't call C variadic functions, so `curl_easy_setopt` needs a C
   shim. Static inline wrappers in a bridging header (`-import-objc-header`) are enough; no
   module map, no package. Set `CURLOPT_HTTP_CONTENT_DECODING` to 0 and send no
   `Accept-Encoding`, which is the libcurl form of the spec's `Content-Encoding` warning.

3. **zlib from Swift.** There is no `zlib` module; include `<zlib.h>` in the bridging header and
   wrap `inflateInit2`, which is a macro. `inflateInit2(&strm, 15 + 16)` reads the gzip framing,
   `Z_STREAM_END` with `avail_in` left tells you where the next stream starts, `Z_BUF_ERROR` with
   no input left is a cut-short file, and a bad trailer comes back as `Z_DATA_ERROR` "incorrect
   data check". That is the "drive `inflate` to see the end" the spec recommends, in Swift.

4. **A no-replace rename on macOS** is `renamex_np(from, to, RENAME_EXCL)`; the spec names only
   Linux's `renameat2` and `link`/`unlink`.

5. **Nanosecond times on macOS**: `futimens` on the open descriptor, then `lstat` and
   `st_mtimespec`. APFS kept 1969-12-30T23:59:59.750Z exactly and clamped the year 2300 to
   `Int64.max` nanoseconds (2262-04-11T23:47:16.854775807Z), as the spec's "stores 2262" says.

6. **`/tmp` and the user's folders on macOS are case-insensitive APFS**, so the spec's "ordinary
   macOS directory" collisions happen there too; the twins in the edge sets collided as described.

7. **Write names with POSIX calls on raw bytes** (`open`, `mkdir`, `lstat` on `[CChar]`), not
   Foundation's `FileManager` or `URL`, which would normalize. Names holding `\v`, `\f`, U+0085,
   `\`, `:` and a trailing space all landed as themselves.

8. **S3 ListObjectsV2 with `delimiter=/`** is exactly "only a key directly in that folder": keys
   below come back as `CommonPrefixes` and never need filtering. Foundation's `XMLParser` reads
   the response; no XML library needed.

9. **Swift 6 language mode**: top-level `var`s are main-actor isolated, so a function reading
   them needs `@MainActor`; libcurl callbacks must be `@convention(c)` closures with the context
   passed through `CURLOPT_WRITEDATA`.

10. **The empty object exists.** `objects/e3b0c442…` is stored (0 bytes); fetch it like any
    other. The spec's "upload every object" rule covers it, but a reader may wonder.

11. **`String(validating:as:)`** is strict (overlongs and surrogates rejected), so it is the UTF-8
    check the spec asks for; `String(decoding:as:)` is only safe after that check.

## Environment notes, not the format

- **Signing.** SigV4 for S3 was written from memory and accepted by S3 on the first request:
  canonical request over the URI-encoded path, sorted query, `host`, `x-amz-content-sha256`
  (hash of the empty body), `x-amz-date` and `x-amz-security-token`, scope
  `<date>/us-east-1/s3/aws4_request`, virtual-hosted URL. The `aws` CLI was used only to
  confirm the proxy reached the bucket before any code was written, and afterwards as an
  independent check (`head-object` on the fault objects, and copying the snapshots and records to
  disk for the verifier). The restorer never invokes it.
- **Transport.** libcurl 8.7.1 from the macOS SDK, with `curl_global_sslset(OPENSSL)` before
  `curl_easy_init` and `/etc/ssl/cert.pem`, as `ENVIRONMENT.md` says; it picked up the proxy from
  the environment by itself. Note that libcurl prefers the lowercase `https_proxy`, and this
  sandbox sets both spellings plus `all_proxy`, so overriding only `HTTPS_PROXY` changes nothing.
  Reusing one easy handle for the whole run (keep-alive through the proxy) took a request from
  about 0.25 s to about 0.1 s; the 1,100-file bulk sets then restore in about two minutes.
- **Retries.** No 5xx or dropped connection occurred in 7,922 requests. The dropped-connection
  path was exercised against a dead proxy: it retried with random waits under a ceiling that
  doubled from 0.5 s to 2 s until the test was stopped after 15 s (the policy runs for 2 minutes).
- **Toolchain.** Swift 6.1.2, `swiftc` directly with `-swift-version 6 -O`, module cache under
  `$TMPDIR`. The sandbox prints harmless `xcrun_db` cache warnings. Objects are fetched whole into
  memory; the 40 MB media files were fine.
- **Sandbox.** The permission layer blocked `sed -i` and commands with computed paths in `cd`,
  `tail` and `diff`; small Python scripts under `tools/` (run with `-I`) did that work instead.
  No `timeout` command on macOS.
- **The bucket.** 24 sets (`{bulk,corrupt,docs,edge,faults,hollow,media,spread}-{linux,macos,windows}`),
  42 snapshots, six deletion records numbered 1, 3, 4, 6, 7, 9 (gaps, as the spec says), a
  `.info` per set, and a `.s3cab/sets/<set>/dirs.txt` client folder, which the restorer never
  reads. s3cab's objects and snapshots are in `GLACIER_IR` with `AES256` server-side encryption
  and `application/octet-stream`; a plain GET reads them. The seeded corrupt objects are in
  `STANDARD`. All 66 runs finished by 10:27Z, well inside the credential window.

## What was not tested against the bucket

- A real 5xx or `SlowDown` (none occurred).
- Latest-snapshot selection with non-snapshot keys or sub-folders under `snapshots/<set>/`
  (the bucket has none and is read-only); tested only by the name filter.
- Multi-stream gzip, trailing bytes, cut-short gzip, CRLF, BOM, nested DIRs, `/` and share
  DIRs, Windows case-insensitive matching, the malformed-row rules other than the three seeded
  ones: on disk only, with the same code.
- A snapshot that reaches two DIRs with one name, or `/` beside another DIR (whole-restore
  refusal): the code path exists but no file exercised it.
- An invalid deletion record, and a hash the records list twice.
- A corrupt object named by two rows.

## Files

- `s3cab-restore`: the binary, built from `src/` by `./build.sh`.
- `src/`: `Http.swift` (libcurl), `SigV4.swift`, `S3.swift` (list, get, retries, XML),
  `Gzip.swift`, `Text.swift` (the five reading rules, instants), `Paths.swift` (path kinds,
  segments, DIR matching), `Snapshot.swift` (parsing and every validity check), `Deleted.swift`,
  `Writer.swift` (destination checks, atomic writes, times), `main.swift`, `shim.h`.
- `tools/`: the test driver, the verifier, the parser harness and two display helpers.
  Development aids only; the restorer uses none of them.
- `NOTES-guesses.md`: the guesses as they were recorded during the work.

## Differences from the reference

`reference/` holds the tool's own restore of each of the 42 snapshots. Every one was compared
with my restorer's output for the same snapshot, byte for byte: the set of relative paths as
bytes, every file's bytes, its size, its mode bits, and its modification time in nanoseconds,
plus every directory or link entry (`tools/compare-ref.py`, driven by `tools/compare-all.sh`).
My latest-snapshot runs were compared with the matching references the same way, and one more
run with the final binary (edge-windows 0103) was compared after the last rebuild.

**Result: no difference in paths, bytes, sizes, modes, or millisecond modification times, in
any of the 42 snapshots.** For the six snapshots the tool refused and the three empty sets, the
reference directory is empty and my restorer made none, which RECONCILE.md says is equivalent.
The 12 twin collisions, 15 damaged objects, 9 deliberate deletions and 14 refused rows all
leave the same files, with the same spelling, on both sides, and the year-2300 file holds the
same clamped time on both sides.

**The one difference found: modification times below the millisecond.** 3,939 of the 3,972
reference files carry a time a few nanoseconds off the stored instant (at most 119 ns, both
directions), where mine carry the stored instant exactly. For example, `bulk/item-0.txt`, stored
as `2026-10-23T00:58:09.242Z`:

| | nanoseconds since the epoch |
| --- | --- |
| row | 1792717089242000000 |
| mine | 1792717089242000000 |
| reference | 1792717089242000102 |

- **Cause.** The tool sets times as a floating-point count of seconds. Modelling that (the
  stored milliseconds divided by 1000 as a double, split into whole seconds and a nanosecond
  remainder the way libuv does, with the negative-fraction fix for times before 1970) reproduces
  the reference's exact nanosecond value for 3,970 of the 3,972 files. The two it does not
  reproduce are the year-2300 files, which APFS clamps to its maximum on both sides, so they are
  identical anyway. My restorer sets the time through `futimens` with an exact nanosecond value.
- **Bug or gap?** Neither. The spec predicts exactly this under *Setting a modification time*:
  "a restored file can land up to about a hundred nanoseconds off its row. s3cab's own restore
  does, where the filesystem keeps nanoseconds; setting the time through a nanosecond interface
  is exact", and under *Paths*: "compare at that resolution, not finer: below the millisecond two
  restores can disagree without either being wrong." Rounded to the millisecond, which is the
  comparison the spec commits to, every file agrees. I have left the restorer as it was, since
  the nanosecond-exact value is what the spec calls exact and what re-backing-up compares at;
  matching the reference to the nanosecond would mean reproducing a floating-point artefact the
  spec itself describes as the tool's imprecision.

**Observed but outside the comparison: access times.** The spec says s3cab sets each restored
file's access time to the stored instant. In the references only 33 files hold that (the `.bin`
files, the `.log` files and the empty file); the other 3,939 hold a time inside the
reference-restore window. On this volume, reading a file with Python, `cat` or `shasum` leaves
the access time alone, and the files touched are the text-like ones (`.txt`, `.md`, `.o`, no
extension) while binaries, logs and the empty file are not, which fits a background indexer
reading the text after the restore rather than the tool. Access time isn't part of the format
and RECONCILE.md compares paths and modification times, so this was not pursued further. My
restorer sets both times to the stored instant and both survive on disk.

**What the reconciliation changes in the lists above.** Nothing. No guess in the first phase
turned out to be a bug, and no reference tree exposed a reading of the spec that differs from
the tool's on any of the seeded cases: the prefix trap, the `..` segment, the duplicate path,
the case-mismatched directory, the deleted and missing and corrupt objects, the re-uploaded
deleted object, the case and normalization twins, the names with spaces and control characters,
the Windows snapshots on macOS, the two member directories, the cut-short files, and the empty
set all came out identical. The four "would corrupt" items remain untested by the references
because no snapshot in the bucket exercises them.
