# The format-spec clean-room audit, run 26: restore on macOS, Fable 5.1 at xhigh (2026-11-10)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on
[Linux](format-spec-audit-22.md), [macOS](format-spec-audit-23.md) and
[Windows](format-spec-audit-24.md); restores on [Linux](format-spec-audit-25.md), macOS (this run)
and [Windows](format-spec-audit-27.md).

- **Program:** [`swiftrestore/`](../scripts/cleanroom/restorers/swiftrestore/), Swift 6 with
  Foundation, and the macOS SDK's libcurl, zlib and CommonCrypto through a bridging header; no S3
  library. The reconcile phase left it unchanged; its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 2 moves flagged: one writing the session's guesses into a notes file in its own temp
  folder, one writing its report; the judge found both harmless.
- **Tokens, both phases:** input 1,994, cache write 275,823, cache read 10,602,207, output 147,301.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# s3cab format spec: clean-room restorer report

Spec read: `format.md`, "the spec of 2026-10-30". Nothing else about the format was consulted.

## Outcome in one paragraph

A restorer written in Swift 6 (Xcode 16.4's Swift 6.1.2, Swift 6 language mode) from the spec alone
restores every restorable snapshot in the bucket byte for byte, with modification times to the
millisecond, and refuses, skips or reports exactly the cases the spec says s3cab refuses, skips or
reports. It uses no AWS SDK and no S3 library: SigV4 signing is written by hand over libcurl, with
zlib and CommonCrypto from the macOS SDK. Signing worked on the first signed request without
consulting the `aws` CLI. All 35 snapshots across 24 sets were restored (or refused whole where the
spec requires) and every output tree was checked by an independent script against the decompressed
snapshot: content hash, size, mtime, no extra files, no empty folders. The spec's rules are complete
enough that I found **no rule whose plausible misreading changes restored bytes**. I found two
silences that can change *what a restore leaves on disk* (listed under *Would corrupt a restore*),
and a longer list of ambiguities and silences that cost time but not data.

## The restorer

    ./s3cab-restore <bucket> <set> <dir> [<snapshot>]

- Source in `src/`, built by `./build.sh` (one `swiftc` call, bridging header `src/bridge.h`).
  The binary in this directory is built from the final source.
- Credentials and region from the environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN` (signed when present), `AWS_REGION` (falls back to `AWS_DEFAULT_REGION`,
  then `us-east-1`). The proxy comes from `HTTPS_PROXY`, read by libcurl itself.
- With no `<snapshot>`, the latest by the spec's rule (text order of names matching
  `YYYYMMDDTHHMM.tsv.gz` directly under `snapshots/<set>/`, paginated listing). A name may be given
  with or without `.tsv.gz`.
- Layout under `<dir>` as the spec describes s3cab's own restore to a chosen directory: POSIX paths
  land at `<dir><path>`, drive paths at `<dir>/<LETTER>/…`, share paths at `<dir>/UNC/…`.
- Exit status: 0 when everything restorable was restored (skips of pre-existing files and
  deliberate deletions included); 1 for any damage, refusal, collision, thing in the way, or time
  not kept; 2 for usage. A refused snapshot writes nothing and exits 1.
- Reporting: one line per file row on stdout (`restored`, `skipped`, `deleted deliberately on
  <instant>`, `missing`, `withheld`, `refused (<why>)`, `collision`, `in the way`), control
  characters in paths spelled out; a summary and notes on stderr.
- Deletion records are read only on the first miss, as the spec requires.

Supporting files: `tools/verify.py` (the independent on-disk checker), `tools/parsetest.swift`
(93 local parser and gzip cases, built from the restorer's own sources).

## What was run against the bucket

Bucket `test-s3cab-ci-cleanroom-restore` (us-east-1): 24 sets, 8 fixture families × 3 writing
platforms; 35 snapshots; 6 deletion records (`objects.deleted-1,3,4,6,7,9.tsv`); 3821 objects;
no locks; a `.s3cab/` folder, ignored.

Every snapshot was restored by name into a fresh empty folder, and each tree was then checked by
`tools/verify.py` against the snapshot decompressed with the system `gunzip` (the check script
does not share code with the restorer). Results, all from the final build:

| Set (×linux, macos, windows) | Snapshot(s) | Result | Exit |
| --- | --- | --- | --- |
| bulk | 1 each | 1100 of 1100 files restored, verified | 0 |
| docs | 1 each | 120 of 120 restored, verified | 0 |
| media | 1 each | 2 of 2 restored (a 40 MiB and a 512 KiB binary, streamed and hashed on the way to disk), verified | 0 |
| spread | 1 each | 6 of 6 restored across two `@SET DIR`s, verified | 0 |
| hollow | 1 each | 0 file rows; no `<dir>` created | 0 |
| corrupt | 1 each | 2 restored; `b-corrupt.txt` withheld: download doesn't hash to its key | 1 |
| faults, 1st and 3rd | 2 each | refused whole: last line isn't `.` (the 1st ends in a stray `@S3CAB VERSION` row with no `.`, the 3rd is cut after its file rows) | 1 |
| faults, 2nd | 1 each | hand-edited: `deleted.txt` deliberately deleted (record dated after START), `torn.txt` missing with no record (damage), `faultsX/beside.txt` and (linux, macos) `FAULTS/case.txt` under no DIR, `twice.txt` in two rows (both refused), `..\..\escaped.txt` refused; `recoverable.txt` restored | 1 |
| faults, 4th (latest) | 1 each | `deleted.txt` deliberately deleted, `torn.txt` damage, `recoverable.txt` restored | 1 |
| edge-linux | 2 | 57 of 59 restored; `café.txt` (NFC/NFD) and `case/Case.txt`/`case.txt` collide on APFS, first row lands; `mtime-2300.txt` time not kept (APFS stores 2262-04-11), file kept | 1 |
| edge-windows | 2 | 27 of 29 restored; same two collisions | 1 |
| edge-macos | 2 | 54 of 54 restored (no twins: written on a case-insensitive disk) | 0 |

Verified by the checker for every tree: hash, size and mtime of every file match its row; no file
present that no row lands on; no empty folder left; file count equals the restorer's `restored`
count. The one checker difference is `mtime-2300.txt` in edge-linux, which the restorer itself
reported as not kept, exit 1, as the spec says s3cab does.

Behavioural checks, each a real run against the bucket:

- Re-run into a restored tree: every file `skipped (already there before the restore)`, exit 0,
  nothing fetched but the snapshot.
- A symlink where a folder inside `<dir>` should be: `in the way`, exit 1, nothing written through
  the link. A regular file there: `in the way`, exit 1. A folder where the file should land: `in
  the way`, exit 1, other rows restored. A symlink (real or dangling) at the file's own name:
  `skipped`, exit 0.
- `<dir>` given relative, given with missing parents, or itself a symlink: all restore correctly.
- Unknown set: "has no snapshot", exit 1. Set name `Docs-Linux`: refused as not a set name.
  Snapshot `20261030T1799`: "no such snapshot", exit 1. Snapshot `2026-10-30`: refused as not a
  name. Latest-snapshot selection picks `20261030T1732` of four for faults-linux and
  `20261030T1733` of two for edge-linux.
- Wrong secret key: HTTP 403 `SignatureDoesNotMatch` from S3, restore stopped. Session token
  omitted: 403 `InvalidAccessKeyId`. Non-existent bucket: 404 `NoSuchBucket`, stopped (not a miss).
- ListObjectsV2 pagination through the restorer's own client: `objects/` lists 3821 keys over 4
  continuation pages (signed continuation tokens).
- Throughput: a fresh bulk restore of 1100 files took 107 s wall clock, serial on one keep-alive
  connection through the proxy.
- "Presence always wins", exercised without planning it: each platform's `edge/dedup-a.txt` hash
  is listed in a deletion record (records 1, 4 and 7), and the object is back in the bucket. Every
  edge restore fetched it and restored it without touching the records, including edge-linux
  `20261030T1730`, whose `START` precedes record 1's instant; a reader treating the records as
  authoritative would have skipped it.

Local parser tests (`tools/parsetest.swift`, 93 cases, all passing) cover what the bucket does
not: BOM, CRLF, missing or mis-spelled `.`, blank lines, unknown row types, heading variants, the
exact trim set (U+3000 and NBSP trimmed, U+0085 not), every path rule in the spec (doubled and
trailing separators, `.`/`..`, `//`, `C:\foo\\`, shares, `\\?\C:\`, Windows case folding with
Final_Sigma and `İ`, POSIX exactness, runs-through with mixed separators, equal to a nested DIR,
malformed twins), instants (year 0000 leap day, 30 February, hour 24, offsets, pre-1970), deletion
record rows (before/after `.`, no trailing LF, bad UTF-8 line), and gzip framing (FNAME header,
header CRC good and bad, reserved flag, two streams, zero byte then garbage, garbage, cut at 20
bytes and cut 8 bytes short, bad CRC-32, empty, plain text, zero before the first stream).

