# Architecture deepening — snapshot pipeline

Epic: deepen the **local snapshot pipeline** (walk → prop → snapshot file → compare) so the
snapshot grammar lives in one place, the write path is testable through one interface, and the
pure diff core is tested at its own seam. From an `/improve-codebase-architecture` review
(2026-06-23). Vocabulary is the `codebase-design` skill's: *module / interface / seam / deep /
shallow / leverage / locality*. The accompanying HTML report (the four candidates with
before/after diagrams) is [architecture-review-2026-06-23.html](architecture-review-2026-06-23.html).

Scope note: the **remote engine** (`s3.mjs`/`objects.mjs`/`remote.mjs`) and the **config layer**
(`sets.mjs`/`env.mjs`/`home.mjs`/`auth.mjs`) were also reviewed and found already deep and
cleanly seamed — nothing proposed there. (Separate, pre-existing remote-engine ideas live in
[engine-robustness.md](engine-robustness.md).)

---

## 1. Collapse the snapshot-writing pipeline into one deep module — **READY TO IMPLEMENT**

This is the hand-off item. The other three below are for thinking-on.

### The problem (verified)

"Write a snapshot file" is one concept smeared across three modules, and the snapshot **grammar
leaks into the walk**:

- `src/lib/walk.mjs:7` — `import { excludedLine } from "./snapshot-file.mjs"`. The walk (a
  filesystem concern) depends on the snapshot file grammar.
- `src/lib/walk.mjs:111` and `:115-117` — inside `createWalkCallbackFn`, the walk writes
  `#EXCLUDED` rows straight into a write stream: `snapshotWriteStream?.write(excludedLine(...))`.
- That write stream is threaded down purely to carry those rows: `walkSet(set, writeStream)`
  (`walk.mjs:24`) → `walkDirs(dirs, patterns, writeStream)` (`:43`) → `createWalkCallbackFn(...,
  writeStream)` (`:91`). The `LineWriter` typedef (`walk.mjs:14`) exists only for this.
- `src/commands/snapshot.mjs:54-76` — the command glues the rest: it opens `withSnapshotFile`,
  writes `snapshotHeader(...)` itself (`:61`), calls `walkSet(set, writeStream)` (`:65`) handing
  the walk that same stream, then runs the props pipeline
  `pipeline(files, withProgress, createPropsGenerator(lookup), stringifySnapshot, writeStream)`.
- The row type `SnapshotRow = [string, Props | Error]` is **defined** in
  `src/lib/snapshot-file.mjs:58`, **produced** in `src/commands/snapshot.mjs:114-124`
  (`createPropsGenerator`), and **consumed** in `src/lib/snapshot-file.mjs:306-314`
  (`stringifySnapshot`) — three files for one contract.
- The grammar primitives all live in `snapshot-file.mjs`: `formatLine` (`:328`, private),
  `snapshotHeader` (`:348`), `excludedLine` (`:363`), `errorLine` (`:376`), `stringifySnapshot`
  (`:306`), and the compression + temp-file-rename machinery `withSnapshotFile` (`:86-144`).

So to understand how a snapshot gets written you bounce between `walk.mjs` (writes `#EXCLUDED`
rows mid-walk), `snapshot.mjs` (header + pipeline + error-tuple), and `snapshot-file.mjs`
(grammar + compression).

### The test gap (verified — strengthens the case)

The write path is barely tested through any single interface:

- `walkSet` — **no direct test** (only `walkDirs` is tested, in `walk.test.mjs`, and those tests
  don't pass a write stream — they assert on returned paths). The walk's `#EXCLUDED`-row writing
  is therefore untested.
- `excludedLine` — **no direct test** anywhere.
- `withSnapshotFile` and `stringifySnapshot` — only used as fixture helpers in
  `compare.test.mjs`; never asserted on directly.
- `snapshot.test.mjs` covers the command end-to-end (identity/`#DIR` header at `:120`,
  same-minute refusal at `:146`, change report at `:73`) — useful, but it's the whole command,
  not the write path at a seam.

### Target design (the deepening)

One deep module owns the whole "files → snapshot file" flow behind a small interface. Sketch:

```
writeSnapshot(snapshotDir, name, { dirs, identity, files, excluded, lookup, overwrite }) → path
```

It absorbs: the header, the props→TSV pipeline (`createPropsGenerator` moves in here), the
`#ERROR` and `#EXCLUDED` rows, compression, and the temp-file rename. After it:

- **The grammar never leaves this module.** `formatLine`, `snapshotHeader`, `excludedLine`,
  `errorLine`, `stringifySnapshot`, `SnapshotRow` all become internal (un-exported). The
  interface shrinks; the implementation absorbs them.
- **The walk stops knowing the format.** Instead of writing `excludedLine(...)` into a stream,
  the walk **yields exclusion records as data** — e.g. `{ fileType, reason, path }` — and the
  writer formats them. `walk.mjs` loses its `snapshot-file.mjs` import and its `LineWriter`
  /`writeStream` parameter entirely.
- **The pipeline lives in one place**, so `SnapshotRow` is produced and consumed inside one
  module.
- `snapshot.mjs` (the command) becomes a thin caller: resolve set, read previous snapshot for
  the lookup, `await writeSnapshot(...)`, then `compareSnapshots(...)`.

### Open design questions for the implementing session (grill these first)

1. **Where does the writer live?** Extend `snapshot-file.mjs` (it already owns the grammar +
   `withSnapshotFile`), or a new `src/lib/snapshot-writer.mjs` that imports the grammar? Leaning
   toward keeping it in `snapshot-file.mjs` so reader+writer+grammar stay co-located, but
   `snapshot-file.mjs` is already 376 lines — weigh splitting reader/writer if it gets unwieldy.
2. **What shape is the walk's exclusion output?** Options: (a) return value
   `walkSet(set) → { files, excluded }`; (b) an async iterable of tagged records the writer
   consumes; (c) a callback. Note the walk is currently **eager** (`walkDirs` builds the full
   `files` array) and writes `#EXCLUDED` rows *during* the walk — option (a) is the smallest
   change and preserves "collect everything, then write".
3. **Preserve write order?** Today: header first, then `#EXCLUDED` rows (written during the
   walk), then file entries (the pipeline). Parsing is marker-driven so order doesn't affect
   correctness — but keep excluded-before-entries for readable debug `.tsv` output.
4. **Streaming vs eager.** The walk is eager today; `proposals/performance.md` floats a streaming
   walk→hash pipeline. Don't couple this refactor to that — keep eager, but don't design the new
   interface in a way that blocks a later streaming variant (i.e. accept `files` as an iterable).
5. **`createPropsGenerator` error-tuple convention** moves inside the writer; `prop` itself
   (`src/commands/prop.mjs`) is unchanged.

### Test plan (replace, don't layer)

- New tests at the `writeSnapshot` interface: header + entries + `#EXCLUDED` + `#ERROR` rows for
  a given set of files/exclusions/lookup, asserting on the parsed-back snapshot (round-trip via
  `readSnapshot`/`parseSnapshotStream`). This finally covers the write path through one seam.
- New `walkSet` test asserting the returned exclusion records (now that they're data, not a
  side-effecting stream write).
- Delete the fixture-only reliance on `withSnapshotFile`/`stringifySnapshot` in
  `compare.test.mjs` if the writer gives a cleaner fixture path (or keep — see candidate 2).

### Constraints / non-conflicts

- **Pre-1.0** (`package.json` major `0`) → CLAUDE.md convention #8 sanctions bold *justified*
  refactors. This is justified (real leaked seam + an untested write path), not speculative
  structure (ADR-0006).
- Stays within `lib/`; **ADR-0023** (porcelain/plumbing/lib) and the `local/one-export-per-command`
  rule are untouched — `snapshot.mjs` keeps its single `snapshot` export and calls the new lib
  function.
- Watch CLAUDE.md's hot-path guidance: thread the `Dirent` data you already have; don't add a
  second `stat`/`lstat` per file. The exclusion record should carry what the walk already knows
  (`fileType` from the `Dirent`, the matched pattern).
- When implemented: per the proposals README, move lasting knowledge to its home first — this is
  a candidate **ADR** ("the snapshot writer owns the grammar; the walk yields exclusions as
  data") and/or an update to `docs/specs/backup.md` — then delete this section.

### Suggested slices

1. Walk yields exclusion records (drop `excludedLine` import + `writeStream` param from
   `walk.mjs`); callers adapt. Tests for the new walk output.
2. Introduce `writeSnapshot`, move `createPropsGenerator` + header + row writers inside; un-export
   the grammar primitives. Tests at the new interface.
3. Thin `snapshot.mjs` down to a caller. Verify `snapshot.test.mjs` still green.

---

## 2. Test `diff` at its own interface, not through the I/O shell — *worth exploring*

### The problem (verified)

`diff` in `src/lib/compare.mjs:196` is a **pure, in-process** function (two `SnapshotEntries`
Maps in, four classification sets out) and it holds the codebase's most intricate logic: the
greedy move-pairing and copy-annotation at `:226-272`. It is `export`ed — but **every one of its
tests reaches it through `compareSnapshots`**: `compare.test.mjs` calls `compareSnapshots` 22
times and `diff` zero times, each test building real compressed `.tsv.zst` fixture files via
`withSnapshotFile` + `stringifySnapshot`. The deepest logic has the most expensive test access,
and edge cases of the pairing (rotations, swaps, copies-of-moves) are costly to set up through
file I/O.

### The deepening

This is a **test-discipline** change, not a structural one — `diff` already sits at the right
seam (exported, pure). Drive it directly with in-memory Maps; keep a thin set of
`compareSnapshots` tests for the parts only it adds (snapshot resolution defaults — `since`/`until`
— and `relativeToRoot` display). Dependency category 1 (in-process): no adapter, test through the
interface directly.

Wins: interface is the test surface; pairing edge cases cheap to enumerate; tests survive I/O and
format refactors. Pairs with CLAUDE.md convention #12 (coverage by review). Cheap, high-value;
could even ride along with candidate 1 since both touch this corner.

Decision for later: keep `diff` exported purely as a test surface (a deliberate internal seam
exposed), or is direct testing of a still-`export`ed-for-one-reason function fine? It has no
non-test caller besides `compareSnapshots` — so the export is *only* a test seam today. That's
acceptable (an internal seam used by its own tests) but worth a conscious call.

---

## 3. Narrow the snapshot read surface — *considered, REJECTED on verification*

Recorded so a future review doesn't re-suggest it. The HTML report's candidate 3 floated
collapsing the three read paths and making `snapshotNames` internal. **It does not hold** — each
read/list export has a distinct real caller, so they are three genuine seams, not a wide-shallow
surface:

- `parseSnapshotStream` (`snapshot-file.mjs:261`) — real second caller `remote.mjs:95`
  (reads a snapshot straight from the S3 body stream, no temp file). Real seam; keep public.
- `snapshotNames` (`snapshot-file.mjs:176`) — real second caller `remote.mjs:51` (the remote
  lister runs S3 keys through the same name filter/sort as the local lister). Real seam; keep
  public.
- `readSnapshotFile` (`snapshot-file.mjs:226`) — real external caller `prop.mjs:53` (the
  `prop --lookup <path>` case reads a snapshot file by path). Not just a shallow resolver.
- `readSnapshot` (`snapshot-file.mjs:154`) — four callers (`status`, `snapshot`, `remote`,
  `compare`), the by-name-in-a-set's-dir path.

The only shallow link is `readSnapshot` → `readSnapshotFile` (one delegation), but both are
independently called, so collapsing them removes a real entry point. Candidate 1 already
consolidates the *writer* half of `snapshot-file.mjs`; the *reader* half is genuinely deep. No
action.

---

## 4. Unify the "resolved backup set" (set + applied env) — *parked: contradicts ADR-0022*

### The friction (real)

"A resolved set" is two things in two files: `resolveSet` (`sets.mjs`) builds the `BackupSet`
value; `loadSet` (`env.mjs:126`) wraps it and **mutates `process.env`** as a side effect to apply
the set's env layer. Calling `resolveSet` directly gets you a correct `BackupSet` but silently
**skips the env layer** — a latent trap for a new command or a library consumer. Understanding
the full picture means bouncing between `sets.mjs` (the typedef + bucket invariant) and `env.mjs`
(the layering + once-per-run guard).

### Why it's parked, not proposed

This contradicts **ADR-0022** (env is loaded at the entry point; the set layer goes through the
`loadSet` door) — a *pinned* decision, and the two-door split is deliberate. The
`/improve-codebase-architecture` rule is to surface an ADR conflict only when friction warrants
reopening; the friction here is real (the `resolveSet`-vs-`loadSet` trap; env-as-global-side-effect
is awkward to test) but not clearly worth reopening a settled ADR.

If revisited: the shape would be one resolution call returning the set *and* its resolved config
together (no global side effect), e.g. `resolveSet(name) → { set, env }`, with callers reading
config from the returned value rather than `process.env`. That's a large blast radius (every set
command + `s3.mjs`'s credential/region reads). **Likely outcome: leave it, or record the
rationale in ADR-0022** so it stops surfacing. Don't action without an explicit decision to reopen
the ADR.
