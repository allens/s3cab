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

**Picking these up cold (a later session, or another machine).** Everything needed is in this
file plus the ADRs — with three caveats worth stating rather than rediscovering.
(1) **Line anchors rot on every landing, and so do the file paths.** Two files of the same name
exist in `src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`,
`provider.mjs`, `snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify
before trusting any anchor — this file's own opening rule. It paid this pass: three carried-forward
entries were dead and one had the wrong mechanism.
(2) **Ordering constraints, by file overlap rather than theme.** **F → H** are sequential (both
own the enumeration/scan shape). **A** and **B** each touch one seam nobody else on this list
touches. **C** spans `auth.mjs`/`s3.mjs`/`lib/provider.mjs` and conflicts with nothing here.
Everything else is independent.
(3) **`.env.test` is gitignored and does not travel.** Every candidate except **C** is pure or
local and verifies with `npm test` alone; C is the exception — it needs the gated suite *and* the
Roles Anywhere prerequisites, both written up in
[docs/integration-testing.md](../docs/integration-testing.md). Do that setup before starting C,
not after.

- **A — `path-match.mjs` owns half the path-spelling question, and `find` borrows the wrong
  half.** _Strong — live fault._ [path-match.mjs](../src/lib/path-match.mjs):9–28 documents
  `isWindowsPath` as the **case** predicate (*"True when comparisons against it should fold
  case"*), and deliberately excludes a UNC root because a remote filesystem sets its own case
  rules — correct for that question. [find.mjs](../src/lib/find.mjs):181–191's `prepare` then uses
  it for the **separator** question. For `\\server\share\a.jpg` the answers diverge and every
  consequence is wrong at once: `windows === false` ⇒ `cut === -1` ⇒ `base` is the whole path, and
  `path` keeps its backslashes while `compileFindPattern` (find.mjs:133) already `/`-normalized the
  pattern, so **no pattern can match**. Nothing in `setup` or the walk refuses a UNC root, so the
  data is there; under ADR-0089 `find` is the only route to the hash `delete` takes as its operand,
  so UNC-backed content cannot be removed by the documented workflow. **There is no
  `src/lib/path-match.test.mjs` at all.** The deepening and the bugfix are the same edit: one entry
  point returning `{ path, base, foldCase }` with the three root shapes handled inside. Consistent
  with ADR-0088 (which put the shared grammar here on purpose); finishes that move.
- **B — The `#END` completion instant is minted outside the clock seam.** _Strong._
  [snapshot-file.mjs](../src/lib/snapshot-file.mjs):992–1001's `endLine` calls
  `Temporal.Now.instant()` directly and re-spells ADR-0085's `roundingMode: "ceil"` inline, while
  [format.mjs](../src/lib/format.mjs):254–265's `localMoment` — the door the model harness mocks
  ([test/model/harness/seam.mjs](../test/model/harness/seam.mjs):37–44) — documents the very
  invariant the trailer breaks: *"taking the instant separately would let an `await` slip a
  boundary between the two, and an artifact whose name and contents disagree is exactly what a
  record must never be."* The rounding rule now lives in two places, one of them a test:
  [snapshot.test.mjs](../src/commands/snapshot.test.mjs):271–289's `parkSentinelHashes` respells it
  by hand. `localMoment` already takes the unit as a parameter, so the fix is routing, not new
  interface. Deletes three test workarounds and makes a snapshot fully deterministic under the fake
  clock.
