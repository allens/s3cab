# The format-spec clean-room audit, run 19: restore on Linux, Fable 5.1 at xhigh (2026-11-04)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on
[Linux](format-spec-audit-16.md), [macOS](format-spec-audit-17.md) and
[Windows](format-spec-audit-18.md); restores on Linux (this run), [macOS](format-spec-audit-20.md)
and [Windows](format-spec-audit-21.md).

- **Program:** [`crestore/`](../scripts/cleanroom/restorers/crestore/), C with OpenSSL and zlib, and
  libcurl declared by hand since its header isn't packaged there; no S3 library. The reconcile phase
  left it unchanged; its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 2 moves flagged, each a heredoc writing the session's own source or report; the judge
  found both harmless.
- **Tokens, both phases:** input 2,254, cache write 311,443, cache read 13,417,254, output 160,567.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# s3cab format spec (2026-10-30): clean-room restorer report

A restorer was written in C from `format.md` alone, with no AWS SDK and no S3
client library, and run against every snapshot in the real bucket. This report
lists where the spec left a reader guessing. The code is `s3cab-restore.c`
(built by `make` as `./s3cab-restore <bucket> <set> <dir> [<snapshot>]`); it is
the means, the lists below are the result.

Headline: the format is restorable from the page. All 36 snapshots in the bucket
were read and acted on exactly as the spec says a restore should, and every
restored byte, name and millisecond was verified independently. Signing requests
needed nothing from the vendor. The gaps found are real but narrow; none of them
let wrong bytes land, and two could flip a verdict between "deliberately
deleted" and "damage".

Every item below names what was run to check it. Nothing here was taken from
any source other than `format.md`, `ENVIRONMENT.md` and the bucket.

## Would corrupt a restore

Gaps where a reasonable second reader would produce a different tree, a
different exit status, or let damage pass as intended. Ordered by severity.

1. **Repeated or conflicting `@SNAPSHOT START` rows: the spec never says which
   counts.** `START` decides whether a missing object is "deliberately deleted"
   (exit 0) or "damage" (exit 1). The spec covers a missing `START` and an
   invalid one ("counts as none"), and says `.info` keys are last-wins, but is
   silent for snapshot properties. A hand-edited file with two `START` rows
   gives first-wins and last-wins readers opposite verdicts and exit codes, and
   neither reports anything.
   *Guess:* the first well-formed `START` row wins; later ones are ignored.
   *Checked:* crafted file 27 (no `START`) shows the verdict depends on it: the
   same missing object is "deleted" with `START` and "DAMAGE ... (which the
   snapshot lacks)" without, exit 1. No bucket snapshot has two `START` rows.

2. **A pre-existing destination hit by two rows: "exists" twice, or "exists"
   then "collision"?** The spec defines a collision as "a destination this
   restore has already written" and a skip as "a file already at a destination
   before the restore began". Read literally, two rows spelling one file
   differently, restored over a tree that already holds it, are both skipped,
   exit 0: the two-spellings fault the spec says must be reported (exit 1)
   vanishes whenever the tree was restored once before.
   *Guess:* literal reading, both rows "exists", exit 0.
   *Checked:* crafted file 26 (`C:\...\recoverable.txt` and
   `C:/s3cab.seed\fixtures/faults/recoverable.txt`) gives "restored" then
   "COLLISION", exit 1, into an empty directory; run again onto the same
   directory it gives "exists" twice, exit 0 (case 44).

