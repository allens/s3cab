# The format-spec clean-room audit, run 25: restore on Linux, Fable 5.1 at xhigh (2026-11-09)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on
[Linux](format-spec-audit-22.md), [macOS](format-spec-audit-23.md) and
[Windows](format-spec-audit-24.md); restores on Linux (this run), [macOS](format-spec-audit-26.md)
and [Windows](format-spec-audit-27.md).

- **Program:** [`crestore/`](../scripts/cleanroom/restorers/crestore/), C with OpenSSL and zlib over
  its own HTTP client; no S3 library. Its notes, logs and test tools stay with the run, outside the
  repo.
- **Checker:** the spec-only phase's restorer matches. The reconcile phase never ran: the session
  hit the plan's 5-hour limit before it began, so the final check ran the same program, and it
  matches too. The spec-only verdict is the evidence about the format.
- **Audit:** 3 moves flagged, each writing or patching the session's own source; the judge found
  all three harmless. The judge's CI step hit the same limit, so it was run by hand afterwards,
  with the same script and model.
- **Tokens, spec-only phase:** input 2,212, cache write 340,078, cache read 12,387,091, output
  175,714.

Everything below the rule is the session's own report, verbatim. With no reconcile phase, it has no
*Differences from the reference* section.

---

# Clean-room reading of `format.md` (spec of 2026-10-30)

An independent restorer for the s3cab format, written in C from `format.md` alone, and the gaps
the reading found. The restorer is `./s3cab-restore <bucket> <set> <dir> [<snapshot>]`, built by
`make` from `src/`. It talks to S3 over its own HTTP/1.1-over-TLS client (OpenSSL), signs with
SigV4 by hand, inflates with zlib, and uses nothing from AWS. Test tooling I used is in `tests/`
and is not part of the restorer.

## Outcome in one paragraph

The format is restorable from the spec alone. Every one of the 36 snapshots in the 24 sets of
the bucket was fetched and processed over the network; 30 restored, each verified byte for byte
(SHA-256, size, mtime to the millisecond) against its snapshot by an independent checker, with
no stray files; 6 truncated snapshots were refused whole as the spec requires; the planted
faults (an object whose bytes don't hash to its key, a missing object, a deliberately deleted
one, a row under no `@SET DIR`, a duplicated path, a `..` segment, a case-mismatched path) were
each caught and reported as the spec says, with the exit status the spec says. I did not need the
`aws` CLI to get signing right: the first signed request succeeded, and the one failure after
that was a C bug of mine, diagnosed from S3's own error body. The spec is unusually thorough;
most of what follows is small, and I found nothing in it that was outright wrong.

## Would corrupt a restore

Points where a plausible second reading changes what lands on disk, or lets a partial restore
pass as a full one. None of these is large; I rank them here because the spec itself ranks
"never lets a partial restore pass for a full one" as the reader's promise.

1. **How to tell "a destination this restore wrote" from "one that was there before" is left to a
   hint.** The rule (Reading checklist) says to tell the two apart, and that the first is skipped
   with exit 0 while the second is a collision with exit 1. *How* is only in the hints (device and
   inode, or Windows file ID). A reader that keys on the destination's path string, which is the
   obvious implementation, reports a case twin on a case-insensitive disk as "already there",
   exit 0, which is exactly the partial-restore-passing-as-full the promise forbids. The spec
   knows this (the .NET hint says so) but never makes identity part of the rule.
   *What I did:* kept the (dev, inode) of every file written and checked an existing destination
   against that set. Tested with two paths landing on one file (`/C/a.txt` and `C:\a.txt`,
   `/UNC/nas/photos/x` and `\\nas\photos\x`): first restored, second reported as a collision,
   exit 1.