- **C — The credential path carries two disjoint error families.** _Strong._ *(Was eleventh-pass B;
  **holds, with its mechanism corrected** — the request-time relay **is** on the stack, so the old
  entry's "it never passes `s3.mjs`" was wrong.)* [auth.mjs](../src/lib/auth.mjs):679–697 returns
  from the RA branch at `:681`, **outside** the `try` that adds set / profile / endpoint context, so
  only the absent-identity case gets `noCredentialsError` (:629–642). A *runtime* `createSession`
  failure — expired cert, STS 403, non-JSON body, timeout — is a hand-written plain `Error`
  ([roles-anywhere.mjs](../src/lib/roles-anywhere.mjs):774–821) that reaches
  `requestErrorTable` ([s3.mjs](../src/lib/s3.mjs):322–347, :479–487) and matches **none** of its
  seven rows, all keyed on `name`/errno. One user-facing concern, two implementations that share
  nothing; a new failure mode added to either will not appear in the other. The readiness rule
  splits the same way: [setup.mjs](../src/commands/setup.mjs):271 refuses
  `--roles-anywhere` without an identity, [provider.mjs](../src/commands/provider.mjs):284–290 does
  not — and the module both go through, `lib/provider.mjs`'s `gatherProviderConfig`, doesn't know
  the rule. **`resolveCredentials` is imported by exactly one file in the repo — `src/lib/s3.mjs:29`,
  production. No test imports it**, while the pure `parseSessionResponse` has five: the skill's
  own warning, exactly.
- **D — Ten adapters at the `s3.mjs` seam, one of them checked.** _Strong._ ADR-0019 designates
  `s3.mjs` as the fake point, and [test/model/CAPABILITIES.md](../test/model/CAPABILITIES.md)
  writes the rule down: *"declare only what you truly model. An optimistic fake that claims what
  it fakes poorly is how a suite passes against broken code."*
  [fake-s3.mjs](../test/model/harness/fake-s3.mjs) obeys it — it re-implements ADR-0083's
  hash-verification guard and documents what it does not model. The **nine** object-literal
  adapters in `src/` declare nothing: `commands/backup.fused.test.mjs:20`,
  `commands/backup.online-only.test.mjs:73`, `commands/restore.counts.test.mjs:66`,
  `commands/restore.missing-object.test.mjs:60`, `lib/objects.test.mjs:46`, `lib/upload.test.mjs:49`,
  `lib/set-marker.test.mjs:13`, `lib/deletion-record.test.mjs:28`,
  `lib/remote.referenced-scan.test.mjs:23`. The first two are near-identical down to a copy-pasted
  ADR-0084 comment, both stubbing `putFile: async () => true` — the one method ADR-0083 gave a
  guard to. **Not one god-fake** (the tiers differ on purpose): a factory returning honest defaults
  that a test narrows by passing only what it varies. Ten adapters is past "two means a real seam".
- **E — `generateSnapshot` takes the baseline whole.** _Worth exploring._ *(Was eleventh-pass C;
  re-verify the anchors — `snapshot.mjs` moved this pass.)* Three of its seven options are
  `readBaseline`'s own fields renamed and re-threaded by hand, identically at **2 of 2** call sites;
  the typedef marks them independently optional but `readBaseline` sets them together, so one
  ternary arm can only evaluate to `undefined` and a test exists solely to stop a refactor dropping
  one — a test defending an interface against a mistake that interface invites. Take the baseline as
  one optional record: same implementation, smaller interface, illegal state unrepresentable.
  Does **not** reopen ADR-0069. *(Doc rot in the same file:
  [commands/snapshot.mjs](../src/commands/snapshot.mjs):48–50's comment states the reverse of what
  `readBaseline` does. And [commands/find.mjs](../src/commands/find.mjs):12–15 still calls ADR-0089
  "a settled-but-unbuilt rework", pointing at a `proposals/hash-operand-delete.md` deleted when it
  shipped. One-line fixes, not candidates.)*
- **F — The bucket-scan ordering rule is prose, not code.** _Worth exploring._ *(Was an
  eleventh-pass smaller item, filed "Strong the moment a third bucket-scan command lands". That
  trigger did **not** fire — the phase count grew instead.)* The safety property — snapshots listed
  before objects, so a concurrent backup can only make the scan **over**-estimate what is
  referenced — is stated in nine doc comments across `src/lib/remote.mjs`, `src/lib/referenced.mjs`,
  `src/commands/cleanup.mjs` and `src/commands/delete.mjs`, and enforced by none of them. ADR-0090's
  compaction added a third phase and a cross-command writer, so the rule now spans modules that
  don't import each other. A scan assembled in the wrong order is silent data loss with a green
  suite. Deepening: one module owns "scan the bucket safely" and returns a result whose
  construction order *is* the ordering.
- **G — `lib/delete.mjs` went shallow when `find` took its job.** _Worth exploring._ ADR-0089 moved
  *what to delete* into `find`, leaving [lib/delete.mjs](../src/lib/delete.mjs) with one production
  caller and the interesting rules — referenced-check, record write, confirmation — in
  [commands/delete.mjs](../src/commands/delete.mjs) above it. Deletion test: folding it up
  concentrates the deletion story in one file; moving the rules down earns the module its keep.
  Either beats the current split, which is the one shape that doesn't.
- **H — Five enumeration shapes, ten construction points, three incompatible `ref` helpers.**
  _Worth exploring._ *(Carried from the eleventh pass's smaller items; it paired with D there, and
  now pairs with F.)* "The set of hashes something references" is built five ways across the
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
co-locating `globSource` with the spelling question is right, and **A** deepens it rather than
splitting it; `generateSnapshot` and `readBaseline` **as modules** — **E** is about one parameter
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

- **E — `compileExclude` owns only half the matching convention.** _Strong — **not re-verified in
  the twelfth pass**, whose scope was the ADR-0077–0090 work; `walk.mjs` and `exclude.mjs` both
  changed since, so treat every anchor below as stale until checked._
  [exclude.mjs](../src/lib/exclude.mjs) normalizes the *pattern* side and returns a bare `RegExp`,
  then documents in prose three obligations the caller must honour on the *subject* side — all
  implemented in [walk.mjs](../src/lib/walk.mjs) (as of `4221fad`, 312–343): separator
  normalization, the trailing-`/` **directory rule**, and `matchers.find` to recover which pattern
  hit. So the directory rule is reachable only through the filesystem.
  `exclude.test.mjs`'s helper re-implements the first obligation and **cannot express the second** —
  there was no directory-exclusion case in it at all, and the only coverage was one `walk.test.mjs`
  case building a real temp tree. Four of the six active starter patterns are directory form, so the
  least-tested half of the grammar is the most-used half. One production caller. **Note ADR-0080
  (`tree --excluded`) landed since this was written and may have added a second caller — check
  before assuming the "one production caller" premise still holds.**

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
