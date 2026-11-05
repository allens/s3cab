# The format-spec clean-room audit, run 21: restore on Windows, Fable 5.1 at xhigh (2026-11-05)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30, as of
[PR #491](https://github.com/allens/s3cab/pull/491). The set is runs 16–21: backups on
[Linux](format-spec-audit-16.md), [macOS](format-spec-audit-17.md) and
[Windows](format-spec-audit-18.md); restores on [Linux](format-spec-audit-19.md),
[macOS](format-spec-audit-20.md) and Windows (this run).

- **Program:** [`csrestore/`](../scripts/cleanroom/restorers/csrestore/), C# 5 built with the
  `csc.exe` that ships with .NET Framework 4, and no S3 library. The reconcile phase left it
  unchanged; its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens, both phases:** input 1,540, cache write 281,634, cache read 8,258,989, output 137,609.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# Independent restorer for the s3cab format: report on `format.md` (spec of 2026-10-30)

Written from `format.md` alone, on Windows Server 2025, with the .NET Framework 4.8 C# 5
compiler that ships with Windows and nothing else. No AWS SDK, no S3 library, no `aws` CLI
in the program: HTTPS through `HttpWebRequest`, Signature Version 4 signed by hand, SHA-256,
HMAC and DEFLATE from the standard library.

Deliverables in this directory:

- `s3cab-restore.exe`, built from `s3cab-restore.cs` (final source, clean rebuild):
  `.\s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]`, credentials and region from the
  environment. Exit 0 when everything restored or was skipped or deliberately deleted, 1 when
  any row was damaged, refused, in collision, in the way or could not take its time, 2 when
  the snapshot was refused whole or the restore stopped.
- Development aids, kept so the evidence below can be re-run: `verify-tree.cs/.exe` (an
  independent checker sharing no code with the restorer), `make-tests.cs/.exe` (crafted
  snapshot files in `tests\`), `fetch-snaps.ps1` (aws CLI downloads into `snaps\`, for the
  verifier only), `restore-all.ps1`, `verify-all.ps1`, `check-tests.ps1`, `test-dest.ps1`,
  `test-from.ps1`, `test-rerun.ps1`. Restored trees and per-run logs are under `out\`.

## What was run

Every snapshot in the bucket was restored by the restorer, one run per snapshot, into
`out\<set>\<snapshot>` (`restore-all.ps1`; summary in `out\summary.txt`). The bucket holds
24 sets in eight families times three writer platforms (linux, macos, windows) and 42
snapshots.

| Family | Snapshots | Outcome |
| --- | --- | --- |
| bulk | 3 | 1100 files each, all restored, exit 0 |
| docs | 3 | 120 files each, all restored, exit 0 |
| media | 3 | 2 files each (one 40 MiB), restored, exit 0 |
| spread | 3 | 6 files each under two `@SET DIR` rows, restored, exit 0 |
| hollow | 3 | 0 file rows, nothing written, no output directory made, exit 0 |
| corrupt | 3 | 3 rows; one object's bytes don't hash to its key: withheld, exit 1 |
| edge | 6 | odd names, case twins, NFC/NFD twins, extreme mtimes, deep paths: see below |
| faults | 12 | two cut-short snapshots per platform refused whole; the rest restore with refused rows, a deliberate deletion and a missing object |

Then `verify-tree.exe` checked every restored tree against the snapshot rows fetched
separately by the aws CLI: each row the log reports as restored must exist at
`<dir>\<root folder>\<segments>` with the row's SHA-256 and modification time to the
millisecond; each other row must have nothing at its destination unless a restored row's case
twin landed there; every file on disk must be a restored row's destination; no empty folder
may remain. Result (`out\verify.txt`): 36 restorable snapshots, 0 problems; 6 refused
snapshots left no output directory.

Further real-bucket runs:

- Destination rules (`test-dest.ps1`, media-windows set): a second run into the same
  directory skips both files with exit 0; a file where a folder should be, a junction where a
  folder should be, and a folder where the file should land are each reported "in the way"
  with exit 1 and nothing written through the junction; a case twin already there and a
  symlink at the file's own name are each "skipped", exit 0; a snapshot name that doesn't
  exist and a set with no snapshot stop with exit 2 and make no directory.
- Crafted snapshots restored through a `--from <file>` development mode with objects and
  deletion records fetched from the bucket for real (`test-from.ps1`): a deletion recorded
  before `START` and a snapshot with no `START` both report damage, exit 1; one recorded
  after `START` reports "deleted (deliberately, <instant>)", exit 0; rows timed
  `0000-02-29`, `1600-12-31` and `1601-01-01T00:00:00.000Z` are restored but reported as a
  time the destination can't hold, exit 1, while `1601-01-01T00:00:00.001Z`, `1969-12-31`
  and `9999-12-31` are held exactly; `//NAS/photos/a.jpg` lands at `UNC\NAS\photos\a.jpg`,
  `c:/x/y.txt` at `C\x\y.txt`, `/home/me/z.txt` at `home\me\z.txt`; three spellings of one
  Windows path restore the first and report two collisions.
- Parser cases (`check-tests.ps1`, 48 crafted files, no network): two gzip members joined
  mid-line read as one text; two whole snapshots as two members refused; a zero byte after
  the stream ignored; other bytes after it, a cut deflate stream, a missing trailer, a wrong
  CRC and a wrong length all refused; CRLF, BOM, no `.`, `.` without LF, `. `, a `.` in the
  middle, a blank line, an unknown type `+`, invalid UTF-8, a heading with a trailing space
  all behave as the spec says; unknown `@`/`#` rows and properties are skipped; Windows
  `@SET DIR` matching ignores case and separator style, POSIX doesn't; a row equal to a
  `DIR`, under no `DIR`, with `.`/`..`/empty segments, a NUL, a CR, a fifth tab or fewer
  than five fields is refused; two rows with one path are both refused, a malformed twin
  included; `C:\P\a` and `C:\P\a/c.txt` are both refused; leading-zero and huge sizes pass,
  signed or spaced ones don't; `30 February`, hour 24, second 60, `1900-02-29`, two
  fractional digits and a `+00:00` offset are all refused, `0000-02-29` passes.
- Signing: the first signed request (a `ListObjectsV2`) succeeded; about 4,200 signed
  requests were made in all, with no signature failure, no 5xx and no dropped connection.

Not exercised, because the bucket doesn't contain the case: a latest snapshot that is refused
(the latest of every set is valid, so the no-fallback rule wasn't tested); a 403 or a
`NoSuchBucket`; retries on 5xx or dropped connections (the code paths exist, untested); a
deletion record with a malformed row; a Windows-kind row with `:` in a segment; `<output>`
itself being a link; objects larger than 40 MiB; a case-sensitive NTFS directory; FAT or
exFAT rounding.

## Would corrupt a restore

Ranked by how badly a reasonable reading goes wrong. Each entry says what I guessed.

1. **A re-run into a populated directory turns a reported collision into a clean skip.**
   The rules say a file at a destination before the restore began is "left alone and reported
   as skipped", exit 0, and only a destination *this restore* wrote is a collision. On the
   first run of edge-windows, `case\Case.txt` restores and `case\case.txt` is a collision,
   exit 1. On a second run into the same directory both read as already there: 29 skipped,
   exit 0, and `case.txt`'s content is nowhere on disk (`test-rerun.ps1`). The same holds for
   NFC/NFD twins on macOS and for any pre-existing file with the wrong bytes: a skip never
   checks content, so a restore resumed after a partial one reports success for a tree that
   is incomplete. The spec never says whether a skip may be trusted, whether a skipped file
   should be hashed against its row, or that a re-run can't be used to finish a restore.
   Guess: I followed the letter (skip without checking). A hashed skip, or a "skipped but
   differs" verdict with exit 1, would close it.
2. **Which `@SNAPSHOT START` counts when the row is repeated or malformed.** The spec gives
   last-wins for `.info` keys and says repeated `SPEC`, `NAME` and `VERSION` are ignored, but
   says nothing for `START`, and `START` decides whether a missing object is "deliberately
   deleted, exit 0" or "damage, exit 1" (`r01`–`r03` show the verdict flipping with `START`).
   Two readers that pick first and last can report different exit codes for one file, and
   one of them lets an incomplete restore pass. Guess: the first row whose column 4 is a
   valid 24-character instant; a malformed one counts as absent and is skipped over (`t14`).
   Only a hand-edited file has two, but the spec takes hand edits seriously everywhere else.
3. **"The first row restores" when the first row didn't.** For two rows landing on one
   destination the first restores and later ones are reported. If the first row's object is
   missing or withheld, nothing landed, and the spec doesn't say whether the destination is
   still "claimed". Guess: not claimed, so the later row restores (`r06`: `b.txt` damaged,
   then `B.txt` restored). A reader that claims it leaves nothing at that name. Both exit 1,
   but the trees differ, which is exactly what the "no reader guesses" rule is meant to
   prevent.

## Would inconvenience the implementer

1. **The gzip header's optional fields are never mentioned.** The spec promises "plain,
   single-stream gzip" and tells a .NET reader to "read the gzip framing yourself", but never
   says a member's header may carry FEXTRA, FNAME, FCOMMENT or FHCRC, which its own writing
   hint says Python's `gzip.open` adds. A reader that assumes a fixed 10-byte header feeds
   the file name into the inflater and refuses a good file. Guess: parse all four flags
   (`t46` passes with all three string fields set). Also unstated: whether a member with a
   non-deflate compression method, or a zero byte *before* the first member, is "not gzip".
   Guess: refuse.
2. **The case-insensitive `@SET DIR` match is defined as JavaScript's `toLowerCase()`,
   which no standard-library call reproduces.** The hint explains why `ToLowerInvariant` is
   wrong (Final_Sigma, U+0130) and points at ICU through P/Invoke. Guess: `ToLowerInvariant`
   plus my own Final_Sigma and U+0130 rules, approximating Unicode's cased/case-ignorable
   classes with general categories and a few punctuation marks (`t23`, `t23b` pass; never
   compared against ICU). A wrong mapping refuses a valid row, reported, exit 1, so this
   can't corrupt, but the spec is asking readers to agree on something it doesn't define
   itself. Giving the rule in terms of Unicode's `Final_Sigma` condition, or just saying
   "simple lowercase mapping plus these two exceptions", would make it implementable.
3. **Where a download may live before its folders exist.** "Folders are made only as files
   land", "a file that fails leaves none of the folders made for it", "a restore that writes
   nothing makes no `<output>`" and "never write outside your destination" together forbid
   streaming a download to its destination and leave nowhere for a temporary file. Guess:
   hold each object in memory until it hashes (fine for this bucket's 40 MiB maximum, not for
   a 50 GiB file). The spec should say where a tool may spill, or that `<output>` may be
   made for a temporary file.
4. **`\\?\C:\` is listed as a Windows path but never rooted.** By the rules it is a share
   whose server is `?` and share `C:`, landing at `<output>\UNC\?\C:\…`, which NTFS refuses.
   A reader might instead strip the prefix and treat it as drive `C`. Guess: the literal
   reading (`r05`: `\\?\C:\q.txt` was a share-kind path under no `DIR`). The spec could
   say "a reader treats `\\?\` like any other share root" or tell readers to strip it.
5. **A root-only `@SET DIR` (`C:\`, `/`).** Nothing says a member directory may be a root.
   Guess: allowed, zero segments, every path of that root is under it (`t33`, `r05`).
6. **`:` in a Windows-kind segment.** The checklist refuses a *POSIX* name holding `\` or
   `:` because Windows would misread it. A Windows path can't be written with one, but a
   hand edit can. Guess: refuse `:` in any segment on a Windows destination (untested for
   the Windows kind; `a:b.txt` from edge-linux was refused).
7. **A second `@S3CAB FORMAT` row.** Repeated `SPEC`, `NAME` and `VERSION` are to be
   ignored; `FORMAT` isn't listed, and the heading row is matched by position. Guess: a
   later `@S3CAB FORMAT` is an unknown property, skipped (`t45`).
8. **A `-` row with fewer than five fields.** "A line with fewer reads the missing ones as
   empty" and "a file row's path must be absolute" have to be combined by the reader to
   get "refuse the row". Guess: refuse it as a malformed row (`t18`, third row).
9. **Whether `<output>` itself may be a link or junction.** The rule covers "one of its
   folders inside `<output>`". Guess: `<output>` itself is not checked. Untested.
10. **A hash with both a malformed and a well-formed `#deleted` row.** "A malformed row is
    refused, so its object counts as not deleted" and "the well-formed rows of an invalid
    record still explain an absence" can both apply to one hash. Guess: the well-formed row
    counts. The bucket's six records are all well-formed, so untested.
11. **Re-fetching a missing hash.** A download that doesn't hash is "not fetched again for
    any later row naming that hash"; nothing is said about a miss. Guess: fetch again (cheap,
    and "presence always wins").
12. **The refusal conditions are spread over five places** (the five rules, Snapshot files,
    The last line, Valid and invalid files, the Reading checklist), and some appear in only
    one: ". with anything more refuses the file" is only under The last line; "a `#` row
    repeating a file row's path needn't be checked" only under Valid and invalid files; the
    zero-byte rule in Snapshot files and the checklist but not in Valid and invalid files. A
    single table of "condition, verdict, where explained" would have saved a careful
    cross-read.
13. **Exit codes.** "Exit nonzero" for a refused snapshot and for a failed row; whether the
    two should differ is left open. Guess: 2 for a refused snapshot or a stopped restore, 1
    for a restore that finished with reports.

## Hints that would have helped

- **.NET's `File.GetAttributes` through `\\?\` is not `File.Exists`.** For a name holding
  `"`, `*`, `<`, `>` or `?` it reports not found, as the hint says `File.Exists` does; for
  `|` and for control characters such as VT and FF it throws `IOException` with Win32 error
  123 (ERROR_INVALID_NAME) instead, so a "something in the way" check written with
  `GetAttributes` blows up before the creation step reports the name (seen on edge-linux
  `a|b.txt`, `formfeed.txt`, `verticaltab.txt`; fixed by treating error 123 as absent).
- **.NET has no `lstat`, but `File.GetAttributes` doesn't follow a link while `FileStream`
  does.** The `ReparsePoint` attribute is how a junction or symlink at a folder position, or
  at the file's own name, is told apart; the hint names `lstat` for POSIX only.
- **A time before 1601 can't even be attempted from .NET.** `DateTime.FromFileTimeUtc` and
  `File.SetLastWriteTimeUtc` throw `ArgumentOutOfRangeException` below 1601, so the "Windows
  takes FILETIME 0 as leave alone" behaviour is never reached; compute the FILETIME from the
  millisecond count and report when it is zero or negative. NTFS does hold
  `1601-01-01T00:00:00.001Z` exactly (`r04`).
- **`DeflateStream` over a one-byte stream stops exactly at the end of the data, as the
  hint says, and returns 0 rather than throwing on a cut stream**; the trailer and CRC check
  is the only thing that reports the cut (`t05`, `t06`). Worth saying in the gzip hint.
- **The file-identity check needs `GetFileInformationByHandle` through P/Invoke**; the hint
  names the call but a .NET reader may not know `FileStream.SafeFileHandle` is enough to get
  the handle, and that a `ReparsePoint` destination should be skipped as "already there"
  before opening it, since opening follows the link to a file this restore may have written.
- **`ListObjectsV2` keys are XML text in the `http://s3.amazonaws.com/doc/2006-03-01/`
  namespace**; XPath needs an `XmlNamespaceManager`, and a key holding a character XML can't
  carry (a control character in a `.<name>/` key, say) breaks `XmlDocument` unless
  `encoding-type=url` is requested. Snapshot, object and record keys never do.
- **When stdout and stderr are redirected to one file, .NET's buffering reorders them**; a
  log reader that pairs verdicts with the summary line should use one stream.

## Environment notes, not the format

- **Signing.** SigV4 was written from what I already knew: canonical request (method, URI,
  sorted query, lowercase sorted headers, signed-header list, empty-body SHA-256), string to
  sign with the `date/region/s3/aws4_request` scope, the four-step HMAC key, and the
  `host`, `x-amz-content-sha256`, `x-amz-date`, `x-amz-security-token` headers. Before
  writing any code I ran the aws CLI once with `--debug` to see the endpoint host form and
  whether a proxy was in play; that trace also printed its canonical request, which matched
  what I then wrote. No signing debugging was needed: the first signed request succeeded.
  The CLI was otherwise used to confirm access and enumerate the bucket before coding, and
  to download the snapshots and records for the independent verifier.
- **Transport.** `HttpWebRequest` to `https://<bucket>.s3.us-east-1.amazonaws.com`, TLS 1.2
  forced, no proxy (none configured; the CLI connected directly too), 30-second timeouts,
  `AllowAutoRedirect` off, no automatic decompression so no `Accept-Encoding` is sent.
  `Authorization` is settable through `Headers`; `Host` is set from the URI; the restricted
  `Date` header isn't needed since `x-amz-date` is accepted. The query string is sent
  already percent-encoded in SigV4 form and the request path is checked against what was
  signed. Retries follow the spec's schedule but never fired.
- **Toolchain.** `csc.exe` 4.8 is C# 5: no string interpolation, `nameof`, `out var`,
  expression-bodied members or null-conditional operators. `System.Xml` is referenced by the
  default response file. `[assembly: TargetFramework(".NETFramework,Version=v4.8")]` was
  enough for `\\?\` paths and a 340-character path, as the spec's hint says.
- **Sandbox.** The PowerShell permission layer refused command lines containing `$(...)`,
  `"$var"` interpolation, .NET method calls, `Select-Object`, `Format-Table`, `Get-ChildItem`
  on environment variables and `Write-Output $LASTEXITCODE`, and the classifier denied
  `netsh winhttp show proxy`; script files in this directory ran without objection, so every
  loop and check lives in one. The machine's clock is UTC, so the credential expiry was easy
  to track.
- **Bucket.** 24 sets, 42 snapshots, 3,821 objects totalling about 130 MB with a 40 MiB
  maximum, six deletion records at indices 1, 3, 4, 6, 7 and 9 (gaps, as the spec says are
  normal), `.info` files for every set, a `.s3cab/sets/<set>/` folder with `dirs.txt` and
  `exclude.txt` (ignored, as the spec says), no `locks/`. Every object and snapshot is in
  `GLACIER_IR`, and a plain GET reads it, as the spec promises for that class. A snapshot
  restore costs one LIST, one GET for the snapshot and one GET per file row, plus one LIST
  and six GETs for the records on the first miss.
- **Did I want more than `format.md`?** Only the S3 API itself (SigV4, `ListObjectsV2`
  parameters and XML, error bodies), which the spec rightly leaves out.

## Guesses, each recorded as made

Every guess, right or wrong, with the evidence that decided it. Those already in the ranked
lists are referenced by number.

| # | Guess | Outcome |
| --- | --- | --- |
| G1 | A skipped pre-existing file is never checked (Corrupt 1) | Spec's letter; harmful on re-run |
| G2 | First valid `@SNAPSHOT START` wins (Corrupt 2) | Untestable from the bucket; `t14`, `r01`–`r03` |
| G3 | A failed first row doesn't claim its destination (Corrupt 3) | `r06` |
| G4 | gzip header flags FEXTRA/FNAME/FCOMMENT/FHCRC must be skipped (Inconv. 1) | `t46` |
| G5 | JS `toLowerCase()` approximated with Final_Sigma and U+0130 rules (Inconv. 2) | `t23`, `t23b` |
| G6 | Objects held in memory until hashed (Inconv. 3) | Worked up to 40 MiB |
| G7 | `\\?\C:\` is a share with server `?` (Inconv. 4) | `r05` |
| G8 | A root-only `@SET DIR` is legal (Inconv. 5) | `t33`, `r05` |
| G9 | `:` refused in any segment (Inconv. 6) | edge-linux `a:b.txt` |
| G10 | A later `@S3CAB FORMAT` is skipped (Inconv. 7) | `t45` |
| G11 | A `-` row with fewer than five fields is a malformed row (Inconv. 8) | `t18` |
| G12 | `<output>` itself isn't checked for being a link (Inconv. 9) | Untested |
| G13 | Well-formed `#deleted` row counts beside a malformed twin (Inconv. 10) | Untested |
| G14 | A missing hash is fetched again for a later row (Inconv. 11) | Harmless either way |
| G15 | Exit 2 for a refused snapshot or a stop, 1 for reported rows (Inconv. 13) | Spec says only "nonzero" |
| G16 | Snapshot name regex `[0-9]{8}T[0-9]{4}\.tsv\.gz` with ASCII digits only, sorted ordinally | Latest chosen correctly for edge and faults sets |
| G17 | Record key regex `objects\.deleted-[1-9][0-9]*\.tsv`, listed with prefix `objects.deleted-` and delimiter `/` | Six records found and read |
| G18 | A snapshot whose `@SET DIR` value has four fields or an empty fifth is "no directory" | `t28` |
| G19 | The heading's first four fields are trimmed, the fifth must equal the address exactly | `t19` refused |
| G20 | A `.` line anywhere but last refuses the file | `t30`, `t02` |
| G21 | A malformed `#deleted` row never counts; records are read line by line with per-line UTF-8 | Untested (all records valid) |
| G22 | Share paths: root is the two separators; server and share are ordinary segments; a share `DIR` needs at least two | `t22`, `t22b`, `r05` |
| G23 | Trailing separators on a `DIR` are all stripped; on a file row none are | `t36` |
| G24 | Deliberate deletion needs record instant strictly greater than `START`, compared ordinally | `r01`–`r03` |
| G25 | On a miss the records are listed and read once, lazily; a record listed but gone explains nothing and doesn't stop the restore | Six records read at first miss |
| G26 | A dangling symlink or a junction at the file's own name is "already there" | Symlink case in `test-dest.ps1` |
| G27 | Access time set to the stored instant like s3cab, then both times read back | Verified by `verify-tree.exe` (mtime only) |
| G28 | A `#` row repeating a file row's path isn't checked | Allowed by the spec |
| G29 | FILETIME of zero or below is "can't hold", file kept at restore time, exit 1 | `r04` |
| G30 | A GET 404 with code `NoSuchKey` or `NotFound` is a miss; any other status stops the restore | torn.txt misses were `NoSuchKey` |

## Statements in the spec I could check

- Hints confirmed: the `TargetFramework` attribute with bare `csc` enables `\\?\` and long
  paths; `DeflateStream` with one-byte reads stops at the end of the compressed data; NTFS
  refuses `"`, `*`, `<`, `>`, `?`, `|`, VT and FF even through `\\?\`, keeps `CON`,
  `aux.txt`, `notes.`, `trailing.txt ` and ` leading.txt` through it, and holds NFC and NFD
  `café.txt` as two files; the file-ID approach the hint describes reported the case-twin
  collision on NTFS (a `File.Exists` check alone was not tried).
- Not checked: that .NET Framework's `GZipStream` stops after the first member and decodes
  a file missing only its trailer (I used `DeflateStream` as advised); the `ToLowerInvariant`
  examples against ICU; the `.NET Trim()` set.
- Nothing in the spec was found to be wrong by anything I ran.

## Differences from the reference

None. Every one of the 36 trees under `out\<set>\<snapshot>`, restored by my restorer from
the bucket, is identical to `reference\<set>-<snapshot>`, restored by the tool itself:
same set of relative paths spelled identically (ordinal comparison, so case, trailing spaces
and dots, NFC against NFD and control characters all count), same directories, same bytes
(length and SHA-256) and the same modification time to the 100-nanosecond tick, for all
3,932 files. The six snapshots refused whole and the three empty sets left no directory on my
side, which matches the empty reference directory as `RECONCILE.md` defines it. Beyond the
byte-for-byte comparison, the tool also reports attribute and access-time differences as
notes: there were none, so the reference sets the access time to the stored instant as the
spec says s3cab does, and so does mine. Full output is in `out\compare.txt`.

The comparison was checked against trees that must differ (`compare-control.ps1`): a tree
with a case twin and a different root reports each path as only on one side; a copy of a
matching tree with one modification time moved by one millisecond reports that one file and
nothing else. So a clean result means the trees are the same, not that the comparison is
blind.

What the agreement says about the findings above:

- The verdicts my restorer reached from the spec alone match the tool's on every row the
  bucket exercises: the refused rows in the faults sets (under no `@SET DIR`, one path twice,
  a `..` segment, `FAULTS` on a case-sensitive platform), the deliberately deleted file, the
  missing object, the withheld corrupt object, the case-twin collision (reference holds only
  `case\Case.txt`), the names NTFS refuses, `CON`, `aux.txt`, `notes.`, the trailing-space
  names, the NFC/NFD pair, the 340-character path, and the 1969, 2038 and 2300 times.
- None of the three "would corrupt a restore" items could be settled by the reference: a
  re-run into a populated directory, a repeated `START` and a failed first row are not in
  the bucket's snapshots, so they remain open spec questions rather than observed
  divergences.
- No difference was found, so nothing was traced to a bug in my restorer or to a gap in the
  spec in this phase, and the restorer was not changed: `s3cab-restore.exe` is the build the
  first phase left, from the same `s3cab-restore.cs`.