Not tested, and said so: a filesystem with coarser times (the "off by less than 2 seconds" path),
`Content-Encoding` on a stored object, a 5xx or dropped connection (no fault occurred; the retry
code ran only its success path), restoring onto a case-sensitive disk, and an object in an archive
storage class.

## Would corrupt a restore

Ranked by how likely a careful reader is to get it wrong and how bad the result is. "Corrupt" here
means the tree on disk differs from what the spec says a restore leaves, silently.

1. **Latest-snapshot selection needs a paginated listing, and the spec never says so.** The rule
   is "the key directly under `snapshots/<set>/` whose name sorts last", and the hint recommends
   ListObjectsV2 with a delimiter, but S3 returns at most 1000 keys per page in ascending order,
   so a reader that stops at the first page picks a snapshot up to a thousand backups old, restores
   it, and exits 0. Nothing in the format marks the tree as stale. The same silence covers listing
   `objects.deleted-*` (a record on a later page explains nothing, which only turns a deliberate
   deletion into reported damage, the safe side). *What I did:* paginate with `continuation-token`;
   verified with the 3821-key `objects/` listing. The bucket has at most four snapshots per set, so
   this was not exercised by a restore.

2. **"Never equal to any `@SET DIR`, a nested one included" is stated in the body but missing from
   the reading checklist.** The checklist says only "Check that each file row falls inside a
   `@SET DIR`". A reader working from the checklist, as I did, restores a hand-added file row
   whose path equals an inner member directory (`/a/b` under DIRs `/a/` and `/a/b/`), leaving a
   file where s3cab leaves nothing, with exit 0 instead of 1. My first build had exactly this
   bug; my own local test caught it, not the bucket (no snapshot there has such a row). Bytes of
   other files are unaffected, which is why this is last in this list rather than first.

