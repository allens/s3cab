# Output & compare UX

Epic: make s3cab's output consumer-friendly — human-readable by default, machine output behind
a flag, and a structured diff that survives to the CLI edge.

- **Human-readable output by default; `--json` for machines.** The single biggest
  consumer-audience win. The README quick start already *shows* the desired UX (`Added:` /
  `Moved:` sections); make it real, keep JSON behind a flag (and that also resolves the doc
  drift below). Stream discipline already separates results from progress, so this is purely
  the stdout formatter.
- **Summary counts**: end every snapshot/compare with
  `3 added, 1 moved, 2 modified, 0 deleted` (and "No changes." when clean).
- **First-snapshot experience.** The first ever snapshot diffs against empty and dumps every
  file as "added" — potentially a 100k-line JSON splash. Say
  `First snapshot: 1,234 files (4.2 GB)` instead.
- **Return structured data from `compare`,** not preformatted strings with embedded
  `→`/`→→`/`==` microsyntax. Presentation belongs in the CLI layer; the JSON output is
  currently neither human-friendly nor machine-friendly.
- **Keep `compare`'s diff structured to the edge** (architecture-deepening candidate D).
  `diff()` already returns a structured `DiffResult`, but `compareSnapshots` then flattens it
  to display strings (the arrow strings, `relativeToRoot`) before returning — so the structure
  is lost at *that* seam, and `--remote` must thread through presentation. Remaining work: have
  `compareSnapshots` return the structured result and move the arrow-string building into a
  `presentDiff()` the command calls, keeping the structure to the CLI edge.
- **Document or replace the arrow microsyntax** — `→` vs `→→` vs `==` in results is explained
  nowhere user-facing; in human output, words ("renamed", "moved", "duplicate of") may serve
  the audience better. Related: README promises "renamed" detection but `CompareResult` has no
  `renamed` key — it's implied by the arrow style only.
- **Colors** (plain ANSI per #5): green added / red deleted / yellow modified transforms
  compare output readability for zero deps.
- **A `doctor`/`info` command**: show which env files were found and applied, the resolved
  bucket/endpoint/region, which credential source won, and try a cheap S3 call. Auth
  misconfiguration is the #1 support question for any S3 tool, and the layered env model is
  invisible today without `S3CAB_DEBUG`.
- **"Did you mean…?" for misspelled commands** (edit distance over the registry);
  `s3cab help <unknown-topic>` currently falls back silently to the command list — say
  "unknown topic" and list the valid ones.
- **`--quiet`** to suppress stderr progress (for cron/scripts), and richer progress: bytes
  hashed + ETA, not just file-count percent.
- **Richer `list`**: snapshot date *and* file count / total size (cheap to read from the
  snapshot), maybe `list --stat`. Today it's bare names.
- **Flexible snapshot references**: accept unambiguous prefixes (`--since 2025-11-11`),
  `latest`, `latest~1` — anything to avoid typing `2025-11-11T0830` exactly (especially given
  the silent-typo bug in [bugs.md](bugs.md)).
- **Snapshot labels** (`snapshot -m "before reorg"`) — a commit-message-like note, storable as
  a header comment line without breaking the TSV format.
- **Friendlier failure for "no snapshots found"** — suggest running `s3cab snapshot` rather
  than a bare error.
- **Exit-code doctrine**: document the codes (0/1/127 today); decide whether `compare` should
  signal "differences found" diff-style (probably not, for a consumer tool — but decide).
- **`tree`'s stdout is a JSON array** (the dispatcher JSON-serializes every command result) —
  fine for machines, but a line-per-path mode (like `hashes`) would suit
  `s3cab tree > files.txt`. Falls out of the human-output work above.
