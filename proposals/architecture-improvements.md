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

Surfaced 2026-09-04 (twelfth pass) — the first architecture read of the **`find` → hash-operand
`delete` pair** (ADR-0088/0089/0090), the **`#END` trailer** (ADR-0082), the **streamed-digest
upload guard** (ADR-0083), **snapshot identity by byte equality** (ADR-0084), the **ctime
cross-check** (ADR-0085), **restore collision by filesystem equivalence** (ADR-0086), the **run
report** (ADR-0078/0079), **`tree --excluded`** (ADR-0080) and **online-only files** (ADR-0081):
35 `src/` commits since HEAD `4221fad` — 81 files, +9677/−2298. Verified against the source at
HEAD `a4e0c9d`. Verdict: the new subsystems are well-shaped, and the friction is at their
*joins* — three of the four Strong candidates are a rule that ended up split across two modules
that don't import each other, and the fourth is a seam with ten adapters and one contract.
**A–D were re-verified against source by hand; E–L carry their sweep's anchors.**

**A, C, D and E landed 2026-09-05** ([PR #334](https://github.com/allens/s3cab/pull/334),
[PR #331](https://github.com/allens/s3cab/pull/331),
[PR #335](https://github.com/allens/s3cab/pull/335),
[PR #330](https://github.com/allens/s3cab/pull/330)); **B and F landed 2026-09-06**
([PR #338](https://github.com/allens/s3cab/pull/338), and for F see the run log, whose entry
records that two of its four named files were dead anchors). Their entries are retired to the run
log below, and A's, C's and D's lasting knowledge is now in
[ADR-0088](../docs/adr/0088-find-matches-like-posix-find.md)'s,
[ADR-0075](../docs/adr/0075-resolve-time-credential-expiry.md)'s and
[ADR-0019](../docs/adr/0019-s3-test-strategy.md)'s amendments; B's is the module doc at the top
of [format.mjs](../src/lib/format.mjs).

**Picking these up cold (a later session, or another machine).** Everything needed is in this
file plus the ADRs — with three caveats worth stating rather than rediscovering.
(1) **Line anchors rot on every landing, and so do the file paths.** Two files of the same name
exist in `src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`,
`provider.mjs`, `snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify
before trusting any anchor — this file's own opening rule. It paid this pass: three carried-forward
entries were dead and one had the wrong mechanism.
(2) **Ordering constraints, by file overlap rather than theme.** **H** follows F (both own the
enumeration/scan shape), and F has landed, so H is unblocked. Everything else is independent.
(3) **`.env.test` is gitignored and does not travel.** Every remaining candidate is pure or
local and verifies with `npm test` alone (C was the exception, and has landed).

- **H — Five enumeration shapes, ten construction points, three incompatible `ref` helpers.**
  _Worth exploring._ *(Carried from the eleventh pass's smaller items; it paired with D there, and
  then with F, which has landed.)* "The set of hashes something references" is built five ways across the
  codebase and its tests, and three `ref`-shaped test helpers disagree on the shape, so every new
  test picks one by proximity. One constructor, taken by the tests rather than re-derived.
- **L — `progress.mjs`'s cadence claim vs `withProgress`'s own timer.** _Answered, no change._ Not
  drift: `progress.mjs` owns the redraw-rate *floor* (`update()` enforces `MIN_REDRAW_MS` — 100 ms —
  regardless of caller), while `withProgress`'s 250 ms `setInterval` is only how often it *asks* to
  redraw (matched to a byte percentage climbing visibly), and every one of those asks still funnels
  through that same gated `update()` — the two cadences don't compete, they compose.

**Examined & left alone (twelfth pass)** (not candidates — skip future runs):
`src/lib/deletion-record.mjs` after ADR-0090 — the compaction and the record format sit behind a
small interface and the format is the ADR's, not the module's invention;
[find.mjs](../src/lib/find.mjs)'s **two-pass scan** (candidate index, then the backing lookup) —
the two passes answer different questions and fusing them would put the store's shape into the
matcher; `uploadObjects` / `putFile` after ADR-0083 — the streamed-digest guard is *inside*
`putFile` where a caller cannot skip it, which is the whole point (see **D**: the problem is nine
fakes that skip it, not the real one); [path-match.mjs](../src/lib/path-match.mjs) **as a module** —
co-locating `globSource` with the spelling question is right, and A (landed) deepened it rather
than splitting it; `generateSnapshot` and `readBaseline` **as modules** — **E** is about one parameter
group, not their placement; `writeFileAtomic` vs `withSnapshotFile` — they look like a duplicated
landing mechanic but ADR-0001's hash check lives in one and the three release paths in the other,
and CLAUDE.md already records why `writeFileAtomic` sits outside the `s3.mjs` seam; `fileProps`'s
`Props | Error` return — the split is load-bearing (ADR-0079's previously-unreadable file needs the
error *as a value*, not a throw). And **ADR-0086's restore-collision rule is tested**, at
[test/model/model.hostile.test.mjs](../test/model/model.hostile.test.mjs):317–368 — the eleventh
pass's note that it was uncovered was wrong.

---

Surfaced 2026-08-06 (eleventh pass) — the snapshot-format work (ADR-0071/0072/0073), the walk
rewrite (ADR-0077), the progress rework (ADR-0076), resolve-time credential expiry (ADR-0075) and
`lib/referenced.mjs` (ADR-0074), across 27 PRs (#249–#275). **A landed 2026-08-06**
([PR #277](https://github.com/allens/s3cab/pull/277), knowledge now in
[ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s amendment); **D landed
2026-08-07**, and **H was rejected** the same day (see *Rejected & parked*). The twelfth pass
re-verified the rest: **B, C and G carried forward** as this pass's **C**, **E** and **J**,
**F survives only as I**, and **I is dead**.

- **E — `compileExclude` owns only half the matching convention.** _Strong — re-verified
  2026-09-06 against HEAD `f7db3ed`; anchors below current._
  [exclude.mjs](../src/lib/exclude.mjs) normalizes the *pattern* side and returns a bare `RegExp`,
  then documents in prose three obligations the caller must honour on the *subject* side — all
  implemented in [walk.mjs](../src/lib/walk.mjs) (`createWalkCallbackFn`, 374–405): separator
  normalization, the trailing-`/` **directory rule**, and `matchers.find` to recover which pattern
  hit. So the directory rule is reachable only through the filesystem.
  `exclude.test.mjs`'s helper re-implements the first obligation and **cannot express the second** —
  there is still no directory-exclusion case testing the walk's trailing-separator append, and the
  only coverage is one `walk.test.mjs` case building a real temp tree. Four of the six active
  starter patterns are directory form, so the least-tested half of the grammar is the most-used
  half. **Still one production caller** — ADR-0080's `tree --excluded` ([tree.mjs](../src/commands/tree.mjs))
  reads the `excluded` array `walkSet` already produces rather than calling `compileExclude`
  itself, so it added a consumer of the walk's *output*, not a second caller of the matcher. The
  premise holds unchanged.

**Smaller items (eleventh pass), as the twelfth pass left them.** `snapshotName` — **dead**, the
alias was deleted in `0060b61`. The bucket-scan **ordering invariant**, the **enumeration
fixture** and `render.mjs`'s **section grammar** were all promoted to candidates in their own
right — **F**, **H** and **K** above. The two premises that cannot both be true are still there,
now at snapshot-file.mjs:350 (*"Windows will not rename onto an existing file"*) and :358 (renaming
onto one under `overwrite`), green on `windows-latest` — a comment to settle, not a candidate.
One classification rule still lives outside the classifier: `compareSnapshots` applies "a path
that failed hashing is not a deletion" by mutating `diff`'s output — and this pass it grew a
**second** loop, so [compare.mjs](../src/lib/compare.mjs):181–194 now reconciles both
`untilSnapshot.errors` and `untilSnapshot.skipped`, each calling `deleted.delete(path)`. `diff`'s
contract documents both rules and implements neither. Still small; still real.

**Examined & left alone (eleventh pass)** (not candidates — skip future runs): `progress.mjs`'s
**core mechanic** (`update`/`due`/`clear`/`Disposable` hides the TTY gate, write-then-clear-tail
ordering, the held-update rule, wrap truncation and cursor parking, all covered including flicker
ordering — A is about what its interface *lacks*); `uploadObjects` (small interface over dedup,
drift guard, never-throw-mid-stream, and the two-fields-not-one outcome); `writeSnapshot`'s
`through` seam and `withSnapshotFile`'s three release paths; `planDelete` / `planUnrestorable` /
`diff` (each intricate behind a small interface — deleting any would spread complexity into its
command); `fileProps` (`onHashStart` earns its width by reporting from inside and so avoiding a
second stat); `putObjectParams`/`awsOnlyPutParams`; `deletion-record.mjs`, `env-file.mjs`,
`set-marker.mjs`, `error.mjs` (incl. `errorText`'s aggregate backstop), `commands/aws.mjs` and the
ADR-0059 quarantine, `read-lines.mjs`, `command-details.mjs`; the **network-resilience trio** and
`referencedObjects`' unfiltered set names, both re-confirmed; and **ADR-0072's two clock checks**
(snapshot.mjs:491–506, compare.mjs:354–371), which look duplicated but fire at creation vs
consumption and leave no gap, because `sinceInstant` is set only on the read branch.

---

Surfaced 2026-07-29 (tenth pass) — the first review of the **deletion rework** (ADR-0063/0064),
the **network-resilience** work (ADR-0065/0068), **interrupt hash-parking** (ADR-0067) and the
**fused snapshot+upload pipeline** (ADR-0069): 73 commits (PRs #217–#245) since the open list was
last emptied. Verified against the source at HEAD `0268c73`. Verdict: the new subsystems followed
the house plan/execute pattern rather than inventing one, so three of the four candidates are
duplications *between* modules, and the fourth is a guard that one path never got. **All four
landed 2026-07-30** (run log below) — _nothing from this pass is still open._

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
planUnrestorable / planRestore / planCleanup / verifySet / planUpload all pure and all say so);
and — recorded when B landed — the **six pluralizations still hand-rolled beside the exported
`plural`**, which are **clause agreement, not noun morphology** (`was`/`were`, `its`/`their`,
`This path matches`/`These paths match`, `Snapshot 'a' is`/`Snapshots 'a', 'b' are`, plus
`referenced.mjs`'s pair): no signature holds a clause, and `directory`/`directories` is the lone
irregular *noun*, so an irregular table would have one row. The rationale sits on the export in
[format.mjs](../src/lib/format.mjs) — read it before proposing to "finish the job".

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
and **D in [PR #204](https://github.com/allens/s3cab/pull/204)**. Only E remained open. (Its run-log
entries were retired by the eleventh pass under the three-pass cap; see `git log -p` on this file.)

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
trivial); pluralization hand-rolls outside render.mjs's `plural` (marginal — superseded: the
deletion rework tripled them, they became tenth-pass candidate B, and what remains is recorded
in that pass's leave-alone list above); snapshot.mjs's
floor-based percent arithmetic (a simpler spelling changes rounding — not worth it); the
render/help/error/auth/RA modules generally (read in full: deep, cleanly seamed — auth.mjs's
error taxonomy and the snapshot-file grammar module are exemplars alongside the SigV4-X509
signer).

---

## Rejected & parked — do not re-suggest

Recorded so future runs (and reviewers) skip them. Each was verified against the source at
least once; re-open only if the stated reason no longer holds.

- **Giving `verify` and `restore` a shared "deliberate ≠ fault" implementation** (was open
  candidate **H**, eleventh pass) — **rejected 2026-08-07** after reading both sides, in the
  session that had just refactored `verifySet`. The candidate's premise was that the rule is
  *"implemented in two shapes with no shared name."* **It has a name.**
  [CONTEXT.md](../CONTEXT.md)'s **Deletion record** entry defines the distinction, coins
  **expected-missing** *(context, exit 0)*, and names all four consumers in one sentence, with
  [ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) as the decision of record —
  cited at both code sites. The vocabulary was never missing; only a *function* was, and the code
  doesn't want one:
  - **The shapes have not converged, and a refactor moving them closer did not change that.** They
    differ on how absence is learned (set difference up front vs a failed GET), when the record map
    loads (eager parameter vs lazy `??=`, so restore's happy path never pays), what they key on
    (path, one hash → N rows, vs dest file memoized per hash), sync vs async, and both output
    shapes. Strip those and the shared logic is `record ? deliberate : fault` — a ternary. Sharing
    it means parameterizing on all five, which is the injection reflex and a solution more complex
    than its problem (working rule #3).
  - **The drift risk it exists to close is already closed behaviourally.**
    `restore.missing-object.test.mjs` asserts *"reports a recorded absence as deleted-with-date,
    not missing, and exits 0"* and *"an unrecorded absence beside a recorded one still exits 1"*;
    `verify.test.mjs` asserts exit 1 on findings and untouched on clean. Changing the rule on one
    side alone goes red.
  - Re-open only if a **third** consumer needs the same decision *in the same shape* — at which
    point it is a rule with three call sites, not a coincidence with two. Note this is a different
    thing from the "three shapes of the deletion-record lookup" rejection below, which turns on
    consumers asking *distinct* questions; that one stands on its own reasoning and the two must
    not be merged.
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

> **Capped to the last three passes.** Earlier entries (2026-06-23 first pass through
> 2026-07-14) recorded landings that are already of record in their ADRs, PRs and `git log`,
> and re-verification notes superseded by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

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
- **2026-07-30 — tenth-pass C landed** ([PR #247](https://github.com/allens/s3cab/pull/247)).
  `putText` builds its params with `putObjectParams` instead
  of re-typing `parseS3Uri` + `awsOnlyPutParams()` + `IfNoneMatch: "*"`, and both uploaders' 412
  catch now reads through `isPreconditionFailed` — the predicate twin `isObjectNotFound` already
  modelled. `awsOnlyPutParams`' doc claim (the gating "lives in one place") is true rather than
  half-true, and it is now reachable *only* through `putObjectParams`. **No mechanism and no round
  trip changed**, so the abutting `putFile` no-clobber rejection stands untouched — and so the only
  genuinely red-first test was the new predicate's (an unresolved export). What the refactor
  actually needed was coverage that `putText` *goes through* `putObjectParams`, since that routing
  is what makes it inherit the params suites: two fake-S3 cases pin the wire request carrying the
  conditional flag and a 412 reading as "already claimed", plus one pinning that an
  **unconditional** 412 still throws (the `noClobber &&` gate the shared predicate could tempt
  someone to drop). Behaviour-preservation verified against the real bucket —
  `npm run test:integration` green, where the set-marker suite's "first writer wins, the second
  loses" case *is* this path live.
- **2026-07-30 — A landed** ([PR #248](https://github.com/allens/s3cab/pull/248), grilled in-session
  with the decisions recorded in the entry first, then built red-first in four commits). *Give every
  hash-then-PUT path the confirmation guard*: `uploadDir` never joined the shared PUT loop — it
  predated it ([#227](https://github.com/allens/s3cab/pull/227) before
  [#245](https://github.com/allens/s3cab/pull/245)) — so `upload --dir` had ADR-0069's
  hash-then-PUT window with **no guard at all**, storing a file edited in that window under its
  *previous* content's hash and corrupting that object for every path that dedups to it. **The red
  run was the proof**: the corruption test asserted the stale hash was never written and failed
  before the fix, with drift reproduced through the real mechanism (genuine props for the bytes
  hashed, then the file edited) rather than by faking props. `uploadDir` is now a lazy row source
  (a unit asserts the hash→PUT interleave, so a multi-GB seed still can't hash the subtree up
  front); `upload --file` got the **guard but not the loop** (`--force` means deliberate overwrite,
  `--bucket` has no set) with its own plain-`Error` factory. **A masking defect fell out of the
  unification and was fixed too:** the outcome's single first-wins `failure` slot let an early drift
  hide a later dropped connection, so `result()` now returns `{ drifted, failure }` — drift as
  *plural per-file data*, transport failure as *singular and terminal*, checked first — which also
  let `uploadObjects` drop its `set` parameter (`{ bucket, stored }`), since the caller now builds
  the message. Being plural, drift also earned `backup` a count line (one drifting file is bad luck,
  forty means the set points at a live directory). ADR-0069 amended rather than replaced (no new
  trade-off, a refined interface). Copilot found one real defect — the seed's skip header said
  "changed while being read" while the per-file reason printed `(removed)` two lines below, a
  regression introduced when the layout was restructured; fixed reason-neutral, and its
  low-confidence flag under-rated it, since one pinned test asserted "changed" about an
  `unreadable` fixture. Naming footnote: `drifted` was challenged as borrowed CloudFormation
  jargon and **kept** — it never reaches user text in this sense, and ADR-0012 governs user prose,
  not code identifiers; no CONTEXT.md term for the same reason.
- **2026-07-30 — D landed** (grilled in-session before any code, with each decision put to the user
  one at a time). *Name the bucket's unreadable snapshots.* The grilling moved the entry twice.
  **First, the shape shrank:** no consumer of the flattened list ever read `reason` — all four
  display sites joined `set/snapshot` and dropped it, and the only `reason` anyone prints is
  `verify`'s, from the *per-set* list. With `reason` gone the shared thing is just an identifier,
  so it became **`string[]` of `set/snapshot` names**: one function now does the flatten *and* the
  qualification, which collapsed all ten copies (three `flatMap`s, three inline typedefs, four
  joins) rather than merely naming them. **Second, the home turned out to be a fourth option.**
  The entry offered remote.mjs / verify.mjs / error.mjs; the real finding was that `verify.mjs`
  was two modules glued together — the verify command's planner, and the enumeration's
  *vocabulary* — with `isCorruptSnapshotError` living there while its **only** caller was
  remote.mjs. The obvious correction (move it to its producer) is barred by purity: remote.mjs
  reaches `@aws-sdk/client-s3`, and cleanup.mjs imports **nothing** at runtime. Hence
  **ADR-0074** and a zero-import `lib/referenced.mjs`; the `remote.mjs → verify.mjs` edge is gone.
  **The wording half grew, on the user's push, and found two defects.** `forget`'s caveat printed
  a bare `s3cab verify` — but `verify` takes a *required* bucket, so the fix **failed if pasted**,
  the dead-end ADR-0030 forbids (`formatUnrestorableSummary` was never handed the bucket, though
  `set.bucket` sat at the call site). And `delete`'s abort and its dry-run warning were two
  different sentences for one command's one condition; they are now the **same text**, built once.
  Also cut: "snapshots won't read" (garden-paths — the snapshots read nothing), "Triage first"
  (jargon by ADR-0030's own test, and it had entered the product *only* through these messages),
  and the count, which dodged candidate B's pluralization entirely. Naming footnote, and it went
  the opposite way to A's: `set/snapshot` **is** user-facing, so ADR-0012 applies — but what was
  new is a *notation*, not a concept, and Snapshot/Backup set/Namespace already exist. So **no new
  CONTEXT.md headword**; a line on the existing **Snapshot** entry instead, recording the list form
  and that a single snapshot named in a sentence stays prose.
- **2026-07-30 — B landed** (grilled in-session before any code, each decision put to the user one
  at a time). *One count, one plural, one aligned-total table.* **B was two candidates and split
  cleanly into three commits.** The count half was mechanical — [#246](https://github.com/allens/s3cab/pull/246)
  had already settled a count formatter's home by precedent, so render.mjs's private `count` and
  six inline `toLocaleString("en")` simply routed through `formatCount`; that spelling is now
  absent from `src/` entirely. **The plural half is where the entry was wrong, and re-verifying
  is what found it.** Every line number in the entry predated #250/#252, but the claims held; a
  full sweep then found **five** unnamed sites rather than the four the last note claimed — the
  fifth, `forget.mjs`'s `Snapshot 'a' is`/`Snapshots 'a', 'b' are`, being the most irregular of
  the lot. **The reframe that decided it:** the leftovers are *clause agreement, not noun
  morphology*, so the entry's three options were the wrong three — a "small irregular table" would
  hold exactly one word (`directory`), and a two-form `plural(n, one, many)` reads no shorter than
  the ternary it replaces while still failing the clause cases. So `plural` was exported
  **regular-only** and nine sites routed; the six irregular ones stay hand-rolled *by decision*,
  with the reasoning on the export rather than in this file, because that is where someone about
  to "finish the job" will look. A combined `countOf(n, word)` was considered and **declined**:
  render.mjs has four sites where the pair does not hold — three passing a raw number, one with
  no count, and upload's summary pairing `count(uploaded)` with `plural(candidates)`, two different
  `n`. The accepted cost is three files keeping a byte-identical one-line `files` alias.
  **The table half survived its own grilling, but the entry's two arguments against it were
  answered rather than overridden.** Sharing is safe because the cells arrive **already
  formatted**: the caller keeps which rows, what they are called, which noun they count in, and
  delete's stored-object suffix, handing over only padding arithmetic that was never either
  command's decision. And `format.mjs` — not render.mjs, whose sibling summaries these are —
  because both previews print *before* the command returns and never pass through the render
  layer; format.mjs already owned `formatByteValue`/`formatCount`, which both tables call.
  Output is byte-identical throughout, including two sites where the "s" had to move to the end of
  a noun phrase (`stored object` → `stored objects`). **A coverage gap turned up while checking
  that claim:** both summaries' existing tests pin the rendered rows but spell the gaps ` +`, so
  they would pass through a change in *alignment* — the new `alignTotalTable` case pins the padding
  exactly, with its expected lines generated from the function rather than hand-counted. One
  pre-existing oddity was **deliberately preserved, not fixed**: a table whose only row is the
  total still emits a rule with nothing above it, exactly as the popped-total code did.
- **2026-08-06 — eleventh pass.** The open list had sat empty since 2026-07-30, so this pass
  explored the **27 PRs since** (#249–#275) at HEAD `4221fad` — the first architecture read of the
  snapshot-format work (ADR-0071/0072/0073), the walk rewrite (ADR-0077), the progress rework
  (ADR-0076), resolve-time credential expiry (ADR-0075) and `lib/referenced.mjs` (ADR-0074). Run
  as **three background Explore sweeps** (snapshot engine / walk+progress+output /
  credentials+upload+removal), each primed with the standing rejections below, plus an inline read
  of the slice none of them covered (`s3cab.mjs`, restore, setup/reattach, `aws`, `set-marker`,
  `error`, `prompt`, the test layout). **Every load-bearing claim was re-verified against source
  before it was recorded** — which mattered: the sweeps' line anchors and counts were checked one
  by one, and the two strongest findings were each confirmed by reading the code rather than the
  report. **Nine candidates recorded above (A–I)** plus seven smaller verified items. The standout
  — **A**, found *independently by two of the three sweeps* from different directions — is the
  only one with a live behaviour fault behind it: the walk's progress line freezes on
  `readdirSync`, on the `lstat` fallback, and while descending a subtree it keeps nothing from,
  which is exactly what ADR-0076 §3 ruled against. Runner-up **B** (an aged-out Roles Anywhere
  certificate prints an HTTP body where every sibling failure prints the fix). Two findings are
  about **test surface rather than duplication** (F, G) — the pattern this pass kept hitting is a
  pure function extracted for testability with the bug surface left on the other side. **The
  rejected/parked list was re-checked and stands untouched**; H deliberately abuts the
  "three shapes of the deletion-record lookup" rejection and the entry says so — they must not be
  conflated. Planned as three tracks by file overlap: **track 1 sequential C → A → F**
  (`snapshot.mjs`/`progress.mjs`/the two porcelain commands), **track 2 D → H** (they share
  `src/lib/verify.mjs`), **track 3 singles** (B, E, G, I + the smalls). Noted en route: this machine has no
  `.env.test`, so `npm run test:integration` can't reach a real bucket here — tracks 1 and 2 are
  pure or local and verify fully, but **B leans on CI**. Overwrote the HTML report in place.
- **2026-08-06 — A landed** ([PR #277](https://github.com/allens/s3cab/pull/277), grilled
  in-session to an empty frontier before any code, then built in four commits). *A counted pass,
  drawn on a clock `progress.mjs` owns.* `countedPass(stream, label, () => count)` now holds the
  shape both callers were re-typing, and the walk's line can no longer freeze when the walk does.
  The reasoning is in
  [ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s amendment (amended, not
  replaced — no new trade-off, a refined interface, the same call the tenth pass made on
  ADR-0069), so it is not repeated here. **What is worth keeping is where the grilling and the
  verification changed the shape.**
  - **`done()` exists because of an abort path nobody had looked at.** The plan was an interface
    the caller never touches again — construction paints, the timer redraws, disposal draws the
    tally. Checking the throw paths killed it: the walk aborts mid-loop on a duplicate path and
    the store LIST can fail, and neither writes a tally today, so a dispose-drawn tally would have
    printed `… 1,204 in 3 secs` directly above the error saying the pass failed.
    `Symbol.dispose` gets no signal that it is unwinding, so the caller has to say.
  - **The `s3.mjs` "third leak" was not one, and counting it would have been the error.** The
    pass's own report called `s3.mjs:720`'s `isInteractive` a third copy of the gate. Reading it
    showed a *different* question — "was a bar drawn, so should I log a line instead?" — which
    `progress.mjs` answers internally (`drawn`) but does not expose. Left out by name in both the
    module header and the ADR, so the omission reads as known. Still open, still its own decision.
  - **Copilot found a real defect, and it inverted a claim this file had made.** `update`'s
    argument is built before `update` can decline it, so off a terminal the tick composed an
    `Intl`+Temporal line once a second and threw it away for the whole pass. Gated on `due()` —
    and note what that does to the entry's note that `due()` would drop to one production caller:
    **false**. The gate moved *out* of the callers' per-item loops and *into* the tick, so it is
    now asked once a second in one place rather than per file in two. `restore.mjs:222` is its
    second caller, not its only one.
  - **The freeze was hand-verified in two halves, and the entry should not pretend otherwise.** A
    402,000-file tree under a pty (400,000 excluded) showed the count jump straight from the bare
    label to 2,000, confirming the excluded descent yields nothing; separately, a pass whose
    caller only sleeps advanced `0 in 1 sec` → `0 in 2 sec` → tally. No tree on this machine walks
    slowly enough to show both at once — the Windows-drive mount takes 90 s to *create* 7,400
    files but reads them fast. The durable assertions are at `countedPass`'s own interface
    (`mock.timers` over `setInterval` alone, so a short real sleep still clears the pacing gate),
    each verified red by mutation.
  - **A visible behaviour change, accepted deliberately:** the walk's line redraws once a second
    rather than up to ten times, and during a long yield-free stretch it now reads `… 0 in 12
    secs`, where the bare-label rule avoids a zero at t=0. Judged not in conflict — a zero at t=0
    is noise, a zero twelve seconds in is information — and confirmed with the user.
  - **`npm run test:integration` did not run** (no `.env.test`; ADR-0049 hard-failed, as designed),
    and the `upload` commit deletes a `try`/`finally` around a `for await` over the `objects/`
    LIST. Stated in the PR body rather than passed over: CI was the authority on that one.
- **2026-08-07 — D landed.** *`referenced.mjs` answers the two questions its `sizes` Set exists
  to pose.* `safeSize(object)` and `sizeDisagreements(object, storedSize)` now hold the
  derivations that four planners were walking by hand; the module stays zero-import, so
  [ADR-0074](../docs/adr/0074-referenced-enumeration-vocabulary-module.md) is *applied*, not
  strained, and no ADR was needed — 0074 already decided where this kind of thing lives.
  - **The candidate said "four planners, the same two questions"; the code said two pairs.** Each
    derivation had exactly two callers, and within a pair the two wanted *different shapes*:
    `lib/unrestorable.mjs` takes the max over one object, `lib/delete.mjs` accumulates it across
    sets (fine — max is associative); `lib/verify.mjs` needs every disagreeing *(path, size)* to
    build a row, `lib/cleanup.mjs` needs only a boolean. So the honest interface was one function
    per *question*, not one per call site, with the boolean caller testing `.length` — not a
    predicate plus a lister, which would have been four exports for four callers and no
    consolidation at all.
  - **The refactor found a real (if harmless) inefficiency in `verify`.** `storedSize === undefined`
    is a property of the *hash*, but the old loop re-tested it at every path of every object.
    Extracting the disagreement walk hoisted the check up one level, where it reads as what it is:
    nothing stored → every path is a finding and none has a size to disagree with.
  - **Verified by mutation, not just by green.** The whole suite passes untouched before and
    after — correct for a pure refactor, and exactly why it proves nothing about the new code.
    `Math.max` → `Math.min` in `safeSize` was confirmed to fail the new "largest across paths"
    case before the tests were trusted.
- **2026-09-04 — twelfth pass.** Explored the **35 `src/` commits since `4221fad`** (81 files,
  +9677/−2298) at HEAD `a4e0c9d` — the first architecture read of ADR-0077–0090, chiefly the
  `find` → hash-operand `delete` pair (0088/0089/0090), the `#END` trailer (0082), the
  streamed-digest upload guard (0083) and the ctime cross-check (0085). Three background sweeps
  (find/delete/removal; render/upload/restore/auth; the deletion-record and enumeration slice) plus
  an inline read of what they left uncovered; every load-bearing claim in **A–D** re-verified
  against source directly before being written down. Twelve candidates recorded above. Top pick:
  **A**. Overwrote the HTML report in place.
  - **Re-verifying the carried-forward list was the highest-value part of the pass, and it is the
    part a run is most tempted to skip.** Of six entries carried from the eleventh pass, **three
    were dead** and **one had the wrong mechanism**. I (`formatCount`) was closed by `e4f4a34`;
    F's main claim was closed by assertions at `backup.fused.test.mjs:152,184-187`; `snapshotName`
    was deleted in `0060b61`; and B's "the request-time relay can't catch it either — `createSession`
    never passes `s3.mjs`" was simply false. The relay **is** on the stack; the real fault is
    narrower and more interesting (every `requestErrorTable` row keys on `name`/errno, and RA throws
    plain `Error`s). A sweep also self-corrected mid-report, first calling ADR-0086's restore
    collision rule untested and then finding it covered at `model.hostile.test.mjs:317-368`.
    **Recorded strength tags rot faster than line anchors** — three of the four dead entries were
    filed *Strong*.
  - **The one live behaviour fault this pass came from a doc comment being right.**
    `isWindowsPath`'s JSDoc says it answers the *case* question and deliberately excludes UNC;
    `find.mjs`'s `prepare` uses it for the *separator* question. Nothing was wrong inside either
    module — the fault is entirely in the join, which is why no unit test could have caught it and
    why `path-match.mjs` has no test file at all. Worth generalizing: **a predicate whose doc has
    to explain which question it answers is a predicate two callers will answer differently.**
  - **Two findings that only exist because the project wrote its own rule down.** D is a finding
    solely because `test/model/CAPABILITIES.md` states the prime rule for fakes, so the nine
    undeclared adapters in `src/` are measurably out of line rather than merely untidy; B is a
    finding solely because `localMoment`'s doc states the invariant the `#END` trailer breaks. A
    codebase that records its invariants in prose gets reviewed against them.
- **2026-09-05 — I landed.** `onHashStart` now has a driving test:
  `file-props.test.mjs`'s `"reports onHashStart once, only on the streaming path"` proves it fires
  exactly once, with the right `path`/`size`/`startedAt`, only on the ≥5MB streaming path — and
  never on the small-file slurp path. No interface change; the eleventh pass's own rationale for
  `onHashStart`'s existence stands, so this closes the untested-surface gap rather than removing it.
- **2026-09-05 — J landed.** `s3cab.mjs`'s exit-code decision is now a pure, directly-tested
  function: `exitCodeFor` (`lib/error.mjs`) returns `EXIT_INTERRUPTED` (130) for an
  `InterruptedError`, 2 for an input error, 1 otherwise, and `s3cab.mjs`'s top-level `catch` sets
  `process.exitCode` from it once instead of branching it inline. `error.test.mjs` asserts all three
  cases directly, closing the hole: no test anywhere previously asserted the exit-130 promise
  ADR-0067 makes.
- **2026-09-05 — K landed.** `render.mjs` gained a shared `section()` helper — label, entries,
  colour, `paint`, per-entry formatter in; heading + joined body out — and `addedSection`,
  `fromToSection`, `pathSection`, `errorSection` and `skippedSection` all delegate to it instead of
  re-typing the heading/count/join grammar five times. Output is byte-identical (full
  `render.test.mjs` suite unchanged and passing); same move pass 11 made for `progress.mjs`.
- **2026-09-05 — G landed** (grilled in-session, both directions argued before any code).
  *Fold the delete operand grammar back into its one caller.* `lib/delete.mjs` and its test are
  deleted; `collectHashes` and `EMPTY_FILE_HASH` are private to
  [commands/delete.mjs](../src/commands/delete.mjs). The rule earned an amendment to
  [ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md) rather than a new ADR: 0023
  already carried the *outward* half (an exported internal two commands pull on is a `lib/`
  primitive that hasn't moved), and this is its silent inverse — **a pure helper with one
  production caller is not a `lib/` primitive either**, with the one-export rule making it
  concrete (a *test* reaching for a private helper is the signal it has become shared).
  - **Moving the rules down was argued and lost on the ADRs, not on taste.** The widest honest
    version — a `planDeletion` owning operands → preflight → `{ found, missing, rejected }` —
    doesn't close the split, it relocates it: the rejection wording, the empty-file refusal and
    the no-hashes-at-all error are user-facing text ADR-0011/0030 keep in the command, so the
    plan would still hand `rejected` back up for the command to re-decide on. A wider interface
    around the same seam, wrapped over an 8-line loop calling an existing `lib/` primitive — and
    it would drag `storedObjectSize` into a module that is currently I/O-free.
  - **The deletion test found a duplication the candidate hadn't seen.** The one genuinely shared
    rule inside `collectHashes` — trim, drop `#` comments (even indented), drop blanks — *is*
    `read-lines.mjs`'s `parseLines`, three callers old and re-implemented by hand rather than
    imported. So the fold is net −70 lines and the private helper is ~20, not 50. **The
    lib-vs-command question was the wrong first question**: asking which *existing* primitive the
    helper should have used answered it better than asking where the helper belonged.
  - **The migration made one test stronger and one weaker, both on purpose.** Eight pure-function
    cases became assertions on `deleteHashes`' observable outcome (four were already in that
    form), which is CLAUDE.md's "assert about the result" — "a coloured `find` file errors
    loudly" is a truer statement of ADR-0088's contract than "the `rejected` array has two
    entries". The price, stated rather than glossed: those cases now run behind four module
    mocks, so a grammar regression localizes less sharply. The empty-file-hash pin now *derives*
    the digest (`createHash("sha256").update("")`) instead of comparing two hand-typed 64-char
    strings in the same file, which proved only that someone copied it twice.
  - **A stale claim fell out en route.** [referenced.mjs](../src/lib/referenced.mjs)'s header named
    `delete.mjs` as one of three pure planners consuming the enumeration; ADR-0089 had removed
    that consumption a pass earlier. It is `cleanup`/`unrestorable`/`verify`. Fixed as its own
    commit. The entry's own "referenced-check" wording was the same stale fact — the command's
    preflight is a per-hash `HeadObject`.
  - `npm run test:integration` ran green (26 pass) though the change is off the S3 path — cheap,
    and `delete` is the one command where being wrong is unrecoverable.
- **2026-09-05 — C landed** ([PR #331](https://github.com/allens/s3cab/pull/331), grilled
  in-session before any code, one decision at a time; the record is
  [ADR-0075](../docs/adr/0075-resolve-time-credential-expiry.md)'s amendment). *The Roles
  Anywhere exchange gets the set-scoped frame; the line to the relay is drawn by type.*
  - **The corrected mechanism changed the shape.** The relay is on the stack —
    `resolveCredentials` runs inside the SDK's `initialize` step, which the relay wraps — so a
    socket error with an errno *already* got the network retry, and the naive fix (catch
    everything in the RA branch) would have taken that away. Hence the three options grilled:
    (A) move the RA branch inside the existing `try` (wraps the socket error too — rejected);
    (B) give `requestErrorTable` RA rows (the relay is keyed on `name`, and the table is 0037's
    request-time contract — rejected as the "mushy middle"); (C) translate at resolve time in
    RA's own catch, keyed on a new `RolesAnywhereSessionError` thrown at the endpoint's own
    boundary — chosen. The relay is untouched.
  - **The readiness gate moved to the module both doors share.** `setup` refused a set without an
    identity, `provider` did not; `gatherProviderConfig` now does, so a marker is never written
    for an identity that fails the next cloud op. `provider`'s `Scope` gained the set's bucket so
    the recipe is spelled for it. The three-command recipe was in three places and is now one
    export, `setupSteps`; the stack name it prints mirrors `lib/aws.mjs`'s `stackName` rather
    than importing it (aws → s3 → auth → roles-anywhere would be a cycle).
  - **`resolveCredentials` now has a test file** — `auth.resolve.test.mjs` fakes `node:https`
    (the timeout test's pattern) under a real temp identity and a `loadSet`-loaded set, so all
    four paths are asserted through the real signer: absent identity, refused session,
    credential-less 2xx, and a socket error rethrown *identical*. One live case in the RA
    integration suite mis-regions the identity to provoke the real 403.
  - **Two things the grilling surfaced that the candidate did not.** The expiry message-match
    (0075's one prose test) would fire on a refusal mentioning an expired *certificate* and
    answer with `aws sso login`, so it is bypassed in RA mode. And the generated RA template
    creates the bucket, which fails against a bucket that exists — the test-bucket recipe in
    docs/integration-testing.md now says how to strip it.
- **2026-09-05 — E landed** ([PR #330](https://github.com/allens/s3cab/pull/330), grilled
  in-session before any code). *Take the snapshot baseline as one optional record, not three
  options.* `generateSnapshot` now takes `baseline?: SnapshotBaseline` — `readBaseline`'s own
  return type, reused as-is rather than narrowed — and destructures `lookups`/`sizes`/
  `previousInstant` from it internally; both call sites (`backup.mjs`, `snapshot.mjs`) pass the
  whole object through instead of picking it apart and renaming it by hand. The
  `backup.test.mjs` assertions pinning the old three-field shape are replaced by one assertion
  that the whole `baseline` object is forwarded. Also fixed: the reversed doc comment at
  `commands/snapshot.mjs`, which claimed the previous snapshot's parse was handed to `compare`
  only on a non-`--rehash` run — it is handed through unconditionally, since only the hash
  *lookup* is rehash-gated. Does not reopen ADR-0069. The dead `since` ternary in
  `commands/snapshot.mjs` was **not** simplified as the entry suggested: `previous && previousName`
  is load-bearing for TypeScript's narrowing of `entries: SnapshotEntries | undefined`, so
  dropping the `previous &&` half fails typecheck — confirmed by trying it. **Still open, not
  part of this candidate's scope:** `commands/find.mjs`:12–15 still calls ADR-0089 "a
  settled-but-unbuilt rework" pointing at a deleted `proposals/hash-operand-delete.md`; a
  one-line fix, noted here so it isn't lost. CI's `test (windows-latest)` failed on the initial
  run with the pre-existing `snapshot.test.mjs:391` ctime-cross-check flake (confirmed identical
  on an unrelated dependabot PR with zero code changes); re-run went green. Filed as an open
  entry in [bugs.md](bugs.md).
- **2026-09-05 — A landed** ([PR #334](https://github.com/allens/s3cab/pull/334), grilled
  in-session, four decisions; the record is
  [ADR-0088](../docs/adr/0088-find-matches-like-posix-find.md)'s amendment). *Answer the
  path-spelling question once, in `path-match.mjs`.* `preparePath(path)` returns
  `{ path, base, foldCase }` with the three root shapes decided inside; `isWindowsPath` is now
  `foldsCase` and is true for a UNC root too. `find.mjs` lost its `prepare`; `restore.mjs` only
  renamed its import. `path-match.mjs` has its first test file.
  - **The interface question was really the UNC-case question.** Making one function answer both
    spellings forced a decision the old split had let each caller dodge: does a UNC path fold
    case? Yes — it only ever originates from a Windows client, and it is what a mapped drive
    resolves to (libuv's realpath rewrites `\\?\UNC\…` to `\\server\share`), so it is every NAS
    backup, and an exact-case miss there is a guess lost right before a `delete`. That reasoning
    is in the ADR, not the code, on purpose.
  - **The pattern side stayed keyed on `process.platform`**, unchanged: the pattern is typed at
    this shell, the path came out of a snapshot possibly from another OS. A Windows-typed
    `\\nas\photos\` pattern floats onto the `/`-normalized path through the implicit `**/`.
  - **Follow-up, taken 2026-09-06** ([PR #337](https://github.com/allens/s3cab/pull/337)).
    `reroot` in [restore.mjs](../src/lib/restore.mjs) now takes `preparePath`'s answer instead of
    its own `dir.split(/[\\/]/)`, so a POSIX filename containing a literal backslash stays one
    segment. Copilot's review caught a regression the fix introduced: `preparePath`'s own `base`
    is empty for a `#DIR` header with a trailing separator, so `reroot`'s basename is derived from
    the trimmed `segments` array instead (as it always was), not from `preparePath`'s `base`
    field. Both cases are red-first tests in `restore.test.mjs`.
  - **First CI run on the merge commit failed on `windows-latest`** in
    `snapshot.test.mjs`'s *"keeps them when the interrupted run's own read moved every ctime"* —
    the parked-hashes resume asserted the sentinel and got five real hashes — and passed on
    re-run with no code change. Not this PR's files; it is the ctime/rounding area **B** already
    names (`parkSentinelHashes` respells the rule by hand). One flake is a data point for B, not
    a finding.
- **2026-09-05 — D landed** ([PR #335](https://github.com/allens/s3cab/pull/335), grilled
  in-session over three rounds before any code; the record is
  [ADR-0019](../docs/adr/0019-s3-test-strategy.md)'s amendment). *One stencil for the nine
  unit-tier `s3.mjs` fakes, with defaults that stay honest.* Ten commits: the helper
  ([test/helpers/s3-seam.mjs](../test/helpers/s3-seam.mjs)) and its coverage test first,
  reviewable on their own terms, then one adapter each — the copy-pasted backup pair first,
  thinnest-gain last. All nine anchors in the open entry were still exact at `49b66f2`.
  - **The shape decision was the asymmetry, and it is what earned the ADR.** Reads default to an
    empty store (falsifiable — a test expecting content gets none and fails); writes default to a
    throw, because there is no truthful zero state for a PUT and a silent
    `putFile: async () => true` is the one default that can make *broken production code* pass,
    ADR-0083's guard being inside `putFile`. Three shapes were argued: throw for everything (the
    purest reading, but it keeps the never-called stubs as explicit noise at every site, which is
    most of what the candidate was about), benign no-ops throughout (the god-fake the entry ruled
    out), and the split that won.
  - **The throwing default paid for itself immediately, on the first file migrated.** `backup`
    refreshes the set's cloud config on the way out — `pushSetConfig`'s PUT of `dirs.txt` plus the
    DELETE clearing a stale remote `exclude.txt` — and only *warns* when that fails. Both backup
    fakes stubbed those to succeed, so the suites had been silently exercising the success branch;
    with the stub gone, all six `backup.fused` tests moved onto the warning path and said so. Now
    modelled explicitly, with the reason at the site. A second, smaller find: `restore.counts`'
    `isObjectNotFound: () => false` was the one deliberate divergence among the nine and had no
    effect (that file mocks `getObject` to `assert.fail`, so nothing reaches restore's catch).
  - **Staleness is answered by a check, not by breadth.** The stencil covers exactly the nine
    exports production imports; [test/s3-seam.test.mjs](../test/s3-seam.test.mjs) asserts set
    equality both directions, so it sheds a method nothing imports any more as readily as it
    gains one, and a second case counts every mention of `s3.mjs` in `src/` against the ones its
    regex could read — so a namespace, default or dynamic import fails loudly rather than leaving
    the first check silently blind. It lives at `test/` rather than beside the helper because
    `npm test`'s `test/*.test.mjs` glob is deliberately shallow, which is what lets `helpers/`
    hold non-test `.mjs`; widening it would undo that to buy locality for one file.
  - **Typed against the real module** (`Pick<typeof import("…/s3.mjs"), …>`), so a default whose
    signature drifts from production's fails `typecheck` naming the method instead of at runtime
    in whichever test happens to call it. A hand-written typedef would have been a tenth copy of
    the thing being deleted.
  - **Two narrowings were considered and declined**, both for the same reason — they would let the
    god-fake back in by the side door. A named `acceptsWrites()` preset (one import away from
    being the default again; `backup.online-only`'s `putFile: async () => true` instead survives
    as a *visible local claim* by a file whose subject is the run report, not the transfer), and
    a built-in call recorder (what each test records differs in shape and in what it proves —
    `upload.test.mjs`' `callOrder` interleaves `hash:`/`put:` events to prove lazy row
    production, which nothing generic produces).
  - 75 lines of stencil deleted; the three hand-copied `isObjectNotFound` spellings and the
    duplicated ADR-0084 comment collapse to one each. **Every test still asserts what it
    asserted** — 1098/1087 pass against `main`'s 1096/1086, the deltas being the two new tests
    plus the e2e `dist/s3cab.exe` case, which skips only because a fresh worktree has no build.
    Integration suite not run: no production code changed.
- **2026-09-06 — F landed** (grilled in-session, seven decisions in one round; no ADR — the
  ordering was already decided in ADR-0064/0090 and docs/design/repository-protocol.md, this only
  moves it from prose into a function). *One module owns "scan the bucket safely".*
  `scanBucket(bucket)` in [bucket-scan.mjs](../src/lib/bucket-scan.mjs) reads every snapshot,
  LISTs `objects/`, then reads the deletion records, and returns
  `{ referencedBySet, stored, deleted }`; `verify` and `cleanup` each replace three reads with one
  destructure. `stored` carries `{ size, lastModified }` for both consumers, so `verifySet`'s
  parameter widened to match rather than have the command reshape a map for it. The read-side
  twin of `upload.mjs`, and named so in both headers.
  - **The entry's anchors were half dead, and the live half was smaller than "four modules".**
    `src/lib/referenced.mjs` carries no ordering prose at all, and `src/commands/delete.mjs` has
    had no bucket scan since ADR-0089 — its "record-first" is the *write-side* rule the read-side
    ordering relies on, not a copy of it. What was real: two scan sites (`verify.mjs`,
    `cleanup.mjs`), one caller-obligation paragraph on `referencedObjects`, and the design docs.
    `forget` reads snapshots alone, with no objects LIST, so it stays a direct `referencedObjects`
    caller and the export stays.
  - **One half of the rule was already enforced, and the entry did not know.**
    [test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs)'s *"cleanup vs forget is
    safe"* parks the real binary between reads 1 and 2 against a live bucket. It pins
    cleanup's snapshots-before-objects half only; nothing pinned verify, or the records-last
    third step, or that the *next* command would inherit the order.
  - **The test is at the `s3.mjs` seam, not at the three lib modules.** Faking
    `remote`/`objects`/`deletion-record` would prove the module calls three functions in a row;
    faking `s3.mjs` (D's stencil, first use outside its migration) proves the LIST requests the
    bucket sees arrive `snapshots/` → `objects/` → `objects.deleted-`. A held snapshot GET proves
    the objects LIST has not *begun* while a snapshot read is in flight — the half a call-order
    assertion cannot see, since two awaits started back to back would list in order and still
    race. Verified red by mutation: moving the snapshot read last fails three of the four cases.
    The two command suites now mock `bucket-scan.mjs` alone, which deleted their per-module
    `referencedObjects`/`listStoredObjects`/`readDeletionRecords` stubs.
  - **`upload.mjs`'s `storedHashes` reads deletion records too, and was left alone on purpose.**
    It is the write side's own baseline (records only on the trusted-baseline branch, ADR-0090)
    and a different question; folding it in would have given the scan a caller with a third
    shape and no ordering need.
  - Prose shrank to pointers: `referencedObjects`' obligation paragraph, `listStoredObjects`'
    consumer list and both design docs now name `scanBucket` and its test as where the order is
    held, instead of restating the three steps.
- **2026-09-06 — B landed** ([PR #338](https://github.com/allens/s3cab/pull/338), grilled
  in-session over five rounds before any code, one decision per round; the record is the module
  doc at the top of [format.mjs](../src/lib/format.mjs), which now names itself the clock seam).
  *Mint the `#END` completion instant inside the clock seam.* `format.mjs` gained a private
  `readClock` behind both recorded-instant reads and a new `completionInstant` export (the
  trailer's rounded-up spelling, with ADR-0085's argument moved from `endLine`); `endLine` calls
  it; the harness `VirtualClock` gained the twin and `seam.mjs` routes it; a new
  [test/model/model.clock.test.mjs](../test/model/model.clock.test.mjs) pins CREATED, `#SNAPSHOT`
  and `#END` to the virtual clock.
  - **Re-verification corrected the entry twice.** Not "routing, not new interface":
    `localMoment` returns a *name* and truncates, and the trailer needs an instant rounded *up*,
    so a second export was the honest shape (Q1). And not three workarounds but four — plus a
    fifth off-seam read the entry missed, `setup.mjs`'s `nowStamp`, which made a set marker's
    CREATED real time under the harness. It rode along in its own commit (Q4).
  - **The windows-latest flake is root-caused and gone, and it was the entry's own evidence.**
    Run [33995666567](https://github.com/allens/s3cab/actions/runs/33995666567) on the merge
    commit of A: all five parked hashes distrusted. `parkSentinelHashes` re-stamped the parked
    trailer with a real-clock read microseconds after `utimes` had moved real ctimes, and the
    kernel's clock and V8's do not agree at the millisecond — a ctime stamped by one read as
    later than an instant read by the other, even after the round-up. The re-stamp existed only
    because the trailer could not be pinned. Now the parked-hash tests pin the clock *relative to
    real time* in whole minutes and tick it to either side of the real ctimes, so the two clocks
    are never asked to agree to the millisecond; the resume-state test parks a real second run
    instead of copying a stale one (Q3). The `bugs.md` entry filed by E is closed.
  - **Accepted consequence in the model tier, no ADR edit (Q2).** Virtual `#END` instants
    (2026-01-05 plus minutes) sit years before the fixtures' real ctimes, so the ctime guard now
    distrusts every reuse there. Harmless — the hashes are identical — and it makes ADR-0085's
    Consequences sentence true again instead of needing amendment.
  - **The rule lives in one place (Q5):** `format.mjs`'s module doc, not an ADR, not a CLAUDE.md
    bullet, not a lint — the seam trap it warns of (the mock spreads the real module, so a new
    clock export without a twin falls through to real time *silently*) is also in
    `harness/clock.mjs`'s header. `CAPABILITIES.md`'s `virtual-clock` now lists every recorded
    instant as steerable.
  - Red first on all four driving tests; 1118/1107 pass against `main`'s 1096/1086. The
    fusion-seam test now asserts byte-identical files rather than normalising the instant out.
