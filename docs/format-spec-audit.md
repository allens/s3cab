# The format-spec clean-room audit (2026-08-12)

A literal test of the no-lock-in promise: a minimal independent restorer was written in Python
from [guide/format.md](../guide/format.md) **alone** — no `src/`, no other guides, no ADRs, no
tests — then verified differentially against s3cab itself, restore against restore,
byte-for-byte including paths and modification times. The point was never the restorer: it was
to surface every place the spec is ambiguous, silent, or wrong, ranked by whether a wrong guess
corrupts a restore or merely costs the implementer. The restorer is preserved as
[scripts/pyrestore.py](../scripts/pyrestore.py); its inline `GUESS(n)` comments are the raw form
of the findings below.

## Verdict

**The claim survives.** The restorer took one sitting and ~250 lines of stdlib-plus-boto3
Python. Across six backup sets (five real repositories plus a crafted edge set), nine snapshot
restores, ~430 files and ~4.7 GB hashed per side, the independent implementation and s3cab
agreed **byte-for-byte, path-for-path, and to the nanosecond on mtimes** — including the
deletion-record skip path, the unexplained-missing-object fault path, and unicode/emoji/CJK
filenames. But the spec forced sixteen guesses, and five of them would corrupt a restore
silently if guessed the other way.

## Method

The harness was fully local: a moto S3 server, an empty bucket, and `s3cab backup` itself
writing the format both restorers then read — the same bytes any S3-compatible provider would
hold. Scenarios and results:

| Set            | Files        | Scenario                                                       | Result           |
| -------------- | ------------ | -------------------------------------------------------------- | ---------------- |
| dotfiles       | 15           | plain restore                                                  | 0 diffs          |
| minimatch      | 49           | plain · after `delete` · after re-upload of a recorded hash    | 0 diffs ×3       |
| pacific-mirror | 23           | plain restore                                                  | 0 diffs          |
| wild-skies     | 5            | plain restore                                                  | 0 diffs          |
| platform       | 275 · 1.5 GB | large objects, multipart-uploaded                              | 0 diffs          |
| edge (crafted) | 7            | unicode/emoji/CJK · empty file · dedup pair · two generations · missing object | 0 diffs; fault paths converged |

The parser was additionally validated against 18 real ~265k-row snapshots of a production set
(1.7 TB recorded, 1,407 non-ASCII paths): all parsed strictly with zero errors. The differential
harness (a byte/path/mtime-ns tree comparator and the local-snapshot parser check) was a session
artifact and is not preserved; the restorer's `--manifest` output is what it joined on.

## Findings

Ranked by consequence. `GUESS(n)` references match the comments in
[scripts/pyrestore.py](../scripts/pyrestore.py).

### Tier 1 — a wrong guess corrupts a restore, silently

**F1 · The text encoding is never stated — anywhere.** Snapshots, deletion records, `dirs.txt`,
`info`: no encoding is named for any of them. Paths are "in the OS's native style", which on
Windows is natively UTF-16, and a Windows-minded implementer reading bytes could as easily pick
the ANSI code page. Every non-ASCII path then restores under a mangled name — silently, since
nothing fails. The audit guessed UTF-8 without BOM (GUESS 1), decoded strictly so a wrong guess
would explode, and confirmed it empirically: ~4.8M real rows decoded cleanly, and
emoji/CJK/accented filenames round-tripped byte-identically through both implementations. The
deletion record needs the answer too — a real one contains a U+2014 em-dash in its header.
*Fix: one sentence — "all text files in this format are UTF-8, no BOM."*

**F2 · "Trim whitespace when parsing" is unscoped — and trimming the path corrupts real
filenames.** The instruction sits mid-sentence about padded columns, but as written it invites
trimming all four fields. The path is last, unpadded — and on Linux/macOS a filename may
legitimately begin or end with a space. A strip-everything parser restores `" notes.txt "` as
`"notes.txt"`: silent corruption in exactly the class of odd-filename edge the spec elsewhere
legislates carefully (tabs, newlines). The audit guessed: trim fields 1–3 only, take the path
verbatim from the third tab to end-of-line (GUESS 3). *Fix: "trim the three leading fields; the
path is everything after the third tab, verbatim."*

