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

Re-verified 2026-10-04 (fifteenth pass): **19 `src/` commits since `f9bba9a`** (58 files,
+3246/−2143), read at HEAD `7501768`. O, P and Q landed (#355), H landed as ADR-0092, and the stretch
also brought ADR-0094 (the change-time check opt-in), ADR-0095 (online-only files read like any
other) and restore's refused names (#350, #354, #365). **I and K are dead and deleted:** ADR-0094/0095
removed what I described, and `foldsCase` gained a production caller (`putsColonInName` in
[restore.mjs](../src/lib/restore.mjs)). **B is downgraded and F rewritten**; C, E, J, L and N hold with
anchors corrected in place; G and M are exact. **Four new candidates, R–U, and smaller items V–X.**
**R was a regression, confirmed by experiment and landed the same day:** #365 made
`writeFileAtomic`'s temp name always legal, which moved a refused name's failure from temp creation to
the `rename` after the full download, on a path that left the temp behind. It was pass 13's shape
again: the module gave a reason to remove its temp ("the caller may carry on past them (`restore`
does)") that held for two of its failures and was acted on for one.

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
(2) **Ordering constraints.** **F** and **U** both edit `readBaseline` in
[src/lib/snapshot.mjs](../src/lib/snapshot.mjs) (F also `generateSnapshot`), so build one, then
re-verify the other. **B**, **C**, **G** and **J** are independent of everything.
(3) **`.env.test` is gitignored and does not travel.** Every open candidate below is pure or local
and verifies with `npm test` alone.

- **A — The deletion record's instants were minted outside the clock seam that names them.**
  _Landed 2026-10-01 as [PR #348](https://github.com/allens/s3cab/pull/348) — see the run log._
- **B — `diff` is exported only for its test, and the rule about skipped paths lives outside it.**
  _Worth exploring — carried from the eleventh pass's smaller items; **downgraded from Strong**
  2026-10-04._ `diff` is [compare.mjs](../src/lib/compare.mjs):313; its **only** production call is
  :172, inside `compareSnapshots` itself, so the export exists so
  [compare.test.mjs](../src/lib/compare.test.mjs) can reach it. Both carve-outs are applied by
  mutating `diff`'s output afterwards: :182–184 (`untilSnapshot.errors`) and :193–195
  (`untilSnapshot.skipped`), each `deleted.delete(path)`. The contract (:279–312) documents the
  **errors** carve-out and honestly names `compareSnapshots` as its owner; the **skipped** one is in
  no contract, only in the inline comment inside the loop. **What the downgrade corrects:** the
  carve-outs are *not* on an untested side. compare.test.mjs:476 and :542 assert both through
  `compareSnapshots`, and the I/O-shell tests cover them again. What is left is a test-only export
  and a contract missing one line. The standing rejection of `diff` **as a module** does not bind.
  Minimal version: document the `skipped` rule where the `errors` rule already is. Real version:
  either move both carve-outs behind `diff`'s signature, or make `diff` module-private and let its
  tests cross `compareSnapshots`.
- **C — `forget`'s unrestorable preview is the only bucket-wide reader that never consults the
  deletion record.** _Strong — re-verified by hand 2026-10-04._
  [commands/forget.mjs](../src/commands/forget.mjs):185–190 calls `referencedObjects(set.bucket)`
  alone and hands the result to `planUnrestorable`, whose signature
  ([unrestorable.mjs](../src/lib/unrestorable.mjs):100–103) has no `deleted` parameter anywhere — where
  its sibling `planCleanup` ([cleanup.mjs](../src/lib/cleanup.mjs):75) takes
  `{ now = Date.now(), deleted = new Set() }`. Every other bucket-wide reader consults the record:
  `verify` partitions into `expectedMissing` ([verify.mjs](../src/lib/verify.mjs):64), `cleanup`
  subtracts it from the `missing` interlock (cleanup.mjs:94),
  [commands/restore.mjs](../src/commands/restore.mjs):213 reads it to skip gracefully, and
  [upload.mjs](../src/lib/upload.mjs):90 subtracts it from the baseline. `forget` is the fifth and the
  only abstainer. **C disagrees with a comment:** [bucket-scan.mjs](../src/lib/bucket-scan.mjs):36–37
  says `referencedObjects` stays exported "for `forget`, which needs the snapshot half alone". The
  grilling should settle which is right before code moves.
  **The consequence is a wrong number on the strongest confirmation prompt the tool has.** After a
  `delete` has removed content an old snapshot still lists, `planUnrestorable` — which reasons purely
  over snapshot references and never sees the store — counts those paths as files "you would no longer
  be able to restore" and their bytes as reclaimable, in the report header at unrestorable.mjs:320–327
  (`N files, holding X across M stored objects` … "Reclaim the space with: `s3cab cleanup <bucket>`")
  and in the table's "total unrestorable" row (:255–259).
  Both halves are false for that content: it cannot be lost, and there are no bytes to reclaim. This is
  precisely the line [CONTEXT.md](../CONTEXT.md)'s **Delete** entry already draws — "the removed content
  is simply **deleted** (not **unrestorable**, which stays `forget`'s preview word for content a
  snapshot removal would strand)". The vocabulary exists; `forget` is the one command that cannot see
  it. Fix: give `planUnrestorable` the same optional `deleted` set and subtract it in step 2 alongside
  the other sets (unrestorable.mjs:131–136), with `forget` reading the record after the snapshot scan:
  the same relative order `scanBucket` enforces for its own reads 1 and 3. `planUnrestorable` is pure
  and non-throwing by design, so the case tests as a fixture: no S3, no new seam.
- **D — The progress line goes blank on exactly the files that are slow.**
  _Landed 2026-10-01 as [PR #343](https://github.com/allens/s3cab/pull/343) — see the run log. Its
  "narrow `onHashStart` to the byte cursor" half was not done there. It landed later as smaller item
  **P**, in [PR #355](https://github.com/allens/s3cab/pull/355)._
- **E — `compileExclude` owns the pattern side; the walk owns the convention.** _Worth exploring —
  carried from the eleventh pass; anchors re-verified 2026-10-04._ `compileExclude` returns a bare
  `RegExp` ([exclude.mjs](../src/lib/exclude.mjs):21–27), and its JSDoc (:5–20) states one
  subject-side obligation, the `/`-separated subject. All three are implemented in
  `createWalkCallbackFn` ([walk.mjs](../src/lib/walk.mjs):381) and nowhere else: separator
  normalization (:393), the trailing-separator directory rule (:395–397) and `matchers.find`
  first-match-wins (:399). There is one production call (walk.mjs:384); `tree --excluded` reads the
  walk's `excluded` output (ADR-0080) and is not a second caller. **No test anywhere compiles a
  trailing-`/` _pattern_:** [exclude.test.mjs](../src/lib/exclude.test.mjs):41–42 tests a trailing-`/`
  *subject* against a `**` pattern, and [walk.test.mjs](../src/lib/walk.test.mjs) covers the directory
  form only end to end through a temp tree. The rule is a string test today
  (`compileExclude("/root/build/")` yields `^/root/build/$`); only the walk's append and its
  stop-descending need a tree. Four of `starterExclude`'s eight patterns are directory-form
  ([sets.mjs](../src/lib/sets.mjs):131–140), eight of fourteen in the dogfood
  [.s3cab/exclude.txt](../.s3cab/exclude.txt). Users are told what a trailing `/` means (the starter
  file's own header, sets.mjs:125–126); the compile side is what has no test. Shape if taken:
  normalization, the directory rule and first-match-wins move behind the module that owns the grammar.
  ADR-0088 governs the *token* grammar and says nothing about the subject side, so this **completes
  0088 rather than reopening it**. One production caller makes it a depth move, not a seam.
- **F — One run names its command twice: given to `readBaseline`, inferred by `generateSnapshot`.**
  _Worth exploring — rewritten 2026-10-04._ #360 gave `readBaseline` the command explicitly
  ([snapshot.mjs](../src/lib/snapshot.mjs):102, :107, used at :113 for the `--resume` refusal), but
  `generateSnapshot` (:224–227) still takes `through` and `transfer` as two independent optional
  parameters and rebuilds the command from whether `transfer` is set: the opening `Backing up` vs
  `Snapshotting` (:247), the `Storing objects in …` line (:258) and the `--resume` command offered if
  the lock turns out to be held (:342–345). The comment there says "naming the wrong one is not
  possible"; four test callers pass `through` alone
  ([snapshot.progress.test.mjs](../src/lib/snapshot.progress.test.mjs):127–129, :188–198, :220–231;
  [snapshot.unreadable.test.mjs](../src/lib/snapshot.unreadable.test.mjs):34–63). The :345 command is
  reachable only when another run takes the lock between `assertNoWorkFile` and the `wx` acquire, and
  no test reaches it; `withSnapshotFile` defaults it to `"s3cab backup --resume"` for tests' sake
  ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):255, :263), and
  [snapshot-file.test.mjs](../src/lib/snapshot-file.test.mjs):797 pins that default. Fix: the
  porcelain states the command once and it is carried into the pass (the baseline
  [backup.mjs](../src/commands/backup.mjs):88–114 already hands over is one carrier), and `through`
  and `transfer` arrive together or not at all. This disagrees with a comment, not an ADR.
- **G — ADR-0091's one user-visible promise is unpinned, because a stream is welded into a seam that
  is already curried.** _Worth exploring — anchors re-verified 2026-10-04, exact._ The
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
- **J — Two homes for the knob ↔ env-key mapping, one of which claims to be the only one.** _Worth
  exploring — anchors re-verified 2026-10-04._ [lib/provider.mjs](../src/lib/provider.mjs):21–23 (and
  :206–208) claims to be "the one home of the knob ↔ env-key mapping", with the three-mode exclusivity
  rule at :146–155 and the env keys written inline at :164–201;
  [commands/provider.mjs](../src/commands/provider.mjs):43–52 holds a second `knobs` table
  (knob → env keys) and :305–332 re-enumerates the same `"ra" | "profile" | "keys"` modes to decide
  which to clear on disk, under a header comment (:38–40) that still counts two modes. So a fourth
  credential mode would be rejected correctly at the option level by
  `gatherProviderConfig` and silently **not cleared** on disk by the command, and the endpoint's
  two-spelling rule is spread across three spots (`knobs.endpoint` clears both `AWS_ENDPOINT_URL_S3` and
  `AWS_ENDPOINT_URL`; `gatherProviderConfig`:184 writes only the `_S3` form;
  [env.mjs](../src/lib/env.mjs):51–52's `customEndpoint` resolves the precedence). Fix: move the table
  beside `gatherProviderConfig`/`readProviderConfig` and have the gather return the env keys its chosen
  mode replaces, so the command applies a list rather than deriving one. **Deliberately not the
  standing-rejected `credentialMode(env)` classifier** — nothing is classified from an env bag; a table
  moves and a return value grows. Named because the two sit next to each other.
- **O — Two lines run on a clock, each has half of what keeps it live, and the walk's clock never
  ticks.** _Landed 2026-10-02 as [PR #355](https://github.com/allens/s3cab/pull/355). See the run
  log; the record is
  [ADR-0093](../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md)._
- **R — A refused name costs a full download and leaves it behind as a temp.** _Landed 2026-10-04
  as [PR #366](https://github.com/allens/s3cab/pull/366). See the run log._
- **S — `FileChangedError` is a subclass nothing catches by type, and two docs say `backup` does.**
  _Landed 2026-10-04 as [PR #367](https://github.com/allens/s3cab/pull/367). See the run log._
- **T — Restore plans "copy from where the first one landed" before anything has landed.** _Landed
  2026-10-04 as [PR #368](https://github.com/allens/s3cab/pull/368). See the run log._
- **U — The parked lookup's lifecycle is claimed by one module and finished by another.** _Landed
  2026-10-05 as [PR #369](https://github.com/allens/s3cab/pull/369). See the run log._
- **Y — Both removers delete one object at a time, the shape C's branch just fixed for the HEADs.**
  _Worth exploring — surfaced 2026-10-05 by C's review
  ([PR #370](https://github.com/allens/s3cab/pull/370)), not by a pass._ `deleteHashes` in
  [commands/delete.mjs](../src/commands/delete.mjs) (after the deletion record is written) and
  `cleanup` in [commands/cleanup.mjs](../src/commands/cleanup.mjs) (over `orphanHashes`) each loop
  `await deleteStoredObject(bucket, hash)`. This hurts the many-small-files population: deleting a
  photo folder, or running `cleanup` after a `forget`, means thousands of round trips back to back.
  For 10,000 objects that is about 5 minutes at a 30ms round trip and about 97 at 580ms. The HEADs
  `storedObjectSizes` makes for the same 10,000 take about 8 seconds and 2 minutes, at 50 in flight
  (measured with [scripts/head-concurrency-bench.mjs](../scripts/head-concurrency-bench.mjs)). **The
  DELETE figures are extrapolated from that HEAD bench, not measured**; it would need a DELETE mode
  to confirm that 50 still holds. ADR-0069's non-goal is cross-object *upload* concurrency and
  doesn't reach the removers, but its bar (measured, not assumed) applies here too.
  **Shape:** a `deleteStoredObjects(bucket, hashes)` beside `storedObjectSizes` in
  [lib/objects.mjs](../src/lib/objects.mjs), with the same contract: at most 50 in flight, and the
  first failure rejects the call with no more started. Both commands call it, and the singular
  `deleteStoredObject` loses its last production caller. Two users of the generator pool in one
  module are the second case that earns a module-private pool helper (CLAUDE.md, working convention
  3). `HEAD_CONCURRENCY` is then misnamed, since 50 is the SDK's socket pool rather than a fact
  about HEADs. **The record-first rule is not at risk:** it orders the record before *any* delete
  ([docs/design/repository-protocol.md](../docs/design/repository-protocol.md), `delete` step 4),
  and nothing orders the deletes among themselves. A crash part-way still leaves an over-complete
  record, and `cleanup` still compacts records only after its deletes.
  **Not S3's DeleteObjects first** (1,000 keys per request). It answers 200 with per-key `Errors`,
  so success has to be read key by key. It is also an operation that *requires* a checksum, so
  `client()`'s required-only gate for custom endpoints
  ([s3-provider-compatibility.md](../docs/design/s3-provider-compatibility.md), item 4) doesn't
  remove it. Whether R2, B2 and Wasabi accept the SDK's CRC32 there in place of Content-MD5 is
  unverified. The pool runs on every provider that already runs `delete`.

**Smaller items (thirteenth pass)** — verified, too small for an entry of their own.
**L — Three spellings of "why this snapshot would not read".** [remote.mjs](../src/lib/remote.mjs):305
builds the finding's `reason` inline (`Error.isError(error) ? error.message : String(error)`);
[find.mjs](../src/lib/find.mjs):219 builds the same field with `errorText`
([error.mjs](../src/lib/error.mjs):311–322), which additionally unwraps a message-less
`AggregateError` rather than rendering blank. #364 added a third, inline, at
[snapshot.mjs](../src/lib/snapshot.mjs):381, which agrees with
[snapshot-file.mjs](../src/lib/snapshot-file.mjs):1079/:1110 only because it restates them. No leverage
today — the current error classes carry messages — offered as a consistency fix, not a defect.
Alongside it, [referenced.mjs](../src/lib/referenced.mjs):176–178 and :189 still name `delete` as one of three
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
does the least it can". There are four calls: [find.mjs](../src/lib/find.mjs):279 and
[restore.mjs](../src/lib/restore.mjs):16, :182 and :211. Only `find` reads `.base`, and only for a
basename matcher (find.mjs:157–158); restore reads `.path` and `.foldCase`. So a basename-only
search — the commonest — pays a whole-path
`replaceAll("\\", "/")` per Windows row for a field it never reads. **I did not measure it against
zstd decompression cost**, and the memory/async stance argues against pre-emptive fuss. Either a lazy
getter or letting `compileFindPattern`'s already-computed `wholePath` decide what the caller asks for.

**Smaller items (fourteenth pass).** **P** (the file in hand carried three ways) and **Q** (three
comments still describing the line before #343): _landed 2026-10-02 with **O** in
[PR #355](https://github.com/allens/s3cab/pull/355), as their own commit. See the run log._

**Smaller items (fifteenth pass)** — verified, too small for an entry of their own.
**V — The pipeline's caller lists are stale.** `readSnapshot`'s doc
([snapshot-file.mjs](../src/lib/snapshot-file.mjs):616–618) calls `readBaseline` "the only other
caller"; the real callers are `status`, `compare`, `find` and `upload`. `fileProps`'s doc
([file-props.mjs](../src/lib/file-props.mjs):78–80) says "both callers"; there are three (`prop`,
`generateSnapshot`, `uploadDir`). [lib/upload.mjs](../src/lib/upload.mjs):417–418 says unchanged "is
the same staleness test `fileProps` uses", false since ADR-0094 made the change-time half opt-in.
Same family at snapshot-file.mjs:311 and :506–507, commands/prop.mjs:17–19, commands/upload.mjs:49–50.
Each is one sentence; name the functions, not a count, or the next caller makes it stale again.
**W — Restore and `referenced.mjs` docs.** `renderRestore`'s doc
([render.mjs](../src/render.mjs):1287–1298) omits the `deleted` field, and :1295 runs past the
line length. [referenced.mjs](../src/lib/referenced.mjs):13–14 calls `cleanup.mjs`,
`unrestorable.mjs` and `verify.mjs` "pure planners with no runtime imports at all", which is false. `unrestorable.test.mjs`:172 says
"delete" where it means `forget`.
**X — `hashedFiles` counts empty files.** `fileProps`'s doc (file-props.mjs:92–93) promises no
`hashDuration` when nothing was read, but the `EMPTY_DIGEST` branch (:139–140) still returns one
(:147), so an empty file counts as hashed. Cosmetic.

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
**Examined & left alone (fifteenth pass).** `clockedLine`/`countedPass`, the tick wrapper and where
`CONCEDE_MS` sits (ADR-0093) — one mechanism, each piece argued where it stands. ADR-0092's tolerant
read and `recoverWorkFile`. `fileProps` after ADR-0095, and `prop --lookup` having no change-time
cut-off (deliberate); the ADR-0094/0095 removals are complete. `uploadObjects`' three sources,
`progressLine`, and `backup` handing `compare` its baseline. ADR-0086 collision detection
(model.hostile.test.mjs:308–368) and the `IntegrityError` path. `planRestore`/`selectEntries`/`reroot`
as pure functions. `shellCommand` and the
suggested-command layout (#360): three forms, all ADR-0030's. `sameSizeAndMtime` — speculative, since
`putFile`'s `ContentMismatchError` backstops it. Test-only exports used inside their own module, with
fixtures going through the production codec. Restore's failure kinds listed in five places — each
list serves a different reader. `error.mjs`'s remaining classes, each caught by type in
production; the dispatcher's render seam (s3cab.mjs:140–185); `render.mjs` as one file;
`BackupResult.errors`; `command-details.mjs`.

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
landed** (their run-log entries retired under the cap; git history keeps them) and **L was answered, no change** — `progress.mjs` owns the redraw-rate
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
have landed.

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
    `restore.downloads.test.mjs` asserts *"reports a recorded absence as deleted-with-date,
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
  call-graph verification (callers re-checked 2026-10-04). Each export is a real seam with a
  distinct caller: `parseCompressedSnapshotStream` ← `remote.mjs` (reads a snapshot straight from
  the S3 body stream, no temp file); `snapshotNames` ← `remote.mjs` (remote keys run through the
  same filter/sort as local names); `readSnapshotFile` ← `prop.mjs` (`--lookup <path>` reads a
  snapshot by path) and `readBaseline`; `readSnapshot` ← `status`/`compare`/`find`/`upload`.
  `parseSnapshotStream` is reached only inside its module and by its own test. The one shallow
  link, `readSnapshot → readSnapshotFile`, can't collapse because both are independently called.
  The reader half is genuinely deep.
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
> 2026-09-04 twelfth and its landings) recorded landings that are already of record in their ADRs, PRs and `git log`,
> and re-verification notes superseded by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

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
- **2026-10-04 — fifteenth pass.** Read the **19 `src/` commits since `f9bba9a`** (58 files,
  +3246/−2143) at HEAD `7501768`: ADR-0092–0095, the restore name-refusal work (#350/#354/#365) and
  #364's unreadable-file naming. Three background sweeps (rate-limited mid-run and resumed), then hand
  re-verification of the carried list: **I and K dead**, **B downgraded**, **F rewritten**, C and L
  wider, E, J and N re-anchored. **New: R and S (Strong), T and U (Worth exploring), smaller items
  V–X.** Top pick: **R**. Overwrote the HTML report in place.
  - **R was confirmed by experiment, not reading.** A scratch probe ran the real `writeFileAtomic`
    against a refused name: on NTFS both a 300-character name and `q?.txt` failed at `rename` with
    ENOENT and left the 100,000-byte temp; on ext4 the long name failed with ENAMETOOLONG.
  - **Why the regression hid.** The restore refusal tests fake `getObject`, so none reaches
    `writeFileAtomic`; and `putsColonInName`'s "measured" leftover temp was measured before #365
    renamed the temp. A doc that says *measured* is measured as of its commit.
  - **The rejected/parked list was re-checked.** T does not reopen pass 10's plan/execute verdict,
    and U does not reopen H's declined half (adoption stays explicit). The read-surface rejection's
    caller list was stale and is corrected; its reason holds.
- **2026-10-04 — R landed** ([PR #366](https://github.com/allens/s3cab/pull/366), grilled in-session,
  four decisions asked one per turn; no ADR, the rule lives in `writeFileAtomic`'s doc).
  - **`writeFileAtomic` removes its temp on any failure**, a torn stream included, and drops the
    cleanup's own error so it can't mask the one `restore` classifies. Only process death leaves a
    temp. The old reason for leaving a torn stream's temp, not masking the real error, is met by
    dropping the cleanup error instead.
  - **A refused dedup copy no longer downloads.** `copyFile` names its source whichever side failed,
    so restore asks whether the source still exists; only a vanished one is fetched.
  - **Declined: refusing a fetch before it downloads.** Probing the final name would create a file at
    the destination, which a crash would leave there empty, for a later restore to skip as present.
    String rules in `planRestore` would duplicate each filesystem's limits and reverse #354's choice
    of the filesystem's own answer.
  - **Tests now reach the real landing path.** `restore.missing-object.test.mjs`'s fake `getObject`
    writes through the real `writeFileAtomic`, and fails on the old module. Copilot caught that no test
    made the cleanup itself fail; `atomic-file.cleanup-fails.test.mjs` mocks `rm` to reject and fails
    with the `.catch` removed.
  - `npm test` 1176 pass; integration 27 pass, 3 Roles Anywhere skipped; CI green on all three OSes.
- **2026-10-04 — S landed** ([PR #367](https://github.com/allens/s3cab/pull/367), grilled in-session,
  two decisions asked one per turn; no ADR, since error.mjs's taxonomy already decided it).
  - **`fileChangedError` returns a plain `Error`; the class is gone.** ADR-0069's table and ADR-0083
    now name the factory; neither decision changed.
  - **`backup.test.mjs` asserts the factory's exact message** in place of an `instanceof` checking the
    test's own mock. The model tier keeps its message match and drops the `error.name` check.
  - **Declined (Copilot): asserting `name === "Error"`.** It pins construction nothing reads, and it
    would fail a correct later subclass that arrives with a real catch site.
  - Also fixed the pass-15 commit's broken `render.mjs` link, which failed the documentation-links
    test on `main`.
  - `npm test` 1176 pass; CI green on all three OSes.
- **2026-10-04 — T landed** ([PR #368](https://github.com/allens/s3cab/pull/368), grilled in-session,
  three decisions asked one per turn; ADR-0086 amended in place).
  - **`planRestore` decides only skip, refuse or write; the loop owns dedupe.** One `fateByHash` map
    (landed, absent or corrupt) replaces three sets, and `RestoreStep` is a union, so no step casts
    its hash. #366's vanished-source check on the copy is kept.
  - **A behaviour fix rode along.** Behind a refused or collided first holder, every later holder used
    to download again; now the next one fetches and the rest copy from it. ADR-0086 had recorded the
    re-download as a trade-off, so it was amended rather than overridden.
  - **Tests.** `restore.missing-object.test.mjs` became `restore.downloads.test.mjs` (W's naming half)
    with a shared-content group; both redirect tests fail on the old code. `planRestore`'s copy
    assertions moved to the command tier.
  - **Copilot: two wording fixes.** A name refused at the rename has already downloaded, so the docs
    now say later paths copy "once it has landed", not that shared content downloads once.
  - `backup.md`'s pre-#366 fallback paragraph was corrected in its own commit.
  - `npm test` 1178 pass, 13 skipped; integration 27 pass, Roles Anywhere live 3/3; CI green on all
    three OSes.
- **2026-10-05 — U landed** ([PR #369](https://github.com/allens/s3cab/pull/369); no ADR, since
  ADR-0094's decision 4 doesn't say where the check lives).
  - **`readParkedLookup(snapshotDir, notBefore)` returns nothing for a stale file**, one parked by a
    run that started before the previous snapshot. `readBaseline` passes that instant and only warns
    when it reuses parked hashes.
  - **The stale file stays on disk.** The read runs before the lock, so a run parking at that moment
    could have replaced it; the next landed snapshot's delete removes it anyway.
  - **Unchanged, as the entry asked:** `--resume`'s adopt-or-refuse and the `--rehash` early return
    stay ahead of the read.
  - **Tests.** Two reader tests, a millisecond either side of the boundary; the stale one fails on the
    old reader. The command-tier test stays, as the guard on `readBaseline` passing the instant.
  - `npm test` 1180 pass, 13 skipped; no S3 path touched. Copilot raised nothing.
