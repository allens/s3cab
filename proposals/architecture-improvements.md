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

### One atomic `downloadToFile` at the S3 seam. _(Worth exploring — genuinely reduces total lines.)_

_Surfaced 2026-06-24; re-verified 2026-07-10._ `getObject`
([src/lib/objects.mjs](../src/lib/objects.mjs):82–109) and `downloadRemoteSnapshots`
([src/lib/remote.mjs](../src/lib/remote.mjs):272–294, the dance at :283–291) each hand-roll the same dance —
temp-sibling path → `pipeline` → atomic `rename` → `unlink`-on-error in a `try/catch` —
differing only in that `getObject` pipes the bytes through a pass-through SHA-256 **hashing
stage** and `downloadRemoteSnapshots` copies verbatim.

**Settled in grilling (2026-07-10):** `downloadToFile(source, destPath, { sha256 })` at the
[src/lib/s3.mjs](../src/lib/s3.mjs) seam — the option is the **expected hex digest, a plain
value**, superseding the entry's earlier `hasher` sketch (injecting the Hash was
over-engineering: comparing bytes to an expected digest is a generic integrity feature, not
caller policy, and the injected shape pushed the verify *after* the rename — wrong order —
then needed a second option to fix it). The first parameter is the **source stream**
(typically `createS3ReadStream(uri)`), not a URI: with a URI the primitive would call
`createS3ReadStream` intra-module, below the "mock at s3.mjs" line, orphaning the ungated
integrity tests — with the stream handed in, the logic tests directly against
`Readable.from`, no mock at all. When `sha256` is given, the primitive hashes in-stream and
throws **before the rename** on mismatch, so an unverified file never reaches `destPath` and
the unlink-on-error path cleans up; `getObject` collapses to one call passing its key as the
digest, `downloadRemoteSnapshots` passes no option. The `tap` local disappears entirely (the
internal stage gets a plain name, e.g. `hashingStage`). Two real adapters justify the seam,
atomicity/cleanup/verify-ordering live in one place, and callers shrink to the part that
varies. (`withSnapshotFile` shares the temp+rename shape but streams *out* through zstd —
fold it in only if the abstraction stays honest; don't stretch one primitive over two
different writes.)

### One snapshot-name authority — and close the two-clock gap. _(Worth exploring — latent bug.)_

_Surfaced 2026-06-24; extended 2026-07-02; re-verified 2026-07-10._ The snapshot timestamp format is
spelled in three places: [src/commands/snapshot.mjs](../src/commands/snapshot.mjs) renders
"now" **twice** — the filename `2026-06-12T0915` (no colon, `getTimestamp()` called at line 38)
and the `#SNAPSHOT` header `2026-06-12T09:15` (colon, lines 58–60) — from two separate
`Temporal.Now` reads with an
`await readSnapshot(previous)` *between* them (line 46), and
[src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)'s `snapshotNames` regex (lines
263–269, the literal at :265) independently encodes the no-colon filename shape. If the clock
crosses a minute
boundary during that `await`, the filename disagrees with its own `#SNAPSHOT` header. A third
leak (added 2026-07-02): `normalizeName` in [src/lib/compare.mjs](../src/lib/compare.mjs):62
strips the `.tsv(.zst)` extension — a grammar detail a caller shouldn't know, the only place it
lives outside snapshot-file.mjs.

**Settled in grilling (2026-07-10), one step past the entry's `{ name, datetime }` sketch
(chosen as cleaner and net-negative LOC):** export **`snapshotName()`** from snapshot-file.mjs
(one `Temporal.Now` capture → the no-colon name) and **drop `writeSnapshot`'s `datetime`
parameter** — the writer derives the `#SNAPSHOT` header datetime *from the name* inside the
`snapshotHeader` path, so name ↔ header cannot disagree **by construction** (not merely by a
shared capture threaded as two values). `snapshot.mjs` deletes `getTimestamp` and its inline
datetime block; the test call sites drop their paired `datetime:` args. Cost accepted:
`writeSnapshot` assumes timestamp-shaped names (production always passes one). The
extension-normalizer moves as **`normalizeSnapshotName`**, body unchanged (kept separate from
the `snapshotNames` recognizer regex — strip-extension and recognize-a-snapshot are different
questions); compare.mjs imports it. Format in one place; latent skew closed; the seam stops
leaking. (Related but distinct: [snapshot-format.md](snapshot-format.md)'s timezone/precision
*decision* — if that format changes, this refactor makes it a one-place edit.)

### Thread the previous snapshot through `snapshot → compare`. _(Worth exploring — hot path.)_

_Surfaced 2026-07-02 (subsumes a performance.md note); re-verified 2026-07-10._ The previous snapshot is fully
decompressed and parsed **twice** per snapshot run: once by `snapshot` for its hash lookup
([src/commands/snapshot.mjs](../src/commands/snapshot.mjs):43–47), again inside
`compareSnapshots` as the diff baseline ([src/lib/compare.mjs](../src/lib/compare.mjs):113,
`since: latestSnapshotName` passed at snapshot.mjs:81–85). The just-written *new* snapshot is also re-read as the `until`
side — that face is cheaper to accept, since re-parsing what was just written doubles as a
round-trip verification. On a large set the previous-side re-read is a full zstd decompress +
per-entry parse done twice — the per-file-overhead pattern the CLAUDE.md hot-path convention
warns about, and its prescribed fix is exactly this: thread the data you already have through
the interface (never a module-level cache).

