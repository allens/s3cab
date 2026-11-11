# The format-spec clean-room audit, run 27: restore on Windows, Fable 5.1 at xhigh (2026-11-10)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on
[Linux](format-spec-audit-22.md), [macOS](format-spec-audit-23.md) and
[Windows](format-spec-audit-24.md); restores on [Linux](format-spec-audit-25.md),
[macOS](format-spec-audit-26.md) and Windows (this run).

- **Program:** [`csrestore/`](../scripts/cleanroom/restorers/csrestore/), C# 5 built with the
  `csc.exe` that ships with .NET Framework 4.8, and no S3 library. It is the reconcile phase's
  program, which changed the first phase's; its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens, both phases:** input 1,478, cache write 387,580, cache read 10,797,816, output 200,046.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# Clean-room restorer for the s3cab format: report

Date: 2026-11-10. Spec read: `format.md` dated 2026-10-30. Nothing else about the format was consulted.

## Summary

- `s3cab-restore.exe` is one C# 5 source file (`s3cab-restore.cs`) built with the stock
  `csc.exe` of .NET Framework 4.8. It uses only the framework's standard library plus two Windows
  system DLLs through P/Invoke (`kernel32.dll` for file identity and attributes without following
  links, `icu.dll` for Unicode lowercasing). No AWS SDK, no S3 library, no external process.
- It talks to S3 over plain HTTPS with `HttpWebRequest` and signs every request itself with
  Signature Version 4. I signed from what I already knew: the first signed listing and the first
  signed GET both succeeded, and I never needed the `aws` CLI's debug output. The CLI was used only
  as a development aid: to confirm the bucket was reachable, to survey the layout, and to pull the
  snapshots and deletion records to disk for offline parser tests and for `--verify`.
- Every snapshot in the bucket was restored over the network: 36 snapshots across 24 sets, about
  4,000 signed requests in all. 30 snapshots restored; 6 were refused whole because they are cut
  short and lack the `.`, which is what the spec requires. Every restored tree was checked against
  its snapshot by SHA-256 and millisecond mtime, and for extra files; the only mismatches are the
  case-twin collisions the spec predicts on NTFS.
- The format held up. I found no rule whose misreading would have silently corrupted a restore of
  this bucket. The gaps below are real, but each is either a wording wrinkle another sentence
  resolves, or a silence whose wrong resolution changes only reporting or the exit status.

## Would corrupt a restore

Ranked by how much a wrong guess would change what a user gets. None of these changes bytes or
names; the worst changes the completeness verdict, that is the exit status.

1. **Precedence when a destination already exists and the row's hash was earlier found missing or
   withheld.** The Reading checklist says s3cab "checks the destination first, and fetches nothing
   for a row it skips", and separately that a row naming a hash already found missing or withheld
   "is reported as that" whether before or after a row lands. The second sentence is written for
   the collision case, so I guessed: a file that was there before the restore is skipped with exit
   0 whatever its hash's fate; only a destination this restore wrote falls through to the bad-hash
   report. Under the other reading the same row exits 1. Audited: a second restore of
   `spread-windows` into its own output skipped all 6 rows with exit 0 and made 2 requests. The
   combination itself, a pre-existing file whose object is also missing, does not occur in the
   bucket, so that branch ran only in review, not against data.
2. **Whether the deletion record's `.` is matched byte for byte like the snapshot's.** The record
   section says rows count "before any `.`" and that the `.` "says the file is whole, as it does for
   a snapshot", but the byte-for-byte rule is stated only in the snapshot's last-line section. I
   guessed byte for byte, so `.` followed by CR is not the `.` and rows after it still count. That is
   consistent with the spec's own statement that a CRLF record's well-formed rows count. A reader
   that took a looser line as the `.` would stop earlier and read a deliberate deletion as damage,
   the safe side, with exit 1. Audited in the self-test: a CRLF record yields its row, a row after a
   real `.` yields nothing.
3. **Snapshot `START` versus the deletion instant when a record names a hash that is also present.**
   Not a guess in the end, since "presence always wins" settles it, but worth recording because the
   bucket tests it: records 1, 4 and 7 name the content of `dedup-a.txt`, which a later backup
   re-uploaded. A reader that consulted the records before fetching would skip a restorable file
   with exit 0. Audited: all six `edge-*` restores fetched `dedup-a.txt` and `sub/dedup-b.txt`
   successfully; `faults-*` restores consulted the records only after the 404 on `deleted.txt`.

## Would inconvenience the implementer

