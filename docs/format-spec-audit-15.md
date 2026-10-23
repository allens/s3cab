# The format-spec clean-room audit, run 15: restore on Windows, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on [Linux](format-spec-audit-10.md),
[macOS](format-spec-audit-11.md) and [Windows](format-spec-audit-12.md); restores on
[Linux](format-spec-audit-13.md), [macOS](format-spec-audit-14.md) and Windows (this run).

- **Program:** [`csrestore/`](../scripts/cleanroom/restorers/csrestore/), C# 5 built with the
  `csc.exe` that ships with .NET Framework 4, and no S3 library. It is the reconcile phase's
  program; its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens, both phases:** input 2,184, cache write 413,669, cache read 19,473,278, output 224,385.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# Clean-room restorer for the s3cab format: report on `format.md`

Written from `format.md` (the spec of 2026-10-23) and nothing else about the format. The
restorer is `s3cab-restore.cs`, built as `s3cab-restore.exe` with the C# 5 compiler that ships
in `C:\Windows\Microsoft.NET\Framework64\v4.0.30319`. It uses nothing beyond the .NET Framework
class library: `HttpWebRequest` for HTTPS, `HMACSHA256`/`SHA256` for signing and hashing, and
its own DEFLATE and gzip reader so that the end of each gzip stream is known. Two calls go to
Windows DLLs by P/Invoke: `GetFileInformationByHandle` in kernel32, for file identity, and
`u_strToLower` in the system's `icu.dll`, with a fallback when it is absent. It ran against
the real bucket for every result below. The `aws` CLI was never run: SigV4 was written from
memory and the first signed request came back `200`.

Summary of the outcome: every snapshot in the bucket was restored or refused as the spec says
s3cab would, and an independent verifier confirmed every restored file byte for byte with its
modification time to the millisecond. The spec is in good shape. The lists below are what I had
to guess, ranked as asked. The two findings that matter are a missing time bound on deletion
records, which can let damage pass as a deliberate deletion with exit 0, and a gap in the
Windows name rule that can put a POSIX set's files in the wrong folder without a word. Raw
notes taken while implementing are in `scratch\guesses.md`.