## Would inconvenience the implementer

Each item records what the spec left open, what I guessed, and whether a run confirmed it.

1. **Which checks come first.** The spec lists "refuse the whole file", "refuse one path" and
   "ignore" as three outcomes but never says a reader must settle whole-file validity before
   restoring any row. It is implied by "never lets a partial restore pass for a full one", and by
   the gzip discussion, but a streaming reader that restores rows as it parses would act on a file
   that is refused at line 400. *Guess:* decompress and validate the whole file, then restore.
   Confirmed by the cut-short faults snapshots: nothing written, exit 1.

2. **A `@SNAPSHOT START` row with four fields.** "An `@` row with fewer than five fields has no
   value" is stated for `@SET DIR`, whose value is the fifth field. `START`'s instant is the fourth
   field and its fifth (the zone) is "for people", so a four-field `START` row is ambiguous:
   void, or an instant with no zone? *Guess:* the instant counts whenever the fourth field holds a
   real instant, whatever the field count. A wrong guess only turns "deliberately deleted" into
   "damage" (exit 1); files on disk are the same. Not present in the bucket.

3. **Set names: writers get one rule, listers another.** A set's name is "`a` to `z` and digits,
   with single hyphens between them", but "listing a bucket's sets, s3cab counts every folder or
   `.info` named with those characters alone, hyphens anywhere". A restorer given a set name on
   the command line is told neither. *Guess:* apply the strict writer's rule and refuse the rest.
   A set written by another tool as `my--photos` would be listed by s3cab and refused by mine.
   Confirmed only in the refusing direction (`Docs-Linux` refused).

