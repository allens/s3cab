# Architecture improvements

Epic: turn shallow modules into deep ones — more behaviour behind a smaller interface, placed
at a clean seam, testable through that interface (leverage for callers, locality for
maintainers). Vocabulary is the `codebase-design` skill's: *module / interface / seam / deep /
shallow / leverage / locality*.

**This is the durable, cumulative capture of `/improve-codebase-architecture` runs.** The
skill is costly to run, so nothing it finds is left only in chat or in the ephemeral report:
open candidates, standing rejections, and a run log all live here. Each new run **verifies
this file against the source first** (candidates go stale; some land, some rot) rather than
re-deriving from scratch. When a candidate lands, its lasting knowledge moves to an
[ADR](../docs/adr/) or [docs/design/](../docs/design/) and the entry is deleted (the proposals
convention); when one is rejected with a load-bearing reason, it moves to the rejected section
below so no future run re-suggests it.

**The HTML report:** each run's report (before/after diagrams, the visual context that doesn't
translate to markdown) is kept beside this file as
[architecture-review.html](architecture-review.html) — **latest only**; a superseded report is
deleted when the new one lands (they go stale fast, and everything durable is distilled here;
git history keeps the old ones). It loads Tailwind + Mermaid from public CDNs — needs network,
only open trusted copies.

---

## Open candidates

Strength tags: **Strong** / **Worth exploring** / **Speculative**. Each entry notes the run
that surfaced it and when it was last verified against the source.

### Add `rewriteObjects` — the objects cache's missing third verb. _(Strong — slice-5 prep.)_

_Surfaced 2026-07-03, from the settled verify/cleanup design._ The per-bucket objects cache
([src/lib/objects.mjs](../src/lib/objects.mjs):143–189) exposes read-all (`knownObjects`)
and append (`recordObjects`, a bare `appendFileSync`). But
[ADR-0042](../docs/adr/0042-verify-set-scoped-all-sets-default.md) requires `verify` to
**rewrite** the cache from a completed LIST (atomic temp + rename, never from a partial
LIST), and cleanup's `--delete` (docs/design/backup.md) rewrites it from stored − deleted.
No such verb exists — both upcoming commands would otherwise grow the write-and-rename dance
inline in the command layer, each re-spelling the `objects.<bucket>` path. Add
`rewriteObjects(bucket, hashes)` (temp + `rename`, the pattern `getObject` already uses):
the cache becomes one deep concept — three verbs, one owner, one path literal, one atomicity
guarantee, beside the staleness-asymmetry comment that already explains it. Directly
unit-testable (rewrite A→B, assert `knownObjects` sees exactly B).

### Size-carrying `listStoredObjects` — verify's cross-check without breaking the seam. _(Worth exploring — slice-5 prep.)_

_Surfaced 2026-07-03._ `listObjectHashes`
([src/lib/objects.mjs](../src/lib/objects.mjs):122–130) collapses each listed object to a
bare hash, but verify's finding class 2 (size mismatch) needs `hash → size` from the *same*
LIST it already pays for (the design forbids extra requests). As shaped, `verify` would have
to bypass `objects.mjs` and call `s3.mjs`'s `listObjects` directly — leaking the `objects/`
prefix literal out of the one module that owns it. Add
`listStoredObjects(bucket) → AsyncGenerator<{ hash, size }>` and re-express
`listObjectHashes` as a thin map over it: the hash-only consumers keep their view, verify
gets sizes, the seam stays sealed.

### Decide the `referenced` union's seam before slice 5. _(Worth exploring — placement decision, not a defect.)_