2. **The deletion record's `.` is not defined for a record.** The snapshot section defines the
   terminator byte for byte and says a line that merely trims to `.` is "neither the `.` nor a
   row". The record rules say only that well-formed rows "before any `.`" count. A reader that
   stops at the first line that *trims* to `.` and one that stops only at the exact `.` count
   different rows in a hand-edited record, and a row only one of them counts decides whether a
   missing object is "deliberately deleted, exit 0" or "damage, exit 1". The safe direction is
   damage, but the spec's text points both ways.
   *What I did:* stop at the exact line `.`; anything else is a row (well-formed or not). Only
   contrived records trigger this; the six real records in the bucket are canonical.

3. **"A zero byte after a stream ends the file" is stated, but what it protects against is not,
   and it can hide rows.** The rule is clear enough to follow, and I followed it (tested: gzip
   stream + `\0garbage\x1f\x8b` restored the first stream's rows and ignored the rest). But a
   second gzip member *after* a zero byte is silently dropped, where `gunzip` and Python's
   `gzip.decompress` (which also skips zero padding, I checked) would both read it if the padding
   weren't there. Nothing is lost as long as the first member ends with `.`; I note it because
   the spec explains every other gzip rule and not this one, so a reader is tempted to "improve"
   on it and then disagrees with s3cab.

## Would inconvenience the implementer

Guesses I had to make, or places where the right reading was there but easy to miss. Each turned
out, as far as the bucket can tell, to be the intended one; they are reported anyway.

1. **`@SET DIR` classification must happen before trailing separators are stripped.** The spec
   says "decide first whether the DIR is a Windows path, from the row as written; then ignore
   every separator it ends with", which is right, but a reader that strips first turns `C:\` into
   `C:` (no longer a drive root) and `/` into the empty string, and refuses every row on a root.
   The ordering deserves its own sentence in the checklist. *Guess:* classify, then strip, then
   segment; a DIR left with fewer bytes than its root has zero segments. Tested: DIRs `/`,
   `C:\foo\\`, `/p//` and `//` behaved as the spec says (`//` matches nothing).

2. **Final_Sigma needs the Unicode properties "cased" and "case-ignorable", which the spec doesn't
   define and the C library doesn't expose.** The hint says "a per-character mapping plus
   [U+0130 and Final_Sigma] is all of it", but Final_Sigma's condition (preceded by a cased
   letter, not followed by one, skipping case-ignorable characters) is where readers will differ.
   A disagreement makes one reader refuse a row the other restores; never wrong bytes, so it
   sits here rather than above. *Guess:* `towlower` under `C.UTF-8` for the per-character map,
   U+0130 → `i` + U+0307, and Final_Sigma with `iswupper || iswlower` as "cased" and a hand list
   of combining marks, format characters, modifier letters and `'`, `.`, `:`, `·` as
   case-ignorable. Tested: `C:\οδος\y.txt` matched DIR `C:\ΟΔΟΣ\`, `C:\οδοσ\z.txt` did not,
   `été` matched `ÉTÉ`, and `İstanbul` did not match `istanbul` (its lowercase is `i̇stanbul`).

3. **Whether the restorer creates `<output>` and its missing parents.** The spec only implies
   it ("a restore that writes nothing makes no `<output>` either, nor any missing parent of
   it") and says `<output>` and the folders above it may be links. *Guess:* create them, with
   `stat` (following links) for those components and `lstat` (refusing links) for everything
   inside `<output>`; count them among "the folders made for" the first file so a failed first
   file leaves nothing. Tested: hollow sets (no rows) left no output directory at all.

4. **A file row with fewer than five fields has an empty path, which the spec says to "refuse one
   path" on.** What to report, and whether the empty path takes part in the duplicate check, is
   unsaid. *Guess:* report the line number with the (empty) path; it takes part like any other.

5. **Which separators count as the ones a `@SET DIR` "ends with".** *Guess:* those of its own
   kind: `\` and `/` for a Windows DIR, `/` alone for POSIX, so a POSIX DIR ending in `\` ends
   in a name character. Tested: DIR `/d\e/` held `/d\e/x` and not `/d/e/x`.

6. **The `[<snapshot>]` argument form is not the format's business, but the spec's two names for
   a snapshot (`20260612T0915` and `20260612T0915.tsv.gz`) invite both.** I accept either.

7. **Exit codes.** The spec promises only zero/nonzero. I use 1 for anything per-path and for a
   refused snapshot, 2 for a fatal stop (network, listing, no such set, missing credentials).

8. **"s3cab stops the whole restore on any other failure" versus "restore everything you can".**
   Consistent once read closely (the "other failures" are the ones that say nothing about the
   file), but the two sentences sit in the same checklist and a skim reads them as a conflict.

9. **The restore-layout rule says "the root turned into a folder" for drives and shares and
   "`/` has none" for POSIX.** It took the examples to be sure a POSIX path is simply appended
   to `<output>`. Tested on every set.

10. **Listing a folder is described, but not that S3 pages at 1000 keys.** The "Listing a folder"
    hint should say so, since a set with more than a thousand snapshots would otherwise silently
    never restore its latest. The bucket's `objects/` folder has 3,821 keys and my paged listing
    read all of them (not needed for a restore; done to exercise the code).

## Hints that would have helped

Traps in C or Linux I met that the spec's hints do not mention, or mention only in passing.

- **`O_TMPFILE` without `AT_EMPTY_PATH`.** The spec says `linkat` with `AT_EMPTY_PATH` is
  unprivileged only from Linux 6.17 (true: it worked here on 7.0 with no capabilities).
  `linkat(AT_FDCWD, "/proc/self/fd/N", AT_FDCWD, dest, AT_SYMLINK_FOLLOW)` has done the same on
  every kernel for a decade and is what my restorer uses. One trap either way: an unnamed inode
  can be given a name only once; after a link-then-unlink the second `linkat` fails with
  `ENOENT`, which I hit in a test program.
- **OpenSSL 3 deprecates `SHA256_Init`/`Update`/`Final`**; use `EVP_DigestInit_ex` and friends.
  The one-shot `SHA256()` and `HMAC()` still compile cleanly.
- **Ubuntu 24.04's gcc 13 accepts `-std=c2x`, not `-std=c23`.**
- **`renameat2` and `RENAME_NOREPLACE` need `_GNU_SOURCE`** (glibc 2.28 and later have the
  wrapper). Used in my fallback path and tested by forcing it.
- **Decode before you escape when printing a path.** U+0085 is two bytes in UTF-8, so a
  byte-wise "spell out bytes under 0x20" misses it; the spec's own example (`nextline.txt` in the
  edge set) printed raw until I decoded code points first.
- **`snprintf("%s", NULL)` prints `(null)`** and signs it into your canonical request. My one
  SigV4 failure was exactly this on an empty query string; S3's 403 body echoes the canonical
  request it expected, which is the fastest way to find such a mismatch.
- **S3 error bodies arrive `Transfer-Encoding: chunked`** even though object bodies carry
  `Content-Length`; a hand-written HTTP client needs both.
- **glibc's `C.UTF-8` `towlower` really does map non-ASCII** (`É`→`é`, `Σ`→`σ`), as the spec
  says; it is not the "C" locale's ASCII-only table.
- **zlib in gzip mode (`inflateInit2(…, 15+16)`) already checks the header CRC and refuses
  reserved flag bits**, so the spec's "read the gzip framing yourself" is for .NET, not C. The
  messages I saw for the spec's cases: "incorrect data check" (bad CRC-32), "header crc mismatch",
  "unknown header flags set", "incorrect header check" (zlib wrapper or a leading zero byte), and
  `Z_BUF_ERROR` with `avail_in == 0` for a cut stream, all as the spec's hint says.
- **relatime moves atime on the first read after the restore sets atime = mtime.** The spec
  says this for the restorer's own read-back; it also bit my *verifier* on its second pass. Stat
  before reading, and don't expect atime to survive anyone's read.
- **ext4 clamps years outside 1901–2446 exactly as the spec says**, to
  1901-12-13T20:45:52Z and 2446-05-10T22:38:55Z; reading the time back caught both and exited 1.

## Environment notes, not the format

- **Toolchain.** Ubuntu 24.04, gcc 13.3 (`-std=c2x`), glibc 2.39, OpenSSL 3.0.13, zlib 1.3,
  kernel 7.0 (Azure), ext4. libcurl's runtime is installed but its headers (`libcurl4-openssl-dev`)
  are not, and the Ubuntu archive is blocked by the sandbox's allow-list, so I wrote a small
  HTTP/1.1 client over OpenSSL (`src/http.c`: CONNECT proxy with Basic auth, TLS 1.2+, SNI,
  hostname verification against the system CA bundle, `Content-Length` and chunked bodies,
  keep-alive with one reconnect). Libraries used: libssl, libcrypto, libz, all packaged.
- **Proxy.** `HTTPS_PROXY` is an HTTP CONNECT proxy on `localhost:3128` with credentials in the
  URL; it does not intercept TLS (the chain seen was Amazon's). A program ignoring the variable
  cannot connect, as `ENVIRONMENT.md` says.
- **Signing.** SigV4 from memory: canonical request with `host`, `x-amz-content-sha256`
  (hash of the empty body), `x-amz-date` and `x-amz-security-token`; scope
  `date/us-east-1/s3/aws4_request`; keys and object paths URI-encoded once, query parameters
  sorted. The first signed request (a `ListObjectsV2`) succeeded. The `aws` CLI was run once,
  `aws s3 ls` on the bucket root, to confirm reachability as `ENVIRONMENT.md` suggests, and the
  `curl` binary once to look at the TLS chain and proxy exchange; neither was needed for signing.
- **Endpoint.** Virtual-hosted style, `<bucket>.s3.<region>.amazonaws.com`; path-style for a
  bucket name holding a dot. `AWS_REGION` first, then `AWS_DEFAULT_REGION`, then `us-east-1`.
- **The bucket.** 24 sets (`bulk`, `corrupt`, `docs`, `edge`, `faults`, `hollow`, `media`,
  `spread`, each for linux, macos and windows), 36 snapshots, 6 deletion records
  (`-1,-3,-4,-6,-7,-9`), 3,821 objects, written by `s3cab 0.2.0-alpha.2`. The 16 snapshots I
  inspected byte by byte are each a single gzip member with flags 0; the restorer's gzip rules
  were exercised on the crafted files instead.
- **Retries** as the checklist prescribes (dropped connection for two minutes, 5xx three
  attempts) are implemented but were never exercised: no request failed at the transport level
  and S3 returned no 5xx during the run.
- **Test hooks**, both environment variables, exist only for testing: `S3CAB_SNAPSHOT_FILE`
  reads the snapshot bytes from a local file (objects still come from the bucket), and
  `S3CAB_NO_TMPFILE` forces the temp-file-plus-`renameat2` fallback. `S3CAB_DEBUG` prints the
  canonical request.

## What was run, and what it showed

**Real snapshots, all 36, over the network.** Each restored into its own empty folder and checked
by `tests/verify.py`, which recomputes the destination from the spec's layout rule, hashes every
restored file, and compares size and mtime at millisecond resolution.

| Set (×3 OS) | Snapshots | Result |
| --- | --- | --- |
| bulk | 1 each | 1100 restored each, verified, exit 0 |
| docs | 1 each | 120 restored each, verified, exit 0 |
| media | 1 each | 2 restored each (one 40 MiB), verified, exit 0 |
| spread | 1 each | 6 restored each from two `@SET DIR`s, verified, exit 0 |
| hollow | 1 each | 0 rows; no output folder created, exit 0 |
| edge | 2 each | 59/54/29 restored each (linux/macos/windows), verified, exit 0 |
| corrupt | 1 each | 2 restored; `b-corrupt.txt` withheld (download hashes to another value); exit 1 |
| faults | 4 each | see below |

The `edge` sets include names with leading and trailing spaces, VT, FF and NEL, `\` in a POSIX
name, `a"b`, `a*b`, `a:b`, `a<b`, `a>b`, `a?b`, `a|b`, `CON`, `aux.txt`, `notes.`, NFC and NFD
`café.txt` side by side, `Case.txt` beside `case.txt`, an emoji name, a 12-level deep tree,
mtimes of 1969-12-30, 1970-01-02, 2038-01-19 and 2300-01-01, the empty object, and
deduplicated content. All restored and verified.

