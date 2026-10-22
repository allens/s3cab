# The format-spec clean-room audit, run 8: restore on macOS, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on [Linux](format-spec-audit-4.md),
[macOS](format-spec-audit-5.md) and [Windows](format-spec-audit-6.md); restores on
[Linux](format-spec-audit-7.md), macOS (this run) and [Windows](format-spec-audit-9.md).

- **Program:** [`swiftrestore/`](../scripts/cleanroom/restorers/swiftrestore/), Swift 6 with
  libcurl, and no S3 library. It is the reconcile phase's program; its notes, logs and test tools
  stay with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 3 moves flagged; the judge found none voids the run.
- **Tokens, both phases:** input 208, cache write 335,798, cache read 21,888,647, output 195,266.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference,
then the *Differences from the reference* section the reconcile phase added, verbatim. The few
lines the reconcile phase changed elsewhere in the report are left out.

---

# Clean-room test of the s3cab format spec (2026-10-20): report

I read `format.md` and `ENVIRONMENT.md` and nothing else about the format or the tool. From
those I built an independent restorer, `./s3cab-restore`, in Swift, and tested it against the
real bucket over the network. All findings below were written down as I went (the raw log is
`notes/findings-log.md`, with guess numbers G1…G33 that this report cites). Each one is checked
against something I actually ran.

## Verdict

**The "replacement in an afternoon" claim holds.** I finished reading the spec at 09:11. The
first signed request succeeded at about 09:20, the first real restores ran at 09:25, and every
snapshot in the bucket had been restored by 09:28 and independently checked by about 09:30.
Almost all of the remaining time went into the validity rules and the layout rules, and that is
where the gaps are. Reading needs nothing from the vendor: SigV4 signing, one GET and
ListObjectsV2 come to about 400 lines of Swift (`S3.swift`) on the system libcurl, CryptoKit
and zlib.

The spec is unusually careful, and several of its warnings proved true against the bucket (see
*Confirmed by the bucket*). But it still has **six places where two readers that both follow the
text can write different trees, or a wrong one, from the same file without either reporting
anything**. Those are listed first.

## What was built

- `s3cab-restore <bucket> <set> <dir> [<snapshot>]` reads the credentials and region from
  the environment, picks the latest snapshot when none is named, and lays files out as
  `<dir>/<name of the matching DIR>/<rest of path>`, the layout the spec gives for s3cab's
  restore to a chosen directory. Exit status: 0 for complete (or missing only deliberate
  deletions); 1 if it restored what it could and reported the rest; 2 if the snapshot was
  refused or the restore was refused or stopped.