1. **The `@SET DIR` trailing-separator sentence contradicts itself.** "Ignore every separator it
   ends with, so `C:\foo\\` is `C:\foo\`" removes all of them in the rule and one of them in the
   example. Read literally, stripping every separator turns the DIR `/` into an empty string, which
   "isn't an absolute path" and would match nothing, refusing every row of a Linux root backup. The
   same paragraph later says a `DIR` that is `/` or `C:\` "is legal, and every path on it is under
   it", and the instruction to decide the path's kind "from the row as written" implies the root is
   fixed before stripping. I did that: kind and root first, then strip trailing separators from the
   rest. Audited in the self-test: DIR `/` holds `/a.txt`; DIR `C:\` holds `C:\a.txt`; DIR
   `C:\P\\` holds `C:\P\a.txt`; DIR `C:\P\\Q\` holds nothing; DIR `//` holds nothing.
2. **Lowercasing a Windows path for DIR matching: whole string or per segment.** The spec says
   "both are lowercased" but not whether Final_Sigma may look across a separator. It cannot matter,
   because `\` and `/` are neither cased nor case-ignorable, so a sigma before a separator is final
   either way. I lowercased per segment. The spec could say the two are equivalent. Audited in the
   self-test: DIR `C:\ΟΔΟΣ\` matches `C:\οδος\a.txt` and not `C:\οδοσ\a.txt`; `İ` matches
   `i̇`.
3. **"Blank line (empty, or only what the trim removes)": the whole line or its first field.** A
   line of four tabs is blank under the first reading and a row of five empty fields under the
   second; both readings refuse the file, one as blank and one as an unknown empty type. I took
   the whole line. Audited in the self-test.
4. **`@SET BUCKET` and `@SET ENDPOINT` for a reader.** The spec says `@SET NAME` and
   `@SNAPSHOT NAME` are for people and the key decides, but says nothing about whether a reader
   should honour `@SET ENDPOINT`, which is the only row that says which provider holds the objects.
   My restorer takes the bucket from the command line and ignores both rows. No snapshot in the
   bucket has an `ENDPOINT` row, so nothing ran against it.
5. **Access time.** The checklist says to set the modification time and that "s3cab sets its
   access time to the same instant", and the read-back rule speaks of "each time". Whether the
   access time is a rule and whether it is read back is unclear. I set both and read back only the
   modification time. Audited: `plain.txt` in `edge-windows` reads back
   `LastAccessTimeUtc = 2017-07-14T02:40:00Z`, the row's instant.
6. **`\\?\UNC\server\share\x` as a hand-edited row.** The spec works through `\\?\C:\a.txt`, a
   share with server `?`, but not the long-form UNC spelling. By the same rules it is a share whose
   server is `?`, landing under `<output>\UNC\?\UNC\...`, and `?` is a name NTFS refuses. Not run
   against data; the self-test covers only the `\\?\C:\` case, which lands at `UNC|?|C:|a.txt`.
7. **An unknown property on a known type in a real fixture.** Three truncated snapshots end with a
   row `@S3CAB VERSION ... 2026-10-30`. The spec says an unknown property is skipped; a reader that
   treated `@S3CAB` plus an unknown property as an error would refuse these files for a different
   reason than the missing `.`. Observed in `faults-windows/20261030T1731`,
   `faults-linux/20261030T1729` and `faults-macos/20261030T1736`; all three are refused whole for
   the missing `.` before the row matters.
8. **Which failures stop the restore versus cost one row.** The checklist lists 403, NoSuchBucket,
   exhausted retries and record-listing failures as stopping the whole restore. It does not say
   what a reader does with any other non-2xx, non-404 status on an object GET, such as a 400 or a
   301 from a wrong region. I stop the whole restore. Audited: a wrong bucket name stopped on the
   listing with `HTTP 404 NoSuchBucket`, a missing snapshot key stopped with `NoSuchKey`.
9. **A text NUL after the `.` versus a gzip zero byte after the member.** Both rules exist and
   point opposite ways, and they are stated in different sections. They do not conflict, because
   one is about the container and one about the text, but a reader meeting them for the first time
   has to work that out. Audited in the self-test: a NUL byte inside the text after `.` refuses the
   file; a zero byte after the gzip member ends the file cleanly.

## Hints that would have helped

1. **`icu.dll` through P/Invoke needs `CharSet = CharSet.Unicode`.** The spec's hint names
   `u_strToLower` and the empty locale, which is right, but with the default `DllImport` charset a
   `char[]` and `string` marshal as ANSI and the call returns garbage without an error. It also
   needs `CallingConvention.Cdecl`, and the locale parameter is `const char*`, so `LPStr`. This
   cost one build cycle. Once fixed, Windows Server 2025's `icu.dll` gives exactly the JavaScript
   results the spec describes: `ΟΔΟΣ.txt` to `οδοσ.txt`, `İ` to `i` plus U+0307.
2. **The DeflateStream one-byte trick works as described, with two details.** Construct the
   `DeflateStream` with `leaveOpen: true`, read until `Read` returns 0, then take the position from
   your wrapper; the next eight bytes are the trailer. Verified on all 36 snapshots and on
   two-member, zero-byte-terminated and cut-short synthetic files; the CRC-32 and ISIZE matched every
   time, so the position was exact.
3. **`HttpWebRequest` specifics.** The "Decoding by the HTTP client" hint covers `requests` and
   libcurl; for .NET, `AutomaticDecompression` defaults to `None`, so no `Accept-Encoding` is sent.
   `Authorization` goes through `Headers[...]`, `Host` is derived from the `Uri`, and the `Uri` class
   keeps `%2F` in a query, so the canonical query string is byte for byte what goes on the wire.
   Set `AllowAutoRedirect = false` so a region redirect is a reported failure rather than an
   unsigned retry.
4. **Floor division in C#.** The "Times in C" hint about `/` truncating toward zero applies to C#
   too. Converting the 1969 rows from `DateTime` ticks back to milliseconds needs floor division or
   `1969-12-30T23:59:59.750Z` reads back one millisecond off.
5. **`certutil -hashfile` fails on an empty file** with `ERROR_FILE_INVALID`, so it cannot verify
   `empty.txt` by hand. `Get-FileHash` or a small program is needed for that one.
6. **`Directory.GetFiles(@"\\?\...", "*", AllDirectories)` works in 4.8 with the TargetFramework
   attribute**, exact names included, which makes checking a restored tree for extras easy.
7. **PowerShell hides some names.** `Get-ChildItem -Name` prints `next…line.txt` with the U+0085
   invisible; spell control characters out in anything you print, as the spec says, but also in
   anything you read back by eye.
8. **Set the times after `File.Move`.** `MoveFile` keeps timestamps, so set and read back on the
   final path and there is no window where closing a write handle resets the time.
9. **The 1601 hint is exactly right and is cheap to prove.** `--timetest` showed:
   `1601-01-01T00:00:00Z` set and silently ignored, `.001Z` set and read back, `1969-12-30T23:59:59.750Z`
   exact, `1600-12-31` throws `ArgumentOutOfRangeException: Not a valid Win32 FileTime`.

## Environment notes, not the format

- **Signing.** SigV4 with the virtual-hosted endpoint `<bucket>.s3.us-east-1.amazonaws.com`,
  signed headers `host;x-amz-content-sha256;x-amz-date;x-amz-security-token`, the empty-payload
  SHA-256 for every GET, RFC 3986 encoding for key segments and query values. ListObjectsV2 with
  `list-type=2`, `prefix`, `delimiter=/` and `continuation-token`. It worked on the first attempt;
  the CLI's debug output was not needed.
- **Transport.** `HttpWebRequest`, TLS by OS default, keep-alive, 20 s connect and 30 s read
  timeouts, retries for dropped connections and 5xx as the checklist describes. No proxy variables
  were set and the machine reached S3 directly. Sequential GETs: 1,102 requests per bulk set.
- **Toolchain.** `csc.exe` 4.8.9221 (C# 5): no string interpolation, no `out var`, no null
  conditional. The default response file already references `System.Xml` and `System.Net`.
  `[assembly: TargetFramework(".NETFramework,Version=v4.8")]` was enough for `\\?\` and for the
  300-character `deep.txt` path; no `.config` file.
- **Sandbox.** The PowerShell tool here refuses many constructs: environment variables as
  arguments, `$LASTEXITCODE`, script blocks and loops, expandable strings, .NET member calls,
  a bare `/` argument, nested `powershell.exe`/`cmd`, and some `Select-Object`/`Select-String`
  forms. Work-arounds: literal arguments, the program prints `exit N` itself, debug modes in the
  exe (`--parse`, `--dump`, `--verify`, `--selftest`, `--timetest`, `--lower`), and writing output
  to files under `scratch\` to search with grep.
- **Bucket.** 24 sets, 8 kinds (`bulk`, `corrupt`, `docs`, `edge`, `faults`, `hollow`, `media`,
  `spread`) times 3 writers (`linux`, `macos`, `windows`); 36 snapshots; 3,821 objects, mostly
  `GLACIER_IR`, and a plain GET reads them as the spec says it should; deletion records
  `objects.deleted-1,3,4,6,7,9.tsv` with gaps; no `locks/`; `.s3cab/sets/<set>/dirs.txt` and
  `exclude.txt`, ignored. Objects carry a lifecycle expiry of 2027-10-31. The three `faults-*`
  earlier snapshots and records 3, 6, 9 are in `STANDARD`, so they were placed after the rest.
- **Credentials.** Session credentials with the token signed; all requests finished by about
  17:05Z, well before the 22:22:34Z expiry.

## What was run

Each line is a real restore over the network with the final build or an earlier build of the same
source, followed by `--verify` against the snapshot pulled to disk. "ok" means every row that
should land is present with the right SHA-256 and millisecond mtime, and no extra file exists.

| Snapshot | Outcome | Verify |
| --- | --- | --- |
| docs-{windows,linux,macos} | 120 restored each, exit 0 | ok 120, extra 0 |
| bulk-{windows,linux,macos} | 1,100 restored each, exit 0 | ok 1100, extra 0 |
| media-{windows,linux,macos} | 2 restored, exit 0 | ok 2 |
| spread-{windows,linux,macos} | 6 restored under two DIRs, exit 0 | ok 6 |
| hollow-{windows,linux,macos} | 0 file rows, exit 0, no output folder made | ok 0, folder absent |
| corrupt-{windows,linux,macos} | 2 restored, `b-corrupt.txt` withheld (hash mismatch), exit 1 | ok 2, absent 1 |
| faults-windows 1734, faults-linux 1732, faults-macos 1739 (latest) | `deleted.txt` deliberate (record after START), `recoverable.txt` restored, `torn.txt` missing, exit 1 | ok 1, absent 2 |
| faults-windows 1732, faults-linux 1730, faults-macos 1737 | as above plus rows refused: under no DIR, path twice, `..`, and on POSIX `FAULTS/case.txt` under no DIR | ok 1, absent 2 |
| faults-windows 1731/1733, faults-linux 1729/1731, faults-macos 1736/1738 | refused whole: last line isn't `.`; nothing written, exit 1 | folder absent |
| edge-windows 1733/1735 | 28 restored, `case\case.txt` collision with `Case.txt`, exit 1 | ok 28, 1 mismatch = the collision |
| edge-linux 1730/1733 | 47 restored, 1 collision, 3 refused (`:`, `\` in a name), 8 not creatable (`"*<>?|`, FF, VT), exit 1 | ok 47 |
| edge-macos 1738/1740 | 43 restored, 3 refused, 8 not creatable, exit 1 | ok 43 |