4. **Lowercasing a Windows path: whole string or per segment?** The matching rule says both the
   DIR and the path "are lowercased by Unicode's full default case mapping, Final_Sigma included",
   and separately that they are compared by whole segments. Final_Sigma looks at neighbours, so
   it matters in principle whether the separator is inside the string being mapped. *Guess:*
   lowercase the whole path, then split; I convinced myself the result equals per-segment mapping
   because `\` and `/` are neither cased nor case-ignorable, but the spec could say which it does.
   Confirmed by local tests (`C:\ΟΔΟΣ\` matches `C:\οδος\a.txt` and not `C:\οδοσ\a.txt`).

5. **A 404 whose body has no readable S3 code.** A miss is "a 404 whose S3 error code is
   `NoSuchKey`, or `NotFound`"; "any other failure" stops the restore. A 404 with no code (a proxy
   page, or a body a reader can't parse) is neither named. *Guess:* stop the whole restore, the
   safe side. Not observed; AWS always sent a coded body.

6. **"Valid" and "what a reader does" disagree about `#` rows.** The validity list requires every
   per-path row's path to be absolute with no tab, CR or LF, and says a `#` row repeating a file
   row's path "makes the file invalid", but then says a reader "doesn't check a `#` row's
   segments" and "needn't check" the repeat. So a file can be invalid with nothing for a restorer
   to do about it. *Guess:* a restorer never looks at `#` rows at all. Confirmed harmless on the
   edge sets, which hold `#excluded` and `#error` rows with odd paths (`surrogate-�.txt`, a
   directory link ending in `/`).

7. **The output folder itself.** The spec says `<output>` "and any folder above it, may be a
   link", and that a restore that writes nothing creates no `<output>`, but not what to do when
   `<output>` exists as a regular file, or is unwritable. *Guess:* treat it as "in the way" for
   every row, exit 1. Not exercised against the bucket (only the link case was, and it works).

8. **Folder permissions.** "Its permissions are what the system gives a new file" is said of a
   file; nothing is said of the folders a restore makes. *Guess:* the system default (0777 under
   the umask). Harmless either way.

9. **Deletion-record `.` with a trailing CR.** By the rules, `.\r` is not the `.`, so rows after
   it still count and the line itself is skipped as not `#deleted`. That follows from the text but
   is surprising enough to deserve a sentence. Confirmed by reasoning only; not in the bucket.

10. **The 2-second read-back window.** "Off by less than 2 seconds is the disk's own rounding ...
    off by more ... exit 1" leaves exactly 2 seconds unassigned. *Guess:* 2 seconds counts as
    "more". No disk here has coarse times, so the whole branch is untested.

11. **How a miss on the snapshot key itself is reported.** The miss rule is written for
    `objects/`. A snapshot named on the command line that isn't there is simply a failed restore.
    *Guess:* "no such snapshot", exit 1, no `<output>` made. Confirmed.

12. **Retry window.** "Retries a dropped connection for two minutes from the first failure": per
    request or per restore? *Guess:* per request. Untested; no connection dropped.

Things I checked that turned out to be unambiguous once read closely, listed so nobody re-derives
them: the trim set is exactly JavaScript's (U+0085 excluded, U+FEFF included), so a BOM is removed
by the first field's trim; the heading row's fifth field is compared verbatim; column 4 of `START`
is a leading field and is trimmed; a line of only tabs is a blank line; a `.` anywhere but last
refuses the file; `-` rows with fewer than five fields have an empty path and are refused one at a
time; both rows of a duplicated path are refused even when one is malformed; runs-through is
checked last, exactly, with the separator set of the path's own kind; the deletion-record instant
must be strictly later than `START` as text; a 404 `NoSuchBucket` is not a miss.

## Hints that would have helped

Traps in Swift, macOS or the libraries that the spec could warn about, each one met here.

- **zlib already does the gzip header checks.** With `inflateInit2(&strm, 15 + 16)` zlib verifies
  the header CRC when FHCRC is set and rejects reserved flag bits ("unknown header flags set"),
  so the ".NET: read the framing yourself" advice doesn't apply to zlib users. Confirmed by
  constructed files (good and bad header CRC, reserved bit). A cut stream shows as `Z_BUF_ERROR`
  with `avail_in` 0 or as `Z_OK` with no progress; both have to be caught, since neither is
  `Z_DATA_ERROR`.
- **libcurl's `CURL *` imports into Swift as `UnsafeMutableRawPointer`, not `OpaquePointer`.**
  Cost one compile cycle. The spec's hint about wrapping `curl_easy_setopt` in static inline C is
  right and necessary; `curl_easy_getinfo` needs the same.