Build and run:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /out:s3cab-restore.exe s3cab-restore.cs
. .\credentials.ps1; .\s3cab-restore.exe <bucket> <set> <dir> [<snapshot>] [--verbose] [--save-snapshot <file>]
```

## Would corrupt a restore

Each item names what the spec leaves open, what I did, and how it was tested.

1. **A deletion-record row older than the snapshot still "explains" a missing object.** The
   reading rule says a hash any record lists was deliberately deleted, full stop. But the
   bucket's own invariants mean a row dated before a snapshot's `START` cannot explain that
   snapshot's miss: `backup` counts a recorded hash as stored only after a `HEAD` finds it, so a
   snapshot taken after the deletion had the object present when it was uploaded. If that
   object is missing now, it was removed after the snapshot, by a later `delete` (which writes a
   newer row) or by damage. A reader that follows the rule as written reports such damage as
   "deliberately deleted on <old date>" and exits 0, which breaks the promise that a partial
   restore never passes for a full one. The fix is cheap: only a row whose instant sorts after
   the snapshot's `START` explains a miss (both are the same 24-character text), with the
   caveat that the two instants come from different machines' clocks. The bucket could not
   show this (its records all post-date the snapshots that reference them, and I may not write
   to it); the record harness shows my parser, like the rule, accepts any date. I implemented
   the rule as written and flag it here rather than deviate silently. The same reading governs
   s3cab's `verify`, which the spec says reports recorded hashes as expected with exit 0, so
   the stale row hides the damage from that check too. Compaction keeps the row for as long as
   any snapshot references the hash, which is exactly as long as the problem lasts.
2. **A `@SET DIR` whose own name holds `\` or `:` is not covered by the Windows name rule.** The
   checklist says a POSIX *name* holding `\` or `:` is refused before anything is written,
   because Windows would split it into folders or write a stream. It says this of the names in
   a row, but the folder a restore creates from the DIR's last segment is a name too. Under
   `@SET DIR /srv/a\b/`, a reader that follows the rule literally writes `<output>\a\b\...`,
   a different place, with no error. I refuse every row under such a DIR
   (`scratch\cases\posix-dir-backslash.tsv`: the row is refused with "a name holds a '\'").
3. **A tab in a file row's path is a rule in two places, but the checklist's validity list
   omits it.** "Every per-path row's path absolute, with no tab, CR or LF" is there; my first
   draft checked CR, LF and NUL and missed the tab, because the five-field rule says a fifth tab
   "is part of the last field". A path with a tab then restores as a file whose name holds a
   tab, which NTFS refuses, so on Windows it fails loudly; on Linux it would be written. Caught
   while writing the synthetic cases, before any run; now refused
   (`scratch\cases\malformed.tsv`, line 23).

## Would inconvenience the implementer

Guesses that change which valid-looking files are refused, what is reported, or the exit code,
but never the bytes or paths of what is written.

1. **Heading row, last field.** "Its five fields, padding aside, are exactly" versus "never trim
   the last". I compare the URL exactly, so a trailing space on it refuses the file
   (`heading-trailing-space.tsv` refused; `heading-padded.tsv`, padded leading fields, accepted).
2. **The `.` line.** I require the whole line to be `.`; ` . ` and `.<TAB>` are not the
   terminator, and the file is refused (`dot-padded.tsv`, `dot-with-tab.tsv`). The spec says
   "exactly `.`" but also that every type is trimmed before comparison.
3. **A non-blank last line without LF.** The spec covers a `.` cut short. I refuse any such
   file, whatever the tail holds (`unterminated.tsv`, `cut-mid-dot.tsv.gz`).
4. **What counts as "named exactly `YYYY-MM-DDTHHMM.tsv.gz`".** I test the shape only, so a
   key `2026-99-99T9999.tsv.gz` would be a snapshot and sort "latest". Whether the digits must
   make a real date is unsaid.
5. **The set name typed on the command line.** The naming rule is single hyphens between runs of
   `a-z0-9`, but listing "counts every folder or `.info` named with those characters alone,
   hyphens anywhere". I accept the listing rule and print a note when the name isn't canonical.
6. **The zero byte after the last gzip stream.** Written as a description of s3cab ("stops at a
   zero byte there, and ignores it and everything after it") inside a rule that other bytes make
   the file damaged. I do the same (`trailing-zero.tsv.gz` and `trailing-zeros.tsv.gz` read;
   `trailing-garbage.tsv.gz` refused). A reader that treats it as damage refuses what s3cab
   reads.
7. **The boundary separator in "one path running through another".** Paths are compared
   "exactly, with no separator unified", so `C:\P\a` is not a prefix of `C:/P/a/b.txt`; but
   after an exact prefix, which separator may follow? I accept either `\` or `/` for a Windows
   path, `/` for POSIX (`through.tsv`: `C:\P\a/c.txt` refused with `C:\P\a`; `C:/P/a/d.txt`
   restores). The live run `through-mixed` shows the spec's own outcome for the other case: the
   file restores first and the folder is "in the way", exit 1.
8. **DIR root equality.** `C:\` and `C:/`, `c:\` and `C:\`, `\\nas` and `//nas` are the same root
   to my matcher (`driveroot.tsv`, `share.tsv`, `good.tsv`). The spec says both separators split
   a Windows path and case is ignored, which implies it, but never says it of the root.
9. **The drive-root folder's letter case.** `d:/` restores into `<output>\d\`, the DIR row's
   spelling (`driveroot.tsv`). On Windows it makes no difference; on Linux two readers could
   make `C` and `c`.
10. **A bare share root as DIR (`\\` or `//`).** It has no name; I make it match nothing.
11. **Pre-existing file versus fetch order.** I check the destination before fetching, so a file
    already there whose object is missing, deleted or corrupt is "skipped", exit 0, and no
    request is made (`basic` run twice: 3 skipped, 0 requests). The spec says the file is left
    alone and skipped, but not whether its object is still looked at.
12. **A deletion record that isn't UTF-8.** "Well-formed rows still count" can't be applied to
    bytes that won't decode strictly; I count none of its rows, the safe direction
    (`scratch\records.exe`, case `bad-utf8`).
13. **Records that can't be read at all.** A 403 on an object GET stops the whole restore; the
    spec is silent on a 403 or other failure when listing or fetching the records. I report it
    and count every miss as damage.
