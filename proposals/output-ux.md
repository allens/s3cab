# Output & compare UX

Epic: make s3cab's output consumer-friendly. The headline item — human-readable output by
default, `--json` for machines, and the compare-diff/formatting work that feeds it — graduated
to its own build spec, now **implemented** and deleted; the decision lives in
[ADR-0043](../docs/adr/0043-human-first-output.md). This file keeps the surrounding output/UX
niceties.

- **Show the short form in missing-argument errors.** Today a missing flag reports
  `Missing required argument: --bucket — <description>`; the `-b` is discoverable only via
  `--help`. User-reported friction (2026-07-18): "it complains I haven't used `--bucket`
  without letting me know I could have used `-b`."
  - **This was never actually decided.** [ADR-0038](../docs/adr/0038-usage-error-synopsis-not-full-help.md)
    governs usage errors and never mentions short forms — the omission is collateral from
    moving the `Options:` **table** (where `-b, --bucket` rendered) to `--help` only. Some
    past session argued against it; the reasoning was not recorded. The best reconstruction
    is *non-uniformity* (not every option has a short, so the line renders inconsistently),
    echoing the ADR's own "uniform beats special-cased". That argument looks weak: `--help`
    already renders that same mixed shape without complaint.
  - **The fix removes a hardcoding rather than adding machinery.** The dispatcher already
    looks the arg up in the registry to render its description, so `short` is in hand; the
    `--bucket` text is currently hand-written into the throw in `setup.mjs`, so making it
    registry-driven single-sources it — the direction ADR-0038 was already pushing.
  - Gets more relevant once `--set`/`-S` becomes a required flag on `delete`/`restore`/`setup`.
  - Amend ADR-0038 with a short "shorts are shown too" note when it lands.
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
    Live caller: the S3 upload-progress line ([s3.mjs](../src/lib/s3.mjs), `formatUploadProgress`),
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
- **Exit-code doctrine**: document the codes (0/1/2/127 today); decide whether `compare`
  should signal "differences found" diff-style (probably not, for a consumer tool — but
  decide).
