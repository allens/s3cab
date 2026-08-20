# The format-spec clean-room audit, run 2 (2026-08-20)

The second literal test of the no-lock-in promise, and the first that also tested what
*reading* the format costs. Everything below the rule is the clean-room session's own report,
verbatim and unedited — including its own top-level heading.

**How run 2 differed from [run 1](format-spec-audit.md).** Three deliberate changes:

- **No AWS SDK, and no S3 client library, packaged or not.** Run 1 used boto3, so it answered
  whether the *format* is readable without s3cab but not whether it is readable without the
  vendor's code. The restorer here signs its own SigV4 requests. That is the second result:
  s3cab depends on the SDK completely, and nothing had ever established what a reader needs.
- **A real bucket, not a local moto server**, so the store's 1000-key listing pages, multipart
  objects and stream teardown were all live.
- **A reproducible corpus.** Run 1's fixtures were staged by hand and its harness "was a
  session artifact and is not preserved", which is why its findings could not be re-tested on
  the same data. Run 2's corpus is built by
  [scripts/cleanroom-fixtures.mjs](../scripts/cleanroom-fixtures.mjs), whose header carries a
  fixture-per-finding matrix for F1–F16, and its differential verifier is preserved as
  [scripts/cleanroom-compare.py](../scripts/cleanroom-compare.py).

The session read `guide/format.md` and nothing else — no `src/`, no ADRs, no other guides, and
not run 1's report, so that diffing the two ambiguity lists afterwards would mean something.
Its restorer is preserved as [scripts/cpprestore.cpp](../scripts/cpprestore.cpp).

**None of run 1's F1–F16 reappeared**, and its finding 12 confirms each of those fixes against
real data. Two things it found that run 1 could not: the sub-millisecond restore defect in
[src/commands/restore.mjs](../src/commands/restore.mjs) (finding 2 — run 1's Python restorer
routed mtimes through the same binary64 seconds, so the two implementations agreed *because*
they shared the flaw), and the answer to the SDK question.

---

# Clean-room restorer for s3cab: report on `format.md`

**Date:** 2026-08-20 · **Author:** Claude (clean-room exercise; sole format source: `format.md`)

## Summary

A complete independent restorer was written in C++23 (`restorer.cpp`, ~700 lines) using only
Ubuntu 24.04's own packages: libcurl for HTTPS, OpenSSL for SHA-256/HMAC, libzstd for
decompression. **No AWS SDK, no S3 client library, no shelling out** — AWS Signature
Version 4 is implemented by hand and worked on the first attempt, derived from public AWS
documentation knowledge alone. All seven snapshots in the bucket were restored over real,
signed HTTPS requests and compared byte-for-byte against the reference restores.

**Result: paths, directory structure, and file contents are byte-identical across all
seven restores — including every hostile filename in the `edge` set** (leading/trailing
spaces, form feed, vertical tab, U+0085 NEL, NFC/NFD Unicode pair, emoji, a ~300-character
deep path, a 1970 mtime, a 2038 mtime, an empty file). The planted integrity fault
(`faults/torn.txt`) was detected, reported, and skipped exactly as the reference did, with
a nonzero exit. The deleted-then-re-backed-up object restored in both `edge` snapshots
("presence always wins" honoured).

**The only differences found — 1261 of 1269 files — are sub-millisecond mtime deviations
in the *reference* restores, not in mine.** Root-caused below (finding 2): the reference
tool routes the stored timestamp through an IEEE-754 double of seconds; my restorer
reproduces the stored millisecond value exactly, as the spec commits.

The spec is, overall, unusually good: nearly every trap it warns about is real and
present in the fixture data, and following its text literally produced a byte-perfect
restore. The findings below are the places where it was ambiguous, silent, or (in one
case) contradicted by the tool's own behaviour. Each was recorded when the guess was
made, before knowing whether it was right.

---

## Differential verification (the evidence)

| Snapshot | Files restored | vs reference |
| --- | --- | --- |
| bulk/2026-08-20T0135 | 1100 | identical except sub-ms mtimes (1100) |
| docs/2026-08-20T0134 | 120 | identical except sub-ms mtimes (120) |
| edge/2026-08-20T0134 | 23 | identical except sub-ms mtimes (19; 4 exact) |
| edge/2026-08-20T0137 | 23 | identical except sub-ms mtimes (19; 4 exact) |
| faults/2026-08-20T0136 | 1 of 2, exit 2 | identical except sub-ms mtime (1) |
| hollow/2026-08-20T0136 | 0 (legal empty snapshot) | identical |
| media/2026-08-20T0136 | 2 (42 MB) | identical except sub-ms mtimes (2) |

Comparison: `compare_trees.py` walks both trees with raw byte paths and compares the path
set, per-file SHA-256, and `st_mtime_ns`. Zero missing/extra/content/structure
differences anywhere; 1261 mtime differences, all below 1 ms, all explained by one model
(finding 2); the 8 exact matches are precisely the files whose stored value has `.000`
milliseconds. Every downloaded object was re-hashed during download and matched its key.