**F3 · Line endings are unstated, and "newline" is undefined for the path rule.** Nothing says
rows end in LF. A CRLF-assuming reader (or writer!) puts `\r` inside the path field or strips a
legitimate one — POSIX filenames may contain `\r`, and the exclusion rule says only "tab or a
newline". Is CR a newline? Is form feed? Python's `splitlines()` splits on `\v`, `\f`, `\x85`
and more, all legal path bytes under the stated rule — a natural-looking parser mis-splits such
a file. The audit guessed LF-terminated, split on `\n` exactly, hard-fail on any CR (GUESS 2);
observed: LF only, single trailing newline. *Fix: "rows end in LF (never CRLF); 'newline' in the
path rule means LF and CR; other control characters are legal in paths."*

**F4 · Duplicate path rows: undefined.** Nothing forbids the same path appearing twice in one
snapshot. A first-wins reader and a last-wins reader restore *different bytes* from the same
file, with no error either way. The audit treats a duplicate as malformed and refuses (GUESS 5).
s3cab never writes duplicates in practice, which is exactly why an independent reader needs the
commitment in writing. *Fix: "a path appears at most once per snapshot; readers may treat a
duplicate as a malformed file."*

**F5 · Deletion record vs. present object: who wins is unstated.** The record is defined as
explaining *absence* — but nothing says what a reader does with a recorded hash whose object
exists again (content deleted, then later re-backed-up: the object returns; the record stays
forever). A reader that treats records as authoritative skips restorable files indefinitely. The
audit guessed presence-wins — consult records only when a GET misses — and tested it live: after
re-uploading a recorded hash, both implementations restore everything. Convergent, but only by
luck of the same reading. *Fix: "a record explains a missing object; if the object is present,
it is restorable — presence always wins."*

### Tier 2 — fidelity loss, or loud breakage

**F6 · mtime: grammar under-pinned, and the precision loss never admitted.** "ISO-8601 with
milliseconds, UTC" admits `+00:00` offsets, comma decimals, and any digit count; the audit
assumed exactly `YYYY-MM-DDTHH:MM:SS.mmmZ` (GUESS 4), which held for all ~530k rows checked.
Separately, the spec never says the value is *rounded* to the nearest millisecond: measured
against originals, restored mtimes drift up to ±0.5 ms in both directions (NTFS keeps 100 ns).
Both restorers agree with each other exactly, but no restore can reproduce the original's sub-ms
mtime, and any mtime-comparing sync tool sees every restored file as different. An inherent,
undocumented property of the format. *Fix: pin the exact grammar; add "mtimes are stored rounded
to the millisecond — restores reproduce the stored value, not the original's finer timestamp."*

**F7 · Restore semantics for damage: continue or abort?** The spec prescribes graceful
skip-with-date for recorded deletions (both tools: identical behavior, exit 0) but says nothing
about an *unexplained* missing object beyond "integrity fault". Both implementations
independently chose continue-and-report with a nonzero exit — convergence worth canonizing,
since a half-restore that stops at file 3 of 400 is a materially worse recovery tool. *Fix: "a
restorer should restore everything it can, report unexplained missing objects as faults, and
exit nonzero."*

**F8 · Deletion-record rows: grammar details left to inference.** Is the record width-padded
like a snapshot? (Observed: no.) Trim the hash field? Is the `# hash\tpath` line data or
comment? (Comment — the skip-`#` rule saves it.) The real record also carries a whole prose
paragraph the spec's example lacks — fine under skip-`#`, but nothing says the comment block is
advisory and unstable. (GUESS 6.) *Fix: "records are unpadded; `#` lines are human context and
may change freely; rows are `hash TAB path`."*

**F9 · "Every line has four fields" is not actually guaranteed for metadata rows.** The `#ERROR`
row's third column carries a raw OS error string (observed: an 88-char EBUSY message). The
no-tab rule protects *paths* — nothing promises error text is tab-free, and a tab there gives
that line five fields. A parser that validates field count before checking for `#` dies on
metadata it was told to ignore. *Fix: either sanitize whitespace in metadata text, or state "the
four-field guarantee holds for file rows; skip `#` lines before any structural validation."*