_Surfaced 2026-07-03._ The design (docs/design/backup.md) commits to *referenced* — the
union of hashes across snapshots — being a single internal lib function with two scopes
(per-set for `verify`, bucket-wide for `cleanup`), detecting conflicting-size rows for free
while unioning. The pieces exist across two modules (`set-marker.mjs` lists sets,
`remote.mjs` lists/reads one set's snapshots); the composite has no owner yet. Assembled
inline inside `verify`, the two scopes would drift. Pick its placement (in `remote.mjs`, or
a small new module composing the two) as one parameterised function, before writing slice 5.

### Lift `seedStarterExclude`'s guard into `sets.mjs`. _(Worth exploring — small.)_

_Surfaced 2026-07-03._ PR #146's split is mostly right — starter data + read/write
primitives in `sets.mjs`, policy + notice in `setup.mjs`. The residue: the load-bearing
guard ("never clobber an existing exclude file",
[src/commands/setup.mjs](../src/commands/setup.mjs):179–188) is a private command function
reachable only through the async S3 create flow, so absent→write / present→skip is only
testable end-to-end. Move the idempotent seed to `sets.mjs` as
`seedStarterExclude(name) → boolean` (wrote / already had one); `setup` keeps only the
user-facing notice. Locality/testability gain, not a depth lever.

### Pure `planUpload` — give `backup` the `planRestore` treatment. _(Strong.)_

_Surfaced 2026-06-24; re-verified 2026-07-03._ `restore` split its decision step
(`planRestore`, pure and unit-tested without S3) from its I/O loop; `backup` never got the
same treatment. `uploadSnapshot` ([src/lib/remote.mjs](../src/lib/remote.mjs):193–250)
interleaves the upload-set decision — `uploadCandidates` (target − latest remote) minus the
per-bucket objects cache (`knownObjects`, [src/lib/objects.mjs](../src/lib/objects.mjs)), then
first-path-wins `pathByHash` selection — directly with the `putObject` loop. So only the pure
`uploadCandidates` diff is unit-tested; the cache-narrowing + path-selection logic is reachable
only through the gated real-S3 tests (`remote.test.mjs:190`, skipped without a bucket) — and
the `backup` command has no test at all. Extract a pure `planUpload(target, remote, cached) →
Map<hash, path>` and shrink `uploadSnapshot` to *executing* the plan (PUT + `recordObjects` +
snapshot-last). Then the spec's "how `backup` computes the upload set" is one testable
function, mirroring the already-accepted `planRestore`, and a `backup` command test becomes
feasible. Purely additive — no ADR tension.

### One atomic `downloadToFile` at the S3 seam. _(Worth exploring — genuinely reduces total lines.)_

_Surfaced 2026-06-24; re-verified 2026-07-03._ `getObject`
([src/lib/objects.mjs](../src/lib/objects.mjs):85–112) and `downloadRemoteSnapshots`
([src/lib/remote.mjs](../src/lib/remote.mjs):119–139) each hand-roll the same dance —
temp-sibling path → `pipeline` → atomic `rename` → `unlink`-on-error in a `try/catch` —
differing only in that `getObject` taps the stream through a SHA-256 verifier and
`downloadRemoteSnapshots` copies verbatim. Extract `downloadToFile(uri, destPath, { tap })` at
the [src/lib/s3.mjs](../src/lib/s3.mjs) seam; `getObject` passes the hashing tap,
`downloadRemoteSnapshots` passes none. Two real adapters justify the seam, atomicity/cleanup
live in one place, and callers shrink to the part that varies. (`withSnapshotFile` shares the
temp+rename shape but streams *out* through zstd — fold it in only if the abstraction stays
honest; don't stretch one primitive over two different writes.)

### One snapshot-name authority — and close the two-clock gap. _(Worth exploring — latent bug.)_

_Surfaced 2026-06-24; extended 2026-07-02; re-verified 2026-07-03._ The snapshot timestamp format is
spelled in three places: [src/commands/snapshot.mjs](../src/commands/snapshot.mjs) renders
"now" **twice** — the filename `2026-06-12T0915` (no colon, line 37) and the `#SNAPSHOT`
header `2026-06-12T09:15` (colon, line 57) — from two separate `Temporal.Now` reads with an
`await readSnapshot(previous)` *between* them, and
[src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)'s `snapshotNames` regex (lines
263–266) independently encodes the no-colon filename shape. If the clock crosses a minute
boundary during that `await`, the filename disagrees with its own `#SNAPSHOT` header. A third
leak (added 2026-07-02): `normalizeName` in [src/lib/compare.mjs](../src/lib/compare.mjs):21
strips the `.tsv(.zst)` extension — a grammar detail a caller shouldn't know, the only place it
lives outside snapshot-file.mjs. A snapshot-name authority in snapshot-file.mjs, beside
`parseSnapshotStream`: one `now()` capture → `{ name, datetime }`, plus the recognizer and the
extension-normalizer. Format in one place; name ↔ header consistent by construction; latent
skew closed; the seam stops leaking. (Related but distinct:
[snapshot-format.md](snapshot-format.md)'s timezone/precision *decision* — if that format
changes, this refactor makes it a one-place edit.)

### Thread the previous snapshot through `snapshot → compare`. _(Worth exploring — hot path.)_

_Surfaced 2026-07-02 (subsumes a performance.md note); re-verified 2026-07-03._ The previous snapshot is fully
decompressed and parsed **twice** per snapshot run: once by `snapshot` for its hash lookup
([src/commands/snapshot.mjs](../src/commands/snapshot.mjs):42–47), again inside
`compareSnapshots` as the diff baseline ([src/lib/compare.mjs](../src/lib/compare.mjs):99,
`since: latestSnapshotName`). The just-written *new* snapshot is also re-read as the `until`
side — that face is cheaper to accept, since re-parsing what was just written doubles as a
round-trip verification. On a large set the previous-side re-read is a full zstd decompress +
per-entry parse done twice — the per-file-overhead pattern the CLAUDE.md hot-path convention
warns about, and its prescribed fix is exactly this: thread the data you already have through
the interface (never a module-level cache). Two shapes to grill: let the compare seam accept
an already-parsed `since` side (entries alongside the name — widens `compareSnapshots`'
interface), or have `snapshot` compose the pure `diff` directly with what it already holds
(moves display assembly). Pairs naturally with the `diff` test-discipline candidate below —
both reshape the compare seam.

### Test `diff` at its own interface, not through the I/O shell. _(Worth exploring — cheapest on the list.)_

_Surfaced 2026-06-23; re-verified 2026-07-03 (grown: now 27 × `compareSnapshots`, still 0 × `diff`)._
`diff` in [src/lib/compare.mjs](../src/lib/compare.mjs):200 is a **pure, in-process** function
(two `SnapshotEntries` Maps in, four classification sets out) and holds the codebase's most
intricate logic: the greedy move-pairing and copy annotation. It is `export`ed — but every one
of its tests reaches it through `compareSnapshots`, each building real compressed `.tsv.zst`
fixture files via `withSnapshotFile` + `stringifySnapshot`. The deepest logic has the most
expensive test access, so pairing edge cases (rotations, swaps, copies-of-moves) are costly to
enumerate. This is a **test-discipline** change, not a structural one — `diff` already sits at
the right seam. Drive it directly with in-memory Maps; keep a thin set of `compareSnapshots`
tests for what only it adds (`since`/`until` resolution defaults, `relativeToRoot` display).
Decision for later: `diff`'s export has no non-test caller besides `compareSnapshots`, so the
export is *only* a test seam today — acceptable (an internal seam used by its own tests), but
make it a conscious call.

### Narrow `s3.mjs` to the SDK seam it guards. _(Worth exploring — progress half escalated.)_

_Surfaced 2026-06-23 (as "candidate C"); previously filed under engine-robustness.md, moved
here 2026-07-02; `bucketPolicy` point retired 2026-07-02; progress half escalated 2026-07-03
into its own "one stderr-progress module" candidate, which **landed** as
[PR #148](https://github.com/allens/s3cab/pull/148) (`lib/progress.mjs`)._ What remains here:
`s3.mjs` exposes test-only `deleteObject`/`emptyBucket` —
move them to a test helper so the interface narrows to the seam it guards. Note before
acting: the settled `cleanup` design (docs/design/backup.md, slice 5) will need a real
*production* delete at this seam, so the shape of that command may resolve this half for
free — revisit when cleanup is built rather than moving the ops twice. (`bucketPolicy`, once
flagged here as unused-droppable, is now consumed by the `aws` onboarding command via
[src/lib/onboarding.mjs](../src/lib/onboarding.mjs) — if s3.mjs is narrowed it migrates, not
drops. The operational side of `emptyBucket` — uncalled, destructive, one-delete-per-request
— stays tracked in [engine-robustness.md](engine-robustness.md).)

### `compareSnapshots` returns structured diff, not display strings. _(Speculative — parked until a second consumer exists.)_

_Surfaced 2026-06-23 (as "candidate D"); canonical entry here, UX driver in
[output-ux.md](output-ux.md)._ `diff` is exemplary — pure, structured, each rule pinned by a
test. But `compareSnapshots` wraps it and bakes **presentation** into the returned
`CompareResult` — root-relative paths (`relativeToRoot`) and the `==` / `→` / `→→` arrow
rendering — so the lib seam hands callers formatted text, not data. A second consumer (a
`--json` mode, a TUI) couldn't recover the structured relations without re-parsing the arrows.
Split: `compareSnapshots` returns structured relations; a `presentDiff()` formatter at the
command edge renders the display. **Speculative on purpose** — only the terminal renderer
consumes this today, so by the project's own bar
([ADR-0006](../docs/adr/0006-minimal-code.md) / convention #7) it's a hypothetical seam until
a second output format actually appears. The human-output/`--json` work in
[output-ux.md](output-ux.md) is what would make it real — implement this as its first step.

---

## Rejected & parked — do not re-suggest

Recorded so future runs (and reviewers) skip them. Each was verified against the source at
least once; re-open only if the stated reason no longer holds.

- **Split a snapshot codec/grammar module out of `snapshot-file.mjs`** — rejected twice
  (2026-06-23, re-floated and re-rejected 2026-06-29). Contradicts
  [ADR-0028](../docs/adr/0028-snapshot-writer-owns-the-grammar.md) (the grammar is deliberately
  the writer's, in one module; the markers already live in exactly one place). The "500-line
  file" that keeps prompting it is ~200 lines of code under heavy JSDoc — file size is not a
  depth signal.
- **Narrow the snapshot read surface** (collapse
  `readSnapshot`/`readSnapshotFile`/`parseSnapshotStream`/`snapshotNames`) — rejected on
  call-graph verification (2026-06-23). Each export is a real seam with a distinct caller:
  `parseSnapshotStream` ← `remote.mjs` (reads a snapshot straight from the S3 body stream, no
  temp file); `snapshotNames` ← `remote.mjs` (remote keys run through the same filter/sort as
  local names); `readSnapshotFile` ← `prop.mjs` (`--lookup <path>` reads a snapshot by path);
  `readSnapshot` ← four callers (`status`/`snapshot`/`remote`/`compare`). The one shallow link,
  `readSnapshot → readSnapshotFile`, can't collapse because both are independently called. The
  reader half is genuinely deep.
- **Unify the "resolved backup set" (set + applied env, a.k.a. SetContext)** — **parked:
  contradicts [ADR-0022](../docs/adr/0022-prepare-remote-set-front-door.md)**, a pinned
  decision (env at the entry point; the set layer through the `loadSet` door). The friction is
  real: `resolveSet` (sets.mjs) builds the `BackupSet` value while `loadSet` (env.mjs) wraps it
  and mutates `process.env` as a side effect, so calling `resolveSet` directly silently skips
  the env layer — a latent trap; understanding the whole means bouncing between two files. But
  not clearly worth reopening a settled ADR. If ever revisited: one resolution call returning
  the set *and* its resolved config together (`resolveSet(name) → { set, env }`, no global side
  effect), with callers reading config from the returned value — a large blast radius (every
  set command + `s3.mjs`'s credential/region reads). Likely outcome: leave it, or record the
  rationale in ADR-0022 so it stops surfacing.
- **Concentrate the list-and-strip mechanic across `objects`/`remote`/`set-marker`** — not
  worth it (2026-06-29). The shared part (iterate `listObjects`, slice the prefix) is ~1–2
  lines; each caller's real work diverges (bare hash / datestamp filter+sort /
  segment+dedup+filter), and merging the per-prefix modules would contradict
  [ADR-0013](../docs/adr/0013-one-repository-one-bucket.md)/[ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md).
- **Restructure the remote engine (`s3.mjs`/`objects.mjs`/`remote.mjs`) or the config layer
  (`sets.mjs`/`env.mjs`/`home.mjs`/`auth.mjs`)** — all three passes found them already deep and
  cleanly seamed (beyond the specific `s3.mjs` interface-narrowing candidate above). Don't
  re-explore without new friction.
- **Extract the exclude mini-grammar prose into one place** — leave alone (2026-07-03). The
  `**/`/`?`/trailing-`/` token rules are described in three human-facing registers on purpose:
  `helpTopics.exclude` (mid-task reference), `starterExclude`'s file header (inline reminder),
  and `guide/exclude.md` (the full guide) — all linking to the guide. Extraction would flatten
  the registers for no depth gain; the accepted-overlap stance is already recorded in
  CLAUDE.md's placement doctrine.
- **The help/commands registry seam** — examined 2026-07-03 after PRs #144/#145 and found
  clean: `usage()` is pure over the registry, `synopsis`/`argDescription` each have a distinct
  non-help caller (the `s3cab.mjs` error paths), topics-first routing is test-enforced
  disjoint. No shallow pass-throughs; don't re-explore without new friction. `style.mjs` is a
  genuinely deep little module — its only problem was the consumers that *didn't* route
  through it, now fixed by `lib/progress.mjs` ([PR #148](https://github.com/allens/s3cab/pull/148)).

---

## Run log

- **2026-06-23 — first pass.** Four candidates. #1 (collapse the snapshot-writing pipeline —
  the walk imported `excludedLine` and wrote grammar rows mid-walk) **landed** as
  [ADR-0028](../docs/adr/0028-snapshot-writer-owns-the-grammar.md). #2 (diff test discipline)
  still open above. #3 (narrow the read surface) rejected on verification. #4 (resolved-set
  unification) parked behind ADR-0022.
- **2026-06-24 + 06-29 follow-up — second pass.** Surfaced `planUpload`, `downloadToFile`, the
  name authority, and the structured-diff split (all still open above). The `fileProps`
  extraction **landed** ([PR #127](https://github.com/allens/s3cab/pull/127)): the hashing
  engine moved to `lib/file-props.mjs`, `prop` became a thin command over it, closing the last
  `commands → lib` reach in the write path; glossary term **Props** added to CONTEXT.md. The
  codec split and the list-and-strip unification were re-floated and re-rejected.
- **2026-07-02 — third pass.** Re-verified every open candidate against the source (all still
  hold, line refs updated). New: *thread the previous snapshot through `snapshot → compare`*.
  Remote engine and config layer again found deep. Merged the two prior capture files
  (`architecture.md`, `architecture-deepening.md`) and the overlapping bullets in
  `performance.md`/`engine-robustness.md`/`output-ux.md` into this file; superseded the
  2026-06-23 HTML report.
- **2026-07-03 — fourth pass.** Re-verified all six open candidates (all hold; the `diff`
  test count grew 22→27). Explored the churn since the third pass (PRs #144–#147, the settled
  verify/cleanup design). Five new entries: *one stderr-progress module* (Strong — snapshot's
  counter writes `\r` ungated, a live inconsistency PR #147 missed; takes over as top pick),
  *`rewriteObjects`* (Strong — ADR-0042/cleanup both need an atomic cache rewrite that doesn't
  exist), *size-carrying `listStoredObjects`*, *the `referenced` union's seam placement*, and
  *lift `seedStarterExclude`* — the middle three are slice-5 prep. Recorded as leave-alone:
  the exclude-grammar prose triplication, and the help/registry seam (clean after
  #144/#145). Superseded the 2026-07-02 HTML report.
- **2026-07-03 — *one stderr-progress module* landed** ([PR #148](https://github.com/allens/s3cab/pull/148)).
  `lib/progress.mjs` now owns the TTY-gate + `\r`-redraw + drawn-only-newline mechanic; snapshot,
  restore, the upload bar, and the walk all route through it. Verification caught the candidate
  undercounting the problem: there were **four** ungated `\r` writers, not three — the walk's
  `Found N files...` counter in `walk.mjs` was the fourth, and `snapshot` still spammed carriage
  returns off a TTY until it too was folded in (which also fixed a latent "Found 0 files..."
  display quirk for sets under 500 files). Interface shipped as `createProgress(stream, { logLines })
  → { update(text, { cursor }), [Symbol.dispose] }` (per-caller renderers kept as plain strings).