Bucket-wide invariant audit: 1244 unique hashes referenced by the seven snapshots; 1243
objects present; the single referenced-but-absent hash is `faults/torn.txt`'s
(`a2e137a6…`), which no deletion record lists — the intended unexplained fault. Zero
orphan objects. The empty-string object (`e3b0c442…`) is genuinely stored, so the
objects-first invariant holds even for zero-byte files. The deletion record's hash
(`8446e508…`) is present again (re-uploaded by edge/…T0137's backup after the delete).

---

## Findings, ranked

### Tier 1 — a wrong guess silently corrupts or misplaces a restore

**1. The output path mapping is unspecified, and cannot be derived from the spec.**
The spec deliberately declares where a restored file lands "a decision for the tool, not
the format" — defensible as a format stance, but it means *no independent restorer can
reproduce the tool's own `restore --output` layout without observing it*. I had to
inspect the reference trees to learn the rule, and even then two hypotheses fit
everything observable: `<out>/<basename of matched #DIR>/<relative path>` versus
`<out>/<set name>/<relative path>` — indistinguishable here because every set's single
member directory has a basename equal to the set name. I guessed basename-of-`#DIR`
(longest-prefix match). If a set had two member dirs with the same basename (`/a/data`
and `/b/data`), that layout merges them silently; whether the real tool does too, I
cannot know. **If interop with the tool's own restores matters, the layout rule belongs
in the spec** (or in a companion "what s3cab's restore does" note); without it,
"compare my restore against the tool's" is not a well-defined exercise.
*Consequence of a wrong guess: every file lands at a wrong (or colliding) path — the
worst silent failure available. Verified right only by looking at the reference.*

**2. Sub-millisecond restore semantics: the spec's "exactly" is under-specified, and the
tool's own restores contradict the natural reading.**
The spec: "A restore reproduces the *stored* value exactly, so a restored tree compares
clean against the snapshot it came from." Stored precision is milliseconds; I zero-filled
below that (`.674` → `674000000` ns). The reference restores instead carry
`…674000024`-style values. All 1269 reference mtimes — with zero exceptions — equal
`sec·10⁹ + ⌊frac(double("sec.ms"))·10⁹⌋`: the tool parses the timestamp into a binary64
count of seconds and truncates the fraction to nanoseconds, injecting up to ±119 ns of
error (files with `.000` ms are exact because those doubles are exact). So at nanosecond
granularity the tool violates its own spec's claim: its restored tree does *not* compare
clean against the snapshot for any ns-precision comparator, and two spec-faithful
restorers (mine and the tool) produce measurably different trees. Not content corruption,
but it is the one thing in this whole exercise that failed byte-for-byte comparison —
in a format whose promise is exact reproduction, the spec should say what goes below the
millisecond (zero-fill being the only reading consistent with "exactly"), and the tool
should be fixed to match. *This is a bug in the tool (or a wrong claim in the spec), not
in the independent restorer — precisely what differential testing is for.*

### Tier 2 — a wrong guess degrades robustness or reporting, not bytes

**3. "Skips them gracefully with their date" — whose date? And the `generated:` header is
load-bearing but off-limits.** For a recorded-deletion skip, the spec doesn't say whether
to report the record's minute-precision filename or the full UTC instant in its
`# generated:` header. The same section commits readers to "read the rows and never parse
the header" (its wording will change), yet earlier says same-minute records "can still be
told apart and ordered" *by that header*. A reader that must order records has no
committed way to do it. I guessed: report the filename timestamp. Ordering never mattered
for restore (presence wins makes records advisory), but the spec itself points readers at
a line it forbids them to parse.

**4. Verifying downloaded bytes against the hash is never mentioned — nor what to do on
mismatch.** The hash is "both the file's identity and its key", but the restorer guidance
never says to re-hash downloads, and is silent on the corrupt-object case (bytes present
but hashing to something else): leave the file, delete it, count it with missing-object
faults? I verify during download and treat a mismatch as an unexplained fault, leaving no
partial file behind. The bucket contains no corrupt object, so this policy ran zero times
against real data (`torn.txt`'s object is absent, not corrupt) — stated here so the guess
isn't mistaken for a verified behaviour.

**5. A file row not under any `#DIR` is possible and unhandled.** Hand-editing snapshots
is explicitly contemplated, and nothing promises every row's path sits under a `#DIR`.
Under finding 1's mapping such a row has no destination. My tool reports it as a fault
and restores the rest. Never triggered here.

**6. `#DIR` prefix-matching mechanics are unstated.** Matching must be at a path-component
boundary (`…/trees/edge` must not claim `…/trees/edgeX/f`); whether a `#DIR` may carry a
trailing slash, and which of several matching dirs wins (I chose longest), are all
guesses. The spec's note on Windows case-insensitive `#DIR` matching shows these details
matter, but the mechanics are left to the reader.

**7. Cross-OS restore is delegated — which is a stated gap, honestly.** The spec says a
tool must choose and state its policy. Mine: Linux-style paths only; a Windows-style
snapshot (drive letter) is refused with a message rather than mangled. Any two
independent restorers will legitimately differ here; fine, as long as everyone writes it
down like the spec asks.

**8. Set names are unconstrained.** They appear in S3 keys, local directory names, and the
snapshot header's 10-wide column. Nothing says what characters a set name may contain
(`/`? spaces? `..`?), so a listing parser and a restorer must guess how defensive to be.
All names here are tame.

### Tier 3 — inconveniences and notes for the next implementer

**9. `format.md` cites documents the clean-room reader doesn't have** — `exclude.md`,
`compare.md` (for `#SKIPPED`'s "online only" case). Nothing needed for restore lives
there, but a spec that promises self-sufficiency should either inline the relevant
sentence or mark the links as non-normative. (Recorded as "wanted more than the two
files": I did not follow them.)

**10. `#END` marker matching.** "Match the marker and ignore anything after it" — I took
the marker to be the whole first (trimmed) field, so `#ENDX` is not a trailer but
`#END<TAB>extra` is. Consistent with the table's "the whole line is `#END`", but a
one-line grammar (`line == "#END"` or `line startswith "#END\t"`) would remove the guess.

**11. Deletion-record filename grammar is slightly informal.** "`<timestamp>[-<n>].tsv`"
with `-2` as the *second* run implies `-1` never occurs and `<n>` starts at 2; a strict
name validator has to infer that. My reader accepts any `deletions/*.tsv`, which the spec
arguably endorses ("read every file under `deletions/`").

**12. Confirmations worth keeping in the spec** — these traps are real, the fixture tests
them, and the spec's warnings were each verified the hard way here:
LF-only splitting (filenames containing U+000B, U+000C, U+0085 all restored intact —
a `splitlines()`-style parser would have cut three paths in half); never trimming the
path (` both ends.txt ` and `trailing.txt ` survive); the `#`-test-before-field-count
rule (`#SKIPPED`'s 13-char second column and the bare `#END` both break a
count-fields-first parser); the `#END` truncation sentinel; column padding of 64/10/24
with right-aligned column 2 (the *set name* is right-aligned too, which a golden-test
writer might not expect); "presence always wins" (a tombstone-style reader would silently
skip two restorable files in *both* edge snapshots — the fixture is specifically built to
catch it); the objects-first invariant including the zero-byte object; an empty snapshot
being legal; and the header/`#DIR` self-description sufficing to rebuild the tree.

---

## What reading the format actually needs (the no-SDK question)

Everything the vendor's SDK does that a *reader* needs reduced to four things, all
implementable from public documentation with platform packages:

1. **HTTPS GET** (libcurl, ~nothing exotic: no redirects, no chunked uploads);
2. **AWS SigV4 request signing** — SHA-256 + HMAC-SHA-256 (OpenSSL), canonical request,
   signing-key derivation, `x-amz-security-token` as a signed header for session
   credentials. ~80 lines. **It worked on the first attempt against the real endpoint;
   the `aws` CLI was never needed to get signing right.** Signing is derivable from
   public AWS documentation alone. (The CLI was used twice, as permitted: once to confirm
   the bucket was reachable before writing code — as `ENVIRONMENT.md` itself suggests —
   and once to download snapshot copies for offline parser development, plus as the
   listing source for the independent bucket-audit cross-check. Every restore result
   reported above came from the restorer's own signed requests.)
3. **ListObjectsV2** — one XML response shape (Key / IsTruncated /
   NextContinuationToken / CommonPrefixes), pagination via signed continuation tokens
   (exercised for real: the 1243-key `objects/` listing spans multiple pages);
4. **zstd decompression and SHA-256 hashing** (libzstd, OpenSSL).

So the format's reading dependency is: *an HTTP client, two hash primitives, one
decompressor, and one page of signing arithmetic.* The no-lock-in claim holds, with the
one caveat of finding 1: the *bytes* need nothing from the vendor, but reproducing the
tool's *restore layout* needs knowledge the spec withholds.

## Paths not exercised against the real bucket (honesty section)

- The recorded-deletion skip (restore path for a hash that is absent *and* recorded):
  the only recorded hash is present again, so this code path never fired in a real run.
- Corrupt-object handling (finding 4). No corrupt object exists in the bucket.
- HTTP 403 / credential-expiry reporting; Windows-style snapshots; multi-`#DIR` sets;
  duplicate-path snapshots (my reader refuses them, per "a reader may treat one as
  malformed") — no fixture exercises these.

## Deliverables

- `restorer.cpp` → `s3cab-restore` — build:
  `g++ -std=c++23 -O2 -Wall -Wextra -o s3cab-restore restorer.cpp -lcurl -lcrypto -lzstd`
  - `s3cab-restore --bucket B --region R list`
  - `s3cab-restore --bucket B --region R restore <set> <snapshot> <outdir>` (exit 0 clean,
    2 with integrity faults, faults enumerated; restores everything restorable first)
  - `get <key>` / `count <prefix>` — debug/audit subcommands.
  - Credentials from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`.
- `compare_trees.py` — the differential verifier (byte paths, content hashes, ns mtimes).
- `out/` — the seven restored trees compared above.
- This report.
