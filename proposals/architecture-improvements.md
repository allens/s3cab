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

Surfaced 2026-08-06 (eleventh pass) — the first architecture read of the **snapshot-format
work** (ADR-0071/0072/0073), the **walk rewrite** (ADR-0077), the **progress rework**
(ADR-0076), **resolve-time credential expiry** (ADR-0075) and **`lib/referenced.mjs`**
(ADR-0074): 27 PRs (#249–#275) since the open list was last emptied. Verified against the
source at HEAD `4221fad`. Verdict: the new work is deep where it was designed as a module and
thin where it was *wiring* — six of the nine candidates are a rule or a recipe that ended up in
the callers rather than behind an interface, and three of those are also **the places nothing
can test**.

**A landed 2026-08-06** ([PR #277](https://github.com/allens/s3cab/pull/277)); its entry is
retired to the run log below, its lasting knowledge now in
[ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s amendment. **B–I remain
open.** Track 1 continues **C → F**, both in the files #277 just touched.

**Picking these up cold (a later session, or another machine).** Everything needed is in this
file plus the ADRs — with three caveats worth stating rather than rediscovering.
(1) **Line anchors rot on every landing.** E's and F's were refreshed after #277 shifted
`walk.mjs` up ~21 lines and `progress.mjs` down ~22; the rest cite files #277 never touched.
Re-verify before trusting any of them — this file's own opening rule.
(2) **The three tracks are grouped by *file overlap*, not theme**, so they parallelize badly on
purpose: track 1 is strictly sequential (C → F share `snapshot.mjs`/`progress.mjs`), track 2 is
D → H (they share `verify.mjs`), and track 3 (B, E, G, I + the smaller items) is genuinely
independent — start there if two people are working at once.
(3) **`.env.test` is gitignored and does not travel.** Every candidate except **B** is pure or
local and verifies with `npm test` alone; B is the exception — it needs the gated suite *and* the
Roles Anywhere prerequisites, both now written up in
[docs/integration-testing.md](../docs/integration-testing.md). Do that setup before starting B,
not after.

- **B — Bring Roles Anywhere inside the credential-error family.** _Strong._
  `resolveCredentials` ([auth.mjs](../src/lib/auth.mjs) 531–534) returns from the RA branch
  *before* entering its `try`, so only the **absent identity** case is wrapped (auth.mjs:483–490).
  Every *runtime* `createSession` failure — expired certificate, 403 from STS, socket error,
  timeout — escapes raw from [roles-anywhere.mjs](../src/lib/roles-anywhere.mjs) 774–819. The
  request-time relay can't catch it either: `createSession` issues a raw `node:http` request, so
  it never passes `s3.mjs`. The asymmetry's cost is the wrong way round — the *once-per-machine*
  setup failure gets the polished five-line RA fix, the *recurring* one (a certificate that aged
  out) gets an HTTP status and a response body. `isExpiredSignIn` would very likely fire on that
  body and is never consulted. `resolveCredentials` is imported by **no** test.
  Completes 0075/0037's remedy table for the mode 0057 added.
- **C — `generateSnapshot` takes the baseline whole.** _Strong._ Three of its six options are
  `readBaseline`'s own fields renamed and re-threaded by hand, identically at **2 of 2** call
  sites: `lookup` (commands/snapshot.mjs:32, backup.mjs:81), `sizes: previous` (:36, :84),
  `previousInstant` (:38, :85). The `SnapshotBaseline` typedef marks all four fields optional
  ([snapshot.mjs](../src/lib/snapshot.mjs) 42–45) but `readBaseline` sets `previous`/`instant`
  **iff** it sets `name`, and the caller pays for the missing invariant with a dead branch —
  commands/snapshot.mjs:45–48's false arm can only ever evaluate to `undefined`. And
  backup.test.mjs:155–159 exists *solely* to stop a refactor dropping `sizes`: a test defending
  an interface against a mistake that interface invites. The guard is one-sided — deleting
  `sizes: previous` from commands/snapshot.mjs:36 fails zero tests. Both `sizes` and
  `previousInstant` post-date the last pass (#250, #259). Does **not** reopen ADR-0069: the
  `through` seam was re-examined this pass and is still clean.
- **D — Let `referenced.mjs` answer the questions its own shape implies.** _Strong._ The
  three-deep nest exists to preserve torn-snapshot size disagreement, but
  [referenced.mjs](../src/lib/referenced.mjs) exports nothing that touches it, so four planners
  walk it by hand and re-derive the same two questions. *Safe (largest) size before a destructive
  act*: delete.mjs:175–177 and unrestorable.mjs:164–166, near-verbatim rationale, independent
  code. *Does any recorded size disagree with storage*: verify.mjs:74–84 and cleanup.mjs:104–110.
  The nested walk is spelled four times; the `sizes`-is-a-Set rationale appears in five doc
  comments. Both derivations are arithmetic over a `Set`, so
  [ADR-0074](../docs/adr/0074-referenced-enumeration-vocabulary-module.md)'s zero-import property
  survives — this *applies* 0074 rather than straining it.
- **E — `compileExclude` owns only half the matching convention.** _Strong._
  [exclude.mjs](../src/lib/exclude.mjs) normalizes the *pattern* side and returns a bare
  `RegExp`, then documents in prose three obligations the caller must honour on the *subject*
  side — all implemented in [walk.mjs](../src/lib/walk.mjs) 312–343 (anchors refreshed after #277
  shifted this file up ~21 lines): separator normalization (:324), the trailing-`/` **directory
  rule** (:326–327), and `matchers.find` to recover which pattern hit (:330), over matchers built
  at (:315). So the directory rule is reachable only through the filesystem.
  `exclude.test.mjs`'s helper re-implements the first obligation and **cannot express the
  second** — there is no directory-exclusion case in it at all, and the only coverage is one
  `walk.test.mjs` case building a real temp tree. Four of the six active starter patterns are
  directory form, so the least-tested half of the grammar is the most-used half. One production
  caller.
- **F — The snapshot pass's counters are unobservable.** _Strong._ `progressLine` was extracted
  for testability and got 16 tests, but every real defect in the pass lives in what is *passed*
  to it, and none of that is reachable: off a TTY `createProgress` writes nothing
  (progress.mjs:91–93, refreshed after #277), so the `bytesTotal` loop (snapshot.mjs:166–170), the `bytesDone`
  accumulation (:184–199) and the `hashing` binding (:157–158) are inert under `node --test`.
  `snapshot.test.mjs` imports exactly one symbol; `backup.test.mjs` mocks the other two away.
  The behavioural question this hides: `bytesDone += props.size` counts a **reused** file's
  bytes and `fileProps` returns stored props without reading one, so *"38% of 2.4 GB"* means
  bytes read on a first run and files settled on a no-change run — a difference no `progressLine`
  test can see. Whether that is right is a product question; that nothing observes it is the
  architectural one. Pairs with A (the injected clock is the same seam).
- **G — The dispatcher carries policy and has no test surface.** _Worth exploring._
  [s3cab.mjs](../src/s3cab.mjs) holds ~10 policies — version fast path, topics-first help
  routing, unknown-command 127, the `unhandledRejection` handler (:82–97), `--json` merged then
  stripped, render-vs-JSON with the empty-output trim, `InterruptedError` → 130, the usage
  synopsis and the 1-vs-2 exit split — and **cannot be imported**, because dispatch runs as a
  top-level side effect. `isCredentialProviderError` has six unit tests; the policy that *uses*
  it (warn once and never twice, rethrow everything else, `statusLine` not `console.warn` because
  a bar may be mid-line) has none and can have none. That is a pure function extracted for
  testability with the bug surface left on the other side. No ADR to reopen — CLAUDE.md's
  placement note already says to guard the run block with `import.meta.main` *"if dispatch ever
  needs unit testing"*; #256 made the conditional true.
- **H — "Deliberate ≠ fault" is decided twice.** _Worth exploring._ One rule — an absent object
  is either a recorded **deletion** (context, exit 0) or an unexplained absence (a fault, exit 1)
  — is implemented in two shapes with no shared name: `verifySet` pure and eager over
  `Map<hash,{deletedOn}>` ([verify.mjs](../src/lib/verify.mjs) 59–71, exit rule at :148), and
  `restore` imperative and lazy over the same map
  ([commands/restore.mjs](../src/commands/restore.mjs) 148–173, 195–215, exit rule at :232). The
  rationale is spelled out in prose in both. **This abuts the standing "three shapes of the
  deletion-record lookup" rejection below and must not be conflated with it:** that rejection
  turns on three consumers asking *distinct* questions (map / membership / keys) and it still
  holds — this is a **fourth** consumer asking `verifySet`'s *identical* question in the
  identical shape and reaching the identical exit-code rule.
- **I — One run prints the same count both ways.** _Strong (small)._ `formatCount` exists because
  *"six digits run together are unreadable at a glance"*, but whether to apply it is re-decided
  at every interpolation: 20 grouped sites in [render.mjs](../src/render.mjs) against 8 ungrouped
  ones (:215, :232, :245, :257, :286–287, :290, :538) — and the eight are exactly the counts that
  scale with the file set. One session shows both spellings of one number: a first snapshot
  prints `First snapshot: 265,716 files` (:105), the next prints `Added (265716)` and
  `265716 added, …`. **Not a re-litigation of #254**, which routed six inline
  `toLocaleString("en")` calls through `formatCount`: these eight never formatted at all, so that
  sweep could not see them.

**Smaller, verified (eleventh pass).** `snapshotName` (snapshot-file.mjs:516) is an export whose
only importer is its own test — production mints names through `snapshotMoment()`; _Strong,
small_. One classification rule lives outside the classifier: `compareSnapshots` applies "a path
that failed hashing is not a deletion" by mutating `diff`'s output (compare.mjs:141–152), so
`diff`'s contract documents a rule it does not implement, and those two cases need real
`.tsv.zst` files while the other twelve run on in-memory Maps. The bucket-scan **ordering
invariant** (snapshots → `objects/` LIST → `deletions/`) is held only by adjacency in two
commands (verify.mjs:57–74, cleanup.mjs:78–95) — Strong the moment a third bucket-scan command
lands. The enumeration fixture is invented **five incompatible ways** across eight test modules
(ten construction points); pairs with D. `render.mjs`'s four section builders duplicate the
heading grammar and thread a triple-curried `painter` through five signatures. And two premises
that cannot both be true: snapshot-file.mjs:285 unlinks before renaming because *"Windows will
not rename onto an existing file"*, while :290 renames onto an existing file under `overwrite`,
green on `windows-latest` — a comment to settle, not a candidate.

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
  `verify.mjs`), **track 3 singles** (B, E, G, I + the smalls). Noted en route: this machine has no
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
