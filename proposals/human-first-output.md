# Human-first output (`--json` for machines)

Epic: invert the CLI's default output — human-readable text on stdout, with today's JSON
behind a `--json` flag. The *decision and why* are pinned in
[ADR-0043](../docs/adr/0043-human-first-output.md); this file is the **build spec** — the
resolved design the slices work from. Broken out of [output-ux.md](output-ux.md) as the
single biggest consumer-audience item (clig.dev: "human-readable output is paramount — humans
first, machines second").

Settled in a grilling session (2026-07-04). Everything below is agreed unless marked _open_.

## Architecture (settled)

- **Commands return data; nothing prints inside a command.** Every `src/commands/` function
  computes and `return`s a structure (array/object). `list` and `hashes` — which today
  self-print and return `undefined` — are rewritten to return data like the rest.
- **One central render layer.** Renderer *bodies* live in `src/render.mjs`, composing
  `src/lib/format.mjs` primitives (bytes, pluralization, the summary line, colorizers). Each
  registry entry in `commands.mjs` gains a **`render` reference**; `render` is a **required**
  field for built commands (typecheck-enforced) — no generic fallback. A renderer **returns a
  string**.
- **The dispatcher owns stream, colour, and `--json`.** Stdout step becomes
  `json ? JSON.stringify(result) : command.render(result)`. `--json` is a **global** boolean,
  handled once in the dispatcher (like `--help`/`--version`) and **stripped before `exec`** (the
  command never sees it). Colour gates on `styleEnabled(stdout)`.
- **Routing by registry reference** (not a result type-tag, not a parallel registry): keeps
  `--json` free of presentation fields, and lets `snapshot` + `compare` point at one shared
  `renderCompareResult` (same return type).
- **Async-iterable returns are *not* needed.** Every list-shaped command already holds its full
  data in memory (snapshot Maps, walk arrays), so streaming the render would optimize nothing;
  and a normal target machine has ample memory. Progress lives in the *processing* pipeline
  (Layer 1 — plain counters, or the `snapshot` `withProgress` generator), independent of the
  finished value the render layer formats.

## `--json` mechanics (settled)

- **Explicit-only** — no TTY/pipe auto-switch. Predictable format everywhere
  (`s3cab compare > changes.txt` yields readable text).
- **Not a stability contract yet** (pre-1.0): document `--json` as "shape may change".
- **Errors stay human-readable on stderr regardless of `--json`.** `--json` governs only the
  success result on stdout. Structured JSON errors are deferred until a consumer needs them.
- **Never truncate** (ADR-0043): the tool never truncates human output; the user manages volume
  with a pager or redirect. `--json` is the escape hatch for machine consumption.

## `CompareResult` data model (settled)

`compareSnapshots` returns structured data — **absolute paths**, no `→`/`→→`/`==` microsyntax.
`diff()` already produces structured Maps; only the final string-assembly (compare.mjs
lines ~124–145) moves to the renderer.

```js
CompareResult = {
  setName, dirs, since, until,                 // metadata: header + self-describing --json
  added:    { path, size, duplicates: string[] }[],  // duplicates [] = genuinely new; non-empty = a copy
  moved:    { path, size, to: string }[],            // path = old location, to = new
  modified: { path, size }[],
  deleted:  { path, size }[],
  errors:   { path, reason }[],
}
```

- **Uniform `{ path, … }` objects** everywhere (even `modified`/`deleted`) — one loop shape in
  the renderer, and future fields (e.g. `oldHash`/`newHash`) don't break the contract.
- **Rename is derived, not a category.** `moved` covers both; the renderer says "renamed" when
  `dirname(path) === dirname(to)`, else "moved". (Fixes the README "renamed" gap — it becomes a
  rendering, not a missing key.)
- **`duplicates`** (not `sameContentAs`): the existing paths this added file duplicates.
- **`size`** on every entry: already carried by snapshot `Props`, currently discarded by
  `diff()`; thread it through. Spent in the summary (bytes changed) and the first-snapshot line.
- **Absolute paths in the data; the renderer shortens.** Paths are absolute internally
  everywhere (walk, TSV, `diff`, even restore's default) — relative is only ever a display
  transform. So `--json` gets unambiguous absolute paths; the human renderer computes the
  **longest common-ancestor directory of `dirs`** (segment-wise, not string-prefix) and shows
  everything relative to it, with that base in the header. This replaces the old per-path
  shortest-wins `relativeToRoot` (which silently mixed bases) — one base, unambiguous, and it
  unifies single- and multi-root (single-root = the degenerate case). Degrades to ~absolute when
  roots share no common base (e.g. different Windows drives).

## Rendering rules — `compare`/`snapshot` (settled)

Fixed section order, **only non-empty sections shown**, count in each header, colours gated on
`styleEnabled(stdout)`, summary line to close:

```
photos: ~/Pictures  2026-07-01 → 2026-07-04

Added (3)
  2025/beach.jpg
  logo.png  (duplicate of brand/logo.png)

Moved (1)
  old/report.pdf → 2025/report.pdf

Modified (2)
  notes.txt

3 added, 1 moved, 2 modified, 0 deleted · 5.3 MB changed
```

- **Colours:** green `Added`, cyan `Moved`, yellow `Modified`, red `Deleted`, red+bold
  `Errors`; headers coloured, items default (a wall of green is fatiguing). Plain ANSI, no
  dependency (ADR-0006).
- **Arrows/words survive in *human* output** — `→` and "(duplicate of X)" are self-explanatory
  in text; they were only a sin as an undocumented *JSON* microsyntax.
- **Summary line** lists every category including zeros (stable width), plus bytes changed;
  collapses to **`No changes.`** when all empty. `errors` appended only when > 0.
- **First-snapshot** (`since == null`): **suppress the listing entirely** — every file is
  "added" against an empty baseline, which is your whole tree and carries no diff signal.
  Render one line: `First snapshot: 1,234 files (4.2 GB)`. (`tree` and `--json` still list
  everything for anyone who wants it.)
- **`snapshot` and `compare` share `renderCompareResult`.** If `snapshot` later wants a trailing
  action hint, its renderer wraps the shared one (#7 — not now).

## `verify` output — file-centric, per-path (settled)

The finding model is **per-path all the way through** — `--json` and the human view share the
*same* shape. The renderer does **only cosmetic work** (format, colour, path-shorten), never a
structural object→path expansion. Hashes are an internal storage detail of dedup and **do not
appear** in the output; the user — and a machine consumer — thinks in files. (There is no
benefit to a machine-per-object / human-per-path split: it would make the renderer reshape data
and hand `--json` a shape nobody asked for. Per-path everywhere is simpler and 1:1.)

**Return structure** (per set; top level simplifies to `{ bucket, sets }` —
`storedObjects`/`orphanObjects`/`orphanObjectsExact` all leave verify with the orphan move
below):

```js
SetReport = {
  set, snapshotsChecked, referencedObjects,
  problems: {
    path,
    problem: "missing" | "wrong-size",
    snapshots: string[],            // which snapshots reference this broken file
    recordedSize?, storedSize?,     // wrong-size only
  }[],
  unreadableSnapshots: { snapshot, reason }[],
}
```

- **`problems` is one flat per-path list** — literally "list the paths and their problem,
  grouped by set". A missing blob referenced by five files yields **five** `problems` rows (all
  are affected); no object/hash grouping survives. So verify retains *all* paths per content
  during the scan (drop `examplePath`) — cheap in the normal case (≈ one path per content already
  retained), growing only under heavy duplication.
- **`missing`** — data not in S3 (the serious one; that file can't be restored). **`wrong-size`**
  — stored, but size ≠ recorded (corrupt/partial upload); carries `recordedSize`/`storedSize`.
- **No `conflictingRows`, no ambiguous-size skip.** Both go via the verify-logic fix
  ([engine-robustness.md](engine-robustness.md)) — after it, wrong-size is *natively* per-path
  (each file's recorded size vs the one stored size), so this per-path model falls straight out.
  The `problems` **shape** (flat, per-path) is settled now; the exact wrong-size *fields*
  finalize with that fix.
- **`unreadableSnapshots` stays outside `problems`** because it is not file-shaped: the manifest
  file itself is corrupt — no file list to annotate; a lost *restore point*, though the objects it
  referenced are almost certainly fine.
- **Orphans are *not* verify's concern — removed.** Orphaned objects (stored − referenced) are a
  *cleanup* matter (reclaiming wasted space), not an *integrity* one — they never threaten
  restorability. Reporting them over-complicated the command and was the **sole** source of the
  `orphanObjectsExact` upper-bound wrinkle in verify. Both `orphanObjects` and `orphanObjectsExact`
  move to **cleanup's non-destructive (preview) mode**, where the unreadable-snapshot caveat is a
  real safety gate (never delete an object a snapshot you couldn't read might reference), not an
  advisory hint. See [engine-robustness.md](engine-robustness.md) and
  [cloud-cleanup.md](cloud-cleanup.md).

Human render — headline verdict mirrors the exit code: green `all verified ✓` (0) vs red `N sets
with findings ✗` (1). The renderer maps each `problems` row 1:1 to a line:

```
photos-bucket: 3 sets, 4,042 objects checked — 2 sets with findings ✗

  docs   3 files with problems
    invoices/2024/jan.pdf   missing      (in snapshots 2026-06-01, 2026-06-15)
    reports/q1.xlsx         wrong size   (recorded 24,102 bytes, stored 24,000)

  music  could not fully check
    snapshot 2026-05-01T0800 could not be read (corrupt: unexpected end of file)
```

(Orphan count is gone — that's `cleanup`'s preview now. The scale figure is *referenced* objects
checked, not the stored total, which included the orphans verify no longer reports.)

**Dependency:** the file-centric renderer must be built against the *corrected* finding model,
so the verify-logic fix (see [engine-robustness.md](engine-robustness.md)) lands **before** this
epic's verify slice (slice 3). That way `conflictingRows` never gets a rendered home only to be
deleted.

## Other commands (per-slice detail)

Every command gets a renderer; the record-shaped ones are short confirmations (ADR-0030 wording,
the `cli-design` skill governs). Results stay on **stdout** in both modes; no command has empty
human output. Inventory of commands that return a value today (each needs a renderer):

- **action confirmations** — `setup` ("Created set 'photos' → bucket …"), `backup` ("Backed up
  'photos': 3 of 120 files uploaded"), `upload`, `restore` (summary + skipped list), and the
  slice-5 mutators `delete` / `cleanup` (small records: reclaimed/removed counts).
- **query views** — `compare`/`snapshot` (above), `status` (compare-shaped), `tree` (path per
  line — good for `s3cab tree > files.txt`), `hashes` (hash per line, as today), `list` (its
  current formatted view, now returned as data), `prop` (file props).
- **`hashes --output <file>`** — _open_: whether it survives the render-layer move or the user
  just `> file`s. Decide in slice 3.

## Slice plan (settled)

Migration uses a **temporary** optional-`render` + JSON fallback, deleted in the last slice
(the "no generic fallback" rule is the end state; the fallback is scaffolding). A shared
`--json` test asserts each command's machine output as it converts.

1. **Mechanism** — global `--json`, dispatcher branch, `render` optional + JSON fallback, one
   pilot command (a simple action like `setup`) rendered end-to-end.
2. **`compare`/`snapshot`** — the `CompareResult` structured refactor (absolute paths) + the
   shared `renderCompareResult` (common-base shortening, colours, summary, first-snapshot). The
   big one; may split data-refactor from renderer.
3. **Query renderers** — `list`, `tree`, `hashes`, `verify`, `prop`, `status`. (Verify-logic fix
   lands before this.)
4. **Action confirmations** — `backup`, `upload`, `restore`, `delete`, `cleanup`.
5. **Close-out** — delete the fallback, flip `render` to required, flip ADR-0043 to
   `accepted … implemented`, document `--json` in `guide/`, delete this file.

## Open items

- `hashes --output` fate (slice 3).
- Exact confirmation wording for the action commands (decided against real output, per slice).
- Colour shades / exact palette — confirm when first rendered (slice 2).
- **Gated-S3 e2e for the action confirmations** (backup/upload/restore/delete/cleanup) —
  _parked, decide at slice-5 close-out._ Slice 4 gave them renderer *unit* tests
  (`render.test.mjs`) but no end-to-end test, because reaching their result needs a live bucket
  (they all make real S3 calls), so a cheap offline e2e can only hit their usage-error paths. The
  only untested bit is the *wiring* (dispatcher routes each result through the right renderer to
  stdout; `--json` still emits the structure) — and slice-5's typecheck-required `render` closes
  the "unwired" gap for free. Options to weigh: (A) a gated setup→backup→restore→delete→cleanup
  round-trip asserting human stdout + `--json` (high fidelity, gate-only, slow); (B) skip, leaning
  on the typecheck gate; (C) make `s3cab.mjs` dispatch unit-testable (`import.meta.main` guard) so
  the render-vs-JSON branch tests offline. Worth is low-to-moderate (mostly future-regression
  insurance on plumbing already covered by `remote`/`objects` gated tests).
