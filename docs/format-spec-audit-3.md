# The format-spec clean-room audit, run 3 (2026-08-23)

The third literal test of the no-lock-in promise, and the first against the spec as revised for
the hash-operand `delete` and its root-level deletion record (ADR-0089/0090) and the
to-the-millisecond mtime promise. Everything below the rule is the clean-room session's own
report, verbatim — the one edit is that its relative links now point at the preserved copies of
the files they name.

**How run 3 differed from [run 2](format-spec-audit-2.md).** Same rules — no AWS SDK, no S3
client library, no shelling out, a real bucket — read by a fresh session in a new language (Go).
Two things were new underneath it:

- **Run 2's four added fixtures ran live for the first time.** The recorded-deletion skip, the
  corrupt object, the trailerless snapshot and the two-`#DIR` set were built *for* this run;
  run 2 could only describe its handling of each as written and never executed.
- **The first corpus with no POSIX skips.** Staging ran on Linux, so the control-character,
  trailing-space, case-pair and MAX_PATH fixtures were all present — runs 1 and 2 measured a
  corpus missing whichever of them the staging platform refused.

**The diff against run 2's list — the reason a re-run happens.** Every fix that landed, held:
the non-normative `--output` layout note let this run reproduce the tool's layout exactly
(run 2's finding 1); the millisecond mtime rewording was verified quantitatively, ±118 ns of
predicted float error agreeing at the promised resolution (finding 2); and the `#DIR`-matching
and `#END`-grammar answers drew no new findings (6, 10). The new deletion-record format parsed
exactly as specified. Two items reappeared — a fix that didn't land each: **finding 4 returned
as A1**, upgraded from a guess to a live result (the spec still never says to verify downloaded
bytes, and the staged corrupt object caught s3cab itself stopping dead, against its own
graceful-continuation principle); and **finding 8 returned as C8** (set-name character set,
still unstated). A3 is half of one: run 2 built the trailerless fixture, but the spec never said
what "treat it as truncated" means for a restore, so this run had to learn the answer from the
reference trees — exactly what the firewall exists to catch.

The session read `guide/format.md` and nothing else — no `src/`, no ADRs, and neither earlier
report. Its restorer and its own comparator are preserved under
[scripts/cleanroom/restorers/gorestore/](../scripts/cleanroom/restorers/gorestore/).

---

# Clean-room restorer: report on `format.md`

An independent restorer for the s3cab format, written in Go from `format.md` alone, verified
differentially against the live bucket and the reference restores. This file is the deliverable:
every point where the spec was ambiguous, silent, or wrong, ranked by what a wrong guess costs.

## What was built and what happened

- **Restorer:** `restorer/` — ~1100 lines of Go 1.22 (Ubuntu 24.04's packaged `golang-go`).
  Dependencies: Go stdlib plus Ubuntu's packaged `golang-github-klauspost-compress-dev` (pure-Go
  zstd) and its transitive `golang-github-cespare-xxhash-dev`. **No AWS SDK, no S3 library, no
  subprocesses**: SigV4 is hand-rolled over `net/http` ([sigv4.go](../scripts/cleanroom/restorers/gorestore/sigv4.go)), S3 is
  GET + ListObjectsV2 over plain HTTPS ([s3.go](../scripts/cleanroom/restorers/gorestore/s3.go)).
- **Signing:** derivable from public AWS documentation knowledge alone. The `aws` CLI was run
  exactly once, before any code existed, as the reachability pre-flight `ENVIRONMENT.md` itself
  suggests. It was never consulted during development; the first signed request my code ever made
  succeeded, as did every one after it. Session credentials (`x-amz-security-token` signed with
  the rest) worked as described.
- **Verification:** all 10 snapshots across all 8 sets restored from the real bucket, then
  compared byte-for-byte against `reference/`, paths and mtimes included
  ([compare.py](../scripts/cleanroom/restorers/gorestore/compare.py)). Spec corners the bucket doesn't stage (Windows paths,
  case-folding, collisions, malformed files) are covered by 20 synthetic parser tests
  ([snapshot_test.go](../scripts/cleanroom/restorers/gorestore/snapshot_test.go)), all passing.

