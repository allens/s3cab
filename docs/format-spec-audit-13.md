# The format-spec clean-room audit, run 13: restore on Linux, Fable 5.1 at xhigh (2026-10-23)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec as of [PR #454](https://github.com/allens/s3cab/pull/454)
(2026-10-23). The set is runs 10–15: backups on [Linux](format-spec-audit-10.md),
[macOS](format-spec-audit-11.md) and [Windows](format-spec-audit-12.md); restores on Linux (this
run), [macOS](format-spec-audit-14.md) and [Windows](format-spec-audit-15.md).

- **Program:** [`crestore/`](../scripts/cleanroom/restorers/crestore/), C with libcurl, OpenSSL and
  zlib, and no S3 library. It is the reconcile phase's program; its notes, logs and test tools stay
  with the run, outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 4 moves flagged, each a heredoc writing the session's own source, notes or report; the
  judge found all four harmless.
- **Tokens, both phases:** input 1,958, cache write 296,387, cache read 10,054,590, output 175,693.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# Clean-room restorer for the s3cab format: report on `format.md` (spec of 2026-10-23)

A restorer was written in C from `format.md` alone, with no AWS SDK and no S3 library, and run against the
real bucket `test-s3cab-ci-cleanroom-restore` over the sandbox's proxy. Every one of the bucket's 42 snapshots
(24 sets) was restored and checked independently; 51 further snapshot files crafted on disk (still fetching
their objects from the bucket) exercised the reading rules one at a time. The restorer is `./s3cab-restore`,
built from `s3cab-restore.c` by `make`.

Headline: the format is recoverable without the tool. Nothing in the spec was *wrong* for the files the
bucket holds; every real-bucket restore matched the spec's description of what a restore leaves, byte for
byte and to the millisecond. The gaps below are places where the text left me guessing. Four of the guesses
could, under a different reader's reading, produce a silently wrong tree; the rest cost time or produce a
loud difference between two readers.

The lists are ranked. Each item says where the spec is unclear, what I guessed, and what actually ran.

## Would corrupt a restore

1. **A link found at a destination.** The reading checklist says "Never write outside your destination"; the
   hints add "A link already inside the output folder leads out of it, so don't write through a folder this
   restore didn't make without checking it", and name `renameat2`/`link`/`O_TMPFILE`. But the rules for what
   is "already there" and what is "in the way" never mention a symbolic link at the *file's own name* or at a
   folder position. A reader that opens the destination with `O_CREAT` follows a dangling link left in
   `<output>` and creates the file wherever it points; one that tests existence with `stat` sees nothing
   there and does the same. Guess: never follow anything below `<output>`; a link where a folder should be is
   "in the way" (exit 1), a link at the file's name is "already there" (skipped, exit 0). Ran: a symlink to a
   directory elsewhere, placed where the folder `d` should be, was reported in the way and the other
   directory stayed empty; a dangling symlink at the file's name was skipped; a plain file and a directory in
   the way behaved as the spec says (`work/logs/test-*.log`, t20a to t20e in the test record).

2. **A modification time the destination can't hold.** The rule is "Set each restored file's modification
   time to the stored one, to the millisecond." It says nothing about checking that it took, or about the
   exit status when it didn't; only the hint describes s3cab reading the time back, counting under 2 s as
   rounding (exit 0) and more as a failure (exit 1). A reader that follows the rule alone reports a clean
   restore of a tree whose times are wrong, which is exactly the "partial restore passing for a full one"
   the spec forbids. Guess: implement the hint as a rule. Ran: ext4 clamped year 0000 to 1901-12-13T20:45:52Z
   and 9999 to 2446-05-10T22:38:55Z; both reported, exit 1 (test t27); 1969, 2038 and 2300 in the edge sets
   held exactly.

