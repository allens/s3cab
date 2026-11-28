# The format-spec clean-room audit, run 32: restore on macOS, Fable 5.2 at xhigh (2026-11-27)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.2 at
`xhigh`, all reading the spec of 2026-10-30 as of
[PR #527](https://github.com/allens/s3cab/pull/527). The set so far: backups on
[Linux](format-spec-audit-28.md), [Windows](format-spec-audit-29.md) and
[macOS](format-spec-audit-30.md); restores on [Linux](format-spec-audit-31.md) and macOS (this
run).

- **Program:** [`swiftrestore/`](../scripts/cleanroom/restorers/swiftrestore/), Swift 6 with
  Foundation, and macOS's libcurl, zlib, CommonCrypto and ICU through a bridging header; no S3
  library. The reconcile phase left it unchanged; its notes, logs and test tools stay with the run,
  outside the repo.
- **Checker:** the spec-only phase's restorer matches, and so does the reconcile phase's. The
  spec-only verdict is the evidence about the format.
- **Audit:** 2 moves flagged: one running its own restorer through a dead proxy port on
  `127.0.0.1` to test a refused connection, and one caught only by the word "s3cab" while adding
  its guesses to its own report; the judge found both harmless.
- **Tokens, both phases:** input 192, cache write 431,687, cache read 23,252,784, output 287,683.

Below the rule: the spec-only phase's report verbatim, which provably predates every reference, then
the *Differences from the reference* section the reconcile phase added, verbatim. The few lines the
reconcile phase changed elsewhere in the report are left out.

---

# REPORT — an independent restorer for the s3cab format, written from `format.md` alone

Spec read: `format.md`, "the spec of 2026-10-30". Nothing else about the format was read: not
the tool, its source, its site, its other pages, nor the `.s3cab/` folder or the `.info` files
in the bucket. Every guess below is therefore **unconfirmed**: I could check a guess against
the bucket's data and against my own reading, never against s3cab.

## 1. Outcome

- **The restorer exists and works.** `./s3cab-restore <bucket> <set> <dir> [<snapshot>]`,
  Swift 6.3.3 in Swift 6 language mode, about 1,700 lines in `src/`. It links only what macOS
  ships (libcurl, zlib, libicucore, CommonCrypto, Foundation), has no AWS SDK and no S3
  library, and runs no other program.
- **Authenticated requests never defeated it.** The signing was written from memory and the
  first signed request succeeded. I did not need the `aws` CLI to get signing right (§7).
- **Every snapshot in the bucket was restored or refused as the spec says.** 36 snapshots in
  24 sets: 30 read and restored (3,972 files, 133,885,442 bytes; three of the 30 are empty
  sets), 6 refused whole. An independent checker found no discrepancy (§3).
- **The spec was enough.** I made 21 guesses (Appendix A). None of them changed what was
  restored from any snapshot s3cab itself wrote. Three could change a restore of a
  hand-edited or hand-placed file (§4).
- **One hint in the spec is wrong, and following it would have produced a restorer that
  disagrees with s3cab** about which Windows rows restore: Foundation's
  `lowercased(with: nil)` does not lower-case as JavaScript does (§6, item 1).

## 2. The restorer

| | |
| --- | --- |
| Build | `sh build.sh` → `./s3cab-restore` (left built from the final source; SHA-256 `358c0a6d…219c7`) |
| Environment | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (when the credentials have one), `AWS_REGION` else `AWS_DEFAULT_REGION` else `us-east-1`; `HTTPS_PROXY` is honoured by libcurl |
| Layout | s3cab's own restore to a chosen directory, as the spec describes it: `<dir>/<whole path>`, a drive as its upper-case letter, a share as `UNC` |
| Exit 0 | every file row restored, skipped because a file was already there, or deliberately deleted |
| Exit 1 | at least one row refused, missing, withheld, in a collision, in the way, or left with a time the disk didn't keep; everything else was still restored |
| Exit 2 | the restore could not start or had to stop: snapshot refused whole, a request failed, bad arguments |
| Extra | `./s3cab-restore --list <bucket>` prints `set<TAB>snapshot` for the whole bucket. Not asked for; I added it so that finding the sets was also done by my own signed requests |

Its last output line counts rows: `restored N, skipped N already there, N deliberately
deleted, N failed`. A file kept with a time the disk couldn't hold counts in both `restored`
and `failed`.

What it deliberately does not do: overwrite (there is no flag for it), custom endpoints
(AWS only; I had no other real store to test against), and the FAT/exFAT fallback for a
file identity that doesn't last the run.

## 3. What was run, and what it showed

All of it is repeatable: `tests/` holds every script, and the last full run was made with
the final binary.

### 3.1 Every snapshot, from the real bucket (`tests/restore-all.sh`)

Each snapshot was restored by name into its own empty folder. "linux / macos / windows" are
the three variants of each set, which behave alike unless noted.

| Set (×3) | Snapshots each | File rows | Result | Exit |
| --- | --- | --- | --- | --- |
| `bulk-*` | 1 | 1,100 | all restored | 0 |
| `docs-*` | 1 | 120 | all restored | 0 |
| `media-*` | 1 | 2 (40 MiB and 0.5 MiB) | all restored | 0 |
| `spread-*` | 1 | 6, under two `@SET DIR`s | all restored | 0 |
| `hollow-*` | 1 | 0 | nothing written, no folder made | 0 |
| `corrupt-*` | 1 | 3 | 2 restored; 1 withheld: the object is there but doesn't hash to its key | 1 |
| `edge-linux` | 2 | 59 | 57 restored; 2 collisions; 1 of the 57 kept with the wrong time | 1 |
| `edge-macos` | 2 | 54 | all restored | 0 |
| `edge-windows` | 2 | 29 | 27 restored; 2 collisions | 1 |
| `faults-*`, oldest | 1 of 4 | — | refused whole: no final `.` (it ends in an `@S3CAB VERSION` row) | 2 |
| `faults-*`, second | 2 of 4 | 8 (windows: 7) | 1 restored, 1 deliberately deleted, 1 missing, 5 refused (windows: 4) | 1 |
| `faults-*`, third | 3 of 4 | — | refused whole: cut short after the file rows, no `.` | 2 |
| `faults-*`, latest | 4 of 4 | 3 | 1 restored, 1 deliberately deleted, 1 missing | 1 |

- The two **collisions** in `edge-linux` and `edge-windows` are the destination's doing, as
  the spec predicts for macOS: `cafe\u0301.txt` and `caf\u00e9.txt` are one file to APFS, and so
  are `case/Case.txt` and `case/case.txt`. The first row in the file landed, the second was
  reported.
- The **wrong time** is `mtime-2300.txt`: stored `2300-01-01T00:00:00.000Z`, and APFS kept
  `2262-04-11T23:47:16.854775807Z`. Reported, exit 1, file kept, as the spec asks.
- The **five refused rows** of the second `faults` snapshot: a path beside the `DIR`
  (`faultsX/`), one path in two rows (both refused), a `..` segment, and on linux and macos
  `FAULTS/case.txt`, which an exactly-matched POSIX `DIR` doesn't hold.
- `deleted.txt` is **deliberately deleted**: its hash is in `objects.deleted-3.tsv` (`-6`, `-9`
  for the other two systems) with an instant after the snapshot's `START`. `torn.txt` is in no
  record, so it is damage.
- **Presence wins**, on real data: the `edge` sets' `dedup-a.txt` hash is listed in a deletion
  record, and the object is back in the bucket. Both `edge` snapshots restored it, the earlier
  one included.

### 3.2 An independent look at what was written (`tests/check.py`)

A separate program in another language (the system's `/usr/bin/python3`), sharing no code
with the restorer. It gets the snapshots, the deletion records and the `objects/` listing
through the `aws` CLI, reads each snapshot the way "Recovering by hand" describes, and looks
at the disk. Over all 36 restores it found **no problem**:

- all 3,972 files hash to their row's hash, at the path the layout rule gives, under names
  that are byte-for-byte the row's (the directory walk finds each under its exact spelling);
- every modification time equals the stored one to the nanosecond (`time-off(ns)=0` for 28
  of the 30 restores), except the two `mtime-2300.txt` (1,190,419,963.145 s off, and reported
  by the restorer);
- every row with no file is explained by the bucket (object absent, or present and corrupt)
  or by a refusal the restorer printed; nothing was left silently;
- no file that no row accounts for, no empty folder, no temporary file, no link;
- the six snapshots without a `.` left no folder at all, and exited nonzero.

One number in its output looked like a failure and was not: the access time differed from
the modification time on almost every file. See §6, item 3.

### 3.3 Behaviours, against the real bucket (`tests/scenarios.sh`, 77 expectations, all pass)

| Checked | Result |
| --- | --- |
| No snapshot named, all 24 sets | picks the name that sorts last; same tree and exit status as naming it |
| Second restore into the same folder (`edge-linux`) | all 59 rows skipped, the colliding twins included; exit 0; no file's inode, time or size changed |
| A folder where a file should land | reported as in the way, exit 1 |
| A file already at a destination | skipped, content untouched |
| A link at the file's own name | skipped as a file already there; the link's target untouched |
| A link where a folder should be | in the way; nothing written through it |
| A file where a folder should be; a file at `<output>` itself | in the way for every row beneath; exit 1 |
| `<output>` is a link to a folder; `<output>` three missing levels deep | allowed; made |
| Empty snapshot, and a refused one, with a missing `<output>` | no folder made |
| `AWS_REGION=us-west-2` and `eu-central-1` | S3 answers 301; the restorer follows to `us-east-1` and restores |
| No region set | `us-east-1` assumed; works |
| Wrong secret key; session keys without their token | HTTP 403, exit 2, nothing written |
| A set or snapshot that isn't there; malformed set and snapshot names | exit 2, nothing written |
| All pages of a listing | 3,821 keys under `objects/` over four pages, the count the CLI gives |
| A proxy that refuses connections (run once by hand, not in the script: it takes two minutes) | retried for 120 s, then `Couldn't connect to server`, exit 2, nothing written |

### 3.4 Hand-made snapshots, real objects (`tests/local-cases.py`, 42 expectations, all pass)

The bucket's snapshots never name one missing object twice, never spell one Windows file two
ways, hold no share path, and never fail on every row. To reach those paths I built a second
program from the restorer's own sources (`tests/.build/restore-local`) that reads the snapshot
**text** from disk and then restores normally: **every object and deletion record is still
fetched from the real bucket with a signed request.** These are not restores of any bucket
snapshot, and are reported separately for that reason.

| Checked | Result |
| --- | --- |
| `C:\P\a.txt`, `C:/P/a.txt`, `c:\P\a.txt`, `/C/P/a.txt` | first lands; three collisions; exit 1 |
| `C:\P\b` then `C:/P/b/c.txt` | second is in the way: a file where its folder should be |
| `\\nas\photos\a.jpg`, `//NAS/photos/sub\b.txt` | land under `UNC/nas/photos/`, one folder on this disk |
| One missing, one deleted, one corrupt object, each named by two rows | reported twice, fetched once: 12 requests in all |
| A row whose hash is known missing, landing on a file this restore wrote | reported as missing, not as a collision |
| A row that landed nothing, then another for the same destination | the second restores |
| Every row fails after its folders were made | no folder left, not even `<output>` |
| `START` before / equal to / after the real record's instant; absent; not an instant; repeated; four fields | deliberate only when strictly before, and for the four-field row |
| Size column wrong, hash right | restored |
| Stored time `0000-01-01…` and `9999-12-31…` | kept at `1677-09-21T00:12:43.145224192Z` and `2262-04-11T23:47:16.854775807Z`; reported; exit 1 |
| Stored time `2262-04-11T23:47:16.855Z` | disk holds `…16.854775807Z`: equal once rounded to the millisecond, so not reported |
| A 300-byte name | reported, exit 1, no folder left for it, the rest restored |
| A name holding ESC, U+0085 and U+2028 | restored under that name; printed with the characters spelled out |
| A file there before, for a hash already known missing | skipped |

### 3.5 The parser alone, on files on disk (`tests/parser-cases.py`, 263 cases, all pass)

No network, and so no restore result: this is the spec's rules turned into cases and run
through the restorer's own parser. It covers what the bucket has no example of: the gzip
framing rules (several streams, zero padding, trailing bytes, cut streams, bad CRC, header
fields), every whole-file refusal, the trim set character by character, every row rule, `DIR`
matching for POSIX, drive and share paths, and deletion records that are invalid in each way
the spec lists. It also pins the guesses, so each is visible as a case.

### 3.6 What was not tested, or only on disk

- **Never against the bucket, only on disk (§3.5):** every gzip rule beyond "one good
  stream"; every whole-file refusal except "no final `.`"; row refusals other than the three
  the `faults` snapshots hold; case-insensitive `DIR` matching (no bucket snapshot has a
  Windows row whose case differs from its `DIR`); invalid deletion records (all six real ones
  are valid).
- **Not tested at all:** a 5xx retry and `503 SlowDown` (I can't make S3 fail); a 404 with no
  error code or a non-XML body (AWS always sends a code); a key that `encoding-type=url`
  would have to escape; a time the disk rounds by less than 2 seconds (APFS keeps
  nanoseconds); the rename losing a race; a bucket name with a dot (path-style addressing).
  The code for each is there and has never run against a real case.
- **Not implemented:** see §2.

## 4. Would corrupt a restore

Ranked by how likely the divergent reading is, then by how quietly it fails. All three need
a file s3cab did not write. *The one thing in this run that would actually have produced a
wrong restorer is not in this list because it is a hint, not a rule: §6, item 1.*

1. **A `@SET DIR` with no trailing separator: does it match, or match nothing?**
   - *Spec:* a `DIR` is "always ending in one separator"; matching says to "ignore every
     separator of the `DIR`'s own kind that it ends with", with examples that all end in at
     least one. Nothing says whether a `DIR` ending in none is a `DIR` (`/home/me/Photos`,
     the natural hand edit).
   - *Guessed:* none is matched like one.
   - *The other reading:* it matches nothing, so every file row is refused and the restore
     writes nothing. Loud (nonzero exit), but two readers then disagree on a whole snapshot.
   - *Ran:* the case `dir: without its trailing separator` shows what mine does. Every real
     `DIR` ends in one separator (`tests/canonical.py`), so the bucket can't settle it.

2. **"Digits" are only said to be ASCII for the size column.**
   - *Spec:* a snapshot is a key "named exactly `YYYYMMDDTHHMM.tsv.gz`, digits in those places
     and nothing more"; a record's `<n>` is "decimal digits"; a time is "exactly
     `YYYY-MM-DDTHH:MM:SS.sssZ`: 24 characters". Only the size is "the ASCII digits `0` to `9`".
   - *Guessed:* ASCII everywhere.
   - *The other reading:* a Unicode-aware digit test, which is the default in several
     languages. A key named in full-width digits then counts as a snapshot, sorts after every
     ASCII name, and **is the latest**: that reader restores a file s3cab ignores, exit 0. The
     same test accepts `objects.deleted-１.tsv` as a record, whose rows can then turn damage
     into a deliberate deletion.
   - *Ran:* `/usr/bin/python3`: `re.fullmatch(r'\d{8}T\d{4}\.tsv\.gz', …)` matches the
     full-width name, `int('１')` is 1, and the key sorts last in byte order. Mine refuses all
     three (cases `names: …`, `row: time …`). The spec warns of exactly this for .NET's `\d`,
     in a hint; the rule itself doesn't say ASCII.

3. **The minute of a time has no stated range.**
   - *Spec:* "a day the proleptic Gregorian calendar has, hours `00` to `23`, seconds `00` to
     `59`". Minutes are not mentioned.
   - *Guessed:* `00` to `59`.
   - *The other reading:* check what the spec lists and hand the rest to a date library. The
     spec itself notes such parsers roll `24:00` into the next day "without a word"; the same
     happens to `12:75`. That reader restores the file with a time the row never held, exit 0,
     where mine refuses the row.
   - *Ran:* case `row: time b'2025-06-01T23:60:00.000Z'`: refused by mine.

## 5. Would inconvenience the implementer

Ranked by what it cost. None of these changes the bytes a restore writes; several change an
exit status or a message.

1. **There is nothing byte-exact to test against.** The worked examples elide hashes (`3b8e…c0a1`)
   and use spaces for readability; the only exact lines are the three JSON strings under
   "Canonical form". Every one of the 263 parser cases had to be built by hand from prose, and
   no guess could be confirmed. A handful of small files with their verdicts (valid, refused
   whole, refused row by row) would settle most of this list.
2. **Three reading rules are stated in terms of the SDK the reader isn't using.**
   - "its S3 library follows a 301 to the region the bucket is in, so a tool that starts in
     another region … must too". How isn't said. *Guessed:* the 301 carries the region in an
     `x-amz-bucket-region` header; sign again for it and repeat. *Ran:* S3 does send it; the
     restorer followed from `us-west-2` and `eu-central-1`.
   - a 404 with no code is a miss "when the SDK's XML parser accepts its body". That is an
     implementation, not a definition. *Guessed:* an empty body, or well-formed XML with no
     `<Code>`. *Not run:* AWS always sends a code.
   - where the error code is found at all (an `<Error><Code>` element in the body) is only
     implied by "A HEAD's 404 has no body, so no code".
3. **"A malformed file row" is never defined.** It is refused one path at a time, and takes
   part in the duplicate check, so it matters what it is. *Guessed:* hash, size or time not in
   the form the "valid file" list gives, or fewer than five fields. *Ran:* cases `row: …`.
4. **Is stopping on a non-miss failure a rule, or s3cab's habit?** "It stops the whole restore
   on any other failure" describes s3cab, inside a rule, two bullets above "Restore everything
   you can, then report". *Guessed:* stop, exit nonzero, keep what has landed. *Ran:* a 403
   stops mine with exit 2, but only ever on its first request: I had no way to make one
   arrive in the middle of a restore.
5. **Something there before the restore is in the way, and the row's hash is already known
   missing: which is reported?** The spec orders a skip first, and says a known-missing hash
   beats a collision or an obstacle *this restore wrote*. For an obstacle that was there
   before, nothing. It decides the exit status when the hash was deliberately deleted (0) and
   the obstacle is a folder (1). *Guessed:* known-missing first. *Ran:* case `skip-wins`.
6. **"A BOM … a reader may forgive" reads as a choice, and isn't one.** U+FEFF is in the trim
   set, so the heading row's first field matches with or without a BOM: every conforming
   reader forgives it. And "reads past" differs from "trims" in one corner: a deletion record
   whose first line is a BOM and a `.`. Read past, that `.` ends the record; trimmed, it "ends
   nothing" and the rows after it count. *Guessed:* read past, as s3cab does. *Ran:* cases
   `heading: …BOM…`, `heading: U+FEFF after a space`, `record: a BOM is read past`.
7. **Two definitions of a set's name, and no word on which a restorer applies.** A name has
   "single hyphens between" its letters; listing counts "hyphens anywhere". *Guessed:* a
   restorer given a set accepts what listing counts and refuses anything else, which also
   keeps `/` out of the key. *Ran:* scenarios I.
8. **Naming a snapshot, and restoring nothing.** Must a named snapshot fit `YYYYMMDDTHHMM`?
   What is a restore of a set with no snapshot? *Guessed:* yes ("for every purpose"); an error,
   exit nonzero. *Ran:* scenarios H and I.
9. **"s3cab takes the newest" of two record rows: newest by what?** *Guessed:* by the row's
   instant, as text. It can't change the answer (any later row gives the same verdict), so
   this is only a pause.
10. **Small silences, each a guess of a minute:**
    - a row whose type is exactly `@` or `#`: skipped like any unknown `@`/`#` type;
    - a `#deleted` row inside a snapshot: a `#` row, explains nothing;
    - a snapshot object of zero bytes: damaged;
    - "a drive letter": ASCII `A`–`Z`, `a`–`z` only;
    - which Unicode version "Unicode's full default case mapping" means: whatever the system's
      ICU has;
    - whether the "folders made for" a failed file include `<output>` and those above it: yes
      (ran: `nothing-lands`);
    - which of the three actions (refuse whole, refuse the row, ignore) an invalid `#` row
      gets, a relative path say: ignore, from "skipping every `#` row leaves exactly what a
      restore reads".
11. **Which of the destination's behaviours bind another restorer?** "Paths" ends its account
    of where files land with "None of this binds you". The reading checklist, which is
    "everything a tool doing that job has to get right", then states several of the same
    behaviours as rules with exit statuses: skip what was there, report a collision, read the
    time back and exit 1 at 2 seconds. By the page's own definition a checklist item is a
    rule; by the sentence in "Paths" it is s3cab's choice. It cost me nothing, since this
    exercise asked for s3cab's own layout and I implemented all of it, but a reader choosing
    its own layout can't tell which of these it still owes.
12. **Only "Locks" says a reader may skip it.** "Who holds a set", "Links", "What is
    deliberately not stored" and the real-path half of "Paths" are for writers too, and say
    nothing; the reader's rules in "Paths" (path kinds, `DIR` matching, landing) sit between
    writer material. I read all of it to be sure no reader rule hid there. None did.

I never wanted the pages the spec links to (`backup.md`, `exclude.md`, `output.md`,
`maintenance.md`, `aws.md`, the anatomy page). Its claim to cover everything a reader needs
held. What I did want, and worked from memory for, was S3's side: the shape of a
ListObjectsV2 answer and of an error body, and the region header (§7).

## 6. Hints that would have helped

1. **Wrong: "In Swift, Foundation's `lowercased(with: nil)` matches it too."** It does not
   match JavaScript on this system (macOS 26.7.2).
   - *Ran:* `scratch/probe2`, with the system's JavaScriptCore as the JavaScript reference.
     Of Σ placed in five contexts beside every Unicode scalar (5,560,320 strings), ICU's
     `u_strToLower` with the root locale differs from JavaScript on **0**, Foundation on
     **3,545**. Foundation applies Final_Sigma without looking past case-ignorable characters:

     | Input | JavaScript, ICU | Foundation `lowercased(with: nil)` |
     | --- | --- | --- |
     | `ΟΔΟΣ.txt` | `οδοσ.txt` | `οδος.txt` |
     | `Α.Σ` | `α.ς` | `α.σ` |
     | `ΑΣ:Α` | `ασ:α` | `ας:α` |

     The first row is the spec's own example of what JavaScript gives.
   - *How I met it:* I followed the hint, and my own test failed: `got 'οδος.txt' want
     'οδοσ.txt'`.
   - *Consequence:* a Swift reader built on the hint puts `C:\οδοσ.d\a` outside a `DIR`
     written `C:\ΟΔΟΣ.D\` and refuses it, where s3cab restores it; and the reverse for
     `C:\οδος.d\a`.
   - *What works:* `u_strToLower(…, "", &status)` from the system's libicucore. Its headers
     are in the SDK (`#include <unicode/ustring.h>`, link `-licucore`). The restorer uses it.
   - *Caveat:* my reference is JavaScriptCore, not the Node that s3cab runs on. Both
     implement the same language rule, and the spec's own example sides with it.
2. **Incomplete: "`inflateInit2(&strm, 15 + 16)` reads gzip", in the Swift hint.** It is a
   macro, and Swift can't call it: `cannot find 'inflateInit2' in scope … function like macros
   not supported` (ran: `scratch/probe3`). It needs the same static inline wrapper the hint
   prescribes for libcurl, or a call to `inflateInit2_` with `ZLIB_VERSION` and the size of
   `z_stream`.
3. **Missing: on macOS something reads a restored file within a fraction of a second, and its
   access time moves.** A tester who compares access times with the stored time, since "s3cab
   sets its access time to the same instant", finds nearly every file different and suspects
   the restorer.
   - *Ran:* one set restored twice. In a folder named `x.noindex`, which Spotlight leaves
     alone, 120 of 120 files had access time equal to modification time 20 seconds later. In
     a folder beside it, 0 of 120.
   - The spec is right that the access time shouldn't be read back; it could say why.
4. **Missing, minor: APFS counts a name's length in UTF-16 units, not bytes.** "The
   destination's limits" covers Linux's 255 bytes only. *Ran:* 256 ASCII bytes is refused; 255
   CJK characters (765 bytes) and 127 emoji (508 bytes) are created. So a long name from
   Windows always fits on macOS.
5. **Missing, minor: macOS ships a JavaScript engine.** `import JavaScriptCore` gives a Swift
   test a direct answer to "as JavaScript's `toLowerCase()` does". It is how item 1 was found.

## 7. Environment notes, not the format

**Signing and S3**

- Signature Version 4, written from memory; the first signed request succeeded. I never used
  the `aws` CLI to debug or compare a signature. I used it for three other things: to confirm
  the bucket was reachable and look at its keys before any code existed; as the independent
  checker's own route to the snapshots, records, listing and the corrupt objects; and to read
  the stored headers of three keys.
- **What reading needs from S3, in full:** two operations, both `GET`: ListObjectsV2 and
  GetObject. Four signed headers (`host`, `x-amz-content-sha256`, `x-amz-date`,
  `x-amz-security-token`), an empty-body hash, HMAC-SHA-256 and SHA-256. An XML parser for
  listings and error codes. No HEAD, no checksum headers, no multipart, nothing written.
- Addressing is virtual-hosted, `https://<bucket>.s3.<region>.amazonaws.com/<key>`; path-style
  is coded for a bucket name with a dot, and untested.
- Continuation tokens hold `/`, `+` and `=` and must be percent-encoded identically in the URL
  and the signature; the four-page listing of `objects/` proves that path.
- I ask listings for `encoding-type=url`, so a key holding a character XML can't carry
  doesn't break the parse. The bucket has no such key, so the decoding is untested.
- Observed from S3: 404 `NoSuchKey` for a missing object; 403 `SignatureDoesNotMatch` for a
  wrong key; 301 with `x-amz-bucket-region` from another region's endpoint; a plain GET reads
  `GLACIER_IR` objects at once.

**Transport**

- libcurl 8.7.1, as `ENVIRONMENT.md` describes: `curl_global_sslset(CURLSSLBACKEND_OPENSSL…)`
  first, and it reads `HTTPS_PROXY` itself. It worked as described.
- Content decoding is off and no `Accept-Encoding` is sent, as the spec's hint says.

**Toolchain**

- Swift 6.3.3 (Xcode 26.6), `-swift-version 6`, on macOS 26.7.2, arm64.
- Every `swiftc` run prints `couldn't create cache file … xcrun_db` (the sandbox denies
  `xcrun` its cache) and works anyway; `build.sh` filters it. The module cache is kept in
  `.build/`.
- Three compile errors on the way, none to do with the format: a type-check timeout on a
  chained closure, an exclusivity error on `nanosleep(&ts, &ts)`, and main-actor isolation of
  a global in a probe.
- The test aids run on `/usr/bin/python3` (3.9.6, from the command-line tools), not the
  Homebrew one on the `PATH`.

**Sandbox**

- The file tools and any command naming a path outside this directory were refused, `$TMPDIR`
  included, so all scratch work is in `scratch/` here. Nothing was written elsewhere, by me or
  by the restorer.
- Process substitution (`<(…)`) is denied.

**The bucket**

- 24 sets, 36 snapshots, 3,821 objects, six deletion records (`-1`, `-3`, `-4`, `-6`, `-7`,
  `-9`). Read only.
- I never read anything under `.s3cab/` or any `.info`; their key names appeared in my first
  listing and nowhere else.
- The 36 s3cab-written files (30 snapshots, 6 records) are exactly as the spec says s3cab
  writes them: canonical padding, `FILES`, `SIZE` and its readable form, names, row order
  (`tests/canonical.py`). The other six are the hand-cut snapshots with no `.`.
- Stored headers match the spec: no metadata, `application/octet-stream`, `AES256`,
  `GLACIER_IR` for what s3cab wrote; hand-placed keys are `STANDARD`.
- The credentials were valid for every run reported here.

## 8. Statements in the spec that I checked and found true

| The spec says | Ran |
| --- | --- |
| APFS keeps nothing past April 2262; a year-2300 time "succeeds and stores 2262" | real restore of `mtime-2300.txt`; `tests/fs-times.py` |
| APFS keeps times before 1970 down to 1677-09-21; earlier lands at `1677-09-21T00:12:43.145Z` | `tests/fs-times.py`; `local-cases` year 0000 |
| Compare times rounded to the millisecond, not truncated | `…16.855Z` is stored as `…16.854775807Z`: equal rounded, different truncated |
| Splitting a Swift `String` on `"\n"` leaves a CRLF text as one line | `parsetool swift-traps`: 1 piece |
| Swift `String` equality and hashing merge the two spellings of `café` | same: equal, a `Set` of both has 1 |
| `String(validating:as:)` returns nil for bad UTF-8, overlong and surrogate forms included | same |
| `Int("+12")` is 12; `lowercased()` skips Final_Sigma | same |
| `curl_easy_setopt` can't be called from Swift | `scratch/probe3`: "Variadic function is unavailable" |
| zlib opened with `15 + 16` checks the header CRC and refuses a reserved flag bit; a cut stream never reaches `Z_STREAM_END` | parser cases `gzip: …` |
| `O_DIRECTORY \| O_NOFOLLOW` fails on a link with `ENOTDIR` | true on macOS too |
| `\` and `/` are neither cased nor case-ignorable, so lower-casing per segment equals lower-casing the whole path | ICU properties; 4,394 paths, 0 differ (`scratch/probe4`) |
| A delimiter listing gives exactly the keys directly in a folder; 1,000 keys a page | real listings |
| The working folder here is on case-insensitive APFS | the collisions in §3.1 |

## Appendix A. The guess log, as recorded

G1 to G17 were written into this file when they were made, before I knew whether they
mattered. Their wording is shortened here and the cross-references were added at the end;
none was dropped, and the ones that turned out not to matter are still listed. G18 to G21 I
did **not** record at the time: G19 to G21 were decisions I took while designing without
noticing they were guesses, and G18 I only saw when writing up. They are the kind this log
exists to catch, so they are marked.

*While reading and designing, before any code ran:*

- G1. The minute's range in a time is not given. Guessed `00`–`59`. → §4.3
- G2. "A drive letter": ASCII only, or any letter? Guessed ASCII. → §5.10
- G3. A `@SET DIR` with no trailing separator. Guessed it matches as with one. → §4.1
- G4. Does a restorer validate the set name it is given, and by which rule? Guessed yes, by
  the looser listing rule. → §5.7
- G5. Must a snapshot named on the command line be exactly `YYYYMMDDTHHMM`? Guessed yes. → §5.8
- G6. The BOM a reader "may forgive": rule or licence? First guess: leave it to the trim. → §5.6
- G7. A row whose hash is already known missing, with something there before the restore in
  its way. Guessed: known-missing is reported first. → §5.5
- G8. A 404 with no code "when the SDK's XML parser accepts its body". Guessed: empty, or
  well-formed XML with no `<Code>`. → §5.2
- G9. A `#deleted` row inside a snapshot explains nothing. → §5.10
- G10. The folders made for a file that fails include `<output>` and those above it. → §5.10

*While writing the parser and looking at the first real restores:*

- G11. What "malformed file row" covers. → §5.3
- G12. A row whose type is exactly `@` or `#`: skipped. → §5.10
- G13. A snapshot object of zero bytes: damaged. → §5.10
- G14. "Newest" of two record rows: by instant, as text. → §5.9
- G15. G6 revisited: "reads past" and "trims" differ for a record starting BOM + `.`. Changed
  to read past, the direction that explains fewer absences. → §5.6
- G16. Which Unicode version the case mapping means: the system ICU's. → §5.10
- G17. A named snapshot that isn't there, or a set with none: an error, exit nonzero. → §5.8

*Recognised as guesses only afterwards:*

- G18. Whether digits outside the size column must be ASCII. I had written ASCII-only code
  for names and times without asking. → §4.2
- G19. How a tool with no SDK follows a 301 to the bucket's region. I used the
  `x-amz-bucket-region` header from memory; S3 confirmed it. → §5.2
- G20. Whether "stops the whole restore on any other failure" binds another tool. I made it
  stop. → §5.4
- G21. Whether the destination behaviours in the reading checklist are rules or s3cab's
  choices. I implemented them all as rules. → §5.11

Comparisons that failed on the way, and what they were:

- `FAIL swift: matching-lowercased-sigma-before-dot — got 'οδος.txt' want 'οδοσ.txt'`: the
  wrong hint, §6 item 1. Fixed by moving to ICU.
- The checker's `atime!=mtime=1100` of 1,100 files (and the like for most sets): the system
  indexer, §6 item 3. Not a restorer fault.
- `tests/canonical.py` first reported 0 of 42 files as canonical: my checker flagged the
  heading row's `size` as a size on an `@` row. The spec warns of exactly that trap for
  column 4. Fixed in the checker; 36 of 42.

## Appendix B. What is in this directory

| Path | What |
| --- | --- |
| `s3cab-restore` | the restorer, built from `src/` by `build.sh` |
| `src/Text.swift` | the reading rules: trim, fields, instants, gzip |
| `src/Paths.swift` | path kinds, `DIR` matching, lower-casing, where a path lands |
| `src/Snapshot.swift` | snapshot and deletion-record parsing and validation |
| `src/S3.swift` | Signature V4, the libcurl transfer, listing, fetching, retries, the 301 |
| `src/Restore.swift` | writing files: destination checks, download, hash, time, collisions |
| `src/Repository.swift`, `src/main.swift`, `src/Util.swift`, `src/bridge.h` | environment and names; the command line; helpers; the C imports |
| `tests/restore-all.sh`, `tests/check-all.sh`, `tests/check.py` | §3.1 and §3.2 |
| `tests/scenarios.sh` | §3.3 |
| `tests/local-cases.py`, `tests/restorelocal/` | §3.4 |
| `tests/parser-cases.py`, `tests/parsetool/`, `tests/build-parsetool.sh` | §3.5 |
| `tests/canonical.py`, `tests/fs-times.py`, `tests/show.py` | §7 and §8 checks; a snapshot viewer |
| `scratch/` | disposable: the last full restore (`scratch/out`), its logs, the CLI's copies of the snapshots and records, the probes |

To repeat everything: `sh build.sh && sh tests/build-parsetool.sh`, then
`. ./credentials.env; sh tests/restore-all.sh; sh tests/check-all.sh; sh tests/scenarios.sh;
/usr/bin/python3 tests/local-cases.py; /usr/bin/python3 tests/parser-cases.py`. The checker
expects the CLI's copies in `scratch/snap` and `scratch/records` (commands at the top of
`tests/check-all.sh`).

## 9. Differences from the reference

Added after the first report, when `reference/` arrived with one restore per snapshot made
by the tool itself. Sections 1 to 8 and the appendices are as they stood, apart from one
bullet in §1, one item in §6 and two rows in Appendix B that point here.

**The restorer was not changed.** It is the binary the first phase left (SHA-256
`358c0a6d…219c7`), so there is one program to check, not two.

### What was compared

Every snapshot was restored afresh by that binary into `scratch/recon`, and each tree was
compared with its reference by `tests/reconcile.py`: every path as bytes, files and folders
alike, each file's SHA-256 and size, its permission bits, and its modification time both
exactly and rounded to the millisecond.

| Compared, over 36 snapshots | Result |
| --- | --- |
| Snapshots where the tool restored nothing (6 refused, 3 empty) | mine restored nothing either, and made no folder: 9 of 9 |
| Paths, files and folders, byte for byte | the same on both sides: 3,972 files, none only in one |
| Kind of each entry | the same; no links on either side |
| Content | identical for all 3,972 files |
| Permission bits | `644` on every file and `755` on every folder, both sides |
| Hard links | none on either side |
| Modification time, rounded to the millisecond | identical for all 3,972 files |
| Modification time, to the nanosecond | **differs on 3,906 files** |

Where a snapshot's rows collide on this disk, the same row won on both sides: the content
at `café.txt` and at `case/Case.txt` is the first row's in the reference and in mine.
The two `mtime-2300.txt`, whose time the disk can't hold, sit at the same clamped instant on
both sides (`2262-04-11T23:47:16.854775807Z`).

### The one difference: modification times below the millisecond

- **What:** on 3,906 of the 3,972 files the reference's modification time is not the instant
  the row stores. It is between 119 ns before it and 118 ns after it: 1,951 files below,
  1,955 above. Mine is exactly the stored instant on every file the disk can hold (3,970 of
  3,970). For example, `bulk/item-0.txt` stores `…:50.168Z`; the reference has
  `….167999982`, mine `….168000000`.
- **Cause:** the reference's value is, for all 3,970 files, the stored instant held as a
  double-precision count of seconds with its fraction cut to whole nanoseconds
  (`tests/reconcile-times.py` reproduces every one). A double near 1.8 billion seconds has a
  grain of 238 ns, so most milliseconds have no exact double. My restorer sets the time
  from integer seconds and nanoseconds through `futimens`.
- **Whose it is: neither my bug nor a gap in the spec.** The spec says this will happen and
  how to treat it:
  - "a restored file can land up to about a hundred nanoseconds off its row. s3cab's own
    restore does, where the filesystem keeps nanoseconds; setting the time through a
    nanosecond interface is exact";
  - "compare at that resolution [the millisecond], not finer: below the millisecond two
    restores can disagree without either being wrong".

  If it must be assigned to one side, it is the tool's side of a tolerance the spec states,
  not an error on either.
- **Why I did not change the restorer to match:** matching would mean copying the float
  conversion I inferred from the reference files, which is not in the spec, to make the
  restorer land *further* from the stored value than it does now. The format's promise is the
  millisecond, and at the millisecond the two agree everywhere.
- **What it means for comparing two restores:** round, as the spec says. A comparison that
  truncates to the millisecond puts 1,951 of these files in the wrong millisecond; an exact
  comparison flags 3,906. Neither would be a finding about either restore.

One figure in that hint is true only for today's dates. The 119 ns bound is half the grain
of a double between 2004 and 2038. By the same arithmetic it is 237 ns from 2038 and 947 ns
for a time in 2300. That is computed, not measured: no file in the bucket has a fractional
time that late, and it assumes the tool keeps setting times this way. It stays far inside
the millisecond either way (§6, item 6).

### What the references settle, and what they don't

They agree with every decision the bucket's data reaches, which the first phase could only
check against the spec:

- the layout, a drive as `C/…` included;
- which of two colliding rows lands (the first in the file);
- that a corrupt object is withheld rather than written;
- that both rows naming one path are refused, and so are the `..` row and the row beside
  the `DIR`;
- that `FAULTS/case.txt` is not under a POSIX `DIR` spelled `faults`, even restored onto a
  disk that ignores case;
- that a snapshot with no final `.` restores nothing;
- that a deliberately deleted file and a missing one leave nothing behind;
- that a file whose time the disk can't hold is kept;
- the permission bits of files and folders.

They do not reach any of the 21 guesses in Appendix A. Each guess is about an input the
bucket doesn't hold (a `DIR` without its separator, a minute of 60, a name in non-ASCII
digits, a BOM, and so on), so each is as unconfirmed as it was.