The `faults` sets, per OS: two snapshots cut before compression (no `.`) refused whole with
nothing written, exit 1; one intact snapshot with `deleted.txt` (deliberately deleted per
`objects.deleted-3/6/9.tsv`, dated after `START`: skipped with its date), `recoverable.txt`
restored, `torn.txt` missing from `objects/` with no record (damage), exit 1; and one snapshot
with the same three plus `faultsX/beside.txt` (under no DIR), `twice.txt` twice (both refused),
`faults/../../escaped.txt` (`..` segment), and on linux and macos `FAULTS/case.txt` (under no DIR,
exact match); the windows one omits the case row. Case-insensitive `@SET DIR` matching on
Windows paths was exercised by the crafted cases, not by the bucket, whose Windows rows all
spell their DIR exactly.

**Obstacle tests** (docs-linux restored again into prepared folders): all 120 pre-existing files
skipped, exit 0; a folder planted where a file should land, a regular file where a folder should
be, and a symlink where a folder should be were each reported "in the way", left untouched (the
link's target was not created), exit 1.

**Crafted snapshots** (`tests/craft.py`, 54 cases, fed through the real restorer with objects
fetched from the bucket). Refused whole, nothing written, exit 1: no `.`; `.` without LF; a
blank line; CRLF endings; an unknown type `+`; a type that trims to empty; invalid UTF-8; heading
with a trailing space, a fifth tab, or `@s3cab`; `.` not last; a blank line after `.`; `.` with a
tab or a leading space; gzip followed by non-gzip bytes; bad CRC-32; bad header CRC; reserved flag
bit; zlib wrapper; cut-short stream; a leading zero byte; a second stream cut short. Accepted:
BOM; two members; zero-byte padding; FEXTRA/FNAME/FCOMMENT/FHCRC header; unknown `@` and `#`
rows and `@SET dir`/`@set DIR` (skipped); fields padded with U+00A0, U+3000, U+FEFF, U+2028;
heading in canonical padding; a type field ` - `. Per-row: uppercase hash, `-1` and empty size,
30 February, hour 24, `+00:00` offset, tab, CR and NUL in a path, relative path, directory path,
`..` and empty segments, path equal to a DIR, path under no DIR, duplicated path (including a
malformed twin refusing its good sibling), one path running through another (both refused, POSIX
and Windows) were each refused with the rest restored, exit 1. Size `0000` and a size that
disagrees with the object were restored (the hash decides). Deletion logic: a recorded hash with
`START` before the record's instant reported deleted (twice, fetched once); `START` after, equal,
absent, or repeated with the last one invalid reported damage; repeated with the last one valid
reported deleted. Year 0000 and 9999 mtimes restored but reported as not kept (ext4 clamp),
exit 1. A 255-byte name restored; a 256-byte name reported as one the destination won't hold,
exit 1.

**Things I did not test.** Retries (no failure occurred to retry). Windows and macOS destinations
(this is Linux). A multi-part-sized object above 5 GiB (largest in the bucket is 40 MiB). The
`.info` files and `locks/`, which a reader ignores.

## Files

- `s3cab-restore` — the built restorer (`make` rebuilds it).
- `src/http.c` HTTP/1.1 over TLS with CONNECT proxy; `src/s3.c` SigV4, GET, ListObjectsV2;
  `src/gz.c` the gzip rules; `src/text.c` UTF-8, trim set, field split, instants, lowercasing;
  `src/snap.c` snapshot and record parsing and every validity rule; `src/main.c` the restore.
- `tests/verify.py` independent checker of a restored tree against its snapshot;
  `tests/craft.py` generator of the crafted cases, each with the outcome I expected from the spec.