### Differential results (final binary, fresh run)

| snapshot | files | vs reference |
|---|---|---|
| bulk-2026-08-23T0031 | 1100 | identical |
| docs-2026-08-23T0031 | 120 | identical |
| edge-2026-08-23T0031 | 23 | identical (incl. NEL/VT/FF names, leading/trailing spaces, NFC+NFD, case pair, empty file, 1970/2038 mtimes) |
| edge-2026-08-23T0034 | 23 | identical |
| media-2026-08-23T0032 | 2 (42 MB) | identical |
| spread-2026-08-23T0033 | 2 | identical (two `#DIR`s, basename layout) |
| hollow-2026-08-23T0032 | 0 | identical (legal empty set) |
| faults-2026-08-23T0032 | — | refused: truncated (no `#END`); reference is likewise empty |
| faults-2026-08-23T0033 | 1 | identical; 1 skip explained by deletion record, 1 unexplained missing object reported, exit nonzero |
| corrupt-2026-08-23T0033 | 3 | **intentionally different** — see finding A1 |

Every file that both trees hold is byte-identical. All 1272 compared mtimes agree at millisecond
resolution; 1264 of them differ in raw value, by at most ±118 **nanoseconds**, which is precisely the
float-seconds error the spec predicts for s3cab's own restore and confirms my
nanosecond-interface restore is the exact one. Exit code 2 overall, correctly: the bucket stages
genuine integrity faults.

The bucket also stages the **"presence always wins"** trap and my restorer passed it live:
`objects.deleted-1.tsv` records the hash of `edge`'s `dedup-a.txt`/`sub/dedup-b.txt`, but the
content was re-backed-up afterwards and the object is present. A restorer that pre-loads the
records and treats them as authoritative silently skips two restorable files; consulting records
only on an actual 404, as the spec instructs, restores them. The spec's insistence on this — and
its warning that the wrong reading "reports success while doing it" — is exact and earned.

---

## Findings, ranked

**Rank A — spec silence where a wrong guess corrupts a restore or loses data.**
**Rank B — divergent-but-reported outcomes, or interop hazards.**
**Rank C — implementer inconvenience; cosmetic divergence.**

Each finding says how it was verified: **[live]** against the bucket/reference, **[synthetic]**
against local test files, **[unexercised]** a guess nothing tested.

### A1. Corrupt objects: the spec is silent, and the tool contradicts the spec's own principle — [live]

Nothing in `format.md` says what a restorer should do when `objects/<hash>` downloads
successfully but its bytes do not hash to `<hash>`. It never even says a restorer *should* hash
what it downloads — "Recovering by hand" step 4 says "That is your file, byte for byte," trusting
the key outright. The bucket stages exactly this: `corrupt`'s `b-corrupt.txt` object holds 32
bytes hashing to `b8a23f…` under a key claiming `d2c86b…` (snapshot size column says 50).

Three restorers, three different trees, none violating a written rule:
1. **A restorer that doesn't verify hashes** writes wrong bytes to `b-corrupt.txt` and reports a
   clean restore. Silent corruption — the worst outcome, and the spec never warns against it.
2. **s3cab itself** (per the reference tree) restored `a-intact.txt` and then **stopped dead**:
   no `b-corrupt.txt`, and no `c-intact.txt` either, though c's object is fine. That contradicts
   the spec's own requirement — "a recovery tool that stops dead at file 3 of 400 is materially
   worse… the graceful path is not a nicety, it is the requirement" — which as written covers
   only *missing* objects.
3. **Mine** verifies, writes all three (the corrupt bytes may still be most of a file worth
   having), reports the mismatch as an integrity fault, and exits nonzero. The staged content
   agrees this is the intent — `c-intact.txt` literally reads "only reached by a restorer that
   carries on" — yet the shipping tool doesn't do it.

The spec needs a paragraph: restorers should verify downloaded bytes against the key, and
mismatch should be treated like an unexplained missing object — report, carry on, exit nonzero —
plus a stated choice on whether the wrong bytes get written.

### A2. Path traversal under re-rooting: unstated, and the spec's own advice makes it reachable — [synthetic]