14. **Times before 1601, and 1601-01-01 itself.** Only the hints say what s3cab does (leave the
    time, report, exit 1). I do that (`times` run: three "TIME NOT KEPT", exit 1; the instant one
    millisecond into 1601 is kept). Readers that follow rules only may exit 0.
15. **"Two that match equally"** for DIRs: I take it to mean equal under the kind's case rule,
    so `C:\a\Photos\`, `c:/A/PHOTOS/` and `C:\a\Photos` are one DIR, the first counting
    (`dir-twice.tsv`).
16. **`@SET DIR` with five fields and an empty value** is covered only by implication (an empty
    string isn't absolute, so it matches nothing); the rule speaks of fewer than five fields.
17. **The empty-content object.** A row of size 0 names `objects/e3b0c442…`; a reader might be
    tempted to write the empty file without fetching. The spec never says the object must
    exist, though the writer rules imply it, and it does exist here (`empty.txt` restored).
18. **The size column has "no limit".** The spec says s3cab never compares it with the
    download, so a reader needn't parse it; it never says "don't parse it into an integer", and
    a 20-digit size would throw in most languages. I keep it as text.
19. **Which exit code.** "Exit nonzero" everywhere; I use 1 for every failure and 2 for usage.
20. **The 2-second "rounded" tolerance** on reading the time back is in the hints, not the
    rules, so readers will differ on whether exFAT's 10 ms rounding is a reported fault.

## Hints that would have helped

Traps met on Windows with .NET Framework that the spec could warn about, each demonstrated by
`scratch\dotnettraps.exe` unless noted.

1. **`StreamReader.ReadLine`, `File.ReadAllLines` and `File.ReadLines` treat CR, LF and CRLF as
   line ends.** A CRLF file then reads as clean: 14 lines, none with a CR, so the refusal the
   spec relies on never fires. Decode strictly and split on `\n` yourself.
2. **`DeflateStream` can't report where the stream ended, but a one-byte source makes it
   stop exactly at the trailer.** Fed a `Stream` whose `Read` returns one byte, it stopped at
   offset 323 of 331, where the 8-byte trailer begins; over the plain stream it read to the end.
   The current hint, "inflate with `DeflateStream` or your own", needs that detail or it sends
   the reader to write an inflater (I wrote one, about 200 lines, before finding the trick).
3. **`GZipStream` on .NET Framework 4.8.1, measured:** it returns the first member only (449 of
   898 bytes of a two-member file), returns 0 bytes and no exception for a stream cut 20 bytes
   short, returns the whole text with the trailer missing, ignores trailing garbage, and it
   does throw `InvalidDataException` on a bad CRC. The spec's claims hold; the CRC detail is
   worth adding, since it is the one check it does make.
4. **Stock Windows ships ICU.** `icu.dll` (Windows 10 1903 and later) exports `u_strToLower`,
   callable by P/Invoke, and with locale `""` it gives exactly the JavaScript mapping the spec
   asks for: `ΟΔΟΣ` to `οδος`, `İ` to `i̇`, `AΣ'` to `aς'`, where `ToLowerInvariant` gives `οδοσ`,
   `İ` and `aσ'` (`scratch\icu.exe`). The spec names ICU for C; .NET readers on Windows can use it
   too. The restorer does, falling back to an approximation if the DLL is missing.
5. **A dropped connection and a name NTFS refuses both arrive as `IOException`.** My first
   binary treated the failure to create `a*b.txt` as a dropped connection and retried it for two
   minutes per file (seen live on edge-linux). Separate the response read from the file create
   and write, and classify by stage, not by exception type.
6. **With `\\?\`, `File.Exists` and `Directory.Exists` answer `false` for a name holding
   `" * < > ? |` or a control character**, so the "in the way" checks pass and the failure
   surfaces only at creation, as a generic `IOException` whose message ends in CRLF.
7. **`File.Move` refuses to overwrite on .NET Framework**, so "never replace a file that was
   there" comes free, while `File.Copy` and `File.WriteAllBytes` overwrite silently. Use
   `FileMode.CreateNew` for the download and `File.Move` into place.