Destination rules, run against `media-windows`: a folder at the file's name is "in the way"; a
file at a folder's name is "in the way"; a junction at a folder's name is "in the way" and nothing
was written through it; a second restore into a populated tree skips every file with exit 0.
Stop paths: unknown set, unknown snapshot, bad set name, unknown bucket all exit 2 with no output
folder.

Independent checks: `certutil` hashes of `recoverable.txt` and `case\Case.txt` equal their rows;
`Get-ChildItem -Name` shows ` both ends.txt `, ` leading.txt`, `notes.`, `trailing.txt `, `CON`,
`aux.txt`, `nul.txt`, both `café.txt` spellings; `Get-ItemPropertyValue` reads back
`mtime-rounds-up.txt` as `2017-07-14T02:40:01Z`, `mtime-1970s.txt` as `1970-01-02T00:00:00Z`,
`mtime-1969.txt` as `1969-12-30T23:59:59.750Z`, `mtime-2300.txt` as `2300-01-01T00:00:00Z`.

Self-test (`--selftest`): 120 synthetic cases, all passing, covering gzip framing (optional header
fields and header CRC, reserved flags, method, CRC-32, ISIZE, multiple members, zero byte and
garbage after a member, cut-short files), the whole-file text rules, the field rules, the
24-character instant including year 0000 and 1582, every path and DIR rule in the spec including
Final_Sigma, and the deletion-record line rules.