3. **A `@SET DIR` that is only a root (`/`, `C:\`): legal or "matches
   nothing"?** The spec lists what makes a `DIR` match nothing (not absolute, a
   doubled separator, a share with no server or share name, a NUL) and says a
   member directory "always end[s] in a separator", which a bare root does. It
   never says whether a root alone is a member directory. A reader that refuses
   it refuses a whole-drive backup outright; one that accepts it accepts every
   absolute path of that kind, which for a hand-edited file means any path.
   Nothing escapes `<output>` either way (segments are still checked), but the
   two readers restore different sets of files.
   *Guess:* a root-only `DIR` is legal and every path of its kind is under it.
   *Checked:* crafted files 41 (`DIR` = `C:\`) and 43 (`DIR` = `/`, row
   `/etc/passwd`) restore the row under `<output>/C/...` and
   `<output>/etc/passwd` respectively.

4. **The deletion-record lookup mixes two formulations.** "When two rows list the
   same hash, s3cab takes the newest" and "deliberately gone only when a row
   lists it with an instant later than `START`". These agree only when the
   newest row is well-formed. If the newest row for a hash is malformed
   (refused, "counts as not deleted") and an older well-formed row is later than
   `START`, one reading says damage (newest row refused) and the other says
   deleted (a well-formed row is later than `START`).
   *Guess:* malformed rows are dropped first, then the newest remaining row is
   compared with `START`.
   *Checked:* the six records in the bucket each hold one well-formed row, so
   only the simple path was exercised (faults-* snapshots, "deleted ... by",
   exit 1 only for the unexplained `torn.txt`). The conflicting case is untested
   against the bucket.

## Would inconvenience the implementer

Rules that are missing or unclear but whose misreading is reported, costs
requests, or only changes where a tool looks.

1. **Making `<output>`'s own missing parents.** "A restore that writes nothing
   makes no `<output>` either" implies one that writes something makes
   `<output>`, but says nothing about a missing parent of `<output>`. A first
   version here created only `<output>` downward and misreported every row as
   "in the way" when the parent was absent. *Guess:* `mkdir -p` semantics from
   the nearest existing ancestor. *Checked:* restoring into
   `.../latest2/x/faults-windows` with `latest2` absent now lands the file.

2. **Links at or above `<output>` itself.** The in-the-way rule names "a link
   where one of its folders inside `<output>` should be". Whether `<output>` or
   its ancestors may be links is unsaid. *Guess:* they may (the user chose that
   path), so components at or above `<output>` are followed and only those
   inside it are checked with `lstat`. *Checked:* a link inside `<output>` at a
   folder position is reported "a link where a folder should be" for every row
   under it and nothing lands through it (destination test B); with `<output>`
   given as `<link>/x`, all 6 rows land under the link's target. The first build
   applied `lstat` above `<output>` too and misreported that case as "a file
   where a folder should be", which is the kind of slip a sentence here would
   prevent.

3. **File modes and folder times are unspecified.** The spec says what a
   restore leaves for names, bytes and mtimes but not permissions or the
   folders' times. *Guess:* `0666`/`0777` less umask, folders' times left as
   created. Harmless, but "does my restore agree with s3cab's?" has no answer
   for them.

4. **Whether a missing object is fetched again for a later row with the same
   hash.** The spec says a download that doesn't hash to its key "isn't fetched
   again for any later row naming that hash", but says nothing for a 404.
   *Guess:* fetch again (presence may have returned between two rows, and the
   spec says presence always wins). Costs one request per duplicate row.

5. **Where a `\\?\`-prefixed path lands.** The spec says `\\?\C:\` is a Windows
   path "too" (two separators) and that a share lands under `UNC`. By those
   rules `\\?\C:\x\a.txt` is a share with server `?` and share `C:` and lands at
   `<output>/UNC/?/C:/x/a.txt`. Probably not what anyone wants; the spec should
   either forbid the prefix in a row or say how it is stripped. *Checked:*
   crafted file 42 lands exactly there.

6. **The Windows case-insensitive `DIR` match is defined as JavaScript's
   `toLowerCase()`, which only JavaScript and ICU implement.** The hints
   acknowledge C, .NET and Swift all differ (Final_Sigma, U+0130). Two readers
   can disagree on whether a non-ASCII Windows path is under its `DIR`; the
   loser refuses the row and exits 1, so it is reported, but the rule is one
   most tools cannot meet exactly. *Guess:* `towlower` under `C.UTF-8` plus a
   hand-written Final_Sigma and U+0130 rule. *Checked:* only ASCII `DIR`s exist
   in the bucket; crafted file 25 (`c:/S3CAB.SEED` against `C:\s3cab.seed`)
   matches.

7. **A share's server and share name are "root" for matching but "segments"
   for landing.** Matching is case-insensitive (`\\nas\photos\` and
   `//NAS/photos/` are one share), but each row lands with "the file row's
   spelling", so on a case-sensitive destination `//NAS/photos/a.txt` and
   `\\nas\photos\b.txt` go to `UNC/NAS/...` and `UNC/nas/...`. Consistent with
   "depends on its own path alone", but worth saying. *Checked:* crafted file 38
   lands `//NAS/photos/a.txt` at `<output>/UNC/NAS/photos/a.txt`.

8. **`@SET DIR` rows may come after the file rows they govern.** The spec says a
   reader goes by type, not position, but never says the `DIR`s must all be
   collected before any file row is judged. A streaming reader refuses every
   row that precedes its `DIR`. *Guess:* two passes.

9. **The reading checklist says a file whose first line isn't the heading row
   is refused whole; the validity section exempts deletion records.** Both are
   right together but the checklist, which claims to be "everything a tool has
   to get right", omits the exemption. *Checked:* records were parsed row by row
   as the validity section says; all six are well-formed anyway.

10. **Exit codes are "nonzero"/"1" without a prescribed value for a whole-file
    refusal versus a row-level fault.** A tool's choice, but a script around a
    restorer wants to know. *Chosen:* 1 for row-level faults, 2 for a refused
    snapshot or a failed request.

11. **What to print for a malformed row with no path.** A `-` row with four
    fields has no fifth field to name. Cosmetic. *Checked:* crafted file 22
    prints "REFUSED  (malformed: fewer than five fields)" with an empty path.

12. **Listing deletion records is a root listing, not a folder listing.** The
    hint covers "a folder" with delimiter `/`; records live at the bucket root
    and need the prefix `objects.deleted-` with the same delimiter so folder
    keys don't appear. Minor, but the only non-folder listing a reader makes.

## Hints that would have helped

Traps met on Linux/C that the spec could warn about, and hints that were there
and proved right.

- **Collect every `@SET DIR` before judging any file row** (see above). One
  sentence would save a streaming implementation from a rewrite.
- **The hint "check each folder between the output folder and the file with
  `lstat`" is exact, and the boundary matters:** `lstat` above the output folder
  turns a symlinked ancestor into "a file where a folder should be". Saying
  "and `stat` the output folder and its parents" would have closed that.
- **`linkat(fd, "", dirfd, name, AT_EMPTY_PATH)` on an `O_TMPFILE` needs
  `CAP_DAC_READ_SEARCH` before Linux 6.17; `linkat(AT_FDCWD, "/proc/self/fd/N",
  dirfd, name, AT_SYMLINK_FOLLOW)` works unprivileged on any kernel with
  `/proc`.** The spec mentions only the 6.17 form. The restorer tries the first
  and falls back to the second.
- **The `O_TMPFILE` directory must exist before `<output>` does and be on the
  destination's filesystem**, so open it on the nearest existing ancestor of
  `<output>`, not on `<output>`. The spec says "it needs a directory that
  already exists", which is true but understates the ordering problem: a
  restore that writes nothing must leave no `<output>`.
- **Escape control characters when printing a path.** The edge sets hold names
  with VT, FF and U+0085; printing them raw garbles a terminal and a log. The
  spec warns about *splitting* on those characters, not about showing them.
- **The S3 surface a reader needs is tiny: SigV4-signed `GET` on
  `ListObjectsV2` (prefix, `delimiter=/`, continuation token) and `GetObject`.**
  Since the page promises a replacement "in an afternoon", one paragraph naming
  that surface, that the session token header must be signed, and that the
  canonical query must be sorted and the key URI-encoded with `/` kept, would
  save most of the afternoon. Signing from memory worked on the first request
  here, but it is the largest single piece of a reader and the page says
  nothing about it.
- **ListObjectsV2 returns keys XML-escaped** (`&amp;` and friends), or
  URL-encoded with `encoding-type=url`. Snapshot names are digits so a restorer
  never trips on it, but a general lister does.
- Hints that were present and confirmed exactly: ext4 clamps the year 0000 to
  `1901-12-13T20:45:52Z` (crafted file 37 reports precisely that instant);
  zlib's `inflate` ends a cut stream in `Z_BUF_ERROR` with `avail_in` 0 and a bad
  CRC in "incorrect data check" (crafted files 4 and 5); `inflateReset` picks up
  the next member (file 1); `CURLOPT_HTTP_CONTENT_DECODING` 0 and no
  `Accept-Encoding`; `towlower` under `C.UTF-8`; floor-division for a time
  before 1970 (`mtime-1969.txt` restored to `1969-12-30T23:59:59.750Z`, verified
  to the millisecond).

## Environment notes, not the format

- **Platform:** Ubuntu 24.04.5, Linux 7.0 (Azure), gcc 13.3. gcc 13 spells C23
  `-std=c2x` (`__STDC_VERSION__` 202000L); clang 18 is also packaged and
  accepts `-std=c23`. Built with `gcc -std=c2x -O2 -Wall -Wextra`, zero
  warnings.
- **Libraries:** OpenSSL 3.0.13 (`libssl-dev` present: SHA-256 via `EVP_Digest`,
  HMAC via `EVP_MAC`), zlib 1.3 (`zlib1g-dev` present). libcurl 8.5.0 is
  installed as a runtime only (`libcurl4t64`); no `libcurl4-openssl-dev`, no root
  (`sudo` is blocked by `no_new_privileges`), and the proxy allowlist refuses
  the Ubuntu archives. The ~15 libcurl functions and option constants the
  restorer uses are declared by hand in the source and linked with
  `-l:libcurl.so.4`; the constants were checked against the platform's PHP 8.3
  curl extension (`php -r 'echo CURLOPT_...;'`), which mirrors libcurl's values.
  No AWS SDK, no S3 library.
- **Signing:** SigV4 implemented from memory: canonical request with `host`,
  `x-amz-content-sha256` (empty-payload hash), `x-amz-date` and the signed
  `x-amz-security-token`; virtual-hosted URL
  `https://<bucket>.s3.<region>.amazonaws.com/<key>`. The first signed request
  returned 200. **The `aws` CLI was not needed for signing.** It was used as a
  development aid for: confirming the bucket was reachable, listing the
  inventory, mirroring the 36 snapshots and 6 records to scratch for offline
  parser work, and `head-object` on nine hashes to predict expected outcomes.
- **Proxy and sandbox:** `HTTPS_PROXY=http://localhost:3128` is read from the
  environment and passed to libcurl (`CURLOPT_PROXY`); egress is AWS only.
  Background processes detached from a tool shell are killed with it, and the
  execute bit on a script in `$TMPDIR` did not persist, so the batch runs were
  driven with `bash script` in a foreground background task.
- **Test aids in the binary:** `S3CAB_RESTORE_SNAPSHOT_FILE=<path>` substitutes
  the snapshot's bytes from disk (objects still come from the bucket; used for
  the crafted-file table) and `S3CAB_RESTORE_DEBUG=1` turns on libcurl's
  verbose trace. Neither is needed for a restore.