8. **The `TargetFramework` attribute trick works with bare `csc`**, and calling
   `AppContext.SetSwitch` for the two path switches first thing in `Main` works as well. Reserved
   names (`CON`, `aux.txt`, `nul.txt`), trailing dots and spaces, and a path well past 260
   characters all restored (`edge-windows`). Worth saying the attribute must be on the entry
   assembly.
9. **Console output.** `Console.OutputEncoding` must be set to UTF-8 (without a preamble) or
   names like `日本語.txt` print as `?` under the console's OEM code page. Not measured here,
   since I set it from the start.
10. **A Windows counterpart to the Linux `O_TMPFILE` hint exists but is harder:** a file opened
    with `FILE_FLAG_DELETE_ON_CLOSE` can be kept by clearing the disposition through
    `SetFileInformationByHandle` and renamed by handle, so a crash leaves no temp file in the
    output. Untested; I used a `.tmp` beside the destination and delete it on failure.

## Environment notes, not the format

- **Signing.** AWS SigV4 for S3, written from memory: canonical request over the URI-encoded
  path and sorted query, signed headers `host;x-amz-content-sha256;x-amz-date;x-amz-security-token`,
  empty-payload hash, HMAC chain through date, region, `s3`, `aws4_request`. The first signed
  `ListObjectsV2` returned `200`. I did not need the `aws` CLI and never ran it; the sandbox's
  classifier refused even `Get-Command aws`.
- **Transport.** `HttpWebRequest` to `https://<bucket>.s3.us-east-1.amazonaws.com`, TLS 1.2/1.3,
  `AutomaticDecompression` off, `AllowAutoRedirect` off, 30-second timeouts. The `Authorization`
  and `x-amz-*` headers go through `Headers[]`; `Date` is a restricted header, which is why
  `x-amz-date` is used. No proxy was configured (`DefaultWebProxy` returned the request URL
  itself; `HTTP_PROXY`/`HTTPS_PROXY` empty). A guard checks that `System.Uri` sends exactly the
  path and query that were signed.
- **Listing.** `list-type=2`, `delimiter=/` to see only keys directly under `snapshots/<set>/`,
  `encoding-type=url` so a key with an XML-hostile character can't break the parser. The
  scratch tool's listing of `objects/` (3824 keys, four pages) exercised continuation tokens and
  their signing; the restorer itself never needed a second page.
- **Toolchain.** `csc.exe` 4.0.30319 is a C# 5 compiler (no string interpolation, no `?.`, no
  `nameof`); .NET Framework 4.8.1 (release 533509). The scratch tools are built from the same
  source with `/main:`.
- **Sandbox.** PowerShell commands holding script blocks, `$()`, expandable strings, `$env:` as
  an argument, property lists for `Select-Object`/`Format-Table`, `Stop-Process`, or environment
  enumeration are refused, so the test drivers are `.ps1` files and C# programs, and the long
  run went in a background job.
- **Bucket.** 24 sets (`bulk`, `corrupt`, `docs`, `edge`, `faults`, `hollow`, `media`, `spread`,
  each for linux, macos and windows), 36 snapshots, deletion records 1, 3, 4, 6, 7 and 9, a
  `.s3cab/` folder (ignored), 3824 objects up to 40 MB. Sequential GETs ran at roughly 1100
  files in one to two minutes. Credentials expired at 09:52Z; all work finished well before.
- **The bucket is read-only to me**, so no record or snapshot could be planted; whole-file and
  record edge cases were tested on disk, and destination rules through `--snapshot-file`, a
  testing option that reads the snapshot from disk while every object still comes from the
  bucket with a signed request.

## Test record