3. **What counts as a snapshot name when choosing the latest.** "It ignores any key not named exactly
   `YYYY-MM-DDTHHMM.tsv.gz`" and takes "the key ... whose name sorts last". Whether a digit-shaped but
   impossible name such as `2026-13-45T9999.tsv.gz` is a snapshot name is not said. Two readers can pick
   different "latest" snapshots and restore different, individually valid, trees without a word. Only a
   hand-placed key can cause it. Guess: the digit shape alone, no calendar check. Ran: every set in the bucket
   holds only well-formed names, so the choice matched the listing; the reject branch ran only on crafted
   command-line names.

4. **A NUL inside an `@SET DIR` value.** File rows are checked for NUL; `#` rows' segments are explicitly not;
   DIR values are not mentioned. A reader that turns the field into a C string silently shortens
   `/d<NUL>x/` to `/d` and lets it claim every row under `/d/`, landing them in a folder another reader would
   refuse them from ("under no DIR"). Hand-edited files only. Guess: a DIR holding a NUL matches nothing.
   Ran: test t48 (row refused, sibling under a clean DIR restored).

## Would inconvenience the implementer

1. **The zero byte after the last gzip stream.** Under "A reader still decompresses what it is given" the
   damage rule for trailing bytes has "one exception: s3cab, through Node's gunzip, stops at a zero byte
   there, and ignores it and everything after it." It reads as a description of a Node quirk placed among the
   rules. Is a reader required to honour it, allowed to, or just warned that s3cab does? Guess: a rule. Ran:
   t08b (`\0\0junk` after the stream: restored, exit 0) and t08a (`garbage`: refused as damaged).

2. **Running-through with mixed separators.** "Every other comparison of two paths is exact ... no separator
   unified", yet the example says `C:\P\a` and `C:/P/a/b.txt` are *not* a running-through pair but a
   destination collision. So the prefix is compared byte for byte, but is the separator after it any
   separator of the path's kind, or must it match too? Guess: B runs through A when B is A plus one separator
   character valid for B's kind plus more. Ran: t12 (POSIX pair, both refused), t19 (the spec's example:
   first restores, second reported as a collision, exit 1).