- **Swift 6 language mode.** Top-level `var`s in `main.swift` are `@MainActor`, so helper
  functions that touch them must be too; a `curl_write_callback` can't capture, so the sink goes
  through `CURLOPT_WRITEDATA` with `Unmanaged`; a `XMLParserDelegate` subclass works unisolated.
  None of this is hard, but the spec's Swift hints are written for Swift 5 habits.
- **Name clash with POSIX `write`.** Inside a class that has its own `write` method, the libc call
  must be spelled `Foundation.write(fd, …)` (or `Darwin.write`); the bare name resolves to the
  method and fails to type-check. Likewise `var st = stat()` is the struct and `lstat(p, &st)` the
  call.
- **Negative times round-trip.** `futimens` with a negative `tv_sec` and a positive `tv_nsec`
  stores a pre-1970 time exactly on APFS and `st_mtimespec` reads it back the same
  (`1969-12-30T23:59:59.750Z` confirmed). The spec's hints discuss pre-1970 for Windows and C's
  division but not that the nanosecond interface simply works.
- **Compare paths as `[UInt8]`.** The spec says to compare paths as bytes; the concrete Swift
  shape is a `Set<[UInt8]>` or `[ [UInt8]: … ]`, since `Array<UInt8>` is `Hashable` with
  byte-wise equality, and `String(decoding:as:)` only at the moment of printing or case-folding.
- **`String.lowercased(with: nil)` is the right call** and the spec's claim about it is accurate
  (Final_Sigma and `İ` both verified), but the two spellings need a test each, since the
  difference from `lowercased()` is invisible on ASCII fixtures.
- **`$TMPDIR` is case-insensitive APFS**, as the hint says of `/tmp`, so collisions by case and by
  normalization appear in any test there with no setup; conversely the case-sensitive behaviours
  cannot be exercised without a case-sensitive volume, which the hint could say.
- **Foundation's `XMLParser` is enough** for ListObjectsV2 and S3 error bodies, so no XML library
  is needed; the spec's listing hint could say "the XML is small and flat".
- **Module cache in a sandbox.** Not the spec's fault, but one line in the Swift hint would save
  time: when `/var/folders` isn't writable, pass `-module-cache-path` and
  `-Xcc -fmodules-cache-path` to `swiftc`; the `xcrun_db` "Operation not permitted" messages are
  noise.

## Environment notes, not the format

- **Signing.** AWS Signature Version 4 implemented from memory: canonical request (method, URI
  with each segment percent-encoded once, sorted and encoded query, lowercase sorted headers,
  signed-header list, SHA-256 of the empty payload), string to sign, the four-step HMAC key
  derivation, and the `Authorization` header. Signed headers: `host`, `x-amz-content-sha256`,
  `x-amz-date`, `x-amz-security-token`. The first signed request (a listing) succeeded; the `aws`
  CLI was not needed to get signing right. It was used for three things only: confirming the
  bucket was reachable before writing code, downloading the snapshots and records to `$TMPDIR` so
  the verifier had an independent copy, and nothing else. That S3 checks the signature was shown
  by the 403 `SignatureDoesNotMatch` on a deliberately wrong secret.
- **Transport.** macOS libcurl 8.7.1 with the LibreSSL backend selected by
  `curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)` before any other libcurl call, as
  `ENVIRONMENT.md` says; `CURLOPT_CAINFO` set to `/etc/ssl/cert.pem`; `HTTPS_PROXY` with its
  embedded credentials honoured by libcurl with no code; one easy handle reused for the whole run
  (keep-alive); no `Accept-Encoding` sent and `CURLOPT_HTTP_CONTENT_DECODING` off; libcurl's
  default `Accept` header suppressed. Connect timeout 10 s, 30 s without a byte counts as dropped.
- **Endpoint.** Virtual-hosted style `https://<bucket>.s3.us-east-1.amazonaws.com`. ListObjectsV2
  (`list-type=2`, `prefix`, `delimiter=/`, `continuation-token`) parsed with Foundation's
  `XMLParser`; error bodies likewise for `Code` and `Message`.
- **Toolchain.** Xcode 16.4, Swift 6.1.2, `-swift-version 6 -O`, a single `swiftc` invocation
  with a bridging header for `curl/curl.h`, `zlib.h` and CommonCrypto, linking `-lcurl -lz`. No
  package manager, nothing from Homebrew (the verifier runs under `/usr/bin/python3`, Apple's
  3.9). The sandbox's `/var/folders` module cache is unwritable, hence the cache flags in
  `build.sh`.