All results below come from the final binary built from `s3cab-restore.cs`. Logs are in
`restore-out\logs\`, outputs under `restore-out\latest\<set>\` (default command line, latest
snapshot) and `restore-out\named\<set>\<snapshot>\` (snapshot named on the command line).
"verify" is `scratch\verify.exe`, which decompresses the saved snapshot with .NET's own
`GZipStream`, places rows with its own naive matcher, hashes every restored file and compares
its mtime to the millisecond, and lists files in the output that no row explains.

| Snapshot | rows | restored | skipped | deleted | damaged | refused | collided | failed | exit | verify |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| bulk-linux 0058, bulk-macos 0103, bulk-windows 0100 | 1100 | 1100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1100 ok, no extras |
| docs-linux 0058, docs-macos 0103, docs-windows 0100 | 120 | 120 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 120 ok |
| media-* (40 MB and 512 KB) | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 ok |
| spread-* (two DIRs, excluded folders) | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 ok |
| hollow-* (no file rows) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | no output folder made |
| corrupt-* (`b-corrupt.txt` wrong bytes at its key) | 3 | 2 | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 2 ok, 1 absent |
| edge-windows 0100 and 0103 | 29 | 28 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 28 ok; `case.txt` reads `Case.txt` (NTFS twin) |
| edge-linux 0058 and 0100 | 59 | 47 | 0 | 0 | 0 | 3 | 1 | 8 | 1 | 47 ok, 11 absent, 1 twin |
| edge-macos 0103 and 0105 | 54 | 43 | 0 | 0 | 0 | 3 | 0 | 8 | 1 | 43 ok, 11 absent |
| faults-* latest (windows 0102, linux 0059, macos 0104) | 3 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | 1 | 1 ok, 2 absent |
| faults-windows 0100 | 7 | 1 | 0 | 1 | 1 | 4 | 0 | 0 | 1 | 1 ok |
| faults-linux 0057, faults-macos 0102 | 8 | 1 | 0 | 1 | 1 | 5 | 0 | 0 | 1 | 1 ok |
| faults-windows 0059, 0101; faults-linux 0056, 0058; faults-macos 0101, 0103 | — | 0 | | | | | | | 1 | refused whole: no `.`; no output folder |

What the non-trivial rows are:

- **edge-linux / edge-macos.** Refused before writing: `a:b.txt`, `a\b/c.txt`, `back\slash.txt`.
  Failed at creation and reported: `a"b.txt`, `a*b.txt`, `a<b.txt`, `a>b.txt`, `a?b.txt`,
  `a|b.txt`, and two names holding a form feed and a vertical tab. Restored: leading and
  trailing spaces, `CON`, `aux.txt`, `nul.txt`, the twelve-level `aaaa…` path, `café.txt` in NFC and
  NFD as two files, hard-link twins as two files, `mtime-1969.txt` at 1969-12-30T23:59:59.750Z,
  `mtime-2300.txt`, `🎉 emoji 🎉.txt`. On edge-linux the case twins `case/Case.txt` and
  `case/case.txt` give one collision, exit 1.
- **faults-* 0100/0057/0102.** `deleted.txt` is skipped with its record's date and author
  (`objects.deleted-6.tsv` on windows, `-3` on linux, `-9` on macos); `torn.txt` is missing with
  no record and reported as damage; `faultsX\beside.txt` is under no DIR; `twice.txt` appears in
  two rows and both are refused; `..\..\escaped.txt` is refused for its `..`; on linux and macos
  `FAULTS/case.txt` is refused because POSIX DIR matching is exact.
- **faults-windows 0059** ends with an `@S3CAB VERSION` row and no `.`; the other five cut-short
  files end after their file rows, the "valid-looking prefix" the spec warns about. All six are
  refused whole with nothing written.