## The restorer

```
.\s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]
```

Credentials and region come from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` and `AWS_REGION`. With no snapshot named, the key directly under
`snapshots/<set>/` whose `YYYYMMDDTHHMM.tsv.gz` name sorts last is used. Files land as the spec
describes s3cab's own restore: `<dir>\C\Users\me\a.txt` for `C:\Users\me\a.txt`,
`<dir>\UNC\server\share\x` for a share, `<dir>\home\me\x` for a POSIX path, every path through
`\\?\`. Exit 0 when nothing but skips, deliberate deletions and sub-2-second time rounding
happened; 1 when any row was refused, missing, withheld, collided, in the way, not creatable, or
its time not kept; 2 when the whole restore stopped.

Debug modes, all local except `--lower`: `--parse <file>`, `--dump <file>`,
`--verify <snapshot> <dir>`, `--selftest`, `--timetest <path>`, `--lower <text>`.

Build:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:exe /optimize+ /out:s3cab-restore.exe s3cab-restore.cs
```

## Differences from the reference

`reference/` holds the tool's own restore of every snapshot, one directory each. I compared each
of my 36 output directories with its reference using a `--compare` mode added to the restorer
for this phase: it walks both trees through `\\?\` paths and reports every path present on one
side only, every path that is a file on one side and a folder on the other, every file whose
bytes differ, and every file whose modification time differs by a single 100-nanosecond tick. It
also reports access-time and attribute differences as information. The outputs are in
`scratch\cmp-*.txt`.

**Result: no differences.** All 36 comparisons report zero differences, zero access-time
differences and zero attribute differences:

| Pair | Files compared | Folders compared |
| --- | --- | --- |
| bulk-{windows,linux,macos} | 1,100 each | 4 or 5 |
| docs-{windows,linux,macos} | 120 each | 7 or 8 |
| edge-windows 1733, 1735 | 28 each | 19 |
| edge-linux 1730, 1733 | 47 each | 20 |
| edge-macos 1738, 1740 | 43 each | 20 |
| faults-windows 1732, 1734; faults-linux 1730, 1732; faults-macos 1737, 1739 | 1 each | 4 or 5 |
| corrupt-{windows,linux,macos} | 2 each | 4 or 5 |
| media-{windows,linux,macos} | 2 each | 4 or 5 |
| spread-{windows,linux,macos} | 6 each | 8 or 9 |
| faults-windows 1731, 1733; faults-linux 1729, 1731; faults-macos 1736, 1738 | 0: reference empty, mine absent | 0 |
| hollow-{windows,linux,macos} | 0: reference empty, mine absent | 0 |

The nine empty references are the six snapshots I refused whole for lacking the `.` and the three
sets with no file rows. RECONCILE.md says the tool creates nothing in that case and that no
directory matches an empty reference, so these agree too: the tool restored no file from any
snapshot I refused.

So the decisions that mattered all agree with the tool, each visible in the comparison:

- `case\case.txt` is absent on both sides and `Case.txt` holds the first row's bytes: the tool
  also reports the second case twin as a collision rather than overwriting or skipping.
- The names with a trailing space or dot, `CON`, `aux.txt`, `nul.txt`, the NEL name, both
  `café.txt` spellings, the emoji name and the 300-character path are identical on both sides.
- On the Linux and macOS edge sets the tool also wrote nothing for `a:b.txt`, `a\b/c.txt`,
  `back\slash.txt`, the six names with `"*<>?|`, and the form-feed and vertical-tab names.
