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

Surfaced 2026-07-29 (tenth pass) — the first review of the **deletion rework** (ADR-0063/0064),
the **network-resilience** work (ADR-0065/0068), **interrupt hash-parking** (ADR-0067) and the
**fused snapshot+upload pipeline** (ADR-0069): 73 commits (PRs #217–#245) since the open list was
last emptied. Verified against the source at HEAD `0268c73`. Verdict: the new subsystems followed
the house plan/execute pattern rather than inventing one, so three of the four candidates are
duplications *between* modules, and the fourth is a guard that one path never got.

- **A — fold `uploadDir` into the one PUT loop** — **Strong**. `src/lib/upload.mjs`'s header
  states the design as "One PUT loop, one drift guard, two sources". There are **two** loops and
  **three** sources: `uploadDir` (l.387, from [#227](https://github.com/allens/s3cab/pull/227))
  hand-rolls its own `seen`-dedup + `putObject` loop, and
  [#245](https://github.com/allens/s3cab/pull/245) built `uploadObjects` (l.192) beside it without
  folding it in. The cost is a **live correctness gap, not tidiness**: `uploadObjects` re-checks
  size+mtime between hashing and PUTting because — its own words — "the store trusts the hash on
  write, so PUTting its current bytes would file them under the recorded content's hash —
  corrupting that object for every snapshot and path that dedups to it, surfacing only at
  restore." `uploadDir` has the identical window (`fileProps` reads and hashes, then `putObject`
  streams the file again) and **no guard**. The window is widest for exactly what `upload --dir`
  is for: seeding priority folders — the multi-GB video population, where one file hashes for
  *minutes* before the PUT re-reads it. `upload --file` shares the shape (`prop()` then
  `putObject`) at one-file stakes. Sketch: `uploadDir` becomes a **row source** (walk → hash →
  yield `[path, Props]`) `run` through `uploadObjects` with an empty `stored` set — its
  `seen`/`uploaded` counters and `{ candidates, uploaded }` return are already what
  `uploadObjects.result()` reports. Grill: what a drifted file should *do* on a path that writes
  no snapshot, and the drift error's wording (it names `s3cab backup <set>`, honest advice but
  phrased as though a snapshot was written). **The missing guard is also a bug in its own right**
  — it belongs in [bugs.md](bugs.md) whether or not the refactor is taken.

  **Grilled 2026-07-29/30 — decisions recorded before building** (the PR #168 pattern: settle it in
  the entry, then build small-to-large, so the design survives a session boundary; #246 landing in
  this very file mid-grilling proved concurrent work here is live). Re-verified at `f600f9d`: #246
  touched only `storedHashes`' progress output, so **A's premise is intact** — both loops, the
  unguarded `uploadDir` and the false header all stand (anchors moved ~+27 lines: header l.31,
  `uploadObjects` l.219, `fileChange` l.297, `uploadDir` l.414). The "Grill:" questions above are
  answered below.
  - **Unify, don't fix in place.** The absent guard is a *symptom* of the duplicate loop; patching it
    where it sits leaves the loop that will miss the next invariant too. `uploadDir` becomes a **row
    source** (walk → hash → yield `[path, Props]`) `run` through `uploadObjects`. Rows must be
    produced **lazily** so hash→PUT→next-file still interleaves per file rather than hashing the
    whole subtree first, and the seed keeps **no store LIST** (`stored = new Set()`; the conditional
    PUT is its already-stored check, as documented). `fileProps` already returns exactly the `Props`
    shape `fileChange` compares against, so no adapter is needed.
  - **Drift on the seed: skip, report, exit 0** — the load-bearing asymmetry. On
    `backup`/`uploadSnapshot` drift *must* fail the run, because a published manifest would
    reference an object that was never stored. The seed publishes **no manifest**, so once the guard
    has refused the wrong bytes nothing downstream is inconsistent and the next `backup` stores the
    file properly. `uploadSnapshot` is behaviourally untouched; `--force` never interacts with the
    guard (it means "overwrite deliberately").
  - **`result()` returns two fields, `{ drifted, failure }`** — and this **fixes a live masking
    defect**, not just a style point. Today one `failure` slot is first-wins, so a drift at row 1
    followed by a network death at row 5 leaves the transport failure invisible; `backup` still
    fails but blames the wrong thing, and a seed that *tolerates* drift would have exited 0 on a
    dead link. Drift is genuinely plural and per-file; a transport failure is singular and terminal.
    So `backup` now checks `failure` **before** `drifted`.
  - **`drifted` is data**, `(FileChange & { path })[]`, not pre-built errors — the
    plan-returns-data / caller-formats split used everywhere else. `fileChangedError` and
    `fileChange` become exported; `FileChange`/`fileChange` **keep their names** (they read
    correctly — "how the file changed, or undefined"; inverting to `confirmFile` would return a
    value when confirmation *fails*). **Consequence: `uploadObjects` loses its `set` parameter** —
    it existed only to name the re-run command in the drift error, which the caller now builds. The
    interface narrows to `{ bucket, stored }`, dissolving the "what set does a seed name?" question
    rather than answering it.
  - **`backup` names `drifted[0]` as today plus a count line** when there are more ("3 other files
    changed the same way") — one drifting file is bad luck, forty means the set points at a live
    directory, and the existing advice reads very differently in those two cases. Own commit.
  - **`upload --dir` reports skips in the result, named in full** — `DirUploadResult` gains
    `skipped: (FileChange & { path })[]`, rendered by `renderUpload` like `renderRestore`'s skipped
    block, whose doc is on the nose: _"each entry is a file the user asked for and didn't get, so
    name them all and say what to do about it."_ The result _is_ the report (ADR-0043), so `--json`
    gets it free.
  - **`upload --file` gets the guard but not the loop.** Routing it _through_ the transform fits
    badly (`--force` means deliberate overwrite, `--bucket` runs with no set, the result shape
    differs, and the dedup/`stored` machinery is dead weight for one file), but the corruption
    consequence is identical and doesn't care that one file was involved — so `fileChange` is called
    between `prop()` and `putObject`. It **throws** (one file is the whole command; `uploaded: false`
    would be a lie), via its own small **plain-`Error`** factory with upload-framed wording:
    `fileChangedError`'s body is mostly the "your snapshot is saved, nothing is re-hashed"
    reassurance, meaningless here, and error.mjs's taxonomy says a subclass nobody catches by type
    is unused identity.
  - **Naming: `drifted` kept, after interrogating it.** The term was challenged as borrowed
    CloudFormation/Terraform jargon. The rename **didn't hold up**: it never reaches user text in
    this sense (the error says "it changed while the backup was running"; the only user-facing
    "drift" strings are _clock_ drift, standard in S3's `RequestTimeTooSkewed` domain), the generic
    "things getting out of sync" sense never shares a file with the file sense, and ADR-0012 governs
    user prose rather than code identifiers. `unconfirmed` was the runner-up and reads flabbier in
    situ (`if (drifted.length)` scans instantly; `unconfirmedFilesError` is a worse factory name);
    `unverified` is ruled out outright by the `verify` command. **No CONTEXT.md entry** — the
    glossary is the user-facing ubiquitous language, and an internal field name that never reaches a
    user does not belong in it.
  - **Delivery: one PR, four commits, each red-first** — (1) the `{ drifted, failure }` outcome
    shape + exported factory, (2) `backup`'s count line, (3) `uploadDir` routed through the
    transform + `skipped` in the result/render, (4) the `--file` guard. The `--dir` corruption test
    is written to **fail first** (the PR #203 precedent — the red run is the proof). The gated
    real-S3 suite must run: this is the S3 write path, which is exactly why that suite is
    real-bucket. **ADR-0069 gets an amendment note** (the outcome shape and the third source) rather
    than a new ADR — no new trade-off, a refined interface on an accepted decision. **No `bugs.md`
    entry**: it would be filed and deleted inside one PR, so the run-log entry carries the record.
- **D — name the bucket's unreadable snapshots** — **Strong**. `referencedObjects` yields per-set
  `unreadable: { snapshot, reason }[]`; every consumer wants the same *set-qualified, bucket-wide*
  derivation and every consumer builds it itself. Ten copies of one unnamed concept across five
  files: the identical `flatMap` three times (cleanup.mjs:74, unrestorable.mjs:94, delete.mjs:105),
  the same inline structural typedef three times (cleanup.mjs:44, unrestorable.mjs:56,
  delete.mjs:79), and `map((u) => `${u.set}/${u.snapshot}`)` four times (commands/cleanup.mjs:108,
  commands/delete.mjs:155, delete.mjs:389, unrestorable.mjs:294). The tell is that last one:
  `set/snapshot` is a **user-facing identifier** invented independently in four places, with no
  CONTEXT.md term. On top, two sites build the same abort from the same skeleton ("Can't … safely:
  N snapshot(s) won't read … Unreadable: … Triage first: s3cab verify <bucket>"), differing in one
  middle clause — the "heavy, actionable, reused → a named factory" row of `error.mjs`'s own
  taxonomy. **Placement is the grilling question, not the existence**: remote.mjs produces the
  per-set results, verify.mjs owns the `ReferencedResult` typedef the three modules `@import`, and
  error.mjs hosts the taxonomy the abort belongs to — splitting derivation from message across two
  homes may be right.
- **B — one aligned-total table; one `count`/`plural`** — **Worth exploring**. `delete.mjs` says it
  outright ("follows the unrestorable summary's shape exactly") and it does, by copy:
  `formatDeleteSummary` (l.306–341) and `formatUnrestorableSummary` (l.242–277) both compute three
  column widths, close over the same `row()`, pop the total and draw the same `─` rule at
  `fileCol + byteCol + 2` — ~30 near-verbatim lines. Underneath, `render.mjs` already has
  `count` (l.825) and `plural` (l.830) but **private**, so three lib modules hand-rolled `files(n)`
  (delete.mjs:434, unrestorable.mjs:379, deletion-record.mjs:179) and two hand-rolled `objects(n)`.
  The ninth pass logged the pluralization as "marginal"; the deletion rework tripled it. **Two
  arguments cut against the table half**: these are two different commands' user-facing output
  (similar today ≠ must stay identical), and they deliberately bypass render.mjs because they are
  *pre-decision* output printed before the command returns — so render.mjs may be the wrong home
  even though its siblings live there. Grilling should split it: take `count`/`plural`, decide the
  table on its merits.
- **C — `putText` re-spells `putObjectParams`; no `PreconditionFailed` twin to `isObjectNotFound`**
  — **Worth exploring**, small, inside s3.mjs. `awsOnlyPutParams`' doc claims the gating "lives in
  one place", shared by "putFile (via putObjectParams) and putText". Half true: the AWS-only gating
  is shared, but the rest of `putObjectParams`' body is re-typed inside `putText` (l.752) — its own
  `parseS3Uri`, its own `awsOnlyPutParams()` spread, its own `IfNoneMatch: "*"` — so the
  conditional-PUT spelling exists twice in the module whose job is to be the one SDK boundary. And
  both uploaders map `PreconditionFailed` → `false` with the same four-line guard (putFile:677,
  putText:764), where the module already has the pattern: `isObjectNotFound` (l.708), "the single
  spelling of 'missing object' for this SDK boundary, so callers don't each repeat the SDK's
  names." **Don't conflate with the standing rejection** on parameterizing `putFile`'s no-clobber
  *mechanism* (below) — that stays rejected; this changes no mechanism and no round trip.

**Examined & left alone (tenth pass)** (not candidates — skip future runs): the
**destructive-command pattern** across delete/forget/cleanup (ADR-0064) — the non-interactive gate
is structurally identical three times but is *three lines*, and the substance is each command's
bespoke ADR-0030 message; a helper taking the whole message is shallow, and each command already
has its own "refuses a non-interactive run without --force" test; the **three shapes of the
deletion-record lookup** (`verifySet` wants `Map<hash,{deletedOn}>`, `planCleanup` wants
membership, `baselineHashes` wants keys) — distinct questions per consumer, the same reasoning that
declined the `credentialMode` classifier; the **network-resilience trio** (`requestErrorRelay`,
`network-status.mjs`, `requestErrorTable`) — deep, with the module-level state explicitly justified
and the curried-window bug documented in its own doc, an exemplar alongside the SigV4-X509 signer;
**`lib/snapshot.mjs` + the fused pipeline** (the `through` seam is one optional parameter as the
whole snapshot-vs-backup difference; backup.mjs is thin porcelain); **`command-details.mjs`**
(clean prose extraction, stated invariant); the **plan/execute discipline** (planDelete /
planUnrestorable / planRestore / planCleanup / verifySet / planUpload all pure and all say so).

---

Surfaced 2026-07-16 (eighth pass) — a **whole-`src/` simplification-focused read** (user brief:
clear + concise, fewer lines/branches/indirections, hunt bugs en route), every production module
read in full at HEAD `b072f93`. Verdict: the codebase is genuinely deep after seven passes —
no module fails the deletion test — so this pass's candidates are *simplifications inside
interfaces*, not new seams. Everything Strong landed same-day — both bugs fixed (the
`dirs.txt` comment-line bug → [PR #201](https://github.com/allens/s3cab/pull/201), which was
also candidate B; the `aws --save --profile` drop →
[PR #199](https://github.com/allens/s3cab/pull/199)) and **A landed in
[PR #202](https://github.com/allens/s3cab/pull/202)**, **C in [PR #203](https://github.com/allens/s3cab/pull/203)**,
and **D in [PR #204](https://github.com/allens/s3cab/pull/204)** (run log below). Only E remains open.

_Nothing from these two passes is still open._ The eighth and ninth passes (A–G) all landed or
parked; the eighth-pass E bundle's four items are all in — provider.mjs and render.mjs with F
([PR #208](https://github.com/allens/s3cab/pull/208)), remote.mjs and commands/upload.mjs with the
E-bundle finish ([PR #211](https://github.com/allens/s3cab/pull/211)). What survives from them is
the leave-alone list below, which the tenth pass re-checked as still accurate.

**Examined & left alone (eighth pass)** (not candidates — skip future runs): `referencedObjects` *not*
filtering set names to `[a-z0-9-]+` while `listRemoteSets` does — **load-bearing asymmetry**
(filtering the scan would make cleanup treat a non-canonical set's objects as orphans; the
lister only feeds display/discovery); the trust-on-write `upload --snapshot <old>` staleness
window (**not an architecture candidate — it is now tracked as a bug**, [bugs.md](bugs.md); this
pass recorded it as "a deliberate design stance… not a defect", which was an AI-invented verdict
nobody held — don't re-file it as a design stance); list.mjs's summary branch re-doing the
`--latest` slice inline (trivial);
`clientConfig`'s `??` vs the aws command's `||` on the region default (empty-string edge,
trivial); pluralization hand-rolls outside render.mjs's `plural` (marginal); snapshot.mjs's
floor-based percent arithmetic (a simpler spelling changes rounding — not worth it); the
render/help/error/auth/RA modules generally (read in full: deep, cleanly seamed — auth.mjs's
error taxonomy and the snapshot-file grammar module are exemplars alongside the SigV4-X509
signer).

---

## Rejected & parked — do not re-suggest

Recorded so future runs (and reviewers) skip them. Each was verified against the source at
least once; re-open only if the stated reason no longer holds.

- **A pre-walk root-containment check** (compare the set's realpath'd roots up front, reject when
  one is a prefix of another) — rejected 2026-07-16 while building candidate D
  ([PR #204](https://github.com/allens/s3cab/pull/204)). It looks like the strictly better fix —
  fail *instantly*, before any walking — but it is **not faithful to the invariant**: containment
  is a fact about path *shape*, whereas the thing that actually breaks a snapshot is a file
  **reached twice**. Exclude patterns can make nested roots a legitimately working config today
  (an outer root whose pattern drops the inner directory reaches no file twice), so a
  containment check would reject a set that works — trading a real false-positive for latency on
  a config that was never broken. The file-level check is the honest one, and the inline form D
  shipped already bounds the waste to the first root's walk rather than the whole set. Re-open
  only if nested roots become invalid *by decision* regardless of excludes — at which point the
  check is expressing a rule, not guessing at one.
- **Parameterizing `putFile`'s no-clobber mechanism** (each caller picks HEAD-preflight *or*
  conditional PUT) — explored at length 2026-07-16 alongside candidate C and **declined: the two
  are not redundant, they are a deliberate division of labour.** `putFile` looks like it guards
  no-clobber twice; it doesn't. The tempting shape (`objects.mjs` HEADs at every size and skips
  `IfNoneMatch`; `upload.mjs` uses `IfNoneMatch` alone) loses on every axis:
  - **`IfNoneMatch: "*"` is free and unraceable.** It rides a PUT we already send — zero extra
    round trips — and S3 evaluates it *at the write*. HEAD-then-PUT is TOCTOU. For
    `snapshots/<set>/<name>.tsv.zst` the key is a timestamp *name*, not a hash, so two machines
    backing up one set in the same minute produce the same name with different content: losing
    that race **silently destroys the other machine's snapshot**, and multi-machine sets are
    designed for (ADR-0024/0026). Dropping it for objects removes a free net and buys a parameter.
  - **The HEAD costs a round trip**, so it is size-gated — and `partSize` is not an arbitrary
    threshold, it asks *"is the body expensive enough to be worth a round trip to maybe avoid?"*
    `planUpload` has already excluded objects it knows are present, so `putFile` is called almost
    only for genuinely-absent ones: nearly every HEAD would 404 and buy nothing. The plan loop is
    **strictly sequential** (`for … await putObject`), so a HEAD per object on a 50k-file first
    backup is +50k *serial* round trips — the per-file overhead the coding conventions warn about.
  - **The threshold belongs where it lives.** It *is* `partSize`, an s3.mjs concept; `objects.mjs`
    would need a second `stat` per file (or a `planUpload` contract change) to make the same call.
  - **The callers do differ — but not in mechanism.** Only in what `false` *means*: benign dedup
    for objects, a hard error for snapshots. That is already expressed caller-side; `putFile`
    needn't know.

  So: **HEAD = an optimization gated on body cost; conditional PUT = free correctness.** Re-open
  only if the upload loop stops being sequential, or if `IfNoneMatch` proves unsupported on a
  target off-AWS provider.

- **A pure `credentialMode(env) → "profile" | "keys" | "ra" | "ambient"` classifier** — declined
  during the 2026-07-14 grilling of candidate C. The premise (~5 sites re-derive one "which mode"
  question) does **not** survive source verification: the sites ask *distinct* per-layer questions
  — a binary RA route (`resolveCredentials`, `client()→authNotice`), a rich *error-diagnosis*
  cascade needing `knownProfiles` and an absent-vs-present split (`credentialCase`), multi-knob
  *enumerators* that list every present knob at once (`describeScope`/`shellNote`), and
  *option*-classification of incoming CLI flags, not the env bag (`newMode`). So one classifier
  value can't cleanly serve them; building it would over-generalize a scatter that isn't one
  (ADR-0006/#5), and it sits on the [ADR-0055](../docs/adr/0055-per-set-credentials-one-mode.md)
  "auth is a bag of `AWS_*`" line. The genuinely duplicated/drifty part — the RA-marker read — was
  the *real* defect and was fixed narrowly instead ([PR #194](https://github.com/allens/s3cab/pull/194):
  both `provider.mjs` reads routed through the existing `isRolesAnywhereMode`). Re-open only if a
  future change makes several sites genuinely need the *same* single mode value.
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
- **2026-07-10 — the remaining-three bundle landed**
  ([PR #168](https://github.com/allens/s3cab/pull/168), grilled in-session, decisions recorded
  in the entries first, then built small-to-large). **All three opens retired as done,
  emptying the open list for the first time.** *Thread the previous snapshot* (the first
  shape: `compareSnapshots`' `since` accepts `{ name, entries }`, `snapshot` hands its parse
  through, `--rehash` still reads; a test hands in synthetic entries under a since name that
  doesn't exist on disk, proving no re-read). *`downloadToFile`* — grilling reshaped the
  recorded sketch twice, both times smaller: the injected `hasher` became the plain
  `{ sha256 }` expected digest (the injection was over-engineering — the entry's post-mortem
  is in git history), and the first parameter became the **source stream** rather than a URI
  after implementation surfaced that a URI form would sink the integrity logic below the
  "mock at s3.mjs" test line — it now tests mock-free against `Readable.from` in s3.test.mjs
  (plus new verbatim-copy and mid-stream-failure cases), with objects.test.mjs keeping the
  key-as-digest pairing; the `tap` local is gone. *The snapshot-name authority* (one step
  past the sketch: `snapshotName()` mints the name from one clock read and `writeSnapshot`
  **derives the header datetime from the name**, dropping its `datetime` parameter —
  consistent by construction, not by shared capture; `normalizeSnapshotName` moved home to
  snapshot-file.mjs, ending the extension-grammar leak into compare.mjs).
- **2026-07-14 — seventh pass** (after the open list sat empty since 2026-07-10). First review
  of the **Roles Anywhere subsystem** (ADR-0055–0058, PRs #186–#191) — `roles-anywhere.mjs` (879
  lines, now the largest lib file), `onboarding.mjs`, the fourth credential mode in `auth.mjs`,
  the `aws` command. Three parallel Explore agents (RA subsystem / onboarding+aws / s3.mjs+cred
  flow) plus an independent read of the core; all findings re-verified against HEAD `2b48495`.
  Verdict: the subsystem is **mostly deep** — the SigV4-X509 signer (`createSession` flanked by
  pure `buildSignedRequest`/`parseSessionResponse`) is the in-repo exemplar of the pattern the
  project keeps missing. Five open candidates recorded above (A–E); top pick **A — extract pure
  `arnsFromOutputs`** (convergent across two explorers, textbook pure-logic-behind-I/O, smallest
  blast radius, no ADR tension). Parked items (SetContext, remote/config restructure) confirmed
  untouched. Overwrote the prior HTML report in place at `architecture-review.html`.
- **2026-07-14 — the A+B bundle landed** ([PR #192](https://github.com/allens/s3cab/pull/192),
  grilled in-session then built). **Two candidates retired as done.** *Pure `arnsFromOutputs`*
  (A) lifted the stack-output → identity-env mapping out of `saveArnsFromStack`'s CloudFormation
  I/O into a pure exported `arnsFromOutputs(outputs) → { arns, missing }` — the mapping and the
  missing-output check now unit-test against a plain array (4 mock-free cases) instead of a
  mocked SDK; the wrapper thinned to fetch → delegate → throw-or-write, keeping the ADR-0030
  error (which needs the stack/region context) on its side; typed with the real
  `import("@aws-sdk/client-cloudformation").Output[]` (already a dependency, house idiom for SDK
  types) rather than a hand-rolled structural type — the grilling flipped this once the dep
  status was checked. *The ARN contract* (B) — `ARN_ENV` exported as the one home of the three
  (output-name → env-key) pairs: `readSigningIdentity` reads the ARNs back through it (was bare
  `S3CAB_RA_*` literals), and a **contract test** in `onboarding.test.mjs` asserts the RA
  template emits every Output name the reader expects — chosen over a shared symbol (grilling
  decision) so the template stays readable literal YAML and no `onboarding → roles-anywhere`
  edge appears (ADR-0006: a test guard, not machinery; the asymmetric `RoleArn ← Role.Arn`
  GetAtt meant a shared symbol would only own half the pairing anyway). Three opens remained (C,
  D, E) — all on the credential-mode surface; **D is C's concrete symptom**, so the order taken
  was D (Strong, cheap) then C (the deeper classifier, ADR-0055 tension to grill), with E as a
  ride-along whenever the recipe prose is next touched.
- **2026-07-14 — D landed** ([PR #193](https://github.com/allens/s3cab/pull/193)). *Teach
  `authNotice` the RA mode*: an RA-mode set carries no `AWS_PROFILE` and (RA is AWS-only) no
  endpoint, so `authNotice` fell through to the anonymous `"Contacting the cloud…"` for every
  Roles Anywhere command — degrading its "which identity?" promise for the one mode where the
  identity is known. Added an RA-first branch (`"Using Roles Anywhere (keyless)"`) fed by
  `isRolesAnywhereMode()` from `client()`; `authNotice` stays pure (receives the boolean, never
  reads env), RA takes precedence over any hand-left profile/endpoint (mirrors `resolveCredentials`'
  RA-before-chain check), plus the missing `s3.test.mjs` RA case. C and E remain open; C is next
  (grilled before building — the ADR-0055 read-only-classifier decision), E a ride-along.
- **2026-07-14 — C landed as a narrow fix; the classifier declined** ([PR #194](https://github.com/allens/s3cab/pull/194),
  grilled first). Grilling + source verification **undercut C's premise**: the ~5 "sites" ask
  distinct per-layer questions, not one (details in the Rejected & parked entry above), so the full
  `credentialMode()` classifier was declined and parked. What shipped is the genuine, verified
  defect: `commands/provider.mjs` read the `S3CAB_RA` marker two ways — `describeScope:95` used
  `=== "1"`, clear-on-replace `:319` a loose truthy — so `S3CAB_RA=0` read not-RA everywhere except
  the clear path. Both now route through the canonical `isRolesAnywhereMode`, with a regression test
  for the degenerate `=0` case. A worked case of grilling shrinking a candidate to its honest core.
- **2026-07-14 — E landed (narrowed)** ([PR #195](https://github.com/allens/s3cab/pull/195)).
  On close read E's advertised "duplication" was loose (different numbering/indentation, real-vs-
  placeholder bucket), but a *second* rationale — aws.mjs's header asserts "recipe text lives in
  onboarding.mjs (pure, unit-testable)" while `saveRolesAnywhere` hand-wrote its `--save`
  confirmation inline (I/O-path-only, untested) — was the real win. Relocated the confirmation to a
  pure `awsSaveConfirmation({ stackName, region, dir })` (byte-identical string, first unit
  coverage); the marginal step-3 dedup was skipped (ADR-0006/#5). **This emptied the seventh-pass
  open list** — every candidate landed or was parked.
- **2026-07-16 — eighth pass** (user-directed: architecture review + tdd lens, **tuned to code
  simplification** — clear/concise, fewer lines/branches/indirections, bug-hunt en route). Run
  inline (no Explore agents): every production module under `src/` read in full at HEAD
  `b072f93`, plus a test-quality sample (lib/upload.test.mjs, commands/backup.test.mjs — both
  strong: seam-based, behavior-driven, independent literals). The open list had sat empty since
  2026-07-14. **Two bugs found** → [bugs.md](bugs.md): `dirs.txt` `#`-comments walked as
  directories (readSet/readSetConfig vs parseLines's own doc), and `aws --save --profile`
  silently dropping the profile (stack-arns builds its client with `{ region }` only). **Five
  candidates recorded above (A–E)**, all simplifications behind existing interfaces rather than
  new seams — the standout being **A: `backup` re-derives the fresh-name + baseline its own
  `snapshot()` call already returned as `CompareResult.until`/`.since`** (the in-code comment
  claiming otherwise is false), a pure deletion that makes the pair consistent by construction.
  Ride-along doc fixes: the stale `emptyBucket` bullet deleted from engine-robustness.md
  (retired in PR #167) and the trust-on-write staleness note recorded there. Top pick: **A**,
  with **B** (the bug-fixing dedup) as the natural same-session second. Overwrote the HTML
  report in place.
- **2026-07-16 — B landed** ([PR #201](https://github.com/allens/s3cab/pull/201)). *One
  line-parsing rule for `dirs.txt`*: `readSet` and
  `readSetConfig` now route through `parseLines`, making its own doc ("the shape a set's
  exclude.txt and dirs.txt are read as at runtime") finally true — the comment-line bug fixed
  and the duplicated split/trim/filter deleted. Built test-first, one red unit per reader:
  sets.test.mjs hand-edits a `dirs.txt` with `#`/blank lines; set-marker.test.mjs gained the
  objects.test.mjs-style `s3.mjs` module mock (its first behaviour coverage outside the
  integration suite). The bugs.md entry is deleted (bugs go when fixed).
- **2026-07-16 — A landed** ([PR #202](https://github.com/allens/s3cab/pull/202)). *`backup`
  takes the fresh name + baseline from `snapshot()`'s diff*: `{ until, since }` destructured
  from the returned `CompareResult` — both `listSnapshotNames` read-backs, the "No snapshot was
  produced" guard, and the false "returns its diff, not the name" comment deleted (net −10
  lines); backup↔snapshot now agree by construction. The grilled caveat sharpened into a real
  fix: an `S3CAB_DEBUG` same-minute overwrite makes the diff's `since` the fresh name itself,
  and diffing the snapshot against itself would plan zero objects and break
  objects-first/snapshot-last — a `since === until` (or null) baseline now falls back to the
  first-backup store LIST, with its own test. Built test-first (mocked `snapshot()` returns its
  real contract; the stub-file machinery deleted); a Copilot comment moved the test's inline
  `import("…").CompareResult` to the house `@import` tag. **This closes the eighth pass's
  Strong tier** — C/D/E remain open above.
- **2026-07-16 — D landed** ([PR #204](https://github.com/allens/s3cab/pull/204)). *Fail the walk
  at the first duplicate file*: the overlapping-member-dirs check was a full second pass over
  `files` after the walk had already finished, so an overlapping set paid for the **entire** walk
  (minutes, on a big set) before erroring on a condition knowable the moment the duplicate is
  reached. The `seen` Set now sits beside `files`, spans all roots, and is checked as each path
  arrives — the first duplicate throws, and the second pass is deleted. Same error message,
  deliberately: the existing overlap test was strengthened *first* to pin the **named duplicate
  path** rather than just `/overlap/`, so the refactor couldn't silently reword it. Verified by
  driving `walkDirs` over a 1200-file root with a nested root under it — it throws on the nested
  root's *first* file, and the `using progress` disposal already covered the mid-loop throw (its
  newline is `drawn`-gated, so the cursor lands on a fresh line; `progress.mjs`'s doc comment
  states that contract explicitly). The pre-walk root-containment alternative stays **rejected** and
  now has its own entry above (exclude patterns can make nested roots a legitimately working
  config today, so only the file-level check is faithful). C and E remain open.
- **2026-07-16 — C landed** ([PR #203](https://github.com/allens/s3cab/pull/203)). *Drop
  `objectExists`'s metadata heuristic*: any successful
  HEAD now counts as present, so a metadata-less object costs one HEAD instead of a full
  multipart body the conditional PUT then rejects. `objectExists` is **inlined into `putFile`**
  along the way — one module-private caller, and the boolean round-trip (`objectExists` returns
  *true* so `putFile` returns *false*) read as a double negative. **The blame dug up the reason
  the code never stated, and it refuted itself:** the heuristic is a fossil of the `getMetadata`
  *parser*
  ([#25](https://github.com/allens/s3cab/pull/25)) whose `null` meant "no metadata to parse",
  not "object absent". That PR *correctly* dropped it, then restored it (`fix(s3): preserve
  multipart no-clobber metadata check`) to satisfy a Copilot review claiming a metadata-less
  object "would be overwritten" — but `IfNoneMatch: "*"` and the `PreconditionFailed` catch were
  already in `putFile` **in that same commit**, so it never could be. Bug-for-bug compatibility
  with dead code, preserved on a false premise. Built test-first: the wasted body is only
  observable *as* wire traffic, so the new suite runs the real `client()`/SDK against a fake S3
  on loopback and asserts the request sequence (`captureRequest` can't serve — it builds its own
  client, bypassing the memoized one). The exactly-`partSize` fixture keeps lib-storage on the
  single-`PutObject` path, so the fake needs no multipart choreography. The red run was the
  proof: an 8.4MB body on the wire for an object already there. Two further captures ride along:
  the **`putFile` no-clobber split** is now a standing rejection above (the HEAD and the
  conditional PUT are a deliberate division of labour, not redundancy), and the discussion
  surfaced a real defect — the snapshot→upload staleness window, filed in [bugs.md](bugs.md),
  which this pass had recorded as "a deliberate design stance… not a defect", an AI-invented
  verdict nobody held. The coverage audit it produced was captured as `test-coverage.md`
  (since worked through and deleted, 2026-07-17: the skip/accept matrix is now pinned across
  the loopback fake in `src/lib/s3.test.mjs` — grown real multipart choreography — and
  `test/integration/s3.test.mjs`). **Only E now remains open.**
- **2026-07-17 — ninth pass.** E re-verified at HEAD `80a45aa` — **holds** (anchors refreshed:
  E's remote.mjs get-or-inserts 182–186/252–265). The #199–#202 churn
  examined directly: backup.mjs post-#202 is clean thin porcelain (the `since === until` debug
  edge handled); stack-arns's client-config `profile` is justified, not a candidate (onboarding
  has no set env layer). One background Explore agent (fresh eyes, medium breadth, primed with
  the standing rejections) swept the churn plus the less-examined modules and test tiers; both
  its findings verified against the source and recorded as **F** and **G** above. En route it
  caught a live drift bug — `list <set>` never surfaces Roles Anywhere mode (`providerOverrides`
  predates RA, so a keyless RA set renders as "ambient") → recorded in [bugs.md](bugs.md), fixed
  by construction if F lands. Found clean: the plan/execute discipline (`verifySet` /
  `planCleanup` / `planRestore` / `planUpload` all pure), remote/objects prefix ownership (the
  `.tsv.zst` literal in G is the sole leak), the config layer post-#201, and the test tiers per
  ADR-0049 (the "mock at s3.mjs" line holds). Top pick: **F**. Overwrote the HTML report in
  place.
- **2026-07-17 — F landed (+ E-1/E-4)** ([PR #208](https://github.com/allens/s3cab/pull/208),
  grilled in-session then built red-first). *One read of a set's provider config*: pure
  `readProviderConfig(values) → ProviderConfig` in lib/provider.mjs beside `gatherProviderConfig`
  — the module is now the one home of the knob ↔ env-key mapping; `describeScope` and list's
  `providerOverrides` both consume it, and the `ProviderOverrides` typedef moved home as
  `ProviderConfig`, ending the `render → commands/list` type edge. The RA list bug fixed by
  construction — `sign-in: Roles Anywhere (keyless)` now leads the provider block (RA-first,
  like `authNotice`) and the keys line matches `provider` (`set (…MPLE)` via the shared
  `keyTail`, a grilled consistency upgrade); its bugs.md entry is deleted. New pure
  `lib/provider.test.mjs` covers the seam (incl. the degenerate `S3CAB_RA=0`);
  `describeScope`'s tests passed untouched as the refactor's net. Ride-alongs landed as their
  own commits: E-1 (clears via the `knobs` table) and E-4 (one `painter(color)` factory).
  **Open list: E (its remote.mjs and upload.mjs items) + G.** Copilot review returned no
  comments.
- **2026-07-17 — G landed** ([PR #209](https://github.com/allens/s3cab/pull/209), grilled
  in-session then built). *Own the filename grammar's construct direction*:
  `snapshotFileName(name)` exported from snapshot-file.mjs as the one place `.tsv.zst` is built
  (the writer's own write path routed through it too), and `remoteSnapshotUri(bucket, set, name)`
  added to remote.mjs — the twin of objects.mjs's `objectUri` — composing
  `remoteSnapshotsPrefix` + `snapshotFileName`. The six hand-spelled literals across
  remote.mjs/upload.mjs became compositions; upload's `snapshotKey` variable dissolved. New unit
  tests spell the filename and full `snapshots/<set>/<name>.tsv.zst` URI out independently (both
  are format-spec promises), and the **gated real-S3 suite ran green** (15 pass, the change
  rewrites every remote snapshot URI). **Grilling shrank the candidate to its honest core** — the
  recorded "one edit for a codec change" was false (five more extension literals live *inside*
  snapshot-file.mjs, recognition/resolution/lock, deliberately left), so the real win is that the
  grammar isn't spelled *outside* its owner; and the planned `remoteSnapshotsPrefix` export-drop
  was abandoned once the integration-test callers surfaced (it was never G's substance). Copilot
  review returned an overview only, no inline comments. **Open list: E's remaining two items**
  (remote.mjs get-or-inserts, `commands/upload.mjs` trailing throw).
- **2026-07-17 — the E bundle finished** ([PR #211](https://github.com/allens/s3cab/pull/211)),
  landing its last two items and **emptying the open list**. *`refactor(remote)`*: the referenced
  scan's three hand-rolled get-or-inserts (`filesBySet`, `referenced` by hash, `entry.paths` by
  path) fold into `Map.prototype.getOrInsertComputed` — the `filesBySet` site to one line, the two
  nested ones lose their temp-and-guard; `remote.referenced-scan.test.mjs` is the net, and the
  gated real-S3 suite ran green (the scan is an S3 read path). *`refactor(upload)`*: the dangling
  "specify what to upload" throw moves up beside the other six `ParseArgsError` checks (ADR-0011)
  — **verification earned its keep**: the move wasn't free as the entry implied, since with the
  throw gone from the tail TS no longer narrows `snapshotName`, so an `assert(snapshotName, …)`
  now pins that invariant (line-neutral; the win is validation locality, not fewer lines). A
  Copilot comment then asked the assert to carry a message — accepted, matching snapshot-file.mjs's
  house style for invariant asserts. Provider.mjs/render.mjs (E's other two) had already landed
  with F. **This closes the eighth and ninth passes entirely — no open candidates remain.**
- **2026-07-29 — tenth pass.** The open list had sat empty since 2026-07-17, so this pass explored
  the **73 commits since** (PRs #217–#245) at HEAD `0268c73` — the first architecture read of the
  deletion rework (ADR-0063/0064: `forget`, path-scoped `delete`, `deletions/`), the
  network-resilience work (ADR-0065/0068), interrupt hash-parking (ADR-0067), the Glacier-IR tier
  (ADR-0066) and the fused snapshot+upload pipeline (ADR-0069). Run inline (no Explore agents);
  every new or heavily-changed module read in full (`lib/delete.mjs`, `lib/unrestorable.mjs`,
  `lib/deletion-record.mjs`, `lib/network-status.mjs`, `lib/snapshot.mjs`, `lib/upload.mjs`,
  `lib/s3.mjs`, `commands/{delete,forget,cleanup,backup,upload}.mjs`, `command-details.mjs`), plus
  outline reads of render.mjs/snapshot-file.mjs/restore. **Verdict: the new subsystems adopted the
  house plan/execute pattern rather than inventing one** (every `plan*` is pure and says so), so
  three of the four candidates are duplications *between* the new modules and the fourth is a guard
  one path never got. **Four candidates recorded above (A–D)**, with the standout being
  **A: `uploadDir` never joined the one PUT loop, so `upload --dir` has ADR-0069's hash-then-PUT
  window with no drift guard** — a live corruption path (wrong bytes stored under a recorded hash,
  surfacing only at restore) on the command built for the multi-GB files where the window is
  minutes wide, plus a false claim in the module's own header ("two sources" — there are three).
  Runner-up **D**: the set-qualified unreadable-snapshot list, ten copies of one unnamed concept
  across five files. Recorded as leave-alone: the destructive-command gate trio, the three
  deletion-record lookup shapes, the network-resilience trio, `lib/snapshot.mjs`'s `through` seam,
  `command-details.mjs`. The parked/rejected list below was re-checked and stands untouched (C's
  entry deliberately abuts the `putFile` no-clobber rejection — they must not be conflated).
  Overwrote the HTML report in place.
