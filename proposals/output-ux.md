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
- **"Did you mean…?" for misspelled commands** (edit distance over the registry);
  `s3cab help <unknown-topic>` currently falls back silently to the command list — say
  "unknown topic" and list the valid ones.
- **`--quiet`** to suppress stderr progress (for cron/scripts), and richer progress: bytes
  hashed + ETA, not just file-count percent.
- **Display formatting** — the byte/time humanizers the size and progress output above lean on
  (the bytes-hashed progress, the `4.2 GB` first-snapshot line, `list --stat` total size). Built
  from the JS standard library (`Intl`), no `pretty-bytes`-style dependency.
  - **Bytes** (✅ done) — `formatByteValue` in [format.mjs](../src/lib/format.mjs) was *buggy*:
    `notation: "compact"` collided the English short-scale "B"(illion) suffix with the byte unit
    (`1500000000 → "1.5BB"`) and emitted `"KB"` instead of SI `"kB"`. Now it picks the unit by
    magnitude (base 1000) and renders with
    `Intl.NumberFormat("en", { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: 1 })`,
    where `unit` takes a canonical identifier (`byte`, `kilobyte`, …, `petabyte`) that `narrow`
    renders as the symbol (`B`, `kB`, …, `PB`) — *not* the symbol itself (`unit: "kB"` is
    invalid). Decimal SI (matches Finder / pretty-bytes; `Intl` has no binary unit anyway).
    Accepted edge: `999999 → "1,000kB"` (no roll-up to MB) — rare, not worth the extra logic.
    Live caller: the S3 upload-progress line ([s3.mjs](../src/lib/s3.mjs), `httpUploadProgressHandler`),
    plus the `S3CAB_DEBUG` heap readout.
    - **How the byte progress was lost** (don't repeat it): the upload-progress *plumbing* never
      went away — `@aws-sdk/lib-storage`'s `Upload` + its `httpUploadProgress` event (a plain
      `PutObjectCommand` emits no progress), rendered in place via `node:readline`
      `clearLine`/`cursorTo` with an ASCII bar. What broke was just the *formatting*: commit
      `79c93e4` (2025-12-08) dropped the `pretty-bytes` dep, introduced the buggy `compact`
      formatter for the memory-debug line *only*, and downgraded the upload line from
      `prettyBytes(loaded) of prettyBytes(total)` to raw integers (`uploaded 5242880 of …`) —
      never re-pointing it at the replacement. This change reconnects it.
  - **Times** (settled, not yet implemented) — three buckets, two display formatters:
    - *Per-step* (one hash, one upload — operations with human-perceptible latency): a **new**
      `formatSeconds` → `"2.4s"`, seconds with 1 decimal (≈0.1s resolution = the perception
      threshold). For the future hash/upload progress lines.
    - *Overall / aggregate* (tree duration, whole run): **keep** `secondsSince` as-is — the
      composite `"1 hr, 2 mins, 5 secs"` reads better than raw seconds at scale, and
      integer-second precision is enough.
    - *Times of record* (e.g. `prop`'s `hashDuration`, stored as fractional seconds at
      millisecond resolution): already precise enough — data, not display, so unchanged. mtime
      is likewise serialized as ISO / applied via `utimes`, never humanized → out of scope.
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
