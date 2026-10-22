# The format-spec clean-room audit, run 7: restore on Linux, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on [Linux](format-spec-audit-4.md),
[macOS](format-spec-audit-5.md) and [Windows](format-spec-audit-6.md); restores on Linux (this
run), [macOS](format-spec-audit-8.md) and [Windows](format-spec-audit-9.md).

- **Program:** [`crestore/`](../scripts/cleanroom/restorers/crestore/), C with OpenSSL, zlib, expat
  and ICU, and no S3 library. It is the reconcile phase's program; the tools it wrote to test
  itself stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 7 moves flagged. The judge first voided 4 of them, because the audit cut each command
  off before its end, where it read the session's own exit codes.
  [PR #450](https://github.com/allens/s3cab/pull/450) keeps both ends, and judged again on the same
  moves, none voids the run.
- **Tokens, both phases:** input 206, cache write 367,714, cache read 24,331,740, output 228,818.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference,
then the *Differences from the reference* section the reconcile phase added, verbatim. The few
lines the reconcile phase changed elsewhere in the report are left out.

---

# The s3cab format, read cold: an independent restorer in C

Spec under test: `format.md`, "the spec of 2026-10-20". Bucket: `s3://test-s3cab-ci-cleanroom-restore`
(us-east-1), read-only. Everything below comes from `format.md`, `ENVIRONMENT.md`, and what the real
bucket returned to my own signed requests. I read nothing else about the format or the tool.

## Verdict

**The promise holds.** A restorer written from the spec alone, using nothing from the vendor, restores
the bucket correctly:

- `s3cab-restore` is about 2,800 lines of C (gcc 13, `-std=c2x`): about 800 read the format,
  670 run the restore, and 900 are S3 and HTTP. Its only libraries are Ubuntu
  24.04 packages: OpenSSL (TLS, SHA-256, HMAC), zlib (gzip), expat (the S3 list XML) and ICU
  (Unicode lowercasing for Windows paths). It uses no AWS SDK and no S3 library. I wrote SigV4 by
  hand, and also the HTTP/1.1 client, because libcurl's headers aren't installed (see
  *Environment notes*).
- I signed requests from memory, and the first signed request worked. The `aws` CLI was used for
  one shell command, before any code existed: two `aws s3 ls` listings (the bucket root and
  `snapshots/`) to confirm I could reach the bucket. I never used it for signing or anything
  else.
- The final build restored **all 36 snapshots in the bucket**, each by name, and each of the 24
  sets by default ("latest"). An independent Python checker confirmed every file the spec says
  should come back: right path, right bytes (SHA-256), and an mtime exact to the millisecond.
  Every failure the spec says to report was reported, with the exit status the spec gives. For
  that last part I compared each refused, deleted or damaged item by hand with the spec. Numbers
  are in *Results*.

**"In an afternoon" holds only for the format itself.** Turning snapshot rows into files is a
morning's work, and the spec answers nearly every question it raises. The time went into the dozens
of edge rules, and into finding that **four of them, read one plausible way, corrupt a restore**.
Two are about telling apart things the filesystem can't (two spellings of one path, and "already
there" versus "I just wrote that"). One is a sentence the spec states two ways. One is a character
no rule mentions (NUL) that walks a C restorer out of its output directory. All four need only a
sentence each to fix. The spec's hints cover Python, .NET, Swift and Node, and none of them cover C.

## What was built

| File | What it is |
| --- | --- |
| `s3cab-restore` | The restorer, built from `src/` by `make`. `./s3cab-restore <bucket> <set> <dir> [<snapshot>]` |
| `src/format.c` | The format: gzip, strict UTF-8, LF lines, heading and `.`, row types, trimming, path rules, `@SET DIR` matching, duplicate and running-through checks, layout refusals, deletion records |
| `src/restore.c` | Snapshot selection, the restore loop, destination handling, deletion-record lookup, mtime, the report |
| `src/s3.c`, `src/http.c` | SigV4 GET and ListObjectsV2; an HTTPS/1.1 client over OpenSSL that tunnels through `HTTPS_PROXY` |
| `tools/snapcheck.c` (`make snapcheck`) | Runs the reader on a file on disk and prints each row's fate and destination |
| `tools/parser-tests.py` | 86 synthetic files on disk, each with the verdict I read the spec to require |
| `tools/verify.py` | Independent checker: re-parses a snapshot in plain Python and checks a restored tree against it |
| `tools/run-all.sh`, `tools/dest-tests.sh` | Restore every snapshot from the bucket; destination behaviour against the bucket |
| `NOTES.md` | My running notes, guesses recorded as I made them |

How it behaves, in brief:
- **Layout.** Files land at `<dir>/<name of the matching @SET DIR>/<rest of the path>`, which is
  s3cab's own restore to a chosen directory.
- **Downloads.** Each object goes to an unnamed `O_TMPFILE` and is hashed as it arrives. Only
  after the hash matches do its folders get created and the file get linked into place
  (`linkat`, which never overwrites). A download that fails the hash is withheld, and no empty
  folder is left behind.
- **Paths.** Every path component is opened with `O_NOFOLLOW`, so a link already in the
  destination is never followed.
- **Missing objects.** Deletion records are read only when a fetch returns 404.
- **Exit status.** 0 for a full restore. Files deliberately deleted, or already at the destination
  and left alone, don't count against that. 1 otherwise; 2 for a usage error.

## Would corrupt a restore

Each item is a rule that is missing or unclear, where one plausible reading writes outside the
destination, puts bytes in the wrong place, or lets a partial restore pass as a full one. Most
dangerous first. For each: what the spec says, what I guessed, and how far I could test it.

1. **NUL in a path is never ruled out, and it walks a C restorer out of its destination.**
   - *What the spec says.* "Every other character, control characters included, is fair game in a
     path" (l.59). "Every other character — including control characters that are not those
     three — is stored as-is" (l.263). No validity rule (l.679–692) excludes U+0000. It is valid
     UTF-8, and no filesystem allows it in a name.
   - *What goes wrong.* Take a row whose segment is `..` followed by NUL and `x`. It passes every
     rule in the spec, including the `..` check, because that segment is four bytes, not two
     (verified: `tools/parser-tests.py` case `nul-dotdot-segment`, which my reader accepts as
     valid). Any C-string call (`open`, `mkdir`, `openat`) then sees `..`. The spec's own
     example of a hand-added `..` (l.708, l.852) is exactly this attack, one byte longer.
   - *My guess.* A NUL anywhere in a path is "a name the destination won't create" (l.865): it
     is reported with exit 1, before any filesystem call.
   - *Not tested end to end:* no snapshot in the bucket has a NUL.
   - *The fix* is one word: forbid NUL beside tab, CR and LF.

2. **"Paths compared exactly": exact strings, or exact segments?**
   - *What the spec says.* The duplicate check ("each path in at most one per-path row, … paths
     compared exactly", l.689) and the running-through check (l.686) both compare "exactly". But
     a Windows path splits on `/` and `\` alike (l.582).
   - *What goes wrong.* `C:\a\x.txt` and `C:/a/x.txt` are different strings that name one file,
     and both land at `<out>\a\x.txt`. A reader comparing strings lets both rows through, and
     whichever is written first or last silently wins. That is the first-wins/last-wins
     disagreement l.704 says the rule exists to prevent.
   - *My guess.* Compare root and segments, with segments exact, so both rows are refused.
   - *Tested* only on disk (cases `win-dup-across-separators`, and `win-dup-case-differs` for the
     case-sensitive half). No snapshot in the bucket mixes separators.

3. **"Already at the destination" and "two rows, one destination" look identical, and the spec
   never says how to tell them apart.**
   - *What the spec says.* A file already at a destination "is left alone and reported as
     skipped" (l.617), with no exit status given. Separately, of rows "the destination holds as
     one file … the first row restores and each later one is reported, exit 1" (l.863).
   - *What goes wrong.* Both reach the filesystem as the same `EEXIST`. A reader that doesn't
     remember what *this* run wrote reports the loser of a collision as "skipped" with exit 0.
     It has then chosen between conflicting rows, which l.735 forbids, and passed a partial
     restore as full, also forbidden. This happens wherever two valid rows map to one place:
     - drive letters in different case (`C:\a\x` and `c:\a\x` are different by exact comparison
       but match the same DIR);
     - a case-insensitive or normalising destination;
     - or two DIRs merged by a reader that takes the folder-collision rule as Windows-only
       (*Would inconvenience* item 2).
   - *My guess.* Record the (device, inode) of every file the run creates. `EEXIST` on one of
     those is a collision (exit 1); otherwise the file is skipped (exit 0).
   - *Tested:* the skip branch against the bucket (tests D2 and D3 below). The collision branch
     is not exercised: the bucket has no such rows, and ext4 here is case-sensitive.

4. **The last field is defined two ways.**
   - *What the spec says.* "taken verbatim from the final tab to the end of the line" (l.64),
     against s3cab reading "the last as the rest of the line" (l.718).
   - *What goes wrong.* The two disagree whenever a line has more than four tabs, which l.852
     says hand edits produce. Take a hand-edited row `-⇥h⇥5⇥t⇥/x/a⇥/x/b`. Under "from the
     final tab" it restores content `h` as `/x/b`: a valid path, the wrong file, exit 0. Under
     "rest of the line" its path holds a tab, so the row is refused. The same split decides
     what an `@SET DIR` row's directory is.
   - *My guess.* The rest of the line after the fourth tab. A file row with a tab in its path is
     then malformed and refused (case `tab-in-path`).

## Would inconvenience the implementer

These are rules I had to guess, where any reading I can see stays on the safe side: at worst a row
refused that s3cab would restore (or the reverse), or a different exit status. They are ranked by
how much a wrong guess changes the outcome.

1. **Which rows take part in the duplicate check.** "Check one path running through another
   last, among the rows every other check let through: a row refused for any other reason
   blocks nothing" (l.705–707) is said only of the running-through check. Does a twin whose
   hash, size or time is malformed still block its well-formed sibling? *Guessed:* yes. Every
   row whose *path* is well-formed takes part, so no reader picks the survivor (case
   `dup-malformed-twin`). The other reading restores the well-formed twin. Both exit 1.
2. **DIR folder collisions: scope, case mapping, and what "refuses a restore" means** (l.611–616).
   - The example is Windows (`C:\a\Photos\`, `D:\b\photos\`). Does the rule bind POSIX DIRs too?
     *Guessed:* yes, all DIRs (case `names-collide-posix`). The other reading lets `/a/Photos/`
     and `/b/photos/` share one folder on a case-insensitive disk.
   - "Ignoring letter case" by which mapping: ASCII, simple folding, or full lowercase? *Guessed:*
     the same Unicode default lowercase used for DIR matching.
   - Is the whole restore refused up front, and with what exit status? Does a DIR "reach" a
     restore if every row under it is refused? *Guessed:* the whole restore, before anything is
     written, exit 1; a DIR is reached only by a row that passed every check.
   - The same three questions apply to `/` beside another DIR (l.607–608).
3. **Duplicate `@SET DIR` rows.** Two identical DIR rows have names that "collide" by the letter of
   l.611, and every file under them reaches both. A literal reader therefore refuses every
   restore of such a snapshot. *Guessed:* identical rows are one DIR (case `dir-twice`). Windows
   DIRs differing only in case (`C:\Photos\`, `C:\PHOTOS\`) tie at equal depth for every file,
   so which one "matched" is undefined. *Guessed:* a name collision, restore refused (case
   `win-dir-case-twins`).
4. **An `@` row with fewer than five fields.** For `@SET⇥DIR⇥/x/`, "reads the columns it needs by
   position, and the last as the rest of the line" (l.717) could mean the value is `/x/` (the
   last field present) or that there is no value (no fifth column). *Guessed:* no value. The row
   is ignored with a warning, so its files are refused.
5. **Blank lines, and anything after the `.`.** Is an empty line "an unknown type starting with
   neither `@` nor `#`" (l.699), so the whole file is refused? Is `.⏎⏎` "rows after the `.`"?
   *Guessed:* yes to both (cases `blank-line-mid`, `blank-line-after-dot`).
6. **CRLF is forbidden but its consequence is never stated.** It falls out: the heading's last
   field becomes `…/format\r`, which isn't exact, and the last line `.\r` isn't `.`. So the
   file is refused whole (case `crlf`). One sentence would have saved working it out. The
   `.info` rule ("strip one trailing CR", l.147) points the other way.
7. **Root handling when ignoring a DIR's trailing separators** (l.579–580). Stripping `C:\` gives
   `C:`, which by l.569–570 is no longer a Windows path at all, and stripping `/` gives "". The
   root has to be found first. And what *is* the root of a UNC path? l.682 says "a share's
   `\\`", while l.605 treats `\\nas\photos\` as the root. *Guessed:* the root is `\\`; the
   folder name is the last segment, which gives `photos` either way.
8. **"Windows path" is defined only by examples** (l.569–570): "a drive letter followed by `\` or
   `/`, or a network share starting `\\` or `//`".
   - Is the drive letter ASCII only? *Guessed:* yes.
   - What about `/\server\share` (Windows treats it as UNC) or `\/server`? *Guessed:* POSIX and
     not-absolute, respectively.
   - A hand-made POSIX path starting `//` becomes a Windows path, with `\` now a separator.
9. **How deep is the time check?** "its time the 24-character form" (l.691): just the shape, or a
   real instant (February 30, hour 24, a leap second)? *Guessed:* a real instant, with no leap
   second (cases `mtime-feb30`, `mtime-leap-second`). Size "decimal": leading zeros, sign,
   overflow? *Guessed:* digits only, leading zeros allowed, must fit 64 bits.
10. **Deletion records.**
    - What is a valid `<n>` in `objects.deleted-<n>.tsv` (0? leading zeros?)? *Guessed:* one or
      more ASCII digits.
    - What does a `-` row inside a record mean? It's a type "this version knows", but
      meaningless in a record. *Guessed:* the record is invalid and distrusted
      (case `rec-file-row`).
    - Is a `#deleted` row's last field (`user@machine`) validated? *Guessed:* no.
11. **The compaction promise is wrong for list-then-fetch readers.** "a reader at any moment sees
    every live row at least once" (l.231–232) fails for a reader that lists the records and
    then fetches one that a compaction has meanwhile absorbed. The fetch 404s, and the merged
    record was written after the listing, so the reader never sees it. The damage is in the
    safe direction (a deliberate deletion reads as damage, exit 1). *Guessed:* when a listed
    record 404s, list once more.
12. **Rules hiding in a hint.** Multi-member gzip and trailing bytes are decided only in the hints
    (l.825–827: s3cab joins members and refuses non-gzip bytes after them). The rules say only
    "Decompress a snapshot as gzip" and promise "single-stream gzip". A reader that stops after
    the first member (zlib's `inflate`, or .NET by the spec's own account) accepts files s3cab
    refuses, and refuses files s3cab accepts. *Followed the hint* (cases `two-gzip-members`,
    `gzip-trailing-*`).
13. **A validity rule that contradicts the row types.** l.682 requires that *every per-path row*
    have "no trailing or doubled separator", yet `#excluded` and `#error` rows for directories
    end in one by design (l.407–411, l.311). This is harmless to a reader that skips `#` rows,
    but as written every snapshot with an excluded folder is invalid.
14. **Control pictures "spelled out, everywhere else"** (l.532). That includes `@SET DIR`, and
    "a reader may read [them] as the characters they stand for". Meanwhile a file path's `␉` "is
    only a character of the name" (l.530). A reader that un-spells DIR rows can no longer match a
    folder literally named with `␉`. *Guessed:* never un-spell anything.
15. **The file's own names, unchecked.** Nothing says what to do when `@SET NAME` or
    `@SNAPSHOT NAME` disagree with the key the file was found under (a snapshot copied by hand
    into another set's folder). *Guessed:* warn and carry on. Must a "latest" candidate's name be
    a real date, or just the digit pattern? *Guessed:* the pattern.
16. **Small silences.**
    - Is `<dir>` created at all by a restore that writes nothing (the empty `hollow` sets)?
      *Guessed:* no; it's created on the first file.
    - The access time: *left as now.*
    - Identical twin rows (same path, same hash): still "both refused"? *Guessed:* yes.
    - A `@SET DIR` without its trailing separator: valid? *Guessed:* yes.
    - Which Unicode version defines Zs (U+180E left Zs in 6.3) and the case mapping? *Used:* the
      platform's ICU 74 (Unicode 15.1).
17. **Exit status for files skipped as already present** (see *Would corrupt* item 3): never
    stated. *Guessed:* 0.

## Hints that would have helped

The spec's hints cover Python, .NET, PowerShell, Swift and Node. None covers C, though C is the
obvious language for "write a replacement" on any machine. These are the traps I hit or checked, on
C and Linux. Those marked *verified* I reproduced with a test program here.

1. **zlib's convenience API is the wrong tool** (*verified*).
   - `gzopen`/`gzread` hand back a file that isn't gzip at all, unchanged, as if it were the
     decompressed text. They also ignore trailing garbage after a gzip member, with no error.
   - Raw `inflate` (window bits `16+MAX_WBITS`) stops at the end of the first member and returns
     `Z_STREAM_END` with input left over.
   - To read the way s3cab does, loop `inflate`/`inflateReset` over members. Treat `Z_DATA_ERROR`
     on what follows as a refusal, and `Z_BUF_ERROR` with no input left as cut short.
2. **NUL and C strings** (*verified at the rule level*). A path segment `..` + NUL + `x` passes
   every rule; `open` sees `..`. Carry lengths, and refuse NUL before any filesystem call. (This
   is also gap 1 of *Would corrupt*.)
3. **`strtok` collapses empty fields.** Every `@` row has blank size and time columns, so
   `strtok(line, "\t")` shifts the value left into column 3 without a word. Use `memchr` or
   `strsep`, and split only the first four tabs.
4. **`isspace` is not the trim.** It is ASCII and byte-based. The trim set is defined by code
   point (Zs, U+2028/9, BOM), so a byte-wise trim can cut a UTF-8 sequence: 0x85 and 0xA0 are
   continuation bytes. Decode, then trim. ICU's `u_charType(c) == U_SPACE_SEPARATOR` gives Zs.
5. **C has no Unicode case mapping.** `towlower` maps one code point at a time, simply, and
   depends on the locale. "Unicode's default case mapping" (full mappings, Final_Sigma) is ICU's
   `u_strToLower(…, "")`, with the root locale (case `win-final-sigma`).
6. **`strtoull` accepts leading spaces, `+` and `-`, and wraps `-1` to 2⁶⁴−1.** Validate the
   digits yourself.
7. **Pre-1970 instants and truncating division** (*verified*). C's `/` and `%` truncate toward
   zero. Splitting the millisecond count of `1969-12-30T23:59:59.750Z` naively gives
   `tv_sec = -86400, tv_nsec = -250000000`, which `futimens` rejects with `EINVAL`. Use floor
   division (`-86401`, `750000000`).
8. **`mktime` is local time.** `timegm` only became standard C in C23. A self-contained
   days-from-civil avoids both, and covers years 0000–9999.
9. **A link already in the output directory.** "Something in the way" (l.618) names a folder or
   a file, never a link. `open`/`mkdir` follow a pre-existing link where a folder should be,
   straight out of the destination, and `O_NOFOLLOW` only guards the last component. Walk the
   path with `openat(…, O_DIRECTORY|O_NOFOLLOW)` one segment at a time. (Tested against the
   bucket: D6 and D7 below.)
10. **`rename` replaces silently on Linux.** The spec warns writers (l.940), but a restorer that
    moves a temp file into place with `rename` breaks "left alone" if a file appears mid-restore.
    `linkat` (or `renameat2(RENAME_NOREPLACE)`) fails with `EEXIST` instead.
11. **Verify before anything becomes visible.** "Folders are made only as files land" (l.609) and
    "a download that doesn't hash to its key is withheld" (l.868) together mean: download and
    hash first, then create folders. Linux's `O_TMPFILE` plus
    `linkat("/proc/self/fd/N", …, AT_SYMLINK_FOLLOW)` does this with nothing ever visible under
    a temporary name.
12. **Linux's `NAME_MAX` is 255 *bytes*.** Windows allows 255 UTF-16 units, which can be 765 UTF-8
    bytes, so a Windows snapshot's long CJK names fail with `ENAMETOOLONG` on Linux. (Not
    exercised: the bucket has no such names.)
13. **What a Linux disk keeps.** The spec gives APFS's limit (2262). ext4 with 256-byte inodes
    holds 1901–2446 to the nanosecond, so `mtime-2300.txt` and `mtime-1969.txt` restored exactly
    here (verified by the checker). From general knowledge, not tested here: ext4 with 128-byte
    inodes and XFS without `bigtime` stop in 2038.

## Environment notes, not the format

1. **No libcurl headers.**
   - Ubuntu 24.04 here has only libcurl's runtime (`libcurl.so.4`, `libcurl-gnutls.so.4`): no
     headers, no dev symlink, no pkg-config file.
   - Packages can't be installed: there's no root, and the proxy reaches only AWS.
   - Rather than hand-declare libcurl's API, I wrote a small HTTP/1.1 GET client (~490 lines)
     on OpenSSL's libssl, which is fully packaged. It does CONNECT through `HTTPS_PROXY`, with
     Basic proxy auth taken from the URL; TLS 1.2+ with peer and hostname verification against
     the system CA store; Content-Length, chunked and read-to-close bodies; keep-alive.
   - The proxy doesn't intercept TLS: the stock CA store verified S3's certificate.
2. **Toolchain.** The platform `cc` is gcc 13, whose newest C mode is `-std=c2x` (C23 as gcc 13
   has it; `-std=c23` arrives in gcc 14). Strict `-std=c2x` hides POSIX (`getaddrinfo`,
   `strtok_r`, `clock_gettime`), so the build needs `-D_GNU_SOURCE`. Other libraries: OpenSSL 3,
   zlib, expat, ICU 74, all with dev files installed.
3. **Signing: from memory, and it worked first time.**
   - SigV4 for GET: canonical request (method, URI-encoded path, sorted query, the signed
     headers `host;x-amz-content-sha256;x-amz-date;x-amz-security-token`, and the empty-body
     SHA-256); string to sign; the `AWS4`+secret HMAC chain over date, region, `s3`,
     `aws4_request`.
   - The session token is sent and signed as `x-amz-security-token`. I used virtual-hosted
     style, with the region from `AWS_REGION`.
   - The CLI was not consulted for signing. Its only use was the reachability check above.
   - Test D14 shows S3 really checks the signature: the same request with one character of the
     secret changed comes back `403 SignatureDoesNotMatch`.
4. **Listing.**
   - ListObjectsV2 with `delimiter=/` lists one level. Snapshots are found as
     `snapshots/<set>/` and records as `objects.deleted-` at the root.
   - I used `encoding-type=url` so that odd bytes in keys survive XML, and decode `+` as a space.
     That decoding is untested, because no key in the bucket needs it.
   - `.s3cab/` was listed once, while I was surveying the bucket, and never opened.
5. **`SIGPIPE`.** A peer that drops a TLS connection kills a C program on the next write unless
   `SIGPIPE` is ignored (or `MSG_NOSIGNAL` is used).
6. **Speed.** About 80–90 ms per signed GET through the proxy on one kept-alive connection, run
   sequentially. 120 files took 11 s; each 1,100-file bulk set about 90 s. No request was ever
   retried: no 5xx and no dropped connection occurred, so the retry paths are unexercised.
7. **The sandbox.** `$TMPDIR` is ext4, nanosecond timestamps, with `O_TMPFILE` and `/proc` both
   available. The credentials expire at 15:10Z, and every run below finished well before that.

## Results

### Every snapshot in the bucket

All results below come from real signed requests to the bucket, made with the final build of
`s3cab-restore`. Each restore went into its own new directory under `$TMPDIR`
(`tools/run-all.sh`): first each of the 36 snapshots by name, then each of the 24 sets with no
snapshot named.

How each row was checked:
- **Restorer reported** is what `s3cab-restore` said.
- **Independent check** is `tools/verify.py`. It re-parses the same snapshot (a local copy fetched
  with my own signed GET) in plain Python and computes where s3cab's layout puts each row. For
  each file, it checks the SHA-256 and that `st_mtime_ns` equals the stored millisecond exactly.
  It also flags any file no row explains (stray temp files) and any empty folder: **none were
  found in any restore**. "absent: lines …" lists rows with nothing at their destination.
- **Spec says** is the outcome I worked out by hand from `format.md` and each snapshot's rows,
  before comparing.

| Set | Snapshot | Exit | Restorer reported | Independent check | Spec says |
| --- | --- | --- | --- | --- | --- |
| bulk-linux | 2026-10-21T0134 | 0 | 1100 restored | 1100 verified | all 1100 restored, exit 0 |
| bulk-macos | 2026-10-21T0139 | 0 | 1100 restored | 1100 verified | all 1100 restored, exit 0 |
| bulk-windows | 2026-10-21T0137 | 0 | 1100 restored | 1100 verified | all 1100 restored, exit 0 |
| corrupt-linux | 2026-10-21T0136 | 1 | 2 restored, 1 damage | 2 verified, absent: lines 13 | 2 restored; b-corrupt.txt withheld (hash mismatch); exit 1 |
| corrupt-macos | 2026-10-21T0141 | 1 | 2 restored, 1 damage | 2 verified, absent: lines 13 | 2 restored; b-corrupt.txt withheld (hash mismatch); exit 1 |
| corrupt-windows | 2026-10-21T0138 | 1 | 2 restored, 1 damage | 2 verified, absent: lines 13 | 2 restored; b-corrupt.txt withheld (hash mismatch); exit 1 |
| docs-linux | 2026-10-21T0134 | 0 | 120 restored | 120 verified | all 120 restored, exit 0 |
| docs-macos | 2026-10-21T0139 | 0 | 120 restored | 120 verified | all 120 restored, exit 0 |
| docs-windows | 2026-10-21T0137 | 0 | 120 restored | 120 verified | all 120 restored, exit 0 |
| edge-linux | 2026-10-21T0134 | 0 | 59 restored | 59 verified | all rows restored, exit 0 |
| edge-linux | 2026-10-21T0137 | 0 | 59 restored | 59 verified | all rows restored, exit 0 |
| edge-macos | 2026-10-21T0139 | 0 | 54 restored | 54 verified | all rows restored, exit 0 |
| edge-macos | 2026-10-21T0142 | 0 | 54 restored | 54 verified | all rows restored, exit 0 |
| edge-windows | 2026-10-21T0137 | 0 | 29 restored | 29 verified | all rows restored, exit 0 |
| edge-windows | 2026-10-21T0139 | 0 | 29 restored | 29 verified | all rows restored, exit 0 |
| faults-linux | 2026-10-21T0133 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-linux | 2026-10-21T0134 | 1 | 1 restored, 1 deleted, 1 damage, 5 rows refused | 1 verified, absent: lines 12,14,16 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; beside/twice x2/escaped(/case) refused; exit 1 |
| faults-linux | 2026-10-21T0135 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-linux | 2026-10-21T0136 | 1 | 1 restored, 1 deleted, 1 damage | 1 verified, absent: lines 12,14 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; exit 1 |
| faults-macos | 2026-10-21T0138 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-macos | 2026-10-21T0139 | 1 | 1 restored, 1 deleted, 1 damage, 5 rows refused | 1 verified, absent: lines 12,14,16 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; beside/twice x2/escaped(/case) refused; exit 1 |
| faults-macos | 2026-10-21T0140 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-macos | 2026-10-21T0141 | 1 | 1 restored, 1 deleted, 1 damage | 1 verified, absent: lines 12,14 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; exit 1 |
| faults-windows | 2026-10-21T0135 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-windows | 2026-10-21T0136 | 1 | 1 restored, 1 deleted, 1 damage, 4 rows refused | 1 verified, absent: lines 12,14,16 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; beside/twice x2/escaped(/case) refused; exit 1 |
| faults-windows | 2026-10-21T0137 | 1 | refused whole: cut short: no '.' line at the end | no output dir | no '.': refused whole, nothing written, exit 1 |
| faults-windows | 2026-10-21T0138 | 1 | 1 restored, 1 deleted, 1 damage | 1 verified, absent: lines 12,14 | recoverable.txt restored; deleted.txt skipped (record); torn.txt damage; exit 1 |
| hollow-linux | 2026-10-21T0136 | 0 | 0 restored | 0 verified (no output dir) | no file rows: nothing written, exit 0 |
| hollow-macos | 2026-10-21T0141 | 0 | 0 restored | 0 verified (no output dir) | no file rows: nothing written, exit 0 |
| hollow-windows | 2026-10-21T0138 | 0 | 0 restored | 0 verified (no output dir) | no file rows: nothing written, exit 0 |
| media-linux | 2026-10-21T0136 | 0 | 2 restored | 2 verified | both restored (40 MB + 512 kB), exit 0 |
| media-macos | 2026-10-21T0141 | 0 | 2 restored | 2 verified | both restored (40 MB + 512 kB), exit 0 |
| media-windows | 2026-10-21T0138 | 0 | 2 restored | 2 verified | both restored (40 MB + 512 kB), exit 0 |
| spread-linux | 2026-10-21T0136 | 0 | 6 restored | 6 verified | 6 restored into alpha/ and beta/, exit 0 |
| spread-macos | 2026-10-21T0141 | 0 | 6 restored | 6 verified | 6 restored into alpha/ and beta/, exit 0 |
| spread-windows | 2026-10-21T0138 | 0 | 6 restored | 6 verified | 6 restored into alpha/ and beta/, exit 0 |

Restored with no snapshot named, each set picked the name that sorts last. Each outcome
matched the named restore of that snapshot exactly, row for row:

| Set | Picked | Exit | Same outcome as restoring it by name |
| --- | --- | --- | --- |
| bulk-linux | 2026-10-21T0134 | 0 | yes |
| bulk-macos | 2026-10-21T0139 | 0 | yes |
| bulk-windows | 2026-10-21T0137 | 0 | yes |
| corrupt-linux | 2026-10-21T0136 | 1 | yes |
| corrupt-macos | 2026-10-21T0141 | 1 | yes |
| corrupt-windows | 2026-10-21T0138 | 1 | yes |
| docs-linux | 2026-10-21T0134 | 0 | yes |
| docs-macos | 2026-10-21T0139 | 0 | yes |
| docs-windows | 2026-10-21T0137 | 0 | yes |
| edge-linux | 2026-10-21T0137 | 0 | yes |
| edge-macos | 2026-10-21T0142 | 0 | yes |
| edge-windows | 2026-10-21T0139 | 0 | yes |
| faults-linux | 2026-10-21T0136 | 1 | yes |
| faults-macos | 2026-10-21T0141 | 1 | yes |
| faults-windows | 2026-10-21T0138 | 1 | yes |
| hollow-linux | 2026-10-21T0136 | 0 | yes |
| hollow-macos | 2026-10-21T0141 | 0 | yes |
| hollow-windows | 2026-10-21T0138 | 0 | yes |
| media-linux | 2026-10-21T0136 | 0 | yes |
| media-macos | 2026-10-21T0141 | 0 | yes |
| media-windows | 2026-10-21T0138 | 0 | yes |
| spread-linux | 2026-10-21T0136 | 0 | yes |
| spread-macos | 2026-10-21T0141 | 0 | yes |
| spread-windows | 2026-10-21T0138 | 0 | yes |

Every row agrees with its "spec says" column. The absent lines are exactly the rows the spec says
must not produce a file:
- `faults` line 12, `deleted.txt`: the object 404s and a deletion record lists its hash, so it is
  skipped with its deletion date.
- `faults` line 14, `torn.txt`: the object 404s and no record lists it, so it is damage, exit 1.
- `faults` lines 16 and 17, `twice.txt`: the same path in two rows, so both are refused.
- `corrupt` line 13, `b-corrupt.txt`: the download hashes to `b8a23ffb…` instead of its key, so
  it is withheld.
- The rows the checker calls NOWHERE (`faultsX/beside.txt`, `../../escaped.txt`,
  `FAULTS/case.txt`) have no destination by the spec's rules, and the restorer refused them.

Two details worth knowing:
- `faults-windows` 0136 has no `FAULTS\case.txt` row. On Windows that path would match the DIR
  case-insensitively, so it isn't a fault there.
- In `edge-*`, `dedup-a.txt` and `dedup-b.txt` are listed in deletion records 1, 4 and 7, yet their
  objects are present. They were restored, as "presence always wins" requires; the records were
  never consulted, because no fetch missed.

The first, pre-final build gave identical outcomes on all 60 restores.

### Destination behaviour, against the bucket (`tools/dest-tests.sh`)

All 14 pass with the final build. Each is a real restore of `spread-linux` (6 files in `alpha/` and
`beta/`) or as noted:

| Test | Setup | Outcome |
| --- | --- | --- |
| D1 | fresh directory | 6 restored, exit 0, checker: 6 verified |
| D2 | the same again | 6 skipped, exit 0; inode and mtime of every file unchanged |
| D3 | a different `alpha/from-alpha.txt` already there | skipped, its content left alone, exit 0 |
| D4 | a folder at `alpha/build`, where a file lands | reported "a folder is where the file should land", other 5 restored, exit 1 |
| D5 | a file at `beta/src`, where a folder goes | reported, other 5 restored, exit 1 |
| D6 | `beta` is a link to a directory outside | reported, nothing written through the link, exit 1 |
| D7 | `alpha/v10.bak` is a link to a missing file outside | reported, link target not created, exit 1 |
| D8 | a set with no snapshots | exit 1 |
| D9 | a snapshot name that doesn't exist (404) | exit 1 |
| D10 | set name `../snapshots` | refused as a set name, exit 2 |
| D11 | snapshot named with its `.tsv.gz` suffix (`edge-linux`) | restored, exit 0 |
| D12 | `faults-linux`, no snapshot named | picks `2026-10-21T0136`, the name that sorts last; exit 1 for its damaged `torn.txt` |
| D13 | the output path is a file | stops, exit 1 |
| D14 | one character of the secret key changed | S3 answers `403 SignatureDoesNotMatch`; exit 1, nothing created |

### On disk, the reader alone (`tools/parser-tests.py`, 86 cases)

These are synthetic snapshots and records for rules the bucket doesn't exercise, all passing. They
cover:
- **Whole-file verdicts:** CRLF, BOM, `.` without its LF, rows or blank lines after the `.`,
  unknown types, `@set` versus `@SET`, bad UTF-8, a surrogate, an overlong encoding, a
  six-field heading, multi-member gzip, trailing garbage, a cut stream.
- **Trimming:** NBSP, U+3000, U+2028/9 and BOM trimmed; U+0085 and `\x1c` not.
- **Field formats.**
- **Every path rule:** relative, `.`, `..`, trailing and doubled separators, a path equal to a
  DIR, the `edge`/`edgeX` prefix trap, nested DIRs (longest wins).
- **Windows paths:** case-insensitive matching with Unicode lowercase and Final_Sigma, `/`
  against `\`, drive roots, shares.
- **Row conflicts:** duplicates and running-through.
- **Layout refusals:** `/` beside another DIR, colliding folder names.
- **Deletion records:** malformed rows, a missing `.`, a `-` row, a gzipped record.

Each case marked GUESS in that file is one of the gaps above.

### Not tested

- **Retries.** No 5xx and no dropped connection ever happened, so the retry paths (three
  attempts per 5xx; two minutes for dropped connections, random waits under a doubling ceiling)
  never ran.
- **Collisions within one run.** The same-run collision branch (*Would corrupt* item 3) isn't
  exercised: no snapshot has two rows reaching one destination, and ext4 here is case-sensitive.
- **The NUL guard.** It is tested only at the rule level: no snapshot in the bucket has a NUL.
- **Deletion records.** The relisting after a 404 never fired (no compaction ran), and invalid
  records were tested only on disk: all six in the bucket are valid.
- **Windows-only layouts against the bucket.** The bucket's DIRs are ordinary folders, so drive
  roots, shares, `/` as a DIR and colliding folder names were tested only on disk.
- **Minor paths.** The cross-device copy fallback (`EXDEV`), and the "time not kept" report (ext4
  kept every time exactly).
- **No fallback when the latest is refused.** Never exercised: every set's latest snapshot is whole,
  and the cut-short ones (0133, 0135 …) are never the latest.

## Reproducing

```
make                      # builds ./s3cab-restore (and `make snapcheck` the on-disk checker)
. ./credentials.env; ./s3cab-restore "$BUCKET" edge-linux /path/to/out             # latest
. ./credentials.env; ./s3cab-restore "$BUCKET" faults-linux /path/to/out 2026-10-21T0134
```

Set `S3CAB_RESTORE_VERBOSE=1` to list every restored file and count the signed requests.

## Differences from the reference

`reference/` holds s3cab's own restore of each of the 36 snapshots. I compared each one with my
final build's restore of the same snapshot, the run reported in *Results* (`tools/compare-ref.py`).
- **What was compared:** every entry by its path as raw bytes, its type (file, folder, link,
  other), and, for files, size, SHA-256, mtime in nanoseconds and mode.
- **Separately:** link counts and extended attributes.
- **Absent output:** where s3cab restored nothing the reference directory is empty, so mine,
  absent in those cases, matches (as `RECONCILE.md` says).

**Summary.** Across 3,980 files and every folder, paths, types, contents and modes are identical
in all 36 snapshots. Neither side has hard links or extended attributes. Only mtimes differ.

| # | Difference | Where | Cause | Whose |
| --- | --- | --- | --- | --- |
| 1 | File mtimes differ by 1–119 ns (3,945 of 3,980 files). Mine is exactly the stored millisecond; s3cab's lands just off it. | Every snapshot that restores files, except the 35 files whose stored fraction a float can hold exactly (`.000`, `.750`, whole seconds, e.g. `mtime-1969.txt`, `mtime-2300.txt`) | s3cab sets times through a floating-point count of seconds. Mine uses `futimens` with nanoseconds. | **Neither.** The spec predicts exactly this (l.840–843: s3cab's restore lands "up to about a hundred nanoseconds off its row"; "a nanosecond interface is exact") and says below a millisecond "two restores can disagree without either being wrong" (l.629–631). All 3,945 round to the same millisecond, the stored one. Restorer unchanged. |
| 2 | Folder mtimes differ. | Every folder | Neither tool sets them: each is when that restore created the folder. The format records no folder times. | **Neither**, and outside the format. |
| 3 | My checker would have failed every s3cab-restored file with a non-representable fraction. | `tools/verify.py` | It demanded `st_mtime_ns` equal the stored millisecond exactly. The spec says to compare times rounded to the millisecond, not finer (l.629–632). | **Mine** (the checker, not the restorer). Fixed: it now compares the rounded millisecond and counts nanosecond-exact files separately. Re-run over both trees: 3,980 verified each, 0 bad times. Mine 3,980 ns-exact, reference 35. |

One accuracy note on the spec's hint behind row 1. "About a hundred nanoseconds" is right for
today's dates: the largest offset seen was 119 ns, half the 238 ns spacing of doubles near
1.8 × 10⁹ s. But the error grows with the timestamp. Near the year 2300 the spacing is about
1.9 µs, so a float-seconds restore can land about 1 µs off. That is still far below a
millisecond, so nothing breaks, but "about a hundred nanoseconds" isn't a bound.

**What the reference confirms, and what it can't.** Agreement on every byte confirms my reading
wherever the bucket tests it:
- the layout `<dir>/<DIR name>/<rest>` for POSIX and Windows snapshots, including two DIRs (`spread`);
- names kept verbatim: spaces at either end, control characters, `\` inside POSIX names (`edge/a\b/c.txt`), Windows `notes.`;
- whole-segment DIR matching (`faultsX`) and exact case on POSIX (`FAULTS/case.txt` restored by neither);
- both rows of a duplicated path refused (`twice.txt` in neither);
- a missing object a record explains, one it doesn't, and a corrupt download, all left unwritten (`deleted.txt`, `torn.txt`, `b-corrupt.txt`);
- "presence always wins" (`dedup-a/-b` restored by both);
- snapshots cut short restoring nothing;
- an empty restore creating nothing. That was my guess 16 under *Would inconvenience*; `RECONCILE.md` says the tool "creates nothing in that case".

It can't check the guesses the bucket doesn't exercise. That covers all four *Would corrupt*
items and most of *Would inconvenience*. Their cases (NUL in a path, mixed separators, same-run
collisions, extra tabs, colliding DIR names, malformed twins…) appear in no snapshot, so the
reference is silent on them. Nor does it show exit statuses or messages, so those remain checked
only against my reading of the spec. Accordingly I changed none of my gap rankings.

**Changes made in this phase.** Only `tools/verify.py`, and this report: the checker description
under *Results* and this section. The restorer is unchanged. `./s3cab-restore` is still the build
of the final source (sha256 `9e13821b…`) that produced every result above.