- **Credentials:** session credentials from `credentials.env`; the token is
  sent and signed as a header. No 403 was seen at any point.
- **The bucket:** 24 sets (8 fixtures x linux/macos/windows), 36 snapshots, 3821
  objects, 6 deletion records (`-1,-3,-4,-6,-7,-9`), a `.s3cab/` client folder
  (ignored), no `locks/`. All snapshots are single-member gzip with no trailing
  bytes; four (faults-*-1729/1731, 1736/1738, 1731/1733) lack the `.`. Three
  recorded deletions are present again in `objects/` (edge dedup hashes), three
  are gone (faults `deleted.txt`), `torn.txt` is gone and unrecorded,
  `b-corrupt.txt` is present with 32 bytes that hash to another value.
- **Throughput:** about 16 requests/s through the proxy; 1100 files in 68-70 s;
  a 40 MiB object in about 1 s. Credentials expire 11:43Z; the work finished well
  inside the window.

## Results against the bucket

Every snapshot was restored three times, once per build that reached the
batch: the first build, one that stopped doubling backslashes in printed paths,
and the final binary, which also follows a link at or above `<output>` (nothing
in the batch exercised either change). All three runs verified identically; the
tables below are from the final run.
Each tree was then checked by an independent Python script (written from the
spec, not from the C) that recomputes which rows must be refused and why,
confirms every restored file's SHA-256, size and millisecond mtime, confirms
nothing else is on disk and no directory is empty, cross-checks every
"deleted" verdict against the mirrored records and `START`, and checks the exit
code.

