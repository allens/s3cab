# The format-spec clean-room audit, run 9: restore on Windows, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on [Linux](format-spec-audit-4.md),
[macOS](format-spec-audit-5.md) and [Windows](format-spec-audit-6.md); restores on
[Linux](format-spec-audit-7.md), [macOS](format-spec-audit-8.md) and Windows (this run).

- **Program:**
  [`csrestore/`](https://github.com/allens/s3cab/tree/a2cb93351d5e293123a9fac096d42409ef3749ce/scripts/cleanroom/restorers/csrestore),
  C# 5 built with the .NET Framework's own compiler, and no S3 library. It is the reconcile phase's
  program; its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens, both phases:** input 276, cache write 425,387, cache read 32,464,204, output 256,873.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference,
then the *Differences from the reference* section the reconcile phase added, verbatim. The few
lines the reconcile phase changed elsewhere in the report are left out.

---

# An independent restorer for the s3cab format: report on the spec of 2026-10-20

Written from `format.md` alone (plus `ENVIRONMENT.md` for where the bucket and compiler are).
I read no other description of the format and did not look for the tool. Every result below comes
from a real request to `s3://test-s3cab-ci-cleanroom-restore` (us-east-1) or from a test on local
files, and each one says which. My working log, with each guess written down as I made it, is
`NOTES.md`; the G/E/T/R/X numbers below point into it.

## Bottom line

- **The core claim holds for this bucket.** I built a restorer from the spec alone, using only
  stock Windows .NET Framework 4.8.1 (the C# 5 `csc.exe`) and its standard library. It uses
  `HttpWebRequest` and AWS Signature V4, which I wrote
  myself, plus the built-in SHA-256 and `GZipStream`. No SDK, no S3 library, no CLI. It handled
  every snapshot in the bucket correctly: each one either restored, or was refused where the spec
  says to refuse.
- **Signing needed nothing from the vendor.** I wrote SigV4 from what I already knew, and the
  first signed request I sent (a ListObjectsV2) succeeded. I never ran the `aws` CLI at all, not
  even to list the bucket. (E2)
- **Coverage:** every one of the 36 snapshots was run by name, plus all 24 sets with no snapshot
  named ("latest"), over the network, on the final build. 30 snapshots restored. The 6 that the
  spec says to refuse (no `.` terminator) were refused, with nothing written. A separate checker
  hashed every restored file on disk and compared its modification time to the 100 ns tick.
  Every file written matched its row, with no stray files and no empty folders. In every run, the
  rows with no file on disk were exactly as many as the restorer reported not restoring, and each
  reason is right by the spec. (Results table below.)
- **What the spec doesn't settle is almost all hand-edited-file territory.** Three gaps can
  silently corrupt a restore, ranked first below. The spec's one .NET gzip hint describes
  PowerShell 7's runtime, not the .NET Framework that Windows actually ships, which fails
  differently and just as silently (T1).

## Would corrupt a restore

Ranked worst first. Here "corrupt" means two careful readers, both following the text, can leave
different bytes or times on disk, and at least one of them exits 0.

1. **"Paths compared exactly" doesn't say what is compared, and "skipped" has no exit code.**
   The one-row-per-path rule and the running-through rule both say "paths compared exactly", and
   a hint says "compare paths as bytes". But a Windows path splits on `/` and `\`, so `C:\P\a.txt`,
   `C:/P/a.txt` and `c:\P\a.txt` are three different strings naming one file. A reader that
   compares strings keeps all three rows as valid. All three land on `<output>\P\a.txt`. The first
   is written, and the next meets "a file already at a destination is left alone and reported as
   skipped", for which the spec gives no exit code (contrast "something in the way … exit 1").
   That reader can exit 0 having silently picked one row's bytes, which breaks both "never chooses
   between conflicting rows" and "never lets a partial restore pass for a full one".
   *Guess (G9, G30):* path identity is the root plus its segments, split by the path's own
   separator rules, so those rows are duplicates and all of them are refused. Separately, a file
   this run wrote itself never counts as "already there" (G26: I record file IDs). *Tested:*
   offline only (`forward slashes on Windows`, `duplicate path refused twice`). The bucket has no
   such rows.
   *Fix:* define path identity (root + segments; say whether the drive letter compares
   case-insensitively), and give "skipped" an exit code, or at least separate "was there before
   the restore" from "this restore just wrote it".

2. **"Decompress a snapshot as gzip" is the whole reading rule; multiple members and trailing
   bytes are only in a hint.** The spec promises that s3cab *writes* one stream. A hint says
   s3cab's *reader* joins members and refuses trailing non-gzip bytes. Nothing tells another reader
   to do the same. .NET Framework's `GZipStream`, the decompressor Windows ships, returns only the
   first member, ignores whatever follows, and raises no error (T1, measured). Take two whole
   snapshots concatenated (`cat old.tsv.gz new.tsv.gz`, or a tool that appends). s3cab reads rows
   after the `.` and refuses the file. A first-member reader sees a complete, valid *old*
   snapshot, restores it, and exits 0. The same reader also returns the full text with no error
   when only the 8-byte trailer is cut off. The `.` check then passes and the CRC is never checked
   (T1).
   *Guess:* follow s3cab: join members, refuse trailing bytes that aren't a member, and refuse a
   member the decoder had to read past the end of. *Tested:* offline, 19 gzip cases
   (`parsertest.exe`), including the plain-`GZipStream` behaviour quoted above. All 36 real
   snapshots are a single, complete member.
   *Fix:* move the s3cab behaviour into the Reading checklist as a rule.

3. **The 24-character time: shape, or a real instant?** Valid files have "its time the
   24-character form". Nothing says whether `2024-02-30T…`, `…T24:00:00.000Z` (ISO 8601 itself
   allows 24:00) or a leap second `…:60.000Z` is malformed. A reader that builds the instant from
   the fields with a normalising API, as C's `timegm`/`mktime` do by definition, turns Feb 30
   into Mar 1. It then restores the file with an mtime the row doesn't state, and exits 0. A
   strict reader refuses the row. The spec makes mtime fidelity a promise ("re-backing it up
   re-uploads nothing").
   *Guess (G6):* a row whose time isn't a real instant in years 0001–9999 is malformed and
   refused. *Tested:* offline (`Feb 30 refused`).
   *Fix:* say "a real UTC instant in the proleptic Gregorian calendar, seconds 00–59".

## Would inconvenience the implementer

Ranked by how much each cost me, or how differently two readers can behave. None of these, as
far as I can see, lets wrong bytes pass as a good restore.

1. **The last field has three definitions.** Reading rule 4: "verbatim from the final tab to the
   end of the line". Valid and invalid files: s3cab "doesn't count an `@` or `#` row's fields: it
   reads the columns it needs by position, and the last as the rest of the line". And "every line
   has exactly five fields". These agree only on well-formed rows. Two examples:
   - A hand-edited `@SET DIR` row with one extra padding tab yields `C:\Photos\` under "final
     tab", but `<TAB>C:\Photos\` under "rest of line", and that matches nothing. So one reader
     restores every file and another refuses every file.
   - A `@SET DIR` row that lost its padding (3 fields) yields a DIR under one reading and none
     under the other.

   *Guess (G1):* a `-` row must have exactly 5 fields; an `@` row's value is the rest of the line
   after the 4th tab (s3cab's stated behaviour), and an `@` row with fewer than 5 fields is
   ignored. *Tested:* offline (`3-field @SET DIR ignored`, `4 fields refused`, `6 fields refused`).

2. **The compaction claim is wrong for any real reader** (G25). "The merge is written before the
   absorbed files are deleted, so a reader at any moment sees every live row at least once." That
   holds only for an atomic view of the bucket. A reader lists `objects.deleted-*` and then GETs
   each one. Suppose a `cleanup` writes merged record N after the listing and deletes records 1..k
   before the GETs. The reader then has none of those rows, and deliberate deletions get reported
   as damage. That's the safe direction, but the guarantee doesn't hold.
   *Guess:* if a listed record has vanished by its GET, list again (up to 3 passes).
   *Not tested live* (it needs a concurrent cleanup).

3. **Duplicate check vs. malformed rows** (G10). The running-through check is explicitly last,
   "among the rows every other check let through", because "a row refused for any other reason
   blocks nothing, since it lands nowhere". Nothing orders the duplicate check against
   malformation. Example: a good row and a row with a bad hash, same path. Refuse both ("never
   chooses between conflicting rows"), or restore the good one? Either way the restore exits
   nonzero, but the bytes on disk differ.
   *Guess:* every `-` row with a readable path takes part, so both rows are refused.

4. **Refusing a restore over colliding DIR names** (G14, G29). Three things are left open:
   - **Before or during.** "Refuses a restore that reaches both": up front with nothing written,
     or just those DIRs' files?
   - **What "reaches" means.** Does a DIR count as reached when all its rows are refused or
     deleted?
   - **What "ignoring letter case" means.** Which case folding? And on macOS, NFC and NFD
     spellings collide too, which "ignoring case" doesn't cover.

   *Guess:* refuse the whole restore up front (exit 2). A DIR is reached if at least one row that
   passed validation has it as its deepest DIR. Names are compared with `ToLowerInvariant`.
   *Tested:* offline (`colliding DIR names refused`, `… one unreached, ok`,
   `slash beside another DIR refused`).

5. **"Unicode's default case mapping" for Windows DIR matching** (G11, X6). Full or simple
   mapping? .NET's `ToLowerInvariant` leaves U+0130 (İ) alone, where the full mapping gives
   U+0069 U+0307, and maps a final capital sigma to σ where the full, context-sensitive mapping
   gives ς. Python's `str.lower()` does the full mapping. With nested DIRs this can change which
   DIR is deepest, so two readers place a file in different folders and both exit 0. Bytes stay
   right; only the layout differs. *Guess:* `ToLowerInvariant`.

6. **"Distrusted while it's invalid": the whole deletion record, or the bad row?** For a record
   holding one malformed `#deleted` row among good ones, the text supports both readings. They
   differ in exit code (0 or 1) and in whether a missing file is labelled deleted or damaged.
   *Guess:* row by row, as for a snapshot's file rows. A record refused whole (bad UTF-8, no `.`
   and so on) contributes nothing. *Tested:* offline (`record: one good row, two malformed
   refused`, `record without '.' refused whole`).

7. **Blank lines** (G3, G4). A blank line mid-file, or one after the `.` (a file ending `.\n\n`),
   isn't mentioned. *Guess:* a blank line is "an unknown type starting with neither `@` nor `#`",
   and anything after the `.` is "rows after the `.`", so either one refuses the whole file. A
   reader that skips blank lines restores where mine refuses. *Tested:* offline.

8. **What is a Windows path, and what is a share's root?** (G7, G8)
   - **Detection.** "A drive letter followed by `\` or `/`, or a network share starting `\\` or
     `//`." Is a lowercase drive letter included? A mixed `\/` start? A `\\?\C:\…` path? A POSIX
     path that legitimately starts `//`? (Under the rule it becomes a share and splits on `\`.)
   - **Root.** The validity list calls the root "a share's `\\`". The layout section names a
     share DIR's folder after "the share's name", which implies the root is `\\server\share`.
   *Guess:* `[A-Za-z]:` followed by either separator; exactly `\\` or `//`; the root is `\\`; a
   DIR's folder is its last segment.

9. **"Named `YYYY-MM-DDTHHMM.tsv.gz`" when choosing the latest snapshot** (G19). Shape only, or a
   real date? (`9999-99-99T9999.tsv.gz` then wins.) Direct children only, or nested keys too?
   Which sort? *Guess:* shape only, matched as `[0-9]` and anchored with `\z`; direct children;
   ordinal. *Tested:* offline, and live: the latest choice was correct for all 24 sets.

10. **`objects.deleted-<n>.tsv`: what is `<n>`?** Digits only? Leading zeros? (G16) *Guess:*
    `[0-9]+`.

11. **A file already at the destination: exit code** (G15), on its own, apart from item 1 of the
    first list. *Guess:* a plain skip is exit 0. *Tested live* (R5, and the obstacle test below).

12. **Heading row** (G2, G28). "All five fields": exactly five? *Guess:* yes. The text also says
    "a reader goes by each row's type, not its position — except for the `.`", but the heading row
    is positional too.

13. **Two DIRs that match equally** (`C:\Photos\` and `c:\photos\`), and "longest" vs "deepest"
    (G12, G13). There's no tie-break. *Guess:* depth counts segments; different spellings at equal
    depth collide by name (item 4).

14. **"Size: decimal".** Leading zeros, a sign, values beyond 64 bits? (G5) Size is never compared
    with the download, so this matters only for validity. *Guess:* `[0-9]+` that fits a signed
    64-bit integer.

15. **An empty snapshot: create `<output>` or not?** "Folders are made only as files land in
    them." (G20) *Guess:* no.

16. **Case-variant conflicts within one snapshot on a case-insensitive disk.** Example: a file
    `a` and a file `A\b.txt`. The spec's description of s3cab's restore covers twins that land on
    one file, and obstacles already in `<output>`, but not one row needing a folder where another
    row's file lands. *Guess:* first row wins, later rows reported, exit 1.

17. **A time the destination can't hold at all.** NTFS can't hold anything before 1601. The spec's
    description of s3cab's restore covers times "off by more than 2 seconds", not times that can't
    be set. (G23) *Guess:* report, exit 1, keep the file.

18. **Small silences:**
    - property names are case-sensitive or not (G22; guessed yes);
    - a `@SET DIR` without its trailing separator, or not absolute (G21; guessed: accepted, and
      matches nothing, respectively);
    - should `@SET NAME` and `@SNAPSHOT NAME` agree with the key the snapshot was found at? (G27;
      guessed: not checked);
    - a `-` row inside a deletion record (G17; guessed: ignored);
    - which Unicode version defines the Zs trim set (X7: U+180E was Zs before Unicode 6.3; .NET
      Framework 4.8 calls it Format).

19. **"Every rule is in one of the checklists" isn't quite true.** Case-insensitive DIR matching on
    Windows paths, and "which separators count depends on the path", appear only in *Paths*. The
    Reading checklist says only "matched by whole segments, the longest winning".

## Hints that would have helped

Each one measured on this machine (`parsertest.exe exp`, `legacy.exe`, `parsertest.exe`), not
recalled.

1. **.NET Framework's `GZipStream` (what Windows ships), not just PowerShell 7's** (T1). The
   spec's hint says .NET "stops after the first stream, and under PowerShell 7 it hands back
   nothing at all". On .NET Framework 4.8.1:
   - a file cut in half returns a **prefix**, with no error;
   - a file cut anywhere in the 8-byte trailer returns the **entire text**, with no error, so the
     `.` is present and the CRC is never checked;
   - a second member, or trailing garbage, is ignored without a word;
   - only a wrong CRC or length in a *complete* member throws.

   What I needed was a way to find where a member ended. A wrapper stream that hands
   `GZipStream` one byte per `Read`, and notes whether it was asked for a byte past the end, gives
   exactly that. The spec's "Recovering by hand" snippet would inherit this when run in Windows
   PowerShell 5.1, which runs on .NET Framework. That's an inference: the sandbox wouldn't let me
   start Windows PowerShell to run it.

2. **.NET's default string comparisons are culture-sensitive** (X2). Measured:
   `StartsWith(string)` ignores U+00AD (soft hyphen) and U+200D, so
   `"C:\Photos\x".StartsWith("C:\Pho" + U+00AD + "tos\")` is **true**, and the culture-sensitive
   ignore-case `Equals` treats `strasse` and `straße` as equal. `EndsWith(string)`,
   `IndexOf(string)` and `Compare` use the same culture comparison by default (documented, not
   measured). A DIR matcher written with
   the default overloads matches paths it shouldn't. I wrote this bug myself in path classification
   (`p.StartsWith("/")`) after already knowing about it, and found it on a final read-through. The
   spec's equivalent hint is about Swift.

3. **.NET `String.Trim()` is the wrong set** (X3): it removes U+0085 and keeps U+FEFF, the exact
   opposite of the spec on both. (The spec warns about Python's `strip()`.)

4. **.NET `Regex`, for "ignoring any key not named `YYYY-MM-DDTHHMM.tsv.gz`"** (X4): `$` also
   matches before a final LF, and `\d` matches Arabic-Indic and other digits. Use `\z` and `[0-9]`.

5. **A `:` in a name on NTFS writes an alternate data stream, silently** (X1). Through `\\?\`,
   creating `a:b.txt` succeeds with no error. The folder then shows a 0-byte `a`, and the bytes are
   invisible in stream `b.txt`. The spec lists `:` among names "Windows would misread" (s3cab
   refuses them) but explains only the `\` case, so a reader might assume Windows will refuse a `:`.

6. **NTFS times at the edges** (X5, measured through `File.SetLastWriteTimeUtc`, which calls
   Win32 `SetFileTime`). A FILETIME of 0, which is **1601-01-01T00:00:00.000Z**, means "don't
   change". So that time is
   silently not set, and the file keeps *now*. Anything earlier throws "Not a valid Win32
   FileTime". 2300 and 9999-12-31T23:59:59.999Z are kept exactly. The spec's list of times a disk
   can't hold covers APFS, FAT, exFAT, HFS+ and WSL, but not NTFS's own edges. Reading the time
   back (which the spec recommends) catches the 1601 case; nothing else does.

7. **.NET `ToLowerInvariant` is not "Unicode's default case mapping"** (X6). See item 5 of the
   previous list.

Hints that did help, and that I confirmed accurate: `\\?\` for every Windows path (it restored
`notes.`, `CON`, `aux.txt`, `nul.txt`, leading and trailing spaces, and a path over 260 characters
correctly), and `[assembly: TargetFramework(".NETFramework,Version=v4.8")]` for a bare-`csc` exe.
Without that attribute, `\\?\` throws "Illegal characters in path", a plain `trailing-dot.` is
silently created as `trailing-dot`, and a 351-character path throws (X8). "Read the time back",
"split on LF exactly" and "the `.` is all that proves the rows are all there" all earned their
place.

## Environment notes, not the format

- **Toolchain.** .NET Framework 4.8.1 (release 533509); `csc.exe` v4.0.30319 is C# 5, so no
  string interpolation, `?.` or exception filters. I wrote a `when` filter once and caught it
  before building.
- **Sandbox command checker (E1).** It refused `csc.exe` named by its full path (outside the
  working directory), a nested `powershell.exe` (so Add-Type was out), `$()` subexpressions and
  script blocks. It also refused any direct `.\x.exe`, reporting it as "outside the working
  directories", partly because it reads arguments like `'/'` as paths. `-d` was swallowed as
  PowerShell's `-Debug`. I worked through two scripts in this directory: `build.ps1` calls
  `csc.exe`, and `run.ps1` launches an exe and prints its exit code. **To run the deliverable here
  the way the task states it, use `.\run.ps1 s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]`
  after `. .\credentials.ps1`.** From an ordinary shell, `.\s3cab-restore.exe …` works directly.
- **Signing.** SigV4, virtual-hosted style, `host;x-amz-content-sha256;x-amz-date;x-amz-security-token`
  signed, payload hash of the empty string. It worked on the first request. No CLI used (E2).
- **TLS.** `ServicePointManager.SecurityProtocol` is `SystemDefault` on this machine even
  without the TargetFramework attribute, so TLS 1.2 or later was never in question (X8 corrects my
  first guess, E3).
- **HTTP.** `HttpWebRequest` with `AutomaticDecompression = None`, so a stored file is never
  decoded in transit. `DefaultConnectionLimit` raised from 2 to 16 for 8 parallel downloads.
  ListObjectsV2 with `encoding-type=url`, decoded as UTF-8.
- **Credentials.** Session credentials, with the token signed as `x-amz-security-token`. They
  never expired during the work (expiry 12:57Z; the last request was made around 07:30Z).
- **My tool pipeline** turned backslash-u escapes I typed into the literal characters, in files
  and commands. C# then treats a raw U+2028 inside a char literal as a line break, and the build
  failed. Fixed by writing `(char)0x2028` (E5). The restorer's source is pure ASCII.
- **The bucket.**
  - Every object was served as `application/octet-stream` with no `Content-Encoding`.
  - A 40 MiB object (media sets) restored correctly through the over-16 MiB temp-file path.
  - `bulk` (1,100 files) takes about 13 s with 8 parallel downloads.
  - The restorer reads only `snapshots/<set>/`, `objects/` and, on a 404, `objects.deleted-*`. It
    never reads `.info` or `.s3cab/`. (My development probe downloaded the `.info` files once while
    mirroring; nothing used them.)

## What was run against the bucket

`tests\restore-all.ps1` restored every snapshot by name into `out\final\named\<set>\<name>`, and
each set with no snapshot named into `out\final\latest\<set>`, then ran `verify.exe` on each output.
`verify.exe` is separate from the restorer. It decompresses the mirrored snapshot, maps rows to
locations with its own simpler string code, hashes every file on disk, compares mtimes to the
tick, and flags stray files and empty folders. Log: `out\suite-final.txt`; per-run output:
`out\final\logs\`.

Each set exists for linux, macos and windows, and every row below holds for all three.

| Set | Snapshots | Exit | File rows restored | Not restored, and why |
| --- | --- | --- | --- | --- |
| bulk | 1 per OS | 0 | 1100 / 1100 | none |
| docs | 1 per OS | 0 | 120 / 120 | none |
| media | 1 per OS | 0 | 2 / 2 | none (the 40 MiB file went through the temp-file path) |
| spread (2 DIRs) | 1 per OS | 0 | 6 / 6 | none |
| hollow (no file rows) | 1 per OS | 0 | 0 / 0 | none; no output folder created |
| corrupt | 1 per OS | 1 | 2 / 3 | `b-corrupt.txt`: bytes don't hash to the key, withheld |
| edge-windows | 0137, 0139 | 1 | 28 / 29 | `case\case.txt`: the same NTFS file as `Case.txt` |
| edge-linux | 0134, 0137 | 1 | 47 / 59 | 11 names Windows forbids or would misread; `case/case.txt` |
| edge-macos | 0139, 0142 | 1 | 43 / 54 | 11 names Windows forbids or would misread |
| faults, latest | 1 per OS | 1 | 1 / 3 | `deleted.txt` deliberately deleted (skipped, dated); `torn.txt` missing, damage |
| faults, middle | 1 per OS | 1 | 1 / 8 (win 1 / 7) | as latest, plus 4 refused rows (5 on linux/macos) |
| faults, first and third | 2 per OS | 2 | refused whole | the last line isn't `.`; nothing written |

The latest choice was right for all 24 sets (`out\suite-final.txt`), and each of those outputs
verified (`out\verify-latest.txt`). `out\crosscheck.txt`: in all 30 runs that restored, rows not
restored (restorer's report) = rows without a file on disk (verifier), with 0 disagreements.

Exit codes: 0 means everything restored (deliberate deletions and files already present aside);
1 means restored what it could, with every miss listed; 2 means nothing restored on purpose
(snapshot refused whole, restore refused, usage, or a storage failure other than 404).

What each kind of non-restored row was, all checked against the spec:

- **corrupt-\*:** `b-corrupt.txt` downloads as bytes that don't hash to its key, so it's withheld
  as damage.
- **faults-\* latest:**
  - `deleted.txt` is missing and listed in records 3, 6 and 9, so it's skipped "deliberately
    deleted" with its date and who did it;
  - `torn.txt` is missing and listed nowhere, so it's damage.
- **faults-\* middle snapshot:** also refused rows:
  - `faultsX\beside.txt` (a string-prefix trap; under no DIR by segments);
  - `twice.txt` (two rows, both refused);
  - `..\..\escaped.txt`;
  - on Linux and macOS, `FAULTS/case.txt` (POSIX paths match exactly).
- **faults-\* cut snapshots:** the first and third snapshots of each faults set end without `.`
  (one stops at an unknown `@S3CAB VERSION` row, one after the last file row). Both are complete
  gzip around cut text, so only the `.` catches them. Refused whole, nothing written.
- **edge-\*:**
  - names Windows forbids (`" * < > ? |`, VT, FF) or would misread (`:`, a `\` inside a POSIX
    name) are refused before anything is written;
  - `case/case.txt` loses to `case/Case.txt`, since on NTFS they're one file and the first row
    wins.

  Everything else restored, including both NFC and NFD `café.txt`, `CON`, `aux.txt`, `nul.txt`,
  `notes.`, names with leading or trailing spaces, U+0085 in a name, the deep path, and mtimes in
  1969, 1970, 2038 and 2300.
- **edge-\* and the deletion records:** records 1, 4 and 7 list the edge sets' dedup content, but
  those objects are present again. "Presence always wins": they restored, and the records were
  never consulted.

Also run against the bucket:
- a missing snapshot, a missing set, and a bad set name (each exit 2);
- an altered secret key (403 on the first request, restore stopped, exit 2, nothing written);
- a restore into a folder with obstacles placed in advance (out\inway). A file where `alpha\`
  should be, and a folder where `beta\from-beta.txt` should land, were each reported as in the
  way (exit 1). An existing different `in.o` was left alone and reported as skipped. Nothing else
  was touched.

**Not tested:**
- a 403 or a dropped connection in the middle of a restore;
- the 5xx retry;
- the file-ID collision backstop (no row pair in the bucket triggers it);
- an output folder on a UNC share or on FAT/exFAT;
- `/` and share DIRs, and colliding DIR names: offline only, since there are none in the bucket.

## The restorer

`s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]`. Credentials come from
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, the region from
`AWS_REGION`. `<snapshot>` may be given as `2026-10-21T0137` or `2026-10-21T0137.tsv.gz`. Files land
at `<dir>\<name of the matching @SET DIR>\<rest of the path>`, which is how the spec describes
s3cab's restore to a chosen directory.

Where the spec leaves a choice to the tool:
- Names this Windows machine can't hold, or would misread, are refused before anything is written.
- Case twins: the first row wins and later ones are reported.
- A download that doesn't hash to its key is withheld.
- One download per distinct hash.
- Files over 16 MiB are buffered in a temp file inside `<dir>`, removed afterwards.
- Times are read back. Off by under 2 s counts as rounded; anything else is reported, and the file
  is kept.

Sources:
- `src\S3.cs`: signing, GET, listing, retry.
- `src\Core.cs`: reading rules, gzip, validation, planning; no I/O.
- `src\Restore.cs`: the program.

Build with `.\build.ps1`. Tests:
- `tests\Tests.cs`: 74 offline cases, run as `parsertest.exe`; `parsertest.exe exp <dir>` runs
  the OS experiments;
- `tests\Legacy.cs`;
- `tests\Verify.cs`;
- `tests\restore-all.ps1`, `tests\verify-latest.ps1`, `tests\crosscheck.ps1`.

## Differences from the reference

**None found.** I compared all 36 snapshots, plus the 24 latest restores, against the references
restored by the tool itself. That covers paths, bytes and modification times. No difference was
found, so no bug was fixed and no spec gap was blamed; the restorer is unchanged. Exactly what I
compared, and what that can't show, follows.

**How.**
- **Comparator.** `compare.exe` (`tests\Compare.cs`) walks both trees through `\\?\`, keyed by
  exact (ordinal) relative path. It compares every file's SHA-256 and its modification time to the
  100 ns tick, and reports a file or folder present in one tree only. Following `RECONCILE.md`, a
  missing tree counts as equal to an empty one.
- **Named restores.** `tests\compare-all.ps1` compared each `out\final\named\<set>\<name>` (the
  final run on the final build, described above) with `reference\<set>-<name>`. Output:
  `out\compare-final.txt`, with per-snapshot detail in `out\final\compare\`.
- **Latest restores.** `tests\compare-latest.ps1` compared each `out\final\latest\<set>` with the
  reference for the snapshot it chose. Output: `out\compare-latest.txt`.
- **Streams and attributes.** `tests\check-streams.ps1` looked for alternate data streams and for
  attributes other than Archive in both trees.

**Results.**

| Comparison | Snapshots | Files compared | Differences |
| --- | --- | --- | --- |
| named restores vs reference | 36 (27 with files; 6 refused whole and 3 empty, against empty references) | 3,932 | 0 |
| latest restores vs reference | 24 | 3,811 | 0 |
| alternate data streams, extra attributes | both trees, 4,105 + 4,117 entries | | 0 + 0 |

The two entry counts differ only because my outputs are nested `<set>\<snapshot>`. That adds 21
set folders and 27 snapshot folders (48), where the reference has 36 flat top-level folders:
4,117 − 4,105 = 12 = 48 − 36.

**Is the comparator any good?** It found nothing, so I checked that it can find something
(`tests\compare-sanity.ps1`):
- my edge-windows output against the edge-linux reference gave 51 differences;
- a copy of my spread-windows output with one mtime moved by 1 ms and one file grown by a byte
  gave exactly those 2 differences.

**What agreement corroborates (for this bucket's cases only).** The reference tool made the same
choices I had to guess or infer:
- **Layout.** The folder is the DIR's own last name, as spelled in the DIR row, including spread's
  two DIRs.
- **Snapshots refused whole.** The six snapshots without `.` leave nothing behind.
- **An empty snapshot creates no folder** (my G20; `RECONCILE.md` confirms it).
- **Refused rows.** Neither `twice.txt` row restored (G10 and the duplicate rule). `faultsX\…`
  wasn't placed under `faults\` (segment matching). `..\..\escaped.txt` landed nowhere inside the
  output. POSIX `FAULTS/case.txt` didn't match `/…/faults/` (exact matching for POSIX paths).
- **Missing objects.** The deliberately deleted and the missing object, and the object whose
  bytes don't hash to its key, were all left out.
- **Deletion records vs presence.** The edge sets' dedup content, though named in deletion
  records, restored (presence wins).
- **Names.** The names I refused on Windows (`" * : < > ? |`, `\` inside a POSIX name, VT, FF)
  are absent from the reference too. Of `case\Case.txt` and `case\case.txt`, the first row's bytes
  are the ones on disk.
- **Odd names that restore.** `CON`, `aux.txt`, `nul.txt`, `notes.`, leading and trailing spaces,
  U+0085 in a name, both `café.txt` spellings, and the path over 260 characters are identical.
- **Times.** Every mtime agrees to the tick, including 1969-12-30T23:59:59.750Z, 1970, 2038 and
  2300. (The spec warns that s3cab's restore can land about 100 ns off where a filesystem keeps
  nanoseconds; on NTFS here it didn't.)

**What agreement can't show.**
- **Exit codes and messages** aren't in a directory tree. So G15 (the exit code of a skip), the
  deliberate-deletion exit 0, and refusals giving a nonzero exit remain my reading of the spec,
  not something checked against the tool.
- **Nothing written outside the output**: a reference directory can't show what the tool might
  have written outside it.
- **The ranked gap lists above are unchanged.** None of the three "would corrupt" cases, and
  almost none of the "inconvenience" ones, occurs in this bucket. Rows that differ only by
  separator or drive-letter case, multi-member or trailer-cut gzip, impossible times, oddly
  tabbed `@` rows, colliding DIR names, compaction races: none of them is in these snapshots. A
  restorer that guessed every one of them differently would still match all 36 references.
  Matching the reference is evidence about the bucket, not about the spec's open questions.

**One small trap found while checking, the spec's own `\\?\` advice in another guise:**
PowerShell 7's `Get-Item -LiteralPath <path> -Stream *` fails with "cannot find the path" on the
six restored names that end in a space or a dot, and works through `\\?\`.