3. **Where the S3 error code is, and which request to make.** "A miss is a 404 whose S3 error code is
   `NoSuchKey` or `NotFound`" never says the code is in the XML error body of a GET, that a HEAD has no body
   (so a HEAD-based reader can't tell a miss from `NoSuchBucket`), or what to do with a 404 carrying some
   other code. Guess: GET; parse `<Code>`; a 404 with an unrecognised code stops the run. Ran: the faults
   sets' torn file (404 `NoSuchKey`, no record: damage), t22a, and a 403 (`InvalidAccessKeyId`, stop).

4. **What "giving up" means after the retry policy.** The retry bullet says to retry before giving up; the
   miss bullet says "s3cab stops the whole restore on any other failure" for 403 and `NoSuchBucket`. Whether
   an exhausted 5xx or a dead connection stops the run or counts as that one file's damage is not stated.
   Guess: stop the run, exit 1. Ran: the 403 stop; a 5xx or dropped connection could not be provoked against
   the real bucket, so that branch is untested.

5. **Full Unicode lowercasing on Windows paths.** The rule pins JavaScript's `toLowerCase()` with Final_Sigma.
   The hints say C has no such mapping and point at ICU; ICU's headers aren't packaged here. Guess: glibc
   `towlower` per code point in `C.UTF-8`, plus U+0130 to `i`+U+0307 and Final_Sigma with an approximate
   case-ignorable set. A reader that gets this wrong refuses rows loudly ("under no DIR") or, with
   hand-edited DIRs, matches a different one. Ran: t41 (`ÉTÉ` against `été`), t42 (`ΟΔΟΣ` against `οδος`),
   t43 (U+0130), t45 (UNC and `/`-spelled DIRs).

6. **"Exactly `.`" against blank-line skipping.** The `.` is "exactly `.`", a blank line is "empty or holding
   only what the trim removes", and rows after the `.` refuse the file. Is `.␠␠` a `.`, a blank, or an unknown
   type? Is a second `.` a row after the `.`? Guess: byte-exact `.`; `.␠␠` is an unknown type (refuse whole);
   anything non-blank after the first `.` refuses whole. Ran: t32, t04, t07, t21.

7. **The heading row's fifth field.** "all five fields ... padding aside" plus "never trim the last": a
   heading whose URL has a trailing space is refused by a verbatim reader and accepted by one that trims.
   Guess: verbatim. Ran: t29 (refused).

8. **The BOM "may" be forgiven.** Optional behaviour means two readers differ on the same file. Guess: forgive.
   Ran: t02.

9. **Drive-letter case.** Case-insensitivity on Windows paths is defined on segments; the drive letter isn't
   one. Guess: compare it case-insensitively too. Ran: t15 (`c:/users/ME/photos/x.txt` under
   `C:\Users\me\Photos\`), t45.

10. **Windows rows on a POSIX destination.** `<output>/<name of the DIR>/<the rest of the path below that DIR>`
    doesn't say what the rest's separators become. Guess: split by the path's kind, join with the
    destination's separator. Ran: every `*-windows` set (checked by `work/check.py`).

11. **A record that vanishes between listing and fetch.** The spec describes the compaction race and says a
    missed row is the safe direction, but not what the reader does with the 404. Guess: skip it with a note.
    Not triggered.

12. **UNC roots with fewer than two segments** (`\\server\`, `\\`): the folder name rule needs a share name.
    Guess: match nothing. Not triggered.

13. **The reader's grammar for a set name.** Only the writer's grammar is given. Guess: pass the name through;
    an unknown set simply has no snapshots. Ran: `no-such-set` (exit 1).

## Hints that would have helped

- **C strings end at the first NUL.** Check a field's raw length for NUL before converting it; otherwise the
  path rule "no NUL" is tested on a string that has already lost its tail.
- **glibc's `towlower` is ASCII-only under the default `"C"` locale.** Call `setlocale(LC_CTYPE, "C.UTF-8")`
  first; `C.UTF-8` ships with glibc 2.35 and later.
- **zlib's signals.** A member cut short comes back as `Z_BUF_ERROR` with `avail_in == 0`, not `Z_DATA_ERROR`;
  a bad CRC is `Z_DATA_ERROR` with the message "incorrect data check"; after `Z_STREAM_END`, `avail_in` says
  how many bytes follow the member, and `inflateReset` starts the next one.
- **`openat` with `O_DIRECTORY | O_NOFOLLOW` on a symlink fails with `ENOTDIR`, not `ELOOP`.** Word the
  report after an `fstatat(AT_SYMLINK_NOFOLLOW)`, or "a link is in the way" prints as "a file is in the way".
- **`O_TMPFILE` needs a directory on the destination filesystem before `<output>` exists.** Open the nearest
  existing ancestor. `linkat(fd, "", dirfd, name, AT_EMPTY_PATH)` worked unprivileged on this 6.17 kernel; keep
  the `/proc/self/fd/N` form for older ones, and a `memfd_create` plus `O_EXCL` copy for filesystems without
  `O_TMPFILE` (exercised here through a test knob).
- **Verifying "access time equals the stored instant" after the fact fails.** Under `relatime`, the read that
  hashes a restored file moves its atime. Check the times before reading content, or hash the temporary file
  before it gets a name, as the spec's `O_TMPFILE` hint already implies.
- **Turn off transparent decoding in the HTTP client.** The writer-side warning about `Content-Encoding` has a
  reader-side twin: Python's `requests` and libcurl with `CURLOPT_ACCEPT_ENCODING` hand back decoded bytes,
  and the hash check then withholds a perfectly good object. libcurl's default leaves it off.
- **The exact ext4 clamps**, so a test can be written for them: year 0000 lands on 1901-12-13T20:45:52Z
  (−2³¹ s) and year 9999 on 2446-05-10T22:38:55Z.
- **Test the trimmed type, not the first byte.** `␠␠-␠␠` is a file row and `\t\t\t\t` is a blank line (tabs
  are in the trim set). Both follow from the five reading rules, but a one-line note under "Fields in C" would
  stop `line[0] == '-'` from ever being written.
- **A fifth tab in a file row is not a sixth field; it is a tab in the path, and refuses the row.** The two
  sentences are a page apart.

## Environment notes, not the format

- **Platform and toolchain.** Ubuntu 24.04, GCC 13.3.0 with `-std=gnu2x` (the C23 draft; GCC 13 has no
  `-std=c23`), glibc, kernel 6.17 (Azure). `make` builds with `-l:libcurl.so.4 -lcrypto -lz`.
- **libcurl without its header.** The runtime (`libcurl4t64` 8.5.0, OpenSSL build) is installed; the header
  package isn't, and there is no root or package mirror. The program declares the 13 functions and the
  ~20 constants it uses itself (the ABI is stable) and verifies every option id at startup with
  `curl_easy_option_by_name`, aborting on a mismatch. A `curl.h` found under `/usr/share/miniconda` was used
  once to cross-check the enum values, nothing more.
- **Hashing and decompression.** OpenSSL 3.0.13 (`EVP` SHA-256, `EVP_MAC` HMAC) and zlib 1.3, both with
  headers present.
- **Signing.** AWS Signature Version 4 was written from memory and the first signed request (a ListObjectsV2
  with a query string) succeeded; no CLI output was consulted for signing. Request shape that mattered:
  virtual-hosted host `<bucket>.s3.us-east-1.amazonaws.com`; signed headers `host`, `x-amz-content-sha256`
  (hash of the empty body), `x-amz-date`, `x-amz-security-token`; canonical query sorted with
  `continuation-token` fully encoded; errors read from the XML body's `<Code>`. GET only.
- **Where the `aws` CLI was used.** Once before coding, `aws s3 ls` of the bucket root to confirm the
  credentials and proxy worked; afterwards `head-object` and `cp` on four objects to cross-check the
  restorer's verdicts (one present-again hash, two absent, one with wrong bytes). The restorer never invokes it.
- **Proxy.** `HTTPS_PROXY` is `http://user:pass@localhost:3128`; libcurl does the CONNECT tunnel and the proxy
  basic auth from the URL. The program sets `CURLOPT_PROXY` from `HTTPS_PROXY`/`https_proxy` explicitly.
- **The bucket.** 24 sets, eight kinds (`bulk`, `corrupt`, `docs`, `edge`, `faults`, `hollow`, `media`,
  `spread`) times `linux`/`macos`/`windows`; 42 snapshots; six deletion records numbered 1, 3, 4, 6, 7, 9 with
  one `#deleted` row each; a `.s3cab/` client folder; objects in `GLACIER_IR`, which a plain GET reads.
  Sequential fetches ran at about 18 objects a second through the proxy; the 42-snapshot sweep took about six
  minutes for roughly 4,000 objects.
- **Sandbox.** Reading `credentials.env` directly was refused by the permission layer, so it is only ever
  sourced; writes go to this directory and `$TMPDIR` (both ext4, `O_TMPFILE` works). The session credentials
  were valid throughout (finished about 09:31Z against a 14:52Z expiry).

## What was run

**All 42 snapshots, each into a fresh directory** (`work/logs/SWEEP.txt`, one log and one decompressed dump
per snapshot under `work/logs/` and `work/dumps/`), then `work/check.py` on every one. The checker parses the
dumped text itself, recomputes each row's destination from the spec's layout rules, hashes every file on
disk, compares `st_mtime_ns` exactly, cross-references every row with the restorer's log line for it, and
walks the output for extras and empty folders.

| Sets | Rows | Outcome | Checker |
| --- | --- | --- | --- |
| bulk ×3 | 1100 each | all restored, exit 0 | OK |
| docs ×3 | 120 each | all restored, exit 0 | OK |
| edge-linux ×2, edge-macos ×2, edge-windows ×2 | 59 / 54 / 29 | all restored, exit 0 (leading and trailing spaces, `CON`, `aux.txt`, `notes.`, `a"b` `a*b` `a:b` `a<b` `a>b` `a?b` `a|b`, `a\b/c.txt`, NFC and NFD `café`, `case/Case.txt` beside `case/case.txt`, form feed, vertical tab and NEL in names, a 1 MiB file, empty file, mtimes 1969, 2038, 2300) | OK |
| spread ×3 | 6 each, two `@SET DIR` | land beside each other as `alpha/` and `beta/`, exit 0 | OK |
| media ×3, hollow ×3 | 2 / 0 | exit 0; hollow leaves no output directory | OK |
| corrupt ×3 | 3 | middle object holds other bytes: withheld as damage, exit 1; neighbours restored | OK |
| faults ×3, second and fourth snapshot | 8 / 7 / 3 | `deleted.txt` deliberately deleted (record 3/6/9, skipped), `torn.txt` missing with no record (damage), `faultsX/beside.txt` under no DIR, `twice.txt` both rows refused, `../../escaped.txt` refused, `FAULTS/case.txt` under no DIR on linux and macos; exit 1 | OK |
| faults ×3, first and third snapshot | n/a | complete gzip whose text has no `.`: refused whole, nothing written, exit 1 | no output dir confirmed |

CLI cross-checks after the fact: record 1's hash is present again in `objects/` (23 bytes, `GLACIER_IR`), so
the restorer restoring it was right and my first test expectation was wrong, which is "presence always wins"
observed for real; the two "missing" hashes head as absent; the corrupt object downloads to the same
unexpected SHA-256 the restorer printed.

**51 crafted snapshot files** (`work/mktests.py` writes them, `work/runtests.sh` runs them with real object
fetches; expectations in `work/tests/expectations.json`; all pass with the final binary): CRLF; BOM; `.`
without LF; rows after `.`; no `.`; truncated gzip; two concatenated streams; trailing garbage and trailing
zero byte; unknown types (`X` refuses, `@FOO`/`#weird`/`@SET dir` skipped); `..`, `.`, empty and trailing
segments; duplicate path with a malformed twin; running-through; under no DIR; path equal to a DIR; Windows
drive, UNC and `/`-spelled DIRs with case differences; nested DIRs; DIR-name collision reached and unreached;
`/` alone and beside another DIR; two spellings of one destination; blank lines of spaces, tabs, NBSP and
ideographic space before and after the `.`; a deleted hash and a present-again hash; uppercase hex, signed
and empty sizes, 30 February, hour 24, `+00:00`, a comma, 29 February 2024; verbatim paths with leading and
trailing spaces; a fifth tab; a CR; a NUL; `@SET DIR` with four fields, lowercase property, doubled separator,
repeated trailing separators, trailing space, relative, NUL inside, written twice; extreme times; padded `-`
type; heading with a trailing space; `#` rows repeating a file row's path and naming a directory; an empty
second gzip stream; a padded `.`; invalid UTF-8, an encoded surrogate and an overlong sequence; a flipped
CRC byte; a four-field file row; backslashes in POSIX names; POSIX exactness of case.

**Destination state** (t20a to t20e, `work/logs/test-t20*` not kept separately; outputs in the session):
pre-existing file skipped and untouched (exit 0); directory at the file's name in the way (exit 1); file or
symlink where a folder should be in the way (exit 1), nothing written through the link; dangling symlink at
the file's name skipped; a second run over a finished tree skips all 120 files with exit 0; the forced
memfd-and-copy write path restores docs-macos identically and respects a pre-existing file.

**Command line**: a named snapshot with and without `.tsv.gz`; the latest chosen when none is named
(edge-linux picks `2026-10-23T0100` over `T0058`); usage error exit 2; unknown set, missing snapshot and a
403 (session token withheld) exit 1 with the reason.

**Not tested, and why**: 5xx and dropped-connection retries (cannot be provoked against the real bucket);
keys in a sub-folder of `snapshots/<set>/` or with odd names (none exist, and the bucket is read-only);
listing pages beyond 1000 keys (no prefix that large); `NoSuchBucket` (would mean addressing another bucket);
the deletion-record compaction race; a cross-filesystem `EXDEV` link fallback (not reachable here). All of
those paths exist in the code but have run only in review.

## Files

- `s3cab-restore.c`, `Makefile`, `s3cab-restore` (built from the final source).
- `work/check.py` (independent checker), `work/mktests.py` and `work/runtests.sh` (crafted-snapshot tests),
  `work/tests/` (the crafted files), `work/dumps/` (decompressed snapshot texts), `work/records/` (the six
  deletion records as fetched), `work/logs/` (every run's output, `SWEEP.txt`, `CHECK.txt`, `TESTS.txt`).
- `NOTES-findings.md`: the running log of guesses as they were made, which this report is distilled from.

## Differences from the reference

`reference/` holds the tool's own restore of each of the 42 snapshots. `work/compare.py` compared every
tree with mine (the first-phase restores under `$TMPDIR/restores`, made by the binary the sweep used; the
script's output is `work/logs/COMPARE.txt`): the set of relative paths as bytes, every file's content,
every file's `st_mtime_ns`, permission bits, and the set of directories. Three snapshots were then
restored again with the final binary and compared the same way (`work/logs/final-*.log`), with the same
result.

**Paths, content, directories and modes: identical in all 42.** The 36 snapshots that restore something
hold the same 3,980 files at the same relative paths with the same bytes and modes, and no directory
exists on one side only. For the six truncated `faults` snapshots and the three `hollow` sets the
reference directory is empty and mine does not exist, which `RECONCILE.md` defines as a match.

**Modification times: one difference, repeated 3,878 times, never larger than 119 ns.**

- *What differs.* 102 files carry the identical `mtime_ns` on both sides. The other 3,878 differ by
  between 3 and 119 nanoseconds, in both directions. Mine hold the row's instant exactly
  (`…242000000`); the reference holds, for example, `…242000102` or `…243999958`.
- *Cause.* The reference set its times through an interface that takes seconds as a double. A double near
  1.79 × 10⁹ s has a spacing of 238.4 ns, so the nearest double to a stored instant is up to 119.2 ns away
  from it, and converting that double to a `timespec` truncates the fraction to whole nanoseconds. Taking
  each of my exact values, converting it to the nearest double, splitting it into whole seconds and
  truncating the remainder to nanoseconds reproduces every one of the 3,878 reference values, with no
  exception. The 102 exact matches are the instants whose millisecond fraction a double holds exactly:
  `.000`, `.250`, `.500`, `.625` and `.750`.
- *Whose it is.* Not a bug in my restorer, and not a gap in the spec: the spec names this behaviour under
  "Setting a modification time" ("a restored file can land up to about a hundred nanoseconds off its row.
  s3cab's own restore does, where the filesystem keeps nanoseconds; setting the time through a nanosecond
  interface is exact") and rules that times are compared rounded to the millisecond, at which resolution
  the two trees are identical. It is a documented imprecision of the reference. I have **not** changed the
  restorer to reproduce it: `utimensat`/`futimens` sets the stored instant exactly, which is what the rule
  asks for, and matching the float error would mean copying a flaw the spec already warns about. If the
  bar is a byte-identical `st_mtime_ns` against the reference rather than against the row, that is a
  decision for the spec to state, and the change would be a one-line conversion through a `double`.
- *One consequence worth recording.* A tree restored by s3cab and one restored by a nanosecond-exact tool
  will differ under any comparison finer than a millisecond (`rsync -c` is fine; `rsync` with
  `--modify-window=0`, `diff -r` with timestamps, or a byte comparison of `stat` output will report
  every file). The spec says to compare rounded; a sentence in the restorer checklist saying that s3cab's
  own output is *not* exact at nanosecond resolution would stop a reader from hunting a bug in their own
  code, as I would have without the hint.

No other difference was found, so nothing in the first-phase restorer was changed for this phase; the
binary in this directory is built from the final source, which differs from the first phase's only by the
three debug knobs added during testing (`S3CAB_RESTORE_LOCAL_SNAPSHOT`, `S3CAB_RESTORE_DUMP_RECORDS`,
`S3CAB_RESTORE_NO_TMPFILE`), none of which alters default behaviour.