| Set | Snapshot | Exit | File rows | Restored | Deliberately deleted | Refused rows | Damage | Requests | Tree verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bulk-linux | 20261030T1730 | 0 | 1100 | 1100 | 0 | 0 | 0 | 1101 | ok |
| bulk-macos | 20261030T1738 | 0 | 1100 | 1100 | 0 | 0 | 0 | 1101 | ok |
| bulk-windows | 20261030T1733 | 0 | 1100 | 1100 | 0 | 0 | 0 | 1101 | ok |
| corrupt-linux | 20261030T1732 | 1 | 3 | 2 | 0 | 0 | 1 | 4 | ok |
| corrupt-macos | 20261030T1739 | 1 | 3 | 2 | 0 | 0 | 1 | 4 | ok |
| corrupt-windows | 20261030T1734 | 1 | 3 | 2 | 0 | 0 | 1 | 4 | ok |
| docs-linux | 20261030T1730 | 0 | 120 | 120 | 0 | 0 | 0 | 121 | ok |
| docs-macos | 20261030T1738 | 0 | 120 | 120 | 0 | 0 | 0 | 121 | ok |
| docs-windows | 20261030T1733 | 0 | 120 | 120 | 0 | 0 | 0 | 121 | ok |
| edge-linux | 20261030T1730 | 0 | 59 | 59 | 0 | 0 | 0 | 60 | ok |
| edge-linux | 20261030T1733 | 0 | 59 | 59 | 0 | 0 | 0 | 60 | ok |
| edge-macos | 20261030T1738 | 0 | 54 | 54 | 0 | 0 | 0 | 55 | ok |
| edge-macos | 20261030T1740 | 0 | 54 | 54 | 0 | 0 | 0 | 55 | ok |
| edge-windows | 20261030T1733 | 0 | 29 | 29 | 0 | 0 | 0 | 30 | ok |
| edge-windows | 20261030T1735 | 0 | 29 | 29 | 0 | 0 | 0 | 30 | ok |
| faults-linux | 20261030T1729 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-linux | 20261030T1730 | 1 | 8 | 1 | 1 | 5 | 1 | 11 | ok |
| faults-linux | 20261030T1731 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-linux | 20261030T1732 | 1 | 3 | 1 | 1 | 0 | 1 | 11 | ok |
| faults-macos | 20261030T1736 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-macos | 20261030T1737 | 1 | 8 | 1 | 1 | 5 | 1 | 11 | ok |
| faults-macos | 20261030T1738 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-macos | 20261030T1739 | 1 | 3 | 1 | 1 | 0 | 1 | 11 | ok |
| faults-windows | 20261030T1731 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-windows | 20261030T1732 | 1 | 7 | 1 | 1 | 4 | 1 | 11 | ok |
| faults-windows | 20261030T1733 | 2 | - | - | - | - | - | 1 | ok (refused whole: no `.`, nothing written) |
| faults-windows | 20261030T1734 | 1 | 3 | 1 | 1 | 0 | 1 | 11 | ok |
| hollow-linux | 20261030T1732 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | ok |
| hollow-macos | 20261030T1739 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | ok |
| hollow-windows | 20261030T1734 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | ok |
| media-linux | 20261030T1732 | 0 | 2 | 2 | 0 | 0 | 0 | 3 | ok |
| media-macos | 20261030T1739 | 0 | 2 | 2 | 0 | 0 | 0 | 3 | ok |
| media-windows | 20261030T1734 | 0 | 2 | 2 | 0 | 0 | 0 | 3 | ok |
| spread-linux | 20261030T1732 | 0 | 6 | 6 | 0 | 0 | 0 | 7 | ok |
| spread-macos | 20261030T1739 | 0 | 6 | 6 | 0 | 0 | 0 | 7 | ok |
| spread-windows | 20261030T1734 | 0 | 6 | 6 | 0 | 0 | 0 | 7 | ok |