Snapshot paths are joined under an output directory, and the spec repeatedly blesses hand-edited
snapshots ("these files are yours to edit"). A row whose path contains a `..` segment below its
matched `#DIR` (`/a/outer/../../etc/passwd`) walks a naive restorer out of its output directory
and overwrites arbitrary files. No walk produces such a path, but nothing in the format forbids
one — the refused-characters list is tab/LF/CR only — and nothing warns the implementer. My
restorer refuses `.`/`..` segments in the re-rooted remainder and reports them. The
"If you are writing a restorer" section is exactly where this belongs.

### A3. What "treat it as truncated" means for a restore — [live]

A snapshot without the `#END` trailer "is damaged goods — treat it as truncated, not as
complete." But *treat how*? The staged `faults/…T0032` decompresses to three well-formed rows and
no trailer. Refusing outright restores 0 of 3 files; the restore-everything-you-can principle
argues for restoring all three and flagging the tree as possibly incomplete. The two readings
differ by the entire contents of the restore. The reference tree is empty, so s3cab refuses, and
I matched that — but I had to learn it from the reference, not the spec. One sentence would fix
it ("a truncated snapshot is not restored / is restored with a warning").

Related, unstated: whether a refused restore should still create its (empty) output directory.
The reference tree has one; whether s3cab or the harness made it is unknowable from here. I
create it, to match.

### B1. "Two snapshots of an unchanged folder therefore differ in this one line, and nowhere else" — wrong — [live]

`format.md` says this of the `#END` line. Byte-diffing `edge`'s two snapshots of an unchanged
tree shows **two** differing lines, necessarily: `#SNAPSHOT` carries the start instant and the
snapshot's own name, which cannot repeat. Nothing corrupts, but a tool built on the claim — e.g.
dedup-by-content of snapshot files modulo "the one line" — mis-fires. Should read "differ in the
`#SNAPSHOT` and `#END` lines, and nowhere else."

### B2. "Windows path" and its case-insensitivity are never defined — [synthetic]