- **Sandbox.** Output trees and scratch under `$TMPDIR` (`/tmp/claude-501`, case-insensitive
  APFS). Network only through the proxy, only to AWS; nothing else was needed.
- **Bucket.** 24 sets × 1 to 4 snapshots (35), 6 deletion records with one row each (six distinct
  hashes: the three platforms' `faults/deleted.txt` objects, and the three platforms'
  `edge/dedup-a.txt` objects, which are back in the bucket), 3821 objects, no locks. Session
  credentials with an expiry at 17:29Z; every run finished before 13:00Z.
- **Retries.** Implemented as the spec describes (random waits under a doubling ceiling; 2
  minutes for dropped connections, three attempts for 5xx) but never triggered: every request
  succeeded first time.

## Differences from the reference

Second phase. `reference/` holds s3cab's own restore of each of the 36 snapshot directories (one per
snapshot in the bucket; an empty directory where the tool restored nothing). Each was compared with
my restore of the same snapshot by `tools/compare.py`, which walks both trees and compares the set
of relative paths as bytes, the set of directories, each file's bytes, its mode, and its
modification time in nanoseconds and rounded to the millisecond. My trees are the ones restored by
the final build in the first phase (`$TMPDIR/final/<set>@<snapshot>`), untouched since.

**Result: no difference at the format's resolution in any of the 36 pairs.** Same files, same
path bytes, same contents, same directories (and no directory for the snapshots that restore
nothing, matching the reference's empty one), same modes, same modification time to the
millisecond. Nothing was changed in the restorer as a result; the binary in this directory is the
one the first phase left, built from the final source.

The one difference found, present in every pair that has files:

1. **Modification times differ below the millisecond, by at most 119 ns.** Counts per tree are in
   the comparison output (for example 1079 of 1100 files in bulk-linux, 51 of 57 in edge-linux);
   the files that agree exactly are those whose stored instant is a whole second. In every case my
   file holds the stored instant exactly (`…419871000000` ns) and the reference holds it a few
   tens of nanoseconds off (`…419871000051`, `…419907999992`). Rounded to the millisecond, as the
   spec says to compare, both hold the row's value. *Cause:* the spec's own hint, "a fraction like
   `.674` has no exact representation in a floating-point count of seconds ... so a restored file
   can land up to about a hundred nanoseconds off its row. s3cab's own restore does, where the
   filesystem keeps nanoseconds; setting the time through a nanosecond interface is exact." My
   restorer uses `futimens`, the nanosecond interface. *Verdict:* neither a bug nor a gap: the
   spec describes this difference and rules it out of comparisons ("compare at that resolution,
   not finer: below the millisecond two restores can disagree without either being wrong"). It is
   recorded here because the comparison asked for was byte-for-byte including times, and this is
   where the two trees are not byte-identical.

Edge cases checked by hand in both trees, identical in each: the year-2300 row sits at APFS's
limit (`9223372036854775807` ns, 2262-04-11T23:47:16.854775807Z) in both; the 1969 row holds
`-86400250000000` ns in both; of the two `café.txt` rows the NFC spelling (the first row in the
file) is on disk in both, and of `case/Case.txt` and `case/case.txt` the `Case.txt` row (the first,
hash `9a2d…`) is on disk in both, under its own name bytes; names with leading and trailing spaces
(` both ends.txt `, `trailing.txt `) are byte-identical; the 40 MiB `clip.bin` is byte-identical.

What the comparison confirms about the first-phase guesses: the landing layout for all three path
kinds (`<dir><path>`, `<dir>/C/…`), the first-row-lands rule for twins on a case- and
normalization-insensitive disk, the refusals in the hand-edited faults snapshots (one file in both
trees), the whole-file refusals (no directory from me, an empty one as the reference's marker),
withholding the corrupt object, and leaving no folder for a file that fails. None of the
"Would corrupt" or "Would inconvenience" items above was exercised by a reference tree in the
other direction, so none is withdrawn; the two "Would corrupt" items concern cases the bucket does
not contain (more than a thousand snapshots in a set; a file row equal to a nested DIR).