Totals: 36 snapshots, 4009 file rows, 3980 files restored and verified byte for byte with their mtimes to the millisecond, 4073 signed requests. Exit 2 is a snapshot refused whole; exit 1 is a restore that finished and reported faults; every refusal, deletion and damage above is the fixture's intended fault (see the bucket notes).

Latest-snapshot selection without a snapshot argument picked
`edge-linux/20261030T1733`, `faults-windows/20261030T1734` and
`faults-macos/20261030T1739`, the keys that sort last in each folder.

Destination rules (spread-linux, 6 rows): a second restore onto the same tree
reports 6 "exists", exit 0; a link where a folder should be reports the 4 rows
under it "in the way" and the link's target receives nothing; a file where a
folder should be and a folder where the file should land are reported "in the
way"; a link at the file's own name is "exists"; `<output>` being a file is
fatal. In each case the other rows restored and the failing rows left no
folders behind.

## Crafted-file tests of the parser

Forty-five variants of a real snapshot were fed to the restorer through a
test-only environment variable that substitutes the snapshot bytes (objects
still came from the bucket). Expected outcome is what the spec requires.

| # | Variant | Spec says | Result |
| --- | --- | --- | --- |
| 1 | two gzip members holding one text | one text | restored |
| 2 | zero byte after the stream, then garbage | ends the file | restored |
| 3 | 3 garbage bytes after the stream | damaged | refused: "3 byte(s) after the gzip stream" |
| 4 | gzip cut 12 bytes short | damaged | refused: "gzip stream cut short" |
| 5 | one trailer byte flipped | damaged | refused: "incorrect data check" |
| 6 | two whole snapshots concatenated | rows after `.`, refuse whole | refused: unknown row type `.` |
| 7 | plain text, not gzip | damaged | refused: "not a gzip file" |
| 10 | CRLF endings | refuse whole | refused: last line not `.` |
| 11 | UTF-8 BOM | forgiven | restored |
| 12 | no `.` | refuse whole | refused |
| 13 | a blank line | refuse whole | refused: "line 15 is blank" |
| 14 | unknown type `X` | refuse whole | refused |
| 15 | unknown `@FUTURE`, `#note`, `@SET foo` | ignored | restored |
| 16 | `. ` as last line | refuse whole | refused |
| 17 | a row after `.` | refuse whole | refused |
| 18 | a path that isn't UTF-8 | refuse whole | refused: "not UTF-8" |
| 19 | heading with a trailing space in column 5 | refuse whole | refused |
| 20 | heading padded differently in columns 1-4 | trimmed, accepted | restored |
| 21 | `DIR` with a doubled separator | matches nothing | row refused, exit 1 |
| 22 | file row with four fields | malformed, refuse row | row refused, other row restored |
| 23 | NUL in a path | refuse row | row refused |
| 24 | `a` and `a\inner.txt` both files | both refused | both refused |
| 25 | `DIR` `c:/S3CAB.SEED\...` vs rows `C:\s3cab.seed\...` | Windows: case-insensitive | restored |
| 26 | `C:\...` and `C:/...\...` spellings of one file | first restores, second reported | restored, COLLISION, exit 1 |
| 27 | no `START`, object deleted after | miss is damage | DAMAGE, exit 1 |
| 28 | path equal to a `DIR` | refused | refused |
| 29 | POSIX `DIR` `/srv/x/` vs row `/srv/X/a.txt` | exact: refused | refused |
| 30 | fifth tab (tab in path) | refuse row | refused: "holds a tab" |
| 31 | size `028` | leading zero allowed | restored |
| 32 | mtime `2026-02-30` | not a real instant | row refused |
| 33 | uppercase hex hash | malformed | row refused |
| 34 | blank line after `.` | refuse whole | refused |
| 35 | `.` without its LF | cut short | refused |
| 36 | `@SET DIR` with empty value | no directory | row refused: under no `DIR` |
| 37 | mtime `0000-02-29` | valid; ext4 clamps | TIME-NOT-HELD, has `1901-12-13T20:45:52.000Z`, exit 1, file kept |
| 38 | `DIR` `\\nas\photos\`, row `//NAS/photos/a.txt` | one share | restored at `UNC/NAS/photos/a.txt` |
| 39 | `DIR` `\\nas\` | no share name: matches nothing | row refused |
| 40 | `-` and size padded with U+3000, U+00A0, U+2003 | trim set | restored |
| 41 | `DIR` `C:\` alone | (silent) | restored, see gap 3 |
| 42 | `\\?\C:\...` path and `DIR` | (silent) | restored at `UNC/?/C:/...`, see gap 5 |
| 43 | `DIR` `/`, row `/etc/passwd` | (silent) | restored at `<output>/etc/passwd`, see gap 3 |
| 44 | file 26 again onto its own output | (silent) | "exists" twice, exit 0, see gap 2 |
| 45 | a 304-byte file name | "a name the destination won't create is reported, exit 1, and the rest restore" | FAILED "too long (Linux allows 255 bytes)", other row restored, the folder made for it removed, exit 1 |

## What was not tested

- Retries: no 5xx or dropped connection occurred, so the backoff code ran only
  in review.
- A destination filesystem that rounds times (FAT, exFAT), and multi-gigabyte
  objects.
- Two `@SNAPSHOT START` rows and a malformed-newest deletion row (gaps 1 and 4)
  were reasoned about, not run, since no fixture holds them and the verdict is
  the guess itself.

## Differences from the reference

`reference/` holds the tool's own restore of each of the 36 snapshots. Each of my
final-run trees was compared with its reference by a script that walks both,
pairs every entry by relative path, and checks type (file, directory, link),
content (SHA-256 and size), nanosecond `st_mtime`, mode, and the directory sets
(so an empty folder or an extra folder on either side shows up).

**Paths, content, types, modes and folders: identical, all 36 trees, 3980 files.**
Not one entry is present on one side and absent on the other, no file's bytes
differ, no folder exists on one side only. The 9 snapshots from which the tool
restored nothing (the 6 truncated faults snapshots and the 3 hollow sets) have
an empty reference directory and no directory of mine, which `RECONCILE.md`
defines as a match; the other 27 trees match entry for entry. Every verdict the first phase
reported, refused rows, deliberate deletions, damage, therefore agrees with the
tool on what lands and what doesn't.

**Modification times: one systematic difference, on 3892 of the 3980 files.**
The reference's mtimes sit between 1 and 119 ns off the row's millisecond;
mine are on it exactly. The remaining 88 files agree to the nanosecond, and
those are exactly the rows whose fraction is a multiple of an eighth of a second
(`.000`, `.125`, `.250` ... `.875`; `mtime-1969.txt` is `-86400.25 s`), the only
thousandths a binary double holds exactly at this magnitude. Every one of the 3980
reference mtimes is reproduced, to the nanosecond, by taking the row's instant
as a count of seconds in an IEEE double and truncating the fraction to whole
nanoseconds (3980 of 3980 match that prediction; a rounding variant matches only
1987). Doubles near this epoch are spaced about 238 ns apart, so the largest
possible error is 119 ns, which is the largest observed. That is the tool
setting times through a floating-point seconds interface; mine go through
`futimens`, which takes nanoseconds.

*Whose fault:* neither a bug in my restorer nor a gap in the spec. The spec
predicts this to the nanosecond: "A fraction like `.674` has no exact
representation in a floating-point count of seconds ... so a restored file can
land up to about a hundred nanoseconds off its row. s3cab's own restore does,
where the filesystem keeps nanoseconds; setting the time through a nanosecond
interface is exact." It also rules that comparisons happen at the millisecond,
"not finer: below the millisecond two restores can disagree without either
being wrong." Both trees hold the stored value to the millisecond, which is the
rule. I have left the restorer as it is: making it reproduce the tool's rounding
would make it match the reference byte for byte at the cost of being
deliberately less exact than the format, and the spec says which of the two is
right. If the project wants the reference tree to be a byte-for-byte oracle
below the millisecond, the change belongs in the tool (a nanosecond interface),
not in the spec and not in readers.

One thing the comparison could not settle: whether the tool sets the access time
to the same instant, as the spec says it does. Both trees had been read for
hashing by then, and under `relatime` a read moves an access time that equals
the modification time, so no access time on either side was still the one the
restorer set.

The restorer was not changed in this phase. The binary in this directory is the
one the first phase left, built from `s3cab-restore.c` as it stands (`make`
reports it up to date), so the program checked against the references is the
program the first phase delivered.