Case-insensitive `#DIR` matching applies "on Windows paths"; exact matching to "paths without a
drive letter." I had to guess that a Windows path is one whose first segment is `[A-Za-z]:`, and
— harder — what case-insensitive *means*: ASCII? Unicode simple folding (my choice,
`strings.EqualFold`)? NTFS's actual upcase table? These differ for characters like ß, İ, and
Cyrillic. A wrong fold means a `#DIR` fails to claim its files; the failure is reported ("nowhere
to land") rather than silent, which keeps this out of rank A. Every path in the test bucket is
POSIX, so nothing live exercises any of this — worth knowing about the coverage, too.

### B3. `#DIR` with no usable basename — [synthetic]

A member directory of `C:\` or `/` has no basename for the `<output>/<basename>/…` layout. Spec
silent. I refuse the snapshot; inventing a name (`C`, `root`?) is equally defensible and gives a
different tree.

### B4. Are `#DIR` basename collisions matched case-sensitively? — [unexercised]

s3cab "refuses that snapshot" when two basenames collide. `C:\a\Photos` vs `D:\b\photos`: not
byte-equal, but the same directory on the case-insensitive filesystems Windows snapshots come
from — restoring both silently merges two trees. I compare byte-exact (so I'd merge them on
Linux); the safe reading is probably case-insensitive collision. Unstated.

### B5. `PARTIAL` in a bucket snapshot — [unexercised]

`PARTIAL` is documented as belonging to `.snapshot.lookup.tsv.zst`, "the only file s3cab writes
`PARTIAL` into," which is never uploaded. What should a reader do with a *bucket* snapshot whose
trailer says `PARTIAL`? It can only exist by hand-copying, but the spec's stance on hand-edited
files makes that thinkable. I restore it with a warning; refusing is equally defensible.

### C1. Deletion-record row test: hex case — [unexercised]

"…first tab-separated field is 64 hex characters." Uppercase hex satisfies that sentence but no
s3cab hash is ever uppercase. I accept either case and normalise. One word ("lowercase") settles
it.

### C2. Metadata ordering is implied, never committed — [live, trivially]

"The file opens with a header naming the set and its member directories; then one row per file"
— but nothing commits `#SNAPSHOT` to line 1 or `#DIR`s to precede rows. My reader accepts `#DIR`
anywhere and warns if `#SNAPSHOT` isn't first. All real files were ordered as implied.

### C3. "Trim" is never defined — [live, trivially]

Padding is stated to be spaces, so I trim ASCII space only (not tabs — separators — and not
Unicode whitespace). Real files confirm space-only padding. A parser reaching for a generic
`strip()` differs on a hand-edited file whose field is padded with something exotic; same family
of trap as the `splitlines()` warning the spec does spell out.

### C4. Snapshot header vs. its key — [live]

The staged truncated file sits at `snapshots/faults/2026-08-23T0032.tsv.zst` but its `#SNAPSHOT`
header names itself `2026-08-23T0033`. Which is the snapshot's name for a reader — the key or
the header? Only reachable in hand-damaged buckets (s3cab writes them equal), but the spec calls
snapshots "self-describing even found alone in a bucket," which leans header, while every listing
operation leans key. I use the key and warn on mismatch.

### C5. Size column vs. body length — [live]

When the object's actual length disagrees with the row's size column (staged: 32 vs 50), which
is authoritative, and is the disagreement itself reportable? I treat the hash as identity, the
size as advisory, and report the disagreement. Spec silent.

### C6. File permissions, atime, directory mtimes — [live, weakly]

"No permissions or ACLs" are stored, so a restorer must invent a mode; nothing suggests one. The
reference trees show umask-default 0644/0755, which mine matches by construction. atime isn't
stored; I set atime = mtime. Directory mtimes are unrestorable by design (directories aren't
stored). All cosmetic, all worth one sentence each in the restorer section.

### C7. Deletion-record rows with fewer than four fields — [unexercised]

"Everything after the third tab is who ran it" presumes a third tab. A 3-field row satisfying
the 64-hex test is unparseable by that sentence. I reject the record file; skipping the row is
equally defensible.

### C8. Set-name character set — [unexercised]

Set names appear in keys (`snapshots/<set>/…`) and, for any tool following s3cab's own layout, in
output directory names (`<set>-<name>`). Legal characters are never stated. All staged names are
`[a-z]+`. I URI-encode key segments properly regardless.

---

## What the spec got right, verified

Fairness demands the other list too, because most of it held up under byte-level scrutiny:

- **The four reading rules are sufficient, and each one's trap is real.** The `edge` set stages
  filenames containing U+0085, `\v`, `\f`, and leading/trailing spaces; LF-exact splitting and
  never-trim-the-path restored all of them byte-identically, and a `splitlines()`/`strip()`
  reader provably would not have. [live]
- **Padding is exactly as documented**: marker padded to 64 (55 spaces after `#SNAPSHOT`), size
  right-aligned in 10, instant in 24, minimum-not-fixed widths (`Symbolic Link` overflows its
  10), the path never padded, and `#END`'s empty fourth column really does end the line with a
  bare tab. Deletion-record rows really are unpadded, with a bare `#END` trailer. [live]
- **The `#END` first-field-trim test** and its extra-column tolerance behave as committed. [live]
- **The objects-first invariant's fault vocabulary works**: recorded absence restored gracefully
  with the record's date; unrecorded absence (`torn.txt`) reported as an integrity fault while
  the rest of the set restored; **presence always wins** validated live (see above). The
  compaction design (who/when in rows, not filenames) parsed exactly as specified. [live]
- **The restore-layout promise** (`<output>/<basename of matched #DIR>/<rest>`) reproduced the
  reference trees exactly across five sets including a two-`#DIR` set. [live]
- **The mtime paragraph is quantitatively right**: reference (float path) sits tens of
  nanoseconds off the stored value; a nanosecond-interface restore is exact; comparing at
  millisecond resolution makes them agree. Even "the figure is rounded up" describes real files.
  [live]
- **Empty snapshot legal** (`hollow`), **empty file object** (the well-known `e3b0c4…` key
  exists and GETs), **dedup** (one object, two paths) all restored as described. [live]
- **`env` is genuinely absent from the bucket**; `dirs.txt` is the parsed list; `exclude.txt`
  travels verbatim. [live]

One deliberate spec leniency deserves praise: committing readers to *tolerate* trailer columns
they don't know ("ignore anything after it") is what let the format add `#END`'s two columns
without breaking old readers. The same courtesy is extended by the "skip every `#` line"
guarantee. Both held in practice.

## Notes on the ground rules

- I wanted exactly one thing beyond `format.md` and `ENVIRONMENT.md`: an S3/SigV4 protocol
  reference. Public-documentation knowledge sufficed; no AWS SDK, no CLI consultation, no other
  format source. The signing is derivable from public documentation alone.
- `sets/edge/exclude.txt` in the bucket contains the tool's documentation URL. Per the rules I
  did not fetch it.
- The one place I let the *reference trees* (not the spec) settle a behavior: refusing vs.
  partially restoring a truncated snapshot, and creating the empty output directory when
  refusing (finding A3). Everything else was implemented from the spec text before comparison.

## Appendix: the guess log, as made

Recorded before verification ran, kept verbatim with resolutions added, because a guess that
turns out right is still a gap in the spec.

- **G1** S3 wire protocol entirely out of spec scope → expected; public docs sufficed. *(Notes)*
- **G2** "Windows path" = first segment `[A-Za-z]:`; folding = Unicode simple fold → untested by
  the bucket (all POSIX paths); synthetic tests only. *(→ B2)*
- **G3** `#DIR` with empty basename → refuse → never staged. *(→ B3)*
- **G4** basename collision compared byte-exact → never staged. *(→ B4)*
- **G5** atime := mtime → untestable differentially. *(→ C6)*
- **G6** hash/size-mismatched object: write bytes + fault + nonzero → staged! Tool behaves
  differently (stops dead). The one place my tree deliberately differs from the reference.
  *(→ A1, C5)*
- **G7** record-row hex test accepts either case → staged records are lowercase; guess unexercised.
  *(→ C1)*
- **G8** missing final LF = truncated → the staged truncation cuts at a line boundary *with* its
  LF, so this path ran only synthetically. *(→ A3)*
- **G9** `#DIR` accepted anywhere, `#SNAPSHOT` warned if not line 1 → all real files ordered as
  implied. *(→ C2)*
- **G10** trim = ASCII space only → confirmed against real padding bytes. *(→ C3)*
- **G11** reject `.`/`..` segments below a `#DIR` → never staged; synthetic only. *(→ A2)*
- **G12** duplicate path: take last, warn — the spec documents both readings (s3cab takes last, a
  stricter reader may reject) and is honest that they restore different bytes; not a gap, but the
  fork is real. Never staged; synthetic test only.
- **G13** graceful-continuation extended to every per-file fault; structural damage refuses the
  whole snapshot → matched the reference on both staged cases (truncated → refuse; missing
  object → carry on). *(→ A1, A3)*
- **G14** set-name charset unknown; URI-encode keys → all staged names trivial. *(→ C8)*
- **G15** (made during implementation) bucket snapshot with `PARTIAL` trailer: restore with
  warning → never staged. *(→ B5)*

Two guesses were *forced to become code* by the platform, worth flagging for other implementers:
Go's `time` parser accepts a comma as the fractional separator, which the spec explicitly
forbids — strictness needed a hand-written shape check (caught by my own test, not by the
bucket); and Go's `strings.Split` on `\n` is one of the few line-splitting APIs that *doesn't*
also split on `\v`/`\f`/U+0085, so the spec's `splitlines()` warning is aimed squarely at other
ecosystems' defaults.

## Reproducing

```sh
cd restorer && GOFLAGS=-mod=mod GOPROXY=off go build -o s3cab-restore . && go test ./...
. ../credentials.env && export AWS_REGION=eu-west-1
./s3cab-restore -bucket test-s3cab-allen-integration list
./s3cab-restore -bucket test-s3cab-allen-integration restore-all -out ../restored
python3 ../compare.py ../reference ../restored   # 2 expected differences: finding A1
```