Destination rules, driven with hand-written snapshots over real objects (`scratch\live\`,
outputs under `restore-out\tests\`):

| Case | Result |
| --- | --- |
| `C:\P\a` then `C:/P/a/b.txt` | `P\a` restored; `b.txt` in the way ("a file is where the folder should be"); exit 1 |
| same snapshot run twice | second run: 3 skipped, 0 requests, exit 0 |
| folder pre-placed at `P\x.txt`, file at `P\sub` | both in the way, third file restored, exit 1 |
| junction pre-placed at `P\sub` to another folder | `sub\y.txt` refused as "a link this restore didn't make"; target folder untouched; exit 1 |
| DIRs `C:\`, `\\nas\photos\`, `D:\Q\`, `D:\Q\R\` | `C\Users\me\a.txt`, `photos\2024\b.txt`, `Q\c.txt`, `R\d.txt` beside `Q` |
| DIR `/` alone | `etc\hosts` and `top.txt` straight in the output |
| DIR `/` beside `/home/me/` | whole restore refused, nothing written |
| DIRs `C:\a\Photos\` and `D:\b\photos\` | whole restore refused, nothing written |
| times 1600, 1601-01-01T00:00:00.000Z, 0000 | written, time left, reported, exit 1; 1601 + 1 ms, 1969, 9999 kept exactly |
| `objects/000…0` | records read (6 files, 6 hashes), reported as damage |
| `Twin.txt` then `twin.txt`; `Sub\a.txt` and `sub\b.txt` | file twin: collision, exit 1; folder twins: both files land in one folder |
| snapshot `2026-01-01T0000` named but absent; `not-a-name`; set `Docs-Windows` | "no such snapshot", exit 1; usage errors, exit 2; nothing written |

Parser cases on disk (`scratch\cases\`, run through `scratch\plan.exe`, the restorer's own
reader, output kept in `scratch\parser-cases.log`): 72 files covering BOM, CRLF, missing or
padded `.`, rows after `.`, blank lines,
unknown types and properties, `@set dir` in lower case, DIRs that are relative, doubled,
repeated, `..`, drive roots, shares, `\\?\`, POSIX, every malformed hash, size and time
variety, the full trim set, Final_Sigma and `İ`, and gzip framing: two members as one text,
trailing garbage, zero padding, truncation at three depths, bad CRC, bad length, bad body,
optional header fields, a reserved flag, and 5000-row files with dynamic and stored blocks.
All behaved as the spec describes.

## Not tested

- A 403 or a 5xx from the bucket during a restore, and a dropped connection: the retry and stop
  paths are written to the spec but never fired.
- A snapshot in a folder below `snapshots/<set>/`, and a set with more than 1000 snapshots.
- Restoring onto exFAT or FAT, or a case-sensitive NTFS directory.
- The ICU fallback path (ICU was present).

## Differences from the reference

`reference/` holds the tool's own restore of each of the 36 snapshots. I compared each with my
restorer's output for the same snapshot using `scratch\compare.exe` (source beside it), which
walks both trees through `\\?\` paths, matches relative paths exactly and case-sensitively,
hashes every file with SHA-256, compares the modification time in 100-nanosecond ticks (a
difference under one millisecond is reported separately as drift), and reports directories and
files present on only one side, hidden/system/read-only attribute differences, and, for
information, access-time differences. A refused snapshot, for which my restorer makes no
directory, is compared as an empty tree against the empty reference directory. The logs are
`restore-out\logs\compare-<set>-<snapshot>.log`.

**No differences were found.** Across the 36 snapshots, 4,069 entries (files and folders)
matched on both sides, with no entry on one side only, no byte difference, no modification-time
difference, no sub-millisecond drift, no attribute difference, and no access-time difference.
The cases that could have gone either way all agree with the tool:

| Case | What both trees hold |
| --- | --- |
| six cut-short snapshots, three empty sets | nothing: the reference directory is empty and my restorer makes none |
| corrupt object | `a-intact.txt` and `c-intact.txt` only; `b-corrupt.txt` withheld |
| deleted object, missing object | `recoverable.txt` only |
| rows outside the DIR, duplicated, `..`, other-case POSIX path | none of them |
| NTFS case twins (`case/Case.txt`, `case/case.txt`) | one file named `Case.txt` holding the first row's bytes |
| NFC and NFD `café.txt` | two files |
| names with `\` or `:`, and `" * < > ? \|`, form feed, vertical tab | none of them |
| reserved names, leading and trailing spaces, `notes.`, the path past 260 characters | all present, spelled exactly |
| 1969, 1970, 2017, 2038, 2300 modification times | identical to the tick |
| folder names | the DIR row's spelling (`edge`, `faults`, `alpha`, `beta`, `docs`, `bulk`, `media`, `corrupt`) |

So nothing in this phase was traced to a bug in the restorer or to a gap in the spec, and the
restorer was not changed: `s3cab-restore.exe` is the build of 04:33 from the final source of
04:28, the same binary the test record above was made with. What the comparison does not cover:
creation times, which record the restore itself, alternate data streams, and the reporting and
exit codes of the tool, which the references don't carry. The findings in *Would corrupt a
restore* stand as reasoned: neither the stale-record case nor a DIR name holding `\` occurs in
the bucket, so the references can neither confirm nor refute them.
