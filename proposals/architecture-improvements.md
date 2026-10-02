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

Re-verified 2026-10-02 (fourteenth pass): **2 `src/` commits since `3395305`** (9 files, +381/−55),
read at HEAD `f9bba9a`. Both are pass-13 landings: **A** in #348 and **D** in
[#343](https://github.com/allens/s3cab/pull/343). **B, C and E–N were re-checked by hand and all
hold.** Only anchors moved, for F, G, H and I, and those are corrected in place. I's second half is
also narrowed (see the entry). **One new Strong candidate, O, came out of D's own landing.** #343 found
that the fused pass never gave the event loop a turn, so its redraw timer never fired, and fixed that
locally. The walk has the same fault, unseen since
[#277](https://github.com/allens/s3cab/pull/277), and it was confirmed by experiment. There are also two
new smaller items, P and Q. **O is the same shape as pass 13's verdict below:** `countedPass` says of
itself "A caller cannot forget a timer it does not own", and the walk is a caller whose timer never
fires. This time a user-visible fault comes with it.

Surfaced 2026-10-01 (thirteenth pass) — the open list had been emptied by the twelfth pass, so this
one read the **11 `src/` commits since `a4ed60c`'s HEAD `a4e0c9d`** (59 files, +2233/−1302) at HEAD
`3395305`: nine of them are pass 12's own landings — `scanBucket`, `preparePath`, the clock-seam
`completionInstant`, the `s3.mjs` fake stencil, the enumeration builder, the Roles Anywhere error
family — plus one genuinely new subsystem, **ADR-0091**'s idle-connection bound and retry-window
origin. Three background sweeps (pass-12's new seams / the transfer+progress path / re-verification
plus the uncovered remainder); **A, C, the `foldsCase` fact in K, the `diff` call-graph in B and the
starter-pattern count in E were re-verified against source by hand** before being written down.

**Verdict: the recurring shape has changed.** Earlier passes kept finding one rule split across two
modules that don't import each other. This pass's dominant shape is narrower and more embarrassing —
**a module that states a rule in prose _about itself_ which its own code does not keep**: the clock
seam's "and nowhere else" (**A**), `lib/provider.mjs`'s "the one home of the knob ↔ env-key mapping"
(**J**), `commands/backup.mjs`'s "every figure lands here rather than in the renderer" (**I**), and
`exclude.mjs`'s subject-side convention, which turns out to be documented nowhere at all (**E**).
A codebase that writes its invariants down gets measured against them — and **A** showed the cost of
writing one down in the wrong words: its diagnostic sentence named a `Temporal.Now` read, and both
escapes spelled it `new Date()`, so grepping the rule as written found nothing (landed — run log).

**Picking these up cold (a later session, or another machine).**
(1) **Line anchors rot on every landing, and so do file paths.** Two files of the same name exist in
`src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`, `provider.mjs`,
`snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify before trusting any
anchor — see **E** below for what skipping that costs.
(2) **Ordering constraints.** **B** is independent of everything. **F** and **I** both touch
`withProgress`/`generateSnapshot` in [src/lib/snapshot.mjs](../src/lib/snapshot.mjs), which **O** and
**P** reshaped when they landed (#355), so re-verify their anchors before building. **E** touches the
matcher that [walk.mjs](../src/lib/walk.mjs)'s `createWalkCallbackFn` calls, and O now wraps that
callback in `walkDirs` to tick, so E must re-verify there too.
(3) **`.env.test` is gitignored and does not travel.** Every candidate below is pure or local and
verifies with `npm test` alone; none needs a real bucket.

- **A — The deletion record's instants were minted outside the clock seam that names them.**
  _Landed 2026-10-01 as [PR #348](https://github.com/allens/s3cab/pull/348) — see the run log._
- **B — `diff` is exported only for its test, and the two rules that decide "deleted" sit outside
  it.** _Strong — carried from the eleventh pass's smaller items, **re-verified and corrected**
  2026-10-01._ `diff` is [compare.mjs](../src/lib/compare.mjs):312; its **only** production call is
  :171, inside `compareSnapshots` itself, so the export exists solely so
  [compare.test.mjs](../src/lib/compare.test.mjs) can reach it — the shape this project keeps naming,
  *a pure function extracted for testability with the real bug surface left on the other side of the
  call*. Both carve-outs are still applied by mutating `diff`'s output afterwards: :181–183
  (`untilSnapshot.errors`) and :192–194 (`untilSnapshot.skipped`), each `deleted.delete(path)`.
  **The carried entry's mechanism was wrong in an interesting direction, and the correction is the
  finding.** It claimed "`diff`'s contract documents both rules and implements neither." Actually
  there are three separate situations in that contract (:278–306): the **errors** bullet (:297–301)
  documents the rule *and honestly names its owner* — "…so `diff` never sees them. `compareSnapshots`
  reports them under its own `errors` category and keeps them out of `deleted`" — which is an accurate
  cross-reference, not a false promise; the **skipped** rule is documented **nowhere** in the contract,
  its only explanation being the inline comment at :185–191 *inside the loop*; and the
  **previousErrors** bullet (:302–306), which the entry lumped in, describes a rule `diff` **does**
  implement, at :353. So the defect is narrower and sharper than recorded: a caller reading `diff`'s
  interface learns one carve-out exists and reasonably infers there is no other, while the two rules
  that decide what a user sees as "deleted" are on the untested side of the call.
  The standing rejection of `diff` **as a module** does not bind — this is about which side of an
  existing call a rule lives on, not about its placement. Minimal version: document the `skipped`
  rule where the `errors` rule already is. Real version: move both behind `diff`'s signature.
- **C — `forget`'s unrestorable preview is the only bucket-wide reader that never consults the
  deletion record.** _Strong — verified by hand 2026-10-01._
  [commands/forget.mjs](../src/commands/forget.mjs):184–190 calls `referencedObjects(set.bucket)`
  alone and hands the result to `planUnrestorable`, whose signature
  ([unrestorable.mjs](../src/lib/unrestorable.mjs):100–108) has no `deleted` parameter anywhere — where
  its sibling `planCleanup` ([cleanup.mjs](../src/lib/cleanup.mjs):74) takes
  `{ now = Date.now(), deleted = new Set() }`. Every other bucket-wide reader consults the record:
  `verify` partitions into `expectedMissing` ([verify.mjs](../src/lib/verify.mjs):63–77), `cleanup`
  subtracts it from the `missing` interlock (cleanup.mjs:92–97),
  [commands/restore.mjs](../src/commands/restore.mjs):191 reads it to skip gracefully, and
  [upload.mjs](../src/lib/upload.mjs):94 subtracts it from the baseline. `forget` is the fifth and the
  only abstainer.
  **The consequence is a wrong number on the strongest confirmation prompt the tool has.** After a
  `delete` has removed content an old snapshot still lists, `planUnrestorable` — which reasons purely
  over snapshot references and never sees the store — counts those paths as files "you would no longer
  be able to restore" and their bytes as reclaimable, in the report header at unrestorable.mjs:316–323
  (`N files, holding X across M stored objects` … "Reclaim the space with: `s3cab cleanup <bucket>`").
  Both halves are false for that content: it cannot be lost, and there are no bytes to reclaim. This is
  precisely the line [CONTEXT.md](../CONTEXT.md)'s **Delete** entry already draws — "the removed content
  is simply **deleted** (not **unrestorable**, which stays `forget`'s preview word for content a
  snapshot removal would strand)". The vocabulary exists; `forget` is the one command that cannot see
  it. Fix: give `planUnrestorable` the same optional `deleted` set and subtract it in step 2 alongside
  the other sets (unrestorable.mjs:131–136), with `forget` reading the record after the snapshot scan —
  the same relative order `scanBucket` enforces for its own reads 1 and 3. `planUnrestorable` is pure
  and non-throwing by design, so the case tests as a fixture: no S3, no new seam.
- **D — The progress line goes blank on exactly the files that are slow.**
  _Landed 2026-10-01 as [PR #343](https://github.com/allens/s3cab/pull/343) — see the run log. Its
  "narrow `onHashStart` to the byte cursor" half was not done there. It landed later as smaller item
  **P**, in [PR #355](https://github.com/allens/s3cab/pull/355)._
- **E — `compileExclude` owns the pattern side; the walk owns the convention.** _Worth exploring —
  carried from the eleventh pass, **downgraded from Strong and substantially rewritten** 2026-10-01._
  **Read the correction before the claim: the recorded entry was two-thirds wrong.** Dead: it said
  [exclude.test.mjs](../src/lib/exclude.test.mjs) has no directory-exclusion case (it does, :41–42,
  with a comment naming the walk) and that one `walk.test.mjs` temp-tree case is the only coverage
  (there are two, [walk.test.mjs](../src/lib/walk.test.mjs):155–167 and :169–195, the first also
  pinning the non-prefix-match on `builder/`). Wrong mechanism: the JSDoc
  ([exclude.mjs](../src/lib/exclude.mjs):5–20) documents **one** subject-side obligation, not three —
  only :19's "tested against a `/`-separated path" — so the directory rule is *undocumented and*
  unenforced, which is worse than recorded; `exclude.test.mjs`:15's helper is a pure pass-through
  (`compileExclude(pattern).test(path)`) that sidesteps normalization by hard-coding normalized
  subjects rather than re-implementing it; and the directory rule is **not** reachable only through
  the filesystem — `compileExclude("/root/build/")` yields `^/root/build/$` and is a string test
  today, only the walk's *append* and its stop-descending need a tree. Wrong count, and wrong file:
  `starterExclude` is [sets.mjs](../src/lib/sets.mjs):123 (not `setup.mjs`), its active patterns are
  :130–139, and there are **eight**, of which four are directory-form (`**/node_modules/`, `**/.git/`,
  `$RECYCLE.BIN/`, `System Volume Information/`) — four-of-eight, not four-of-six; the dogfood
  [.s3cab/exclude.txt](../.s3cab/exclude.txt) is eight-of-fourteen.
  **What survives, restated honestly:** `compileExclude` returns a bare `RegExp` (exclude.mjs:21–27,
  unchanged); all three subject-side obligations are implemented in `createWalkCallbackFn`
  ([walk.mjs](../src/lib/walk.mjs):386 separator normalization, :388–390 the trailing-separator
  directory rule, :392 `matchers.find` first-match-wins) and nowhere else; there is exactly one
  production call site (walk.mjs:377) — `tree --excluded` reads the `excluded` array `walkSet` already
  produces (ADR-0080), so it is a consumer of the walk's output, not a second caller of the matcher;
  and **no test anywhere compiles a trailing-`/` _pattern_** — `exclude.test.mjs`:41–42 tests a
  trailing-`/` *subject* against a `**` pattern, and `walk.test.mjs` tests the pattern only end to end
  through a temp tree. Half the shipped starter patterns use a form whose compilation has no unit test
  and whose meaning appears in neither the function's JSDoc nor its test file.
  Shape if taken: `compileExcludeSet(patterns) → { match(path, fileType) }`. ADR-0088 governs the
  *token* grammar (`globSource` shared with `find`, `compileExclude` anchoring `^…$`) and says nothing
  about the subject side, so this **completes 0088 rather than reopening it**. One production caller
  makes it a depth move, not a seam — which is why it is no longer Strong.
- **F — `generateSnapshot` infers which porcelain called it from a progress-state getter.** _Worth
  exploring — anchors re-verified 2026-10-02._ [snapshot.mjs](../src/lib/snapshot.mjs):211–212 and :219
  take `through` and `transfer` as two independent optional parameters that in practice always arrive
  together off one uploader, and :409 derives a *third* fact, the command's own name, from whether
  `transfer` is truthy. That name feeds the opening `Backing up` vs `Snapshotting` line (:240) and two
  copy-pasteable remedies (`warnAboutOnlineOnly`'s `s3cab ${command} ${set} --include-online-only`,
  `warnAboutCtimeChurn`'s `every ${command} of '${set}'`, both called at :410–411). Nothing makes
  `through`-without-`transfer` unrepresentable, and that combination uploads objects while announcing
  itself as a snapshot and handing out `s3cab snapshot` advice. **That combination now has a caller**
  (pass 14): [snapshot.progress.test.mjs](../src/lib/snapshot.progress.test.mjs):109–121 passes
  `through` alone as a test convenience. It is harmless there, but it is the first real instance of the
  shape. Fix: take one optional `uploader` carrying all three, which
  [backup.mjs](../src/commands/backup.mjs):95–108 already builds as an object. Leverage is small today
  (two callers), which is exactly why the invariant is invisible. Note also that snapshot.mjs:405–408's
  comment **defends the derivation, not the invariant**, so this disagrees with a comment, not an ADR. Test surface: the `backup` spelling of the churn remedy is asserted nowhere;
  [snapshot.ctime-churn.test.mjs](../src/commands/snapshot.ctime-churn.test.mjs):131–186 drives the
  `snapshot` porcelain and its own comment says "`backup` gets the same sentence with its own verb".
  (The online-only pair *is* covered on both sides.)
- **G — ADR-0091's one user-visible promise is unpinned, because a stream is welded into a seam that
  is already curried.** _Worth exploring — against brand-new code; anchors re-verified 2026-10-02._ The
  relay is curried on its options precisely so "the give-up path is testable in milliseconds"
  ([s3.mjs](../src/lib/s3.mjs):498–503),
  and [network-status.mjs](../src/lib/network-status.mjs):50 and :77 already take the stream as their
  first parameter — but both call sites hard-code it (s3.mjs:543 `enterNetworkWait(process.stderr, …)`,
  :563 `leaveNetworkWait(process.stderr, …)`), so the only way to observe an announcement is
  monkeypatching `process.stderr.write` ([s3.test.mjs](../src/lib/s3.test.mjs):815–825, whose comment
  at :807 claims "there is no stream to inject through SDK middleware". The place to inject it is the
  relay's own option bag, which exists). **The concrete cost:** ADR-0091 decision 2 says the announcement "now names
  **what is left** of the window rather than the constant", and nothing asserts it — s3.test.mjs:860
  asserts the *constant* wording (`/up to 2 minutes/`), the three remaining-window assertions
  ([network-status.test.mjs](../src/lib/network-status.test.mjs):107, :112, :119) drive
  `enterNetworkWait` directly and never go through the relay, and s3.test.mjs:910 ("starts the
  window at the first failure, not at the request") never reaches an announcement at all. Fix: carry
  the stream alongside `windowMs` in the already-curried options, defaulted to `process.stderr`.
  **Brushes the network-resilience-trio rejection and must say so:** that rejection is against
  *restructuring*; the mechanic, `requestErrorTable` and `network-status.mjs` are untouched here — this
  is one parameter on an injection point that already exists.
- **H — The parser knows how much of a torn work file it got, then throws it away.** _Built
  2026-10-01 as [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md) — a tolerant
  `parseSnapshotStream` whose completeness is a returned fact, with the work file's mtime standing in
  for the `#END` instant it never wrote._ **One half was deliberately not taken, and the reason is
  worth keeping:** the entry prescribed recovering *inside* `withSnapshotFile`, as a rename at the
  moment the `wx` acquire is won, so that the exclusion proof and the recovery would be one event. The
  adoption instead sits in `readBaseline` behind an explicit `--resume`, which the acquire cannot see.
  Making it one event would make it *automatic*, and automatic is precisely what ADR-0048 refuses —
  winning the acquire proves only that no run holds the file *now*, which is also true a moment after
  a live run dies, and the user remains the liveness check. The ordering hazard the entry named is
  real and is answered by the flag rather than by the acquire: nothing is adopted unless a person says
  so.
- **I — The rehash diagnosis exists only as a printed sentence, and one returned count merges two
  populations.** _Worth exploring — anchors re-verified and the second half **narrowed** 2026-10-02._
  [backup.mjs](../src/commands/backup.mjs):50–51 states the ADR-0078 rule — "Every figure lands here
  rather than in the renderer, so `--json` gains it deliberately" — and the per-reason rehash counts
  break it: [snapshot.mjs](../src/lib/snapshot.mjs):321 builds `rehashed`, :373 populates it
  (`changed` / `ctime` / `ctime-on-read`), :411 consumes it in a module-private `console.warn`, and the
  return at :413–426 carries **no `rehashed` field at all** — so the numbers that diagnosed the
  re-read-everything-every-run incident reach the warning and nobody else, and a user diagnosing a
  churning volume must read prose rather than a field. Three consumers want them (the warning, the run
  report, `--json`); one can have them. Alongside it, :423 returns `skipped: skipped.length +
  onlineOnly`, while backup.mjs:66 documents that number as "Entries the walk left out by design (a
  symlink, a socket)". **Corrected by pass 14:** the sum is *deliberate*. ADR-0078 §2 says so in the
  comment at :420–422, and `SnapshotPass`'s own typedef (:191) documents both populations. So this is
  not a value aggregated by accident inside a `return`, as filed. It is one stale typedef, at
  backup.mjs:66. Test surface: the churn condition is asserted only by matching warning prose
  (snapshot.ctime-churn.test.mjs:157–186).
- **J — Two homes for the knob ↔ env-key mapping, one of which claims to be the only one.** _Worth
  exploring._ [lib/provider.mjs](../src/lib/provider.mjs):21–23 claims to be "the one home of the knob ↔
  env-key mapping", with the three-mode exclusivity rule at :144–153 and the env keys written inline at
  :162–199; [commands/provider.mjs](../src/commands/provider.mjs):42–51 holds a second `knobs` table
  (knob → env keys) and :304–331 re-enumerates the same `"ra" | "profile" | "keys"` modes to decide
  which to clear on disk. So a fourth credential mode would be rejected correctly at the option level by
  `gatherProviderConfig` and silently **not cleared** on disk by the command, and the endpoint's
  two-spelling rule is spread across three spots (`knobs.endpoint` clears both `AWS_ENDPOINT_URL_S3` and
  `AWS_ENDPOINT_URL`; `gatherProviderConfig`:182 writes only the `_S3` form;
  [env.mjs](../src/lib/env.mjs):51–52's `customEndpoint` resolves the precedence). Fix: move the table
  beside `gatherProviderConfig`/`readProviderConfig` and have the gather return the env keys its chosen
  mode replaces, so the command applies a list rather than deriving one. **Deliberately not the
  standing-rejected `credentialMode(env)` classifier** — nothing is classified from an env bag; a table
  moves and a return value grows. Named because the two sit next to each other.
- **O — Two lines run on a clock, each has half of what keeps it live, and the walk's clock never
  ticks.** _Landed 2026-10-02 as [PR #355](https://github.com/allens/s3cab/pull/355). See the run
  log; the record is
  [ADR-0093](../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md)._

**Smaller items (thirteenth pass)** — verified, too small for an entry of their own.
**K — `foldsCase` is exported surface with no production caller.** Its only uses anywhere in `src/`
are `preparePath`'s own body ([path-match.mjs](../src/lib/path-match.mjs):71) and
`path-match.test.mjs`; `find.mjs` and `restore.mjs` import `preparePath` alone. Yet path-match.mjs:5,
CLAUDE.md and ADR-0088 all present `foldsCase` as the shared answer — and path-match.mjs:32–34 says
outright that "a caller that derived one answer from the other's predicate is how a UNC path once
became unfindable", so the exported door invites exactly the mistake the module exists to close. One
adapter is a hypothetical seam: make it module-private and assert the case decision through
`preparePath(…).foldCase` (path-match.test.mjs:32–47 already asserts that field).
**L — Two spellings of "why this snapshot would not read".** [remote.mjs](../src/lib/remote.mjs):305
builds the finding's `reason` inline (`Error.isError(error) ? error.message : String(error)`);
[find.mjs](../src/lib/find.mjs):218 builds the same field with `errorText`
([error.mjs](../src/lib/error.mjs):319–330), which additionally unwraps a message-less
`AggregateError` rather than rendering blank. No leverage today — both current error classes carry
messages — offered as a consistency fix, not a defect. Alongside it,
[referenced.mjs](../src/lib/referenced.mjs):173–176 and :186 still name `delete` as one of three
consumers of `unreadableSnapshots`/`unreadableMessage`; `commands/delete.mjs` has not imported
`referenced.mjs` since ADR-0089, so the real two adapters are `commands/cleanup.mjs` and
`lib/unrestorable.mjs`. (This is the *second* stale consumer list on that module's header — the first
was fixed when pass-12's G landed. If it recurs again, the list is the problem, not the edit.)
**M — `find.mjs` calls a shipped feature unbuilt, citing a deleted file.**
[commands/find.mjs](../src/commands/find.mjs):12–15 still describes the command as "the first half of
a settled-but-unbuilt rework in which `delete` takes **hashes** (proposals/hash-operand-delete.md)".
Both halves are false: ADR-0089 records "settled 2026-08-22 … built the same day", and the proposal
file is deleted. Noted as a loose end when pass-12's E landed, still there. One sentence.
**N — `preparePath` returns three fields and neither caller reads all three.** _Speculative, and
unmeasured — recorded as join residue at a new seam, not as a finding I am confident in._
path-match.mjs:70–80's own doc says it is "called once per row of every snapshot in history, so it
does the least it can"; `find.mjs`:278–279 reads `.base` always but `.path` only for a whole-path
matcher, and `restore.mjs`:202 reads only `.path` while :174–176 documents why `.base` is the wrong
answer for its question. So a basename-only search — the commonest — pays a whole-path
`replaceAll("\\", "/")` per Windows row for a field it never reads. **I did not measure it against
zstd decompression cost**, and the memory/async stance argues against pre-emptive fuss. Either a lazy
getter or letting `compileFindPattern`'s already-computed `wholePath` decide what the caller asks for.

**Smaller items (fourteenth pass).** **P** (the file in hand carried three ways) and **Q** (three
comments still describing the line before #343): _landed 2026-10-02 with **O** in
[PR #355](https://github.com/allens/s3cab/pull/355), as their own commit. See the run log._

**Examined & left alone (thirteenth pass)** (not candidates — skip future runs). **Pass 12's own
landings all hold up**, which is the most useful thing this pass can say about them:
[bucket-scan.mjs](../src/lib/bucket-scan.mjs) — the ordering invariant is the module's *body* rather
than a comment at two call sites, and its test pins it at the `s3.mjs` seam including the half a
call-order assertion cannot see (a held snapshot GET proving the objects LIST has not *begun*); both
consumers destructure and re-derive nothing. [test/helpers/s3-seam.mjs](../test/helpers/s3-seam.mjs) —
the asymmetric defaults are a real design argument and `test/s3-seam.test.mjs` keeps the surface honest
in both directions *and* guards its own blind spot (a namespace or dynamic import fails loudly rather
than leaving the check silently blind); this is the model the clock seam lacked when **A** was filed
(A landed a lint rule, for the `new Date()` spelling only).
[test/helpers/enumeration.mjs](../test/helpers/enumeration.mjs) — fixtures go through
`addSnapshotReferences`, the production fold, so a test cannot hold a shape a real read would not
produce. `format.mjs`'s `localMoment`/`completionInstant`/`readClock` **as a seam** — one clock read
behind both doors, round-up rule argued and pinned; **A** was about the two callers that bypassed it, not
about the seam. `safeSize`/`sizeDisagreements` and `referenced.mjs`'s `unreadableMessage` — two real
adapters each, and the number-neutral `consequence` contract is the right shape. `verifySet` vs
`planCleanup` — genuinely opposite set-differences over the same two enumerations, not one computation
wearing two hats. `auth.mjs` + `roles-anywhere.mjs` after the `RolesAnywhereSessionError` landing — the
identity/session split is decided by error *type* at the throw site and caught by type, never by
message, and transport errors are deliberately let through raw so the request-time relay retries them;
`ARN_ENV` is one table read by all three sides of the round trip. `snapshot-file.mjs`'s `endLine` —
module-private and emitted from the single tail of `stringifySnapshot`, which is what makes the
marker's presence mean "ended in a controlled way".
**Checked and discarded as findings:** `render.mjs`'s remaining hand-built blocks (`renderRestore`, the
set-findings table) — sentence headings and column alignment, a different shape from `section()`'s
label+list, so folding them in would widen the interface more than it saves, and `renderTree`'s
two-shape branch is documented as deliberate; `snapshot.mjs`'s `bytesTotal` pre-pass — **not** a
hot-path cost, since `walkDirs` already materializes `files`, so it is O(n) Map lookups with no extra
syscall; the `find` → `delete --from-file` contract — **not** an untested promise, since
`delete.test.mjs`:356/:377/:414 feed real `renderFind` output, colour included, back through
`--from-file`; `sets.mjs`'s `validateBucketName` — it looks like a rule split with `lib/aws.mjs`'s
IAM-name cap and is in fact a clean parameterized seam (`commands/aws.mjs` passes
`maxLength: maxBucketNameLength(name)`); `network-status.mjs`'s refcount proxy mis-announcing under
ADR-0069's one-in-flight pass — recorded deliberately in ADR-0091 and pinned as intended.
**Examined & left alone (fourteenth pass).** Every other progress line, checked for **O**'s fault, and
none has it. The store scan's counted pass ([upload.mjs](../src/lib/upload.mjs):138) and both of
`find`'s (find.mjs:259, :379) are fed by real async I/O (a network page, a zstd/readline stream), so
their timers get turns. `restore` pushes on `due()` over real async writes and owns no timer. The
per-file upload bar in `s3.mjs` is driven by the SDK's progress events. `network-status.mjs` has no
timer at all. **O** is the walk and the fused pass only, the two places where synchronous work runs in
front of a timer. #343's own landing was otherwise re-read and holds: `currentFile` set and never
cleared is argued at its declaration (snapshot.mjs:288–296), and the concession's placement after the
yield is argued at :533–538.

---

Surfaced 2026-09-04 (twelfth pass) — the first architecture read of the **`find` → hash-operand
`delete` pair** (ADR-0088/0089/0090), the **`#END` trailer** (ADR-0082), the **streamed-digest
upload guard** (ADR-0083), **snapshot identity by byte equality** (ADR-0084), the **ctime
cross-check** (ADR-0085), **restore collision by filesystem equivalence** (ADR-0086), the **run
report** (ADR-0078/0079), **`tree --excluded`** (ADR-0080) and **online-only files** (ADR-0081):
35 `src/` commits since HEAD `4221fad` — 81 files, +9677/−2298. Verified against the source at
HEAD `a4e0c9d`. Verdict: the new subsystems are well-shaped, and the friction is at their
*joins* — three of the four Strong candidates are a rule that ended up split across two modules
that don't import each other, and the fourth is a seam with ten adapters and one contract.
**A–D were re-verified against source by hand; E–L carry their sweep's anchors.** **All of A–K have
landed** (run log below) and **L was answered, no change** — `progress.mjs` owns the redraw-rate
*floor* while `withProgress`'s 250 ms timer is only how often it *asks*, so the two cadences compose
rather than compete. Only the list below survives from this pass.

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
[ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s amendment). **Its walk half never
took effect**: the walk is synchronous, so the clock it got never ticks. That is the fourteenth pass's
**O**. **D landed
2026-08-07**, and **H was rejected** the same day (see *Rejected & parked*). The twelfth pass
re-verified the rest: **B, C and G carried forward** as the twelfth pass's **C**, **E** and **J**,
**F survives only as I**, and **I is dead**. The thirteenth pass then took the last two: this
pass's **E** (`compileExclude`'s subject-side convention) and the `compare`/`diff` smaller item
carry forward as the thirteenth pass's **E** and **B**, both **rewritten** — each had been filed
with the wrong mechanism, which the re-verification caught. Nothing else from this pass is open.

**Smaller items (eleventh pass), as later passes left them.** `snapshotName` — **dead**, the
alias was deleted in `0060b61`. The bucket-scan **ordering invariant**, the **enumeration
fixture** and `render.mjs`'s **section grammar** were all promoted to twelfth-pass candidates and
have landed. The two premises that cannot both be true are still there, now at
snapshot-file.mjs:350 (*"Windows will not rename onto an existing file"*) and :358 (renaming onto
one under `overwrite`), green on `windows-latest` — a comment to settle, not a candidate.

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

> **Capped to the last three passes.** Earlier entries (2026-06-23 first pass through the
> 2026-08-06 eleventh) recorded landings that are already of record in their ADRs, PRs and `git log`,
> and re-verification notes superseded by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

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
- **2026-09-06 — H landed** ([PR #339](https://github.com/allens/s3cab/pull/339); (grilled in-session, seven decisions in one round; the record is
  [ADR-0074](../docs/adr/0074-referenced-enumeration-vocabulary-module.md)'s amendment). *One
  constructor for the referenced enumeration, and one fixture builder that drives it.*
  `addSnapshotReferences(referenced, name, entries)` in `referenced.mjs` is the fold
  `remote.mjs` carried inline; `enumeration(spec, unreadable)` in
  [test/helpers/enumeration.mjs](../test/helpers/enumeration.mjs) builds `Map<set,
  ReferencedResult>` from a snapshot-shaped fixture (set → snapshot → path → `[hash, size]`)
  by calling that fold once per snapshot. Seven test files, 76 call sites, migrated; seven local
  helpers deleted.
  - **The finding was re-verified and re-worded before anything was built.** "Five shapes, three
    incompatible `ref` helpers" undercounted: ten construction points (production plus nine in
    tests), three `ref`s and two `enumeration`s with five incompatible signatures, five hard-coding
    `snapshotsChecked`, four unable to express the torn-file case `sizes` is a Set for, two
    synthesizing the path so one hash under two paths was unsayable. But **every one was
    shape-correct** — the cost was never a wrong fixture. The stronger reason to build it was that
    the shape had no constructor in production either: ten builders, zero definitions as code.
  - **The spec shape was the design decision.** Hash-first (mirroring the output, what most helpers
    did) vs snapshot-first (mirroring the input). Snapshot-first won because it is the only spec
    under which every case the seven helpers covered is expressible, and because the derived facts
    then fall out of the data: `snapshotsChecked` is the number of snapshots named, the
    `snapshots` Set is which snapshots recorded the path, a torn size is two snapshots disagreeing.
    A test reads as the situation — "b.jpg in both snapshots" — rather than as the shape.
  - **Three fixtures turned out to be saying something a real read cannot say.** lib/verify's
    "no problems" case recorded a path from two snapshots while asserting one was checked;
    lib/unrestorable hard-coded `snapshotsChecked: 0` under paths that referenced snapshots;
    commands/cleanup recorded `kept` at size 1 against a store holding it at 10 in eight tests that
    were not about size, so each carried a stray "wrong size" warning. The first was fixed in the
    fixture (the assertion held); the second was inert (`planUnrestorable` never reads the count);
    the third was left as it was — recording it at 10 would change what the fixtures say, and that
    is a separate decision, noted here.
  - **Two fixtures depended on encounter order, and the migration had to preserve it on purpose.**
    lib/verify's "orders two problems deterministically" listed `h2` before `h1` so that only the
    sort produces the asserted order; lib/unrestorable's report test relied on `s1` inserting before
    `s2`. Both are now spelled by snapshot order with a comment saying why, since a builder that
    inserts in fixture order makes the order a property of the fixture text.
  - **A fixture held in a variable needs `@type {EnumerationSpec}`**, or TypeScript widens
    `["h1", 500]` to `(string | number)[]`. Three sites; the typedef is exported for it and its
    doc says so. Inline arguments are contextually typed and need nothing.
  - **The pin is in the integration suite**, not a unit: `remote.test.mjs`'s real-bucket read
    now `deepEqual`s its whole `referenced` map against the builder's for the same snapshot, so
    the builder is held to what a real read produces. Green (26 pass) alongside `npm test`
    (1111 pass). The migration was five files by parallel agents on one brief and two by hand;
    every file's suite was run before and after with identical counts.
- **2026-10-01 — thirteenth pass.** The twelfth pass emptied the open list (A–K landed, L
  answered), so this pass read the **11 `src/` commits since `a4e0c9d`** (59 files, +2233/−1302)
  at HEAD `3395305` — nine of them pass 12's own landings, plus **ADR-0091**'s idle-connection
  bound and retry-window origin as the one new subsystem. Three background sweeps (pass-12's new
  seams / the transfer+progress path / re-verification plus the uncovered remainder), then **A, C,
  the `foldsCase` fact in K, the `diff` call-graph in B and the starter-pattern count in E
  re-verified by hand** against source. **Fourteen candidates recorded above (A–N)**, the standout
  being **A: the deletion record's instants are minted outside the clock seam that names them** —
  found independently by two sweeps, byte-identical output either way, and the precedent-setter for
  the three others sharing its shape. **Verdict: the recurring shape changed** — earlier passes kept
  finding one rule split across two modules; this pass's dominant shape is a module stating a rule
  *about itself* in prose that its own code does not keep (A, E, I, J). **The re-verification rule
  paid again, and this time against a Strong entry of my own filing:** carried candidate **E** was
  two-thirds wrong — two sentences dead, the mechanism wrong in three places, the pattern count
  wrong (four of eight, not four of six) and the file wrong (`lib/sets.mjs`, not
  `commands/setup.mjs`) — so it is downgraded to *Worth exploring* and rewritten; carried **B** kept
  its strength but had the wrong mechanism (the contract cross-references `compareSnapshots`
  honestly for `errors`; it is `skipped` that is documented nowhere). Recorded as leave-alone:
  every pass-12 landing re-read and holding, plus five discarded findings (`render.mjs`'s remaining
  hand-built blocks, `bytesTotal`'s pre-pass, the `find` → `delete --from-file` contract,
  `validateBucketName`, and `network-status.mjs`'s refcount proxy under ADR-0069). The
  parked/rejected list was re-checked and stands untouched — three candidates brush a rejection
  (**D** two, **G** and **J** one each) and each says in its entry why it does not reopen it.
  Overwrote the HTML report in place.
- **2026-10-01 — A landed** ([PR #348](https://github.com/allens/s3cab/pull/348), grilled
  in-session, eight decisions asked one per turn; no ADR — the rule's record is `format.mjs`'s
  header and the lint). *Read the deletion record's instants through the clock seam.*
  `commands/delete.mjs` and `lib/deletion-record.mjs`'s `compactDeletionRecords` both read
  `localMoment("seconds").instant`, as `setup`'s `nowStamp` does; the written bytes are identical.
  `compactDeletionRecords` lost its `{ instant }` option — no production caller passed it — so its
  tests pin `Temporal.Now` instead, leaving one way to steer a recorded instant, not two.
  `delete.test.mjs` keeps its module mock but now pins the clock and asserts the instant's value,
  not only that the rows agree with the header. The model harness is unchanged.
  - **The open question became a lint rule, for one spelling.** A zero-argument `new Date()` is a
    `no-restricted-syntax` error in `src/` production code; `roles-anywhere.mjs`'s two (an X.509
    validity window, a SigV4 `amzDate`) carry a reasoned disable. `Date.now()` and `Temporal.Now`
    stay unlinted — they also serve elapsed time and deadlines, which a selector cannot tell apart —
    so `format.mjs`'s header now names all three spellings in prose. It also stopped claiming
    records are minted at `minutes` precision: they are named by index (ADR-0090) and take the
    instant alone.
  - **ESLint flat config replaces options, it does not merge them.** A later block's options for
    the same rule replace an earlier block's, so a `src/**` block holding only the clock selector
    would have silently dropped the `realpathSync` ban inside `src/`. The realpath selectors were
    hoisted to a shared constant both blocks spread; a probe confirmed `src/` still flags
    `realpathSync`.
  - **Two things the filing got wrong or missed.** The entry said `compactDeletionRecords`'
    default was "never executed by a test". It *was* executed — by every acting model-tier
    `cleanup` — but never *observed*: no model sequence drives `delete`, so no record existed to
    rewrite, and every direct test passed its own instant. And the grilling counted six
    `{ instant }` callers, all in the unit test; a grep during the build found a seventh in
    `test/integration/delete.test.mjs`, which never asserted the header.
  - Red first: four instant-asserting tests failed on wall-clock time under a pinned clock.
    `npm test` 1118 pass, integration 26 pass, Roles Anywhere live 3/3; CI green, Copilot raised
    nothing.
- **2026-10-01 — D landed** ([PR #343](https://github.com/allens/s3cab/pull/343), built in its own
  session from the [output-ux.md](output-ux.md) note; the record is
  [ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s two-part amendment). *Name the
  file the pass has in hand, and let the clock tick.* `WORTH_REPORTING_MS` now governs the
  measurement, not the name. `currentFile` is set in `getProps` and deliberately never cleared, and the
  pass concedes the event loop every 100 ms after each row.
  [snapshot.progress.test.mjs](../src/lib/snapshot.progress.test.mjs) drives the wiring through
  `through` under a fake `setInterval`.
  - **The entry's fix was right but not enough, and the gap became the fourteenth pass's O.** The
    entry predicted that one assignment in `getProps` would name every file. It did, and the line
    still didn't move, because its timer never fired: every stage is async in form but synchronous in
    the work it does, so the microtask queue never drains. The entry had no way to see that from the
    code. Measured in the PR at 1 ms a file: zero ticks in eight seconds.
  - **Half the entry was not done:** narrowing `onHashStart` to the byte cursor. `HashProgress` still
    carries `path`, so the name now travels three ways. That is smaller item **P**.
- **2026-10-02 — fourteenth pass.** Read the **2 `src/` commits since `3395305`** (9 files,
  +381/−55) at HEAD `f9bba9a`, both of them pass-13 landings (A in #348, D in #343). The steps:
  - one background sweep of the progress subsystem, as the organic friction walk, since #343 was
    where the code had moved;
  - hand re-verification of B, C and E–N, all of which hold, with anchors corrected for F, G, H and I;
  - a narrowing of I's second half (the `skipped` sum is deliberate, ADR-0078 §2);
  - hand verification of every sweep claim before it was written down.

  **New: O (Strong), plus smaller items P and Q.** Overwrote the HTML report in place.
  - **O was found by asking where else #343's fault lives.** #343 found event-loop starvation in the
    pass it was fixing and closed it there. The sweep then asked which other clock-driven line sits in
    front of synchronous work. The walk does, and its `countedPass` has never ticked. This was
    confirmed by running the real module under a scratch harness rather than by reading it, because
    reading it was exactly how pass 11 got it wrong.
  - **Pass 11's evidence for its A was misread, and the lesson outlives the entry.** That entry,
    retired from this log by this pass, said two things. First, a pass "whose caller only sleeps"
    advanced `0 in 1 sec` → `0 in 2 sec`. But sleeping is `await setTimeout`, which gives the loop
    turns, and the walk never sleeps. Second, a 402,000-file pty run "showed the count jump straight
    from the bare label to 2,000", read as the excluded descent yielding nothing. That jump is what a
    starved timer looks like: label, then tally, then nothing. The durable test,
    `progress.test.mjs`:187–208, has the same blind spot (:198, :203). **The general lesson: a test of
    a clock-driven line needs a caller that does not yield, or it tests the clock and not the line.**
  - **The sweep inferred one claim this pass did not run.** It said that deleting the concession
    (snapshot.mjs:544–548) leaves the suite green. That rests on the test file's own header
    (snapshot.progress.test.mjs:40–47, "the 100ms concession that lets it fire at all … still
    unasserted"), not on a mutation. It is recorded as the test's admission, not as a measured result.
  - **The rejected/parked list was re-checked and stands untouched.** O touches no rejection. It amends
    ADR-0076's consequence rather than its decision, and it leaves #343's declined chunked-read fix
    declined.
- **2026-10-02 — O landed, with P and Q** ([PR #355](https://github.com/allens/s3cab/pull/355),
  grilled in-session the same day). The record is
  [ADR-0093](../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md); it partly
  supersedes [ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md) and adds a consequence
  to [ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md). *Let a progress line tick where its
  caller never yields.*
  - **The clock.** `clockedLine` in `progress.mjs` has two hands: the timer, for callers awaiting I/O,
    and `tick()`, for synchronous ones. `countedPass` and `withProgress` are both built on it.
  - **The two passes.** The walk ticks per entry visited. The fused pass ticks per row, and it draws a
    figures-only closing frame when it runs to the end.
  - **The concession** (100 ms) moved into `propsRows`, beside the `signal.aborted` check it serves.
  - **P and Q went in as their own commit.** `HashProgress` lost `path`, and `activity` names a hash
    from `currentFile`. The test of the impossible both-in-flight state was deleted with it.
  - **Two additions the grilling did not settle, flagged in the PR:**
    - an `opening` option, for `countedPass`'s bare label;
    - `done(text)` writes nothing off a terminal, so the fused line stays silent there, as it always
      was.
  - **The settled "both hands stamp one last-drawn moment" covered one direction only.** Copilot
    caught the other:
    - **The gap.** A tick that drew left the interval on its own schedule. The timer could then draw
      again after part of an interval, and `createProgress`' 100 ms floor let that through.
    - **The fix.** Restart the interval whenever a tick draws (`841e6b7`). Its test failed before the
      fix.
    - **Why not `refresh()`** on a re-armed `setTimeout`: under `mock.timers` (Node 26.10),
      `refresh()` reschedules nothing. And mocking `setTimeout` also mocks the ESM-imported
      `node:timers/promises` sleep that the `countedPass` tests rely on.
  - **The concession is asserted at last.** This closes the gap pass 14 could record only from the
    test's own admission. The new real-SIGINT test in `snapshot-file.test.mjs` fails on its
    assertion with the concession disabled. It is skipped on `win32`, and passed 3/3 under WSL.
  - **Test results.**
    - `npm test`: 1169 tests, 1156 passed, 13 skipped.
    - Integration: 27 passed, 3 Roles Anywhere tests skipped.
    - CI green on all three OSes.