### Tier 3 — implementer friction and documentation polish

**F10 · The example snapshot doesn't show the real bytes.** Real files pad field 1 to 64 chars
(so `#SNAPSHOT` trails 55 spaces), right-align field 2, pad field 3 to 24 — and the widths *grow
mid-file* (10→11→12 observed in one real snapshot) while overlong values simply overflow their
column. The spec's fenced example shows none of it. A parser that trims is fine; anyone building
a writer, a golden test, or a `startswith("#SNAPSHOT\t")` matcher from the example produces or
expects the wrong bytes.

**F11 · Metadata-row payloads are undocumented.** `#EXCLUDED` carries kind/pattern in columns
2–3, `#SKIPPED` carries kind/reason, `#DIR` leaves them blank — none of it written down. Restore
doesn't need them, but the file is billed as self-describing, and a by-hand reader meets these
rows first.

**F12 · `sets/<set>/info` syntax unspecified.** "Owner machine + created date" — the actual
bytes are `OWNER=<host>\nCREATED=<iso-instant>\n`. Self-evident once seen; a one-line example
would make it a commitment.

**F13 · Windows MAX_PATH: the one thing that actually broke.** Snapshot paths are absolute;
re-rooting them under an output directory deepens already-deep trees, and the first platform
restore crashed at 260+ chars until every OS call went through `\\?\`. A loud failure, not
corruption — but it will bite every Windows restorer, and one implementer's-note sentence would
save each of them an hour.

**F14 · Cross-OS restore hazards unmentioned.** Two rows differing only by case (legal in one
Linux snapshot) collide on a Windows target; NTFS-invalid characters in POSIX names fail
outright. Arguably out of scope — worth one sentence saying whose problem it is.

**F15 · "Download the object — that is your file" assumes a GET-able storage class.** A
lifecycle rule that archives `objects/` to Glacier breaks the recovery recipe with an error the
by-hand reader won't recognize, and nothing in the spec warns against it.

**F16 · Small unstated legalities.** Snapshot-name grammar (`YYYY-MM-DDTHHMM`, inferred from one
example); whether a header-only snapshot with zero file rows is legal (the audit allows it);
restore-to-a-new-root path mapping (correctly tool UX, not format — worth an explicit "out of
scope" so a reader knows it wasn't forgotten).

## What the spec got exactly right

- **No tabs in paths makes naive `split("\t")` safe.** The escaping-free design carries its
  whole weight; the row grammar never wobbled across ~4.8M real rows.
- **"Skip every `#` line" is load-bearing and correct.** It absorbed metadata kinds and record
  prose the examples never showed — the format can grow without breaking old readers.
- **Local↔remote snapshot byte-identity: verified true** (SHA-256-identical).
- **Objects carry no metadata; hash is identity and key.** All 374+ downloads hashed to their
  key; the size field cross-checked everywhere.
- **Objects-first invariant and cross-set dedup observed working** — the crafted set's empty
  file was already in the bucket from another repository and restored fine from either.
- **Deletion-record semantics reproducible from prose alone** — skip-with-date behavior and its
  date source (the record's filename) converged exactly between implementations.
- **The afternoon claim is literal.** One sitting, ~250 lines, nothing beyond stdlib zstd + an
  S3 client.

## Where the spec alone wasn't enough

Each recorded rather than resolved by reading the source (the clean-room rule): the writer's
text encoding (settled empirically — strict decoding plus a unicode round-trip); the
column-padding algorithm, when three widths showed up in one file (settled by inspecting more
real output; a writer-implementer couldn't); the record-vs-presence precedence of F5, where the
silence was total (settled differentially). One tool-behavior question — which config layer
`delete` reads — was settled from `s3cab provider --help` prose, program output being fair game.

## Tool observations (not spec findings)

- `s3cab delete --bucket` resolves paths through attached sets but signs in with ambient
  credentials — it never adopts any set's `env` (endpoint, keys). In the sandbox it silently
  went to real AWS and got AccessDenied; with six sets sharing one bucket it arguably can't pick
  an `env`, but the failure mode is surprising.
- Restore's output mapping is `<output>\<directory-name>\…` — two member directories with the
  same basename would collide. Unverified; noted in passing.
