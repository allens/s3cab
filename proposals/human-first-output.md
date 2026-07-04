# Human-first output (`--json` for machines)

Epic: invert the CLI's default output — human-readable text on stdout, with today's JSON
behind a `--json` flag. Broken out of [output-ux.md](output-ux.md) as the single biggest
consumer-audience item (clig.dev's core output rule: "human-readable output is paramount —
humans first, machines second").

Today the dispatcher (src/s3cab.mjs) JSON-serializes every command result to stdout
(ADR-0010). That's machine-friendly but backwards for a tool aimed at ordinary folks. The
README quick start already *shows* the desired UX (`Added:` / `Moved:` sections); make it
real, keep JSON behind a flag (which also resolves that doc drift). Stream discipline
(ADR-0010) already separates results from progress, so this is purely the stdout formatter —
and `list` already writes formatted human text directly (list.mjs returns `undefined`), so
the epic generalizes what one command does ad hoc into the default for all of them.

Design notes:

- **`--json` is the stability contract** (clig.dev future-proofing): human output stays free
  to change between releases; `--json` output is an interface, kept stable for scripts.
  ADR-0010's JSON.stringify rationale (never truncates, one uniform serializer) carries over
  intact — it just moves behind the flag.
- **Summary counts**: end every snapshot/compare with
  `3 added, 1 moved, 2 modified, 0 deleted` (and "No changes." when clean).
- **First-snapshot experience.** The first ever snapshot diffs against empty and dumps every
  file as "added" — potentially a 100k-line JSON splash. Say
  `First snapshot: 1,234 files (4.2 GB)` instead.
- **Return structured data from `compare`,** not preformatted strings with embedded
  `→`/`→→`/`==` microsyntax. Presentation belongs in the CLI layer; the JSON output is
  currently neither human-friendly nor machine-friendly. The seam work is
  [architecture-improvements.md](architecture-improvements.md)'s "`compareSnapshots` returns
  structured diff" — this epic's work is what makes that seam real.
- **Document or replace the arrow microsyntax** — `→` vs `→→` vs `==` in results is explained
  nowhere user-facing; in human output, words ("renamed", "moved", "duplicate of") may serve
  the audience better. Related: README promises "renamed" detection but `CompareResult` has no
  `renamed` key — it's implied by the arrow style only.
- **Colors** (plain ANSI per ADR-0006, no dependency): green added / red deleted / yellow
  modified transforms compare output readability. Gate per clig.dev: only when the stream is
  a TTY, honouring `NO_COLOR` (see the TTY-gating item in [output-ux.md](output-ux.md)).
- **`tree`'s stdout is a JSON array** — fine for machines, but a line-per-path mode (like
  `hashes`) suits `s3cab tree > files.txt`. Falls out of the human-output work.

## Implementation starting points (added 2026-07-04 — orientation, not new design)

Where the work lands, for whoever picks this up cold (written right after slice 5, while the
command shapes are fresh):

- **The one seam is the dispatcher.** [src/s3cab.mjs](../src/s3cab.mjs) ends every command by
  `JSON.stringify`-ing the returned result to stdout (the `if (result !== undefined)` block).
  Human-first = commands keep returning structured data, and a **formatter** turns it into text
  on stdout by default; `--json` restores today's `JSON.stringify` path. A command that prints
  its own text already returns `undefined` so the dispatcher leaves stdout alone — exactly what
  [src/commands/list.mjs](../src/commands/list.mjs) does today, the pattern to generalize.
- **`--json` is a global flag**, handled once in the dispatcher (like `--help`/`--version`), so
  every command gets it uniformly and the registry needn't repeat it.
- **Commands returning a value today (all need a formatter):** `snapshot`, `compare`, `status`,
  `backup`, `restore`, `verify`, `delete`, `cleanup`, `tree`, `prop`. `list` already formats;
  `hashes`/`upload` are plumbing (line/summary output). The slice-5 trio returns rich objects
  (`verify` per-set reports, `cleanup` orphan/reclaim counts, `delete` a small record) — easy
  first candidates.
- **Keep the JSON serializer intact behind the flag** (ADR-0010: `JSON.stringify` never
  truncates, one uniform serializer). The formatter is *additive* — it precedes the JSON path,
  never replaces it.
- **Suggested first slice:** add the global `--json` flag + the dispatcher fork (formatter vs
  JSON), then do `compare` (highest value, and it needs the "return structured data, not
  arrow-microsyntax strings" refactor the notes above call for — the
  [architecture-improvements.md](architecture-improvements.md) "structured diff" seam). The
  rest follow one command at a time; a shared `--json` test asserts each command's machine
  output stays stable.