- `deleted.txt`, `torn.txt` and `b-corrupt.txt` are absent on both sides, and the rows refused for
  the path rules in `faults-*` landed nothing on either side.
- Every modification time agrees to the tick, including `1969-12-30T23:59:59.750Z`,
  `2300-01-01T00:00:00.000Z`, `1970-01-02` and the `.750`-style fractions. Every access time
  agrees to the tick as well, so the tool sets the access time to the stored instant exactly as the
  spec says it does.
- No restored file carries a hidden, system or read-only attribute on either side, so
  `hidden.txt` and `system.txt` come back as ordinary files on both.

To show the comparator can see a difference I ran three negative checks: two unrelated trees
(`edge-windows` against `edge-linux`) report 114 differences and exit 1; the `inway` test tree,
where a folder sits at `clip.bin`'s name, reports `kind differs`; a copy of a reference tree with
one file rewritten reports `bytes differ` and `mtime differs` for that file.

Nothing in the restorer was changed to match the reference, and no bug was found by the
comparison. The only change in this phase is the added `--compare` mode; the restore path is the
code the first phase left, rebuilt from the same source. The findings in the earlier sections
therefore stand as written: the three items under *Would corrupt a restore* concern reporting and
exit status, and the reference directories cannot show exit status, so they are neither confirmed
nor contradicted by this comparison.