**Settled in grilling (2026-07-10): the first shape** — `compareSnapshots`' `since` option
widens to `string | { name, entries }`; `snapshot` passes `{ name: latestSnapshotName,
entries: lookup }` when it holds the parse, and the plain name under `--rehash` (where it
never read the previous snapshot, so the compare still must). The object form makes the
name ↔ entries pairing structural (a separate `sinceEntries` option could ride along with a
mismatched name). The rejected shape — `snapshot` composing the pure `diff` directly — would
relocate `compareSnapshots`' ~50-line result assembly into a shared helper and still
duplicate the since-read for `--rehash`, all to save the identical read the option saves in a
few lines.

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
- **2026-07-08 — fifth pass.** Re-verified all opens against the source after heavy churn (PRs
  #150–#160: `verify`/`delete`/`cleanup` built, human-first output + `render.mjs` (ADR-0043),
  unified `upload` (ADR-0044), the objects cache **dropped** (ADR-0045), tests co-located
  (ADR-0046)). **Four candidates retired as done/moot:** `rewriteObjects` (dead — no cache),
  size-carrying `listStoredObjects` (landed — yields `{hash,size,lastModified}`), the
  `referenced`-union seam (landed as `referencedObjects` in remote.mjs), and the structured
  `CompareResult` split (landed, ADR-0043). `planUpload` re-scoped (cache gone; first-backup diff
  inlined) and `s3.mjs` re-scoped (`deleteObject` now production; kill the dead `emptyBucket`).
  New top pick: *extract a pure `planCleanup`* — the verify/cleanup twin realized in code only on
  verify's side. **Landed as [PR #164](https://github.com/allens/s3cab/pull/164):** pure
  `planCleanup` in `src/lib/cleanup.mjs` (mirroring `verifySet`), 8 mock-free lib tests, the
  cleanup command thinned to I/O + policy; a Copilot-review pass also fixed a pre-existing
  cross-set `damaged` under-count the extraction had preserved. Its open-candidate entry is
  deleted (the pair is noted in docs/design/backup.md). Superseded the prior HTML report (now
  overwritten in place at `architecture-review.html`).
- **2026-07-10 — sixth pass** (with a user-requested extra: score the project against the
  `codebase-design` / `domain-modeling` / `tdd` / `code-review` skills; scorecard in the HTML
  report). Re-verified all seven opens against HEAD `0f19353` — **all hold**; line anchors
  refreshed (several had drifted: `downloadRemoteSnapshots` 119→272, `normalizeName` 21→62,
  compare baseline 99→113, `emptyBucket` 569→559, `seedStarterExclude` 179→189 + its
  `(name)`→`(set)` signature). One finding **strengthened**: `diff`'s `export` has zero
  importers anywhere — not even its tests — so it's speculative surface, not a test seam.
  Examined the PR #166 churn (`auth`→`provider` rebuild, ADR-0047, the largest command file at
  352 lines): genuinely deep — pure helpers behind one export, discriminated-union `Scope`
  typedef, 456 lines of tests — **no new candidates**; its CLI-surface follow-ups
  (`--profile` flag collision) already live in `provider-ux.md`. Scorecard net: strong on all
  four skills; the one systematic weakness is plan/execute interleaving pushing pure decision
  logic behind I/O-only test access (exactly the `planUpload` / `diff` / `seedStarterExclude`
  candidates). Minor ubiquitous-language slips noted: user-facing "adopts" in `setup.mjs:256`
  (canonical: **inherit**), comment-level "garbage collector"/"orphan GC"/"blob"
  (`cleanup.mjs:13`, `objects.mjs:116`, `verify.mjs:149`). Top pick: **pure `planUpload`**
  (runner-up: test `diff` directly). Superseded the prior HTML report in place.
- **2026-07-10 — the 1+5+7 bundle landed** ([PR #167](https://github.com/allens/s3cab/pull/167),
  grilled in-session then built step-by-step). **Four candidates retired as done:** *pure
  `planUpload`* (landed as the **`lib/upload.mjs` verb module** — planner + `uploadSnapshot`
  moved in beside it, the subsystem-cohesion rule honestly applied since restore/verify/cleanup
  already had verb modules and upload was the outlier embedded in the store module; `remote.mjs`
  −169 lines to the snapshot-store read/manage side, still sole owner of the `snapshots/`
  prefix; `uploadCandidates`/`candidatesNotIn` subsumed, `status` reuses the planner; the
  first-backup LIST diff gained ungated unit tests), *test `diff` at its own interface* (13
  classification tests on in-memory Maps, 12 shell tests kept; the export is now a deliberate
  internal test seam), *lift `seedStarterExclude`* (name-keyed `sets.mjs` primitive returning
  wrote/skipped; a Copilot review comment then upgraded it to **atomic write-if-absent** — the
  `wx` flag replaces the check-then-write, making the never-clobber guarantee kernel-enforced
  and *smaller*), and *trim `s3.mjs`* (`emptyBucket` deleted; the versioned-bucket manual-test
  script it was meant to be is parked in [misc.md](misc.md) — a per-key delete only adds delete
  markers on a versioned bucket, so a faithful move was impossible). Ride-alongs: the
  CONTEXT.md vocabulary sweep (adopts→inherits incl. one user-facing string, GC→orphan
  sweep/deleter, blob→object) and the user-stated memory/async stance recorded in CLAUDE.md
  ("modern user PC, not a headless VM; async engine interfaces welcome — progress can hook in").
  Three opens remain: `downloadToFile` (spell the option `hasher`, not "tap" — and rename the
  `tap` local in objects.mjs when it lands), the snapshot-name authority, and threading the
  previous snapshot through `snapshot → compare`.