- Source: `Sources/*.swift` (`S3.swift` signing and transport, `Gzip.swift`, `Format.swift`
  reading rules and validity, `Plan.swift` layout, `Restore.swift`), plus `shim/CCurl` (a
  header-only wrapper, because Swift can't call C variadics). Build it with `./build.sh`. The
  binary in this directory was built from the final source.
- Safety properties, all exercised against the bucket:
  - downloads are staged in `$TMPDIR` and SHA-256-checked before any byte reaches `<dir>`;
  - every destination component is opened with `openat(O_NOFOLLOW)`, and files are created
    `O_EXCL`;
  - mtimes are set with `futimens` and integer nanoseconds, then read back.
- Development aids built into the same binary: `--list`, `--get`, and `--parse` (offline: what a
  restore would make of a local file). Tests are in `tests/`.

## How it was tested (every result below came from real requests)

- **Exploration from the layout alone.** I found 24 sets, 36 snapshots and 6 deletion
  records (`objects.deleted-1,3,4,6,7,9`) with my own `--list`. `.s3cab/` was never listed
  into or read.
- **All 36 snapshots restored by name**, into fresh directories, by the final binary
  (`tests/restore_all.sh`). Then **each of the 24 sets with no snapshot named**, to check
  latest-selection. Results: see *Final run*.
- **Independent checker** (`tests/check_restore.py`, Python, no code shared with the
  restorer). It re-parses each snapshot, works out each file's destination, and checks the
  file's existence, SHA-256, size and mtime (exact ns). It also flags extra files and empty
  folders. I matched every discrepancy it reported against a line in the restorer's own
  report (`tests/check_all.sh`).
- **Destination rules against the bucket:**
  - re-restore over a complete tree;
  - a symlink planted where a folder goes;
  - a file where a folder goes;
  - a folder where a file goes;
  - a pre-existing file at a destination.
- **Retry:** I pointed `HTTPS_PROXY` at a dead local port. Dropped connections were retried
  12 times over 132 s, then the restore stopped with exit 2.
- **Offline parser cases** (`tests/parser_cases.py`): 89 crafted files covering every
  reading rule and every guess below, all passing against the final binary. Several rules
  could only be tested this way because the bucket doesn't exercise them (see *Not tested*).

### Final run (the final binary, `tests/restore_all.sh` then `tests/check_all.sh`)

- **Exit status by snapshot.**
  - 17 snapshots exit **0**: bulk ×3, docs ×3, edge-macos ×2, hollow ×3, media ×3, spread ×3.
  - 13 exit **1**: corrupt ×3; edge-linux ×2 and edge-windows ×2 (collisions on macOS);
    faults ×6 (missing `torn.txt`, plus three hand-edited snapshots).
  - 6 exit **2**: the cut-short snapshots, refused whole with nothing written.
- **Latest selection.** With no snapshot named, all 24 sets picked the key whose name sorts
  last.
- **Checker, over the 4,009 file rows of the 30 snapshots not refused whole.**
  - **3,970 OK**: present at the expected `<dir>/<DIR name>/<rest>`, with the right SHA-256,
    size and mtime (exact ns).
  - **15 absent**: 6 deliberately deleted, 6 missing objects, 3 objects with the wrong hash.
    Each has a matching restorer line.
  - **8 HASH**: the later row of a NFC/NFD or case collision on APFS, each reported by the
    restorer.
  - **2 MTIME**: year 2300, clamped by APFS, each reported.
  - **6 DUPROW and 8 refused rows**: each refused, with its reason, by the restorer.
  - **0 extra files and 0 empty folders.**

### Confirmed by the bucket

- **Cut-short snapshots are complete gzip.** All six cut-short snapshots (`faults-linux`
  0133 and 0135, `faults-macos` 0138 and 0140, `faults-windows` 0135 and 0137) pass
  `gunzip -t`, so their text was cut before compression.
  Only the `.` catches them, as the spec warns. All six were refused whole (exit 2), with
  nothing written.
- **Presence wins.** The `edge-*` sets reference hashes that deletion records list, but those
  objects are back in `objects/`. They were restored, not skipped.
- **Hand-edited rows are refused one path at a time.** In `faults-linux@…0134`,
  `faults-macos@…0139` and `faults-windows@…0136`, the rows refused were: `..` escapes, a
  path under `faultsX` beside DIR `faults`, a duplicated path (both rows refused), and
  `FAULTS/` against a case-sensitive POSIX DIR. A Windows snapshot
  with the same `FAULTS` edit would match case-insensitively; that snapshot has no such row.
- **Deliberate deletion versus damage.** In `faults-*`, `deleted.txt` was skipped with its
  deletion date and `torn.txt` (missing, unexplained) was reported as damage, exit 1. In
  `corrupt-*`, an object that doesn't hash to its key was withheld, exit 1.
- **Collisions when restoring Linux/Windows snapshots on macOS.** The NFC and NFD `café.txt`,
  and `case/Case.txt` versus `case/case.txt`, collide: the first row restores and the later
  one is reported, exit 1, which is what the spec says s3cab does.
- **APFS and out-of-range mtimes.** `mtime-2300.txt`: APFS stores
  9223372036.854775807 s (INT64_MAX ns, 11 April 2262) and `futimens` returns 0. Only reading
  the time back catches it, as the spec's hint says. A 1969 mtime (`-86401.750`) round-trips
  exactly.
- **Empty sets.** `hollow-*` (no file rows) restores nothing, exits 0, and creates no folder.

## Would corrupt a restore

These are ranked by how likely and how silent the damage is. In each case two readers that
follow the text give different results from one file, or a reasonable reader gives a wrong
one, and nothing is reported.

1. **Multi-member gzip is only covered by a hint, and the hint decides whether a partial
   snapshot passes as complete** (l.281 "plain, single-stream gzip"; writer rule l.908 "one
   gzip stream"; reader behaviour only in the hint at l.826). The rules never say whether a
   reader must read every member, read only the first, or refuse the file.
   - Failure case: member 1 ends exactly at a `.` line and member 2 holds more rows.
   - A first-member reader sees a valid, terminated, smaller snapshot and restores part of a
     backup as all of it. Plenty of decoders stop at the first member, including .NET's
     `GZipStream` (as the spec itself says) and any zlib loop that stops at `Z_STREAM_END`.
   - A joining reader (s3cab, Python, mine) sees rows after the `.` and refuses the file.
   - *Guess:* join members, and refuse any trailing bytes that aren't another member. Offline
     cases `GUESS_gzip_two_members_joined` and `gzip_trailing_garbage`.
   - *Fix:* make it a reading rule, either "decompress every member…" or "more than one member
     refuses the file".
2. **The last field is defined two ways** (l.64 "verbatim from the final tab to the end of the
   line"; l.718 "the last as the rest of the line" after reading the others by position).
   They differ on any row with more than four tabs.
   - Example: `-  <hash>  <size>  <time>  /home/me/a.txt⇥/home/me/b.txt`.
   - A final-tab reader restores `<hash>` as `/home/me/b.txt`.
   - A rest-of-line reader sees a path holding a tab and refuses it.
   - The same split applies to `@SET DIR` values, so it changes which DIR a file lands under.
   - It also decides the heading check (l.784, "all five fields"). Is that exactly five, or at
     least five? A final-tab reader accepts `@S3CAB FORMAT size time junk⇥<url>` as the
     heading; a rest-of-line reader refuses it. Mine refuses it (offline case
     `GUESS_heading_extra_field`).
   - *Guess:* a `-` row must have exactly five fields; for `@` rows, the value is everything
     after the fourth tab. Offline case `six_fields_refused`.
   - *Fix:* one definition, plus "a file row with more than five fields is malformed".
3. **U+0000 in a path is never excluded.** l.59 says "every other character, control
   characters included, is fair game in a path". NUL is valid UTF-8, isn't a tab, CR or LF, and
   no filesystem can hold it.
   - In Swift (as in C), a `String` passed to a file API is cut at the NUL without any error.
     I verified this: `open("a\u{0}b.txt", O_CREAT…)` created a file named `a`.
   - So a naive restorer writes one row's bytes under another name, possibly over a file it
     restored a moment earlier.
   - *Guess:* the row parses, and the restore reports "a name the destination won't create",
     exit 1, before any syscall.
   - *Fix:* add "a path holding U+0000 is malformed" to the path rules (l.681–689).
4. **"Paths compared exactly" doesn't say whether that is before or after splitting a Windows
   path** (l.573, 686, 689). A Windows path splits on both `\` and `/` (l.582), so `C:\d\x` and
   `C:/d/x` name one file, and both land at `<out>/d/x`.
   - Compared as strings, both rows pass the "one path, one row" check. The bytes that end up
     on disk then depend on first-wins or last-wins, which is the exact silent disagreement
     that rule exists to prevent (l.703–705).
   - s3cab's arrival policy (first restores, later reported) only rescues readers that
     implement it, and it is described as a choice, not a rule.
   - *Guess:* compare the parsed form (kind, root, segments) byte-exactly. `\\` and `//` share
     roots are the same root. Offline case `GUESS_win_dup_mixed_seps`.
   - *Fix:* say "compared segment by segment, after splitting".
5. **"Latest" doesn't say whether a key nested deeper counts** (l.777–780: "the key under
   `snapshots/<set>/` whose name sorts last, ignoring any key not named
   `YYYY-MM-DDTHHMM.tsv.gz`"). Is `snapshots/<set>/old/2099-01-01T0000.tsv.gz` "under" the
   folder, and is its "name" the basename?
   - A recursive-listing reader that takes basenames restores it as the latest.
   - A one-level reader ignores it.
   - The two restore different points in time, silently. It needs a stray key, which no
     conforming writer makes.
   - *Guess:* direct children only (ListObjectsV2 with `delimiter=/`).
   - *Fix:* "a key `snapshots/<set>/<name>.tsv.gz` with nothing between".
6. **The 24-character time is specified by shape, not as an instant that must exist**
   (l.340–342, 691). `2026-02-30T00:00:00.000Z` passes a shape check.
   - Foundation's `ISO8601DateFormatter`, the obvious Swift parser, silently returns
     **2 March** for it (verified). A restorer using it sets that mtime and reports nothing.
   - The spec promises the stored value is reproduced to the millisecond, but there is no
     stored value to reproduce.
   - *Guess:* refuse the row unless the date is a real calendar date with h<24, m<60, s<60.
     That refuses a leap second `:60` too, which the spec doesn't mention. Offline cases
     `time_feb30` and `GUESS_time_leap_second`.
   - *Fix:* "a valid instant in the proleptic Gregorian calendar, seconds 00–59".

## Would inconvenience the implementer

These are ranked roughly by how much they change what a restore writes or reports. None of
them produces wrong bytes, but several move files, refuse them, or change the exit status
compared with s3cab.

1. **"s3cab refuses a restore that reaches both"** (l.608 for `/` beside another DIR; l.611–616
   for colliding DIR names).
   - "Refuses a restore" could mean the whole restore, before anything is written, or only
     those files.
   - "Reaches" could count refused rows, rows whose objects turn out missing, or only rows
     that passed validation.
   - *Guess:* refuse the whole restore up front (exit 2, nothing written). A DIR is reached
     when a file row that passed every check counts for it (deepest DIR). Offline cases
     `root_beside_other`, `name_collision`, `name_collision_unreached` and `drive_vs_dir_name`.
     The bucket exercises neither case.
2. **"Unicode's default case mapping" for Windows DIR matching** (l.571).
   - Read strictly, that mapping includes Final_Sigma, and Python's `lower()` and JS
     `toLowerCase()` apply it. Swift's `String.lowercased()` does not (verified:
     `"ΟΔΟΣ".lowercased()` == `οδοσ`, Python gives `οδος`).
   - So DIR `C:\ΟΔΟΣ\` claims `C:\οδος\…` in Python but `C:\οδοσ\…` in naive Swift, and the
     file lands under a different DIR or is refused.
   - Lowercasing (rather than case folding or Windows' own upcase table) also keeps `οδος` and
     `οδοσ` apart, though Windows treats them as one name.
   - *Done:* I implemented Final_Sigma by hand. Offline cases `win_final_sigma` and
     `win_medial_sigma_no_match`.
3. **There is no tie-break when two different DIR rows match one file at equal depth.** This
   can happen on Windows, where `C:\p\` and `c:\P\` both match case-insensitively; "longest
   wins" (l.585) is silent on a tie. *Guess:* refuse the row ("never chooses"). Offline case
   `GUESS_win_equal_dirs_tie`.
4. **Control pictures in `@SET DIR`** (l.532: "spelled out, everywhere else … a reader may read
   [them] as the characters they stand for"). By the letter that covers DIR values. A reader
   that decodes `␉` in a DIR stops matching file rows, whose `␉` "restores as itself" (l.530).
   Those files are then refused, or land under a parent DIR. *Guess:* never decode, anywhere a
   restore reads.
5. **The order of "ignore the separators a DIR ends with" and the Windows/POSIX test**
   (l.579 and l.569). Stripping first turns `C:\` into `C:`, which isn't a Windows path by the
   spec's own test, and `/` into "". *Guess:* classify first, then strip. Offline cases
   `win_drive_root` and `root_alone`.
6. **Identical `@SET DIR` rows.** Do two copies of one DIR "collide by name" (l.611) and refuse
   the restore? *Guess:* dedupe exact duplicates. Offline case `GUESS_identical_dirs_deduped`.
7. **DIR-name collisions ignore case, by an unnamed mapping, and ignore normalization not at
   all** (l.611). "Compared ignoring letter case" doesn't say which mapping; *Guess:* the same
   default lowercase mapping as DIR matching. On macOS
   (normalization-insensitive APFS), `/a/café/` (NFC) and `/b/café/` (NFD) are one folder and
   merge silently, which the rule exists to prevent. File-level collisions inside the merged
   folder are still reported. *Followed the letter* (case only).
8. **A malformed row duplicating a good row's path** (l.701–707). "A row refused for any other
   reason blocks nothing" is said only for the running-through check. Does a malformed twin
   still refuse the good row? *Guess:* yes, both are refused (never choose). Offline case
   `GUESS_dup_with_malformed`. Either reading exits nonzero.
9. **A blank or whitespace-only line mid-file** is never mentioned. Its trimmed type is "",
   which is neither `@` nor `#`. *Guess:* an unknown type, so the whole file is refused.
   Offline case `GUESS_blank_line_refused`.
10. **Field counts on `@` rows** (l.717–718 "doesn't count an `@` or `#` row's fields"). What is
    a `@SET DIR` row with three fields? *Guess:* ignore it with a warning (its files are then
    refused). Offline case `GUESS_dir_short_row`.
11. **Trim: which ends?** (l.61). Columns 2 and 4 pad on the right and column 3 on the left.
    *Guess:* trim both ends of every leading field. Offline cases `nbsp_padding_trimmed`,
    `nel_not_trimmed`, `fs_not_trimmed` and `vt_ff_trimmed`.
12. **Are property names case-sensitive?** Types explicitly are (l.420); properties (`DIR`) are
    not mentioned. *Guess:* case-sensitive, so `@SET dir` is an unknown property and skipped.
13. **The spec contradicts itself on directory paths in `#` rows.** l.407–411 says an excluded
    directory's path ends with a separator, and the bucket has such rows
    (`#excluded build/ … /spread/beta/build/`). l.682–683 says every per-path row's path has
    "no trailing … separator", while l.676 says "a valid file is what s3cab writes". Harmless
    to a restorer that skips `#` rows, but a reader that validates them would call every such
    snapshot invalid, including s3cab's own (`spread-*`, `edge-*`).
14. **The exit status for a file already at the destination** (l.617). "Reported as skipped" is
    given no exit code, while "something in the way" is exit 1. *Guess:* exit 0. This needs
    telling apart from an in-run collision (exit 1); see the hints.
15. **The form of `<n>` in `objects.deleted-<n>.tsv`** (l.183–190): leading zeros, `0`, or no
    digits? *Guess:* one or more ASCII digits. A laxer reader could treat a stray file as a
    record and make missing content look deliberate (exit 0 instead of 1).
16. **A `-` row inside a deletion record** (l.202–226 "carries no paths"). By the validity list
    `-` is a known type, so the record isn't refused whole. *Guess:* distrust the record
    (refuse it whole), the safe direction. Offline case `GUESS_rec_file_row`.
17. **Deletion-record details.**
    - "Distrusted while it's invalid" (l.725) could mean the whole record or only the
      malformed row. *Guess:* row-level for a bad row, whole-file for a whole-file refusal.
    - A `#deleted` row with fewer than five fields: *Guess:* refuse the row.
    - A record listed and then gone (404) before the GET, a compaction race: *Guess:* skip it
      with a warning. That loses its rows if the merged record was written after my listing,
      a race the spec's ordering argument (l.231–232) doesn't cover.
18. **What "decimal" means for the size column** (l.338, 691): leading zeros, a sign, beyond 64
    bits? *Guess:* one or more ASCII digits, unbounded. Swift's `Int("+12")` accepts a sign
    (verified), so the check has to be done by hand. The size is unused by a restore anyway.
19. **Windows-path detection** (l.569–570): is a lowercase drive letter a drive letter? Is a
    POSIX `//srv/x` a share? *Guess:* ASCII A–Z or a–z; `//` is always a share, as the spec
    literally says.
20. **A file row running through a `@SET DIR`** (file `/a/x`, DIR `/a/x/y/`) is covered by no
    validity rule. It is harmless under the chosen-directory layout and matters only when
    restoring to recorded paths. *Guess:* not checked.
21. **Set-name validation on read** (l.94): *Guess:* refuse empty or `/`, warn otherwise.
22. **Retry semantics** (l.797–800). What counts as a "dropped connection": a TLS failure, a
    proxy refusal, a stall? Do the two-minute window and the three-attempt 5xx count
    interact? *Guess:* any transport-level failure counts, with separate counters. The
    initial ceiling isn't given (I used 0.5 s, doubling, capped at 30 s).
23. **"A miss is a 404"** (l.794). S3 also answers 404 `NoSuchBucket`. It is only reachable
    mid-restore by a race, because the snapshot came from the same bucket. Left as is.

## Hints that would have helped

Traps in Swift and macOS that the spec could warn about. Each was verified by running it here,
except where an item says otherwise.

- **Swift's `String(decoding:as:)` silently replaces invalid UTF-8 with U+FFFD** (verified:
  `[0x61,0xFF,0x62]` decodes to `a�b`). "Decode strictly" needs `String(validating:as:)`
  (Swift 6), which also rejects encoded surrogates and overlongs (offline cases
  `utf8_surrogate` and `utf8_overlong`).
- **Swift `String ==` is canonical equivalence beyond paths.** The spec warns about `café`.
  It is sharper than that: `"\u{212A}" == "K"` is true (verified), and `Set<String>` merges
  NFC and NFD paths (verified). Compare *every* field as bytes, types and properties included.
- **Swift's `String.lowercased()` skips Final_Sigma.** See inconvenience 2; the spec names the
  mapping, so naming the trap would be cheap.
- **A Swift `String` passed to a C file API is cut at U+0000** (corrupt 3).
- **Swift's `Int(String)` accepts `+` and `-`** (verified), so it isn't a "decimal" check.
- **Foundation's `ISO8601DateFormatter` is lenient**: 30 February becomes 2 March (corrupt 6).
- **gzip in Swift.** Foundation has no gzip reader: `NSData.decompressed(using: .zlib)`
  refuses a `.gz` (Cocoa error 5377, verified). The system zlib works: the SDK ships a
  `zlib` module map, so `import zlib` just works. Use windowBits `15+16`; `inflateInit2` is a
  macro, so call `inflateInit2_`; loop `inflateReset` over members.
- **Symlinks already inside the output directory.** The hints cover `..`, but a link left in
  `<dir>` by anything else takes a plain `open` or `FileManager` write outside the destination.
  Restores never create links (links aren't recorded), so any link there was already present.
  `openat(…, O_NOFOLLOW)` per component (or macOS's `O_NOFOLLOW_ANY`) prevents it. That a plain
  `open` follows links in intermediate components is ordinary POSIX behaviour, not tested here.
  What I verified is the mitigation: a planted link was reported "in the way" and its target
  stayed empty.
- **Telling "already there" from "collides with a row this run wrote"** on case- and
  normalization-insensitive APFS. The spec gives the two outcomes different exits (skip,
  versus report with exit 1) but not how to tell them apart: the name you asked for isn't the
  name on disk. Recording each created file's (dev, inode) and checking `EEXIST` against it
  works (verified on `edge-linux`/`edge-windows` and on a re-restore).
- **APFS holds pre-1970 times exactly** (verified with `-86401.750`), so a reader needn't
  special-case them. The spec's 2262 warning is right: `futimens` returns 0 and stores
  INT64_MAX ns (verified).
- **Hints that did help.** The Swift CRLF-as-one-`Character` warning (verified:
  `"a\r\nb".split(separator: "\n")` is one element) and the "read the time back" advice both
  saved time.

## Environment notes, not the format

- **Signing: no CLI needed.** SigV4 was written from memory (canonical request, scope
  `date/region/s3/aws4_request`, HMAC chain, `x-amz-content-sha256` of the empty body, and
  `x-amz-security-token` signed) and the first request succeeded. I never ran the `aws` CLI
  for anything, not even the reachability check `ENVIRONMENT.md` suggests.
- **Transport.** URLSession was unusable here, as `ENVIRONMENT.md` says. The system libcurl
  works:
  - call `curl_global_sslset(CURLSSLBACKEND_OPENSSL)` before any other libcurl call;
  - set `CURLOPT_CAINFO` to `/etc/ssl/cert.pem`;
  - `HTTPS_PROXY` is honoured automatically;
  - `CURLOPT_SUPPRESS_CONNECT_HEADERS` stops the proxy's `200 Connection established` from
    being read as the response status.
  - Content decoding is explicitly off, so bytes arrive as stored.
- **libcurl from Swift.** `curl_easy_setopt` and `curl_easy_getinfo` are C variadics, which
  Swift can't call, so a 16-line header-only shim with a module map (`shim/CCurl`) does it.
- **ListObjectsV2** is used with `encoding-type=url`. I decode `+` as a space on the
  assumption that S3 form-encodes spaces; unverified, because no key here holds a space.
- **Toolchain.** The platform default (`xcode-select`, the `Xcode.app` symlink and
  `/usr/bin/swiftc`) is Xcode 16.4 with **Swift 6.1.2**, built in Swift 6 language mode.
  Xcode 26.3 (Swift 6.2.4) is installed but not selected, and I didn't use it.
  - Build: plain `swiftc` (no SwiftPM) via `build.sh`, with `-module-cache-path` under
    `$TMPDIR`.
  - `xcrun` prints harmless "couldn't create cache file" errors in the sandbox.
  - The Swift type checker timed out on one chained closure expression, which had to be split.
- **Sandbox.**
  - `NSTemporaryDirectory()` returns the per-user `/var/folders` directory, which isn't
    writable here, so `TMPDIR` is read from the environment.
  - `FileManager.createFile` returns false (EPERM) inside the sandbox, so I couldn't test its
    overwrite behaviour.
  - The shell is zsh, so an unmatched glob aborts a command chain.
- **Speed.** All 36 snapshots (4,027 file rows, 134 MB by the size column) restore
  sequentially in about 2¼ minutes through the proxy. No concurrency was needed.
- **The bucket itself.** 24 sets: bulk, corrupt, docs, edge, faults, hollow, media and spread,
  each for linux, macos and windows. The credentials expire at 15:10Z; this work finished long
  before.

## Not tested, or tested only offline

- **Never met in the bucket, so only covered by the offline parser cases:** a BOM, CRLF,
  multi-member gzip, blank lines, `/` or drive-root or share DIRs, DIR-name collisions, nested
  DIRs, Windows case-insensitive matching against a differently cased path, and Final_Sigma.
- **Exit 0 with only deliberate deletions missing:** implemented, but not met in the bucket.
  Every snapshot whose deletion records actually explain a miss also has unexplained damage.
- **Listing pagination** (more than 1,000 keys) and **5xx retries:** implemented, but never
  triggered.
- **The `+`-for-space decoding of listed keys:** unverified (see above).
- **NUL in a path:** tested by its effect on `open()` and by the parser (offline case
  `nul_in_name_parses`), but not through a full restore, because no snapshot in the bucket
  holds one and I can't write to the bucket. The write-time check in `Restore.swift` is
  reviewed, not exercised.

## Differences from the reference

**Method.** I did not change the restorer for this comparison: the binary is the one built at
09:35 from the final source. I ran a fresh restore of all 36 snapshots with it
(`tests/restore_all.sh`) and compared that with `reference/` using
`tests/compare_reference.py`. The earlier final run gave the same result. The comparison
covers:

- every path, compared by raw name bytes with no Unicode normalization;
- each entry's type (file, folder, other), so folders present on one side only are caught;
- file size, SHA-256 of the content, and permission bits;
- file mtimes in nanoseconds.

To show the comparator isn't vacuous, I planted one difference of each kind in a copy and it
reported every one: a 1 ms mtime shift, changed content and size, a missing file, an extra
file, and an extra empty folder. Neither side has extended attributes. Folder mtimes aren't
compared, because the format doesn't record them and both sides simply hold the time of the
restore.

**Result: the trees are identical except below the millisecond.**

| Compared | Snapshots | Files | Differences |
| --- | --- | --- | --- |
| Paths, folders, types, sizes, contents, permission bits | 36 | 3,972 on each side | **0** |
| mtime, at the millisecond (as the spec says to compare, rounded not truncated) | 36 | 3,972 | **0** |
| mtime, at the nanosecond | 36 | 3,972 | 3,937 files, reference − mine from −119 to +118 ns |

Where the tool restored nothing (the 6 cut-short snapshots and the 3 hollow ones), my restorer
also wrote nothing; it doesn't even create the output folder. The cases the bucket is built to
test match exactly, including which row wins a collision:

- the first row restores (`case/Case.txt`, the NFC `café.txt`, with identical name bytes);
- a year-2300 time is held as the same APFS clamp, INT64_MAX ns, on both sides;
- a 1969 time is identical;
- in the hand-edited faults snapshots, only `recoverable.txt` restores;
- deliberately deleted, missing and wrong-hash content is absent;
- the dedup files whose objects came back are present.

### The one difference: sub-millisecond mtimes

- **What.** On 3,937 of 3,972 files the reference's mtime is a few tens of nanoseconds off the
  millisecond its row records: from −119 to +118 ns. Mine is exactly on it: 3,970 of my
  files are on the millisecond to the nanosecond, and the other 2 are the clamped year-2300
  files, which are identical on both sides. Only 33 reference files are on the millisecond
  exactly.
- **Cause.** The tool sets times through floating-point seconds; I set them through `futimens`
  with integer nanoseconds.
- **Bug or gap: neither.** The spec predicts this exact difference. The hint at l.840–844 says a
  fraction "has no exact representation in a floating-point count of seconds … s3cab's own
  restore does [land up to about a hundred nanoseconds off its row] … setting the time through
  a nanosecond interface is exact". The rule at l.625–633 says to "compare at that resolution,
  not finer: below the millisecond two restores can disagree without either being wrong", and
  to compare "rounded to the nearest millisecond, not truncated".
- **The rounding warning matters in practice.** 1,947 reference files sit just *below* the
  millisecond they stand for, so a comparison that truncated would call about half the tool's
  own restore wrong by 1 ms. That excludes the 2 clamped files, which also fall below a
  boundary but are identical on both sides.
- **The only quibble is wording.** The largest offset is 119 ns, against the hint's "about a
  hundred".
- **I kept the restorer as it is.** Matching the reference would mean adding floating-point
  error to times that are now exact; both sides already agree at the resolution the spec
  defines.

### What the reference does not settle

The reference holds trees only, so it can't check exit statuses or messages. That leaves the
following unconfirmed: exit 1 for collisions and the clamped time, exit 2 for refused
snapshots, and exit 0 for a skipped pre-existing file (inconvenience 14). It also can't check
anything the bucket doesn't exercise: every guess in *Would corrupt a restore* and the layout
matching and refusals in *Would inconvenience the implementer* (items 1–7) rest on offline cases
alone. **None of the findings above is withdrawn**: no reference restore contradicts any of
them, and none of them is something these 36 snapshots could have tested.
