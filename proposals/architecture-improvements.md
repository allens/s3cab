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

Surfaced 2026-10-09 (sixteenth pass): **22 `src/` commits since `7501768`** (66 files,
+1810/−923), read at HEAD `2820adf`. Most of them are the fifteenth pass's own landings
(#366–#380), which hold up. The new behaviour is gzip snapshots (ADR-0097, #381), exclude lines
offered for files that failed last time (#385), a name with a line break kept on one row (#388), an
empty `exclude.txt` read as none (#374) and the progress wording (#382). Three background sweeps
(the new behaviour, pass 15's landings, the carried list plus the uncovered remainder); every claim
was checked by hand before it was written down, and the **suggested exclude line** by experiment.

**Verdict: a module writes a path into a grammar it doesn't own.** Backup builds an exclude line
without the rules that read it back (**suggested exclude line**). `tree` writes a tab-separated row
without the guard the snapshot's rows get (**tree's tab-separated output**). The codec check is
split, so the damage classifier knows zlib's error codes (**codec damage on both sides**).

**Picking these up cold (a later session, or another machine).**
(1) **Line anchors rot on every landing, and so do file paths.** Two files of the same name exist in
`src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`, `provider.mjs`,
`snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify before trusting any
anchor.
(2) **Ordering constraints.** None hard. **Tree's tab-separated output** and **codec damage on both
sides** both edit `src/lib/snapshot-file.mjs`, so land one before starting the other.
(3) **`.env.test` is gitignored and does not travel.** Every open candidate below is pure or sits
behind the `s3.mjs` fake, and verifies with `npm test` alone.

- **Suggested exclude line — Backup's suggested exclude line is the exclude grammar run backwards,
  outside the grammar.** _Strong; sixteenth pass, verified by experiment 2026-10-09 on Windows and
  Linux._ #385's `excludePattern` ([backup.mjs](../src/commands/backup.mjs):235, called :219)
  returns `relative(root, path)`, built without [read-lines.mjs](../src/lib/read-lines.mjs)'s
  `parseLines` (trims; `#` starts a comment) or [path-match.mjs](../src/lib/path-match.mjs)'s
  `globSource` (`*` and `?` are wildcards; there is no escape). Read back through the real
  `compileExcludePatterns`, a name starting with `#` becomes a comment and one starting with a space
  is trimmed, so neither excludes its file and both are offered again every run. On Linux and macOS
  a name holding `?` or `*` excludes itself and also, silently, its siblings (`a?.pst` drops
  `ab.pst`). **Fix:** an inverse beside `compileExcludePatterns` in
  [exclude.mjs](../src/lib/exclude.mjs) — the line that matches exactly that path, or nothing when
  the grammar has no exact spelling — and the render says to rename the file or write the pattern
  by hand. One adapter, so the gain is correctness and locality, not leverage. **Tests:**
  backup.test.mjs:252–288 checks only the string's shape. The new test is the round trip,
  `compileExcludePatterns(root, parseLines(line))(path)` matching the path and not a sibling.
- **Forget plans twice — `forget` runs the whole unrestorable plan to learn which hashes to HEAD,
  then runs it again.** _Worth exploring; sixteenth pass, left over from #370._
  [forget.mjs](../src/commands/forget.mjs):189 calls `planUnrestorable` for `.orphaned`, intersects
  that with the deletion record, HEADs the result through `storedObjectSizes`, and :206 calls it
  again with `{ gone }`. The HEAD-candidate rule is a comment in the command (:191–194) while the
  `gone` parameter it feeds is in [unrestorable.mjs](../src/lib/unrestorable.mjs), and
  `UnrestorablePlan.orphaned` (:64) is read only at forget.mjs:189 and in unrestorable.test.mjs:171.
  **Fix:** a pure lib function for "the recorded hashes this forget would orphan";
  `planUnrestorable` runs once and loses `orphaned`. Unmeasured, and correctness is unaffected;
  forget.test.mjs's `headCalls` test pins the rule and should stay green. Since #391,
  `getUndeletedHashes` ([upload.mjs](../src/lib/upload.mjs)) makes the same intersect-and-HEAD step,
  so that function would have a second caller.
- **Tree's tab-separated output — `tree --excluded` writes a tab-separated row with none of the
  guard the snapshot's rows get.** _Worth exploring; sixteenth pass, read, not run._
  [render.mjs](../src/render.mjs):537's `renderTree` writes `` `${entry.path}\t${entry.pattern}` ``
  raw, though its doc picks the tab "for the same reason snapshots use one". #388 taught the
  snapshot writer to spell out an excluded name holding a line break, and the walk refuses to back up
  a name with a tab or line ending and suggests excluding it ([walk.mjs](../src/lib/walk.mjs):310–323)
  — exactly the name that splits tree's row. The rule itself, `UNREPRESENTABLE_IN_TSV` (walk.mjs:53),
  lives in the walk, whose header (:28–31) says it "stays ignorant of the snapshot grammar", and
  [snapshot-file.mjs](../src/lib/snapshot-file.mjs) imports it back (:20, :593). **Fix:** the rule
  moves to the grammar's owner, snapshot-file.mjs, and `renderTree` uses it: spell the name out as
  #388 does, or refuse it (a design call). [bugs.md](bugs.md)'s entry on names that aren't valid
  UTF-8 is a third kind of name a row can't hold, and belongs with this rule if it is ever handled.
- **Codec damage on both sides — gzip damage is known on both sides of the reader.** _Worth
  exploring; sixteenth pass, new in #381._ `parseCompressedSnapshotStream`
  ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):806–836) folds only `Z_BUF_ERROR` into its
  "Truncated snapshot" assertion and lets `Z_DATA_ERROR` through raw, while
  [referenced.mjs](../src/lib/referenced.mjs):97's `isCorruptSnapshotError` matches
  `AssertionError`, `Z_DATA_ERROR` or `Z_BUF_ERROR`. So the classifier's `Z_BUF_ERROR` arm is
  unreachable in production, and #381 had to edit both modules. No test feeds bad bytes through the
  real reader into the classifier: remote.referenced-scan.test.mjs (:44–47, :74–76) throws a
  hand-built `Z_DATA_ERROR` from `getStream`, before anything decompresses. **Fix:** the reader turns
  every codec failure into its own damage error and leaves the source's errors raw, which keeps
  integration remote.test.mjs's "a dropped connection is not damage" true; the classifier then names
  no codec. Does not reopen ADR-0028 or the codec-split rejection: knowledge moves *into*
  snapshot-file.mjs, and no read export goes away.

**Smaller items (sixteenth pass)** — verified, too small for an entry of their own. The thirteenth
and fifteenth passes' items that still hold are carried here, re-anchored.
**Provider's switch re-spells the env keys.** _Worth exploring, small; left over from #380._
lib/provider.mjs calls itself "the one home of the knob ↔ env-key mapping", but `replacedName`
([commands/provider.mjs](../src/commands/provider.mjs):52–61) reads `AWS_PROFILE`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` itself, and the `--unset` naming ternary (:270–275)
is untyped. Routing it through `readProviderConfig` is a behaviour change to decide: that sees no
secret-only set.
**A set with no bucket breaks every "which set?" listing.** _Speculative._
[sets.mjs](../src/lib/sets.mjs)'s "unknown set" (:333) and "several sets" (:400) errors list every
set through the strict `readSet`, so a hand-edited sibling without `S3CAB_BUCKET` replaces "Unknown
backup set: typo" with that sibling's error. Its message is actionable, so this may be acceptable
fail-fast.
**Three failure-reason spellings — now five spellings of "why this would not read".**
[remote.mjs](../src/lib/remote.mjs):305 and [snapshot.mjs](../src/lib/snapshot.mjs):358 build it
inline (`Error.isError(error) ? error.message : String(error)`); [find.mjs](../src/lib/find.mjs):219
uses `errorText` ([error.mjs](../src/lib/error.mjs):291), which also unwraps a message-less
`AggregateError` rather than rendering blank; [backup.mjs](../src/commands/backup.mjs):154 tests
`instanceof Error`; [auth.mjs](../src/lib/auth.mjs):48 has its own `reasonFrom`. No leverage today
— the current error classes carry messages — so a consistency fix, not a defect.
**`preparePath`'s unread fields.** _Speculative, and unmeasured._ path-match.mjs:70's doc says it
is "called once per row of every snapshot in history, so it does the least it can". There are four
calls: find.mjs:279 and [restore.mjs](../src/lib/restore.mjs):16, :166 and :195. Only `find` reads
`.base`, and only for a basename matcher; restore reads `.path` and `.foldCase`. So a basename-only
search — the commonest — pays a whole-path `replaceAll("\\", "/")` per Windows row for a field it
never reads. Not measured against gzip decompression. Either a lazy getter, or let
`compileFindPattern`'s `wholePath` decide what the caller asks for.
**`hashedFiles` counts empty files.** `fileProps`' `EMPTY_DIGEST` branch
([file-props.mjs](../src/lib/file-props.mjs):139–140) still returns a `hashDuration` (:147), so an
empty file counts as hashed. `fileProps`' own doc is accurate; what this contradicts is
snapshot.mjs:345–354 ("only on a path that actually hashed") and `SnapshotPass`'s "really read and
hashed". Cosmetic.
**The empty file's hash is spelled twice.** [commands/delete.mjs](../src/commands/delete.mjs):20
writes `EMPTY_FILE_HASH` as a literal; file-props.mjs:34 derives `EMPTY_DIGEST`, "so it cannot be
mistyped".
**Debug decompression outside the codec's owner.** _Speculative._ snapshot.mjs:369–375's debug
branch imports `createGunzip` and spells `.snapshot.tsv` itself. A debug aid with one caller.
**Stale prose.** remote.mjs:172–173 says the `backup`/`status` diff fetches this way (`backup` no
longer does); [commands/cleanup.mjs](../src/commands/cleanup.mjs):15 calls the command "the
read-only twin of `verify`", though it deletes; [compare.mjs](../src/lib/compare.mjs):428 says "no
header", where `readBaseline` now parses it; [objects.mjs](../src/lib/objects.mjs):186 says "50 at a
time" where `REQUESTS_IN_FLIGHT` is meant, and its header list predates HEAD and DELETE.

**Examined & left alone (sixteenth pass)** (not candidates — skip future runs). **Pass 15's
landings hold:** `eachInFlight`, `storedObjectSizes` and `deleteStoredObjects` (one private pool,
two callers, its failure contract asserted); `REQUESTS_IN_FLIGHT`, exported only for the crash test
(#383), which needs the bound to aim its kill; `writeFileAtomic` after #366; restore's `fateByHash`
and `RestoreStep`; `readParkedLookup`'s `notBefore`; `compileExcludePatterns`; `settingKeys` and
`replaces`, apart from the provider smaller item; `inProgressError`. **The new behaviour:** the gzip
settings sit at one site and are pinned byte for byte; in code, `.tsv.gz` is spelled only in
snapshot-file.mjs; the tolerant reads go through one option; #374's "empty means none" is owned by
set-marker.mjs in both directions; #385's "failed last time" has one source (`readBaseline`'s
`previousErrors`), and its data and wording are split as ADR-0043 says; #382's wording lives in
snapshot.mjs with tests through `progressLine`. **Elsewhere:** `setup` and `reattach` share a
four-step validation preamble, but a helper there would be shallow; the dispatcher, `tree`, and
verify/cleanup/bucket-scan; `planUpload` and `uploadObjects`' predicate are documented twins;
`#ERROR`'s raw reason is safe while every message reaching it is one line.

---

Surfaced 2026-10-01 to 2026-10-04 (thirteenth to fifteenth passes), read at HEADs `3395305`,
`f9bba9a` and `7501768`. The thirteenth pass's verdict: **a module that states a rule in prose
_about itself_ which its own code does not keep** (the clock seam's "and nowhere else",
`lib/provider.mjs`'s "the one home of the knob ↔ env-key mapping"). _Nothing from these passes is
still open._ Every candidate landed (PRs #343–#380) except **`diff`'s test-only export**, rejected; the torn
work file's declined half is in *Rejected & parked*; their smaller items that still hold are carried
above.

**Examined & left alone (thirteenth pass)** (not candidates — skip future runs). **Pass 12's own
landings all hold up**, which is the most useful thing this pass can say about them:
[bucket-scan.mjs](../src/lib/bucket-scan.mjs) — the ordering invariant is the module's *body* rather
than a comment at two call sites, and its test pins it at the `s3.mjs` seam including the half a
call-order assertion cannot see (a held snapshot GET proving the objects LIST has not *begun*); both
consumers destructure and re-derive nothing. [test/helpers/s3-seam.mjs](../test/helpers/s3-seam.mjs) —
the asymmetric defaults are a real design argument and `test/s3-seam.test.mjs` keeps the surface honest
in both directions *and* guards its own blind spot (a namespace or dynamic import fails loudly rather
than leaving the check silently blind); this is the model the clock seam lacked when the **clock seam bypass** was filed
(it landed a lint rule, for the `new Date()` spelling only).
[test/helpers/enumeration.mjs](../test/helpers/enumeration.mjs) — fixtures go through
`addSnapshotReferences`, the production fold, so a test cannot hold a shape a real read would not
produce. `format.mjs`'s `localMoment`/`completionInstant`/`readClock` **as a seam** — one clock read
behind both doors, round-up rule argued and pinned; the **clock seam bypass** was about the two callers that bypassed it, not
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
**Examined & left alone (fourteenth pass).** Every other progress line, checked for the **walk's silent clock**'s
fault, and none has it. The store scan's counted pass ([upload.mjs](../src/lib/upload.mjs):138) and both of
`find`'s (find.mjs:259, :379) are fed by real async I/O (a network page, a zstd/readline stream), so
their timers get turns. `restore` pushes on `due()` over real async writes and owns no timer. The
per-file upload bar in `s3.mjs` is driven by the SDK's progress events. `network-status.mjs` has no
timer at all. The **walk's silent clock** is the walk and the fused pass only, the two places where synchronous work runs in
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
**walk's silent clock**. **D landed
2026-08-07**, and **H was rejected** the same day (see *Rejected & parked*). The twelfth pass
re-verified the rest: **B, C and G carried forward** as the twelfth pass's **C**, **E** and **J**,
**F survives only as I**, and **I is dead**. The thirteenth pass then took the last two: this
pass's **E** (`compileExclude`'s subject-side convention) and the `compare`/`diff` smaller item
carry forward as the thirteenth pass's **exclude subject side** and **`diff`'s test-only export**, both **rewritten** — each had been filed
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
membership, `getUndeletedHashes` wants the recorded hashes still present) — distinct questions per consumer, the same reasoning that
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

- **Recovering a torn work file inside `withSnapshotFile`, as a rename at the moment the `wx`
  acquire is won** (the half of the thirteenth pass's "torn work file" not taken when it was built
  as [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md)) — declined 2026-10-01. It
  would make the exclusion proof and the recovery one event, and so make adoption *automatic*,
  which ADR-0048 refuses: winning the acquire proves only that no run holds the file *now*, which is
  also true a moment after a live run dies, and the user remains the liveness check. The ordering
  hazard the entry named is real, and `--resume` in `readBaseline` answers it: nothing is adopted
  unless a person says so. Re-open only if ADR-0048 changes.
- **Making `diff` private to compare.mjs** (was open as "`diff`'s test-only export") — rejected
  2026-10-07. Its tests would each need a snapshot file on disk in place of an in-memory Map; the
  reason is `diff`'s doc comment. The carve-outs it also named are asserted through
  `compareSnapshots`, and its contract documents both.
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
> 2026-10-01 thirteenth and its landings) recorded landings that are already of record in their ADRs, PRs and `git log`,
> and re-verification notes superseded by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

- **2026-10-02 — fourteenth pass.** Read the **2 `src/` commits since `3395305`** (9 files,
  +381/−55) at HEAD `f9bba9a`, both of them pass-13 landings (the clock seam bypass in #348, the blank progress line in #343). The steps:
  - one background sweep of the progress subsystem, as the organic friction walk, since #343 was
    where the code had moved;
  - hand re-verification of every other pass-13 entry, all of which hold, with anchors corrected
    for command named twice, unpinned retry window, torn work file and backup's figures;
  - a narrowing of backup's figures' second half (the `skipped` sum is deliberate, ADR-0078 §2);
  - hand verification of every sweep claim before it was written down.

  **New: walk's silent clock (Strong), plus smaller items file in hand three ways and pre-#343
  comments.** Overwrote the HTML report in place.
  - **The walk's silent clock was found by asking where else #343's fault lives.** #343 found event-loop starvation in the
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
  - **The rejected/parked list was re-checked and stands untouched.** The walk's silent clock touches no rejection. It amends
    ADR-0076's consequence rather than its decision, and it leaves #343's declined chunked-read fix
    declined.
- **2026-10-02 — Walk's silent clock landed, with file in hand three ways and pre-#343 comments** ([PR #355](https://github.com/allens/s3cab/pull/355),
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
  - **File in hand three ways and pre-#343 comments went in as their own commit.** `HashProgress` lost `path`, and `activity` names a hash
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
  re-verification of the carried list: **backup's figures and idle `foldsCase` dead**, **`diff`'s test-only
  export downgraded**, **command named twice rewritten**, forget's blind preview and three
  failure-reason spellings wider, exclude subject side, two knob tables and `preparePath`'s unread
  fields re-anchored. **New: refused-name download and uncaught `FileChangedError` (Strong),
  restore's early copy plan and parked lookup lifecycle (Worth exploring), and three smaller
  items.** Top pick: **refused-name download**. Overwrote the HTML report in place.
  - **The refused-name download was confirmed by experiment, not reading.** A scratch probe ran the real `writeFileAtomic`
    against a refused name: on NTFS both a 300-character name and `q?.txt` failed at `rename` with
    ENOENT and left the 100,000-byte temp; on ext4 the long name failed with ENAMETOOLONG.
  - **Why the regression hid.** The restore refusal tests fake `getObject`, so none reaches
    `writeFileAtomic`; and `putsColonInName`'s "measured" leftover temp was measured before #365
    renamed the temp. A doc that says *measured* is measured as of its commit.
  - **The rejected/parked list was re-checked.** Restore's early copy plan does not reopen pass 10's plan/execute
    verdict, and parked lookup lifecycle does not reopen the torn work file's declined half (adoption stays explicit). The read-surface rejection's
    caller list was stale and is corrected; its reason holds.
- **2026-10-04 — Refused-name download landed** ([PR #366](https://github.com/allens/s3cab/pull/366), grilled in-session,
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
- **2026-10-04 — Uncaught `FileChangedError` landed** ([PR #367](https://github.com/allens/s3cab/pull/367), grilled in-session,
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
- **2026-10-04 — Restore's early copy plan landed** ([PR #368](https://github.com/allens/s3cab/pull/368), grilled in-session,
  three decisions asked one per turn; ADR-0086 amended in place).
  - **`planRestore` decides only skip, refuse or write; the loop owns dedupe.** One `fateByHash` map
    (landed, absent or corrupt) replaces three sets, and `RestoreStep` is a union, so no step casts
    its hash. #366's vanished-source check on the copy is kept.
  - **A behaviour fix rode along.** Behind a refused or collided first holder, every later holder used
    to download again; now the next one fetches and the rest copy from it. ADR-0086 had recorded the
    re-download as a trade-off, so it was amended rather than overridden.
  - **Tests.** `restore.missing-object.test.mjs` became `restore.downloads.test.mjs` (the naming half of restore and `referenced.mjs` docs)
    with a shared-content group; both redirect tests fail on the old code. `planRestore`'s copy
    assertions moved to the command tier.
  - **Copilot: two wording fixes.** A name refused at the rename has already downloaded, so the docs
    now say later paths copy "once it has landed", not that shared content downloads once.
  - `backup.md`'s pre-#366 fallback paragraph was corrected in its own commit.
  - `npm test` 1178 pass, 13 skipped; integration 27 pass, Roles Anywhere live 3/3; CI green on all
    three OSes.
- **2026-10-05 — Parked lookup lifecycle landed** ([PR #369](https://github.com/allens/s3cab/pull/369); no ADR, since
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
- **2026-10-05 — Forget's blind preview landed** ([PR #370](https://github.com/allens/s3cab/pull/370); ADR-0064 amended
  in place, since it had accepted the overstatement).
  - **`forget`'s preview leaves out content a `delete` already removed**, and the summary and report
    header say how many files that was. `planUnrestorable` takes an optional set of hashes confirmed
    gone and returns the orphaned hashes and that count.
  - **Not the record alone, as the entry proposed.** Deleted content re-uploads on the next backup
    and its row stays, so subtracting every recorded hash would hide a real loss. `forget` HEADs only
    the recorded hashes the preview would count as lost. That settles the comment the entry disagreed with:
    `forget` needs no objects LIST, and bucket-scan.mjs now says why.
  - **50 HEADs in flight (Copilot).** `storedObjectSizes` replaced `storedObjectSize` for `delete`'s
    preflight and `forget`'s preview. 50 is the SDK's socket pool, measured as the ceiling at round
    trips of 30ms, 55ms and 580ms with `scripts/request-concurrency-bench.mjs`, kept to re-run. The
    removers' one-at-a-time deletes are the same shape, filed as **one-at-a-time removers**.
  - **Tests.** `storedObjectSizes` keeps the order given, holds 50 in flight and starts none after a
    failure; `forget` stops before the prompt when the check fails.
  - **Copilot, declined:** rewording the last-snapshot warning when everything the set alone holds
    was already deleted. The set then keeps nothing, so "loses everything the set alone was keeping"
    stays true, and the deleted-content note sits directly above it.
  - `npm test` 1189 pass, 12 skipped on `main` after the merge; CI green on all three OSes, real-S3
    job included.
- **2026-10-06 — One-at-a-time removers landed** ([PR #371](https://github.com/allens/s3cab/pull/371); no ADR).
  - **`deleteStoredObjects(bucket, hashes)` replaced `deleteStoredObject`**, 50 in flight, the first
    failure rejecting with no more started. `delete` and `cleanup` each make one call; `delete`
    still writes the record first.
  - **One private pool, `eachInFlight`,** now serves it and `storedObjectSizes`. `HEAD_CONCURRENCY`
    became `REQUESTS_IN_FLIGHT`.
  - **Measured, not extrapolated.** The bench gained a DELETE mode and became
    `scripts/request-concurrency-bench.mjs`; at a 37ms round trip the knee for DELETEs is 50, as for
    HEADs.
  - **Not DeleteObjects,** for the reasons the entry gave; the rejection is a comment on
    `deleteStoredObjects`.
  - **Tests.** `deleteStoredObjects` deletes each `objects/<hash>`, holds 50 in flight and starts
    none after a failure.
  - **Copilot, declined:** a separate concurrency for the bench's untimed DELETE targets (the timed
    phase already sends up to 64), and capping the pool's workers at the hash count (an idle worker
    costs microseconds against one round trip).
  - `npm test` 1192 pass, 12 skipped on `main` after the merge; integration 27 pass before it; CI
    green.
- **2026-10-06 — Command named twice landed** ([PR #375](https://github.com/allens/s3cab/pull/375); ADR-0092 reworded
  from "two commands" to "two remedies").
  - **The lock-held error no longer names a command.** It says to run the same command again with
    `--resume`; the delete stays pasteable. Nothing passes a command or a remedy string into the
    snapshot lib any more, so there is no second naming to disagree with the first.
  - **Two shapes built and dropped.** Carrying `command: "backup" | "snapshot"` on the baseline had
    the lib knowing its callers. Each porcelain building the string and passing it four levels down
    was correct, but too much plumbing for one pasteable line, and it dropped any other options the
    user typed. The departure from ADR-0030's pasteable form is a comment on `inProgressError`.
  - **Not taken: "`through` and `transfer` arrive together".** With the command gone, the verb and
    the Storing line key on `transfer` alone, whether this pass is sending, and `through` alone is a
    test hook with nothing to contradict.
  - **Copilot**: its one comment asked to pin the verb to the command, which the final shape drops;
    declined on the thread.
  - `npm test` 1191 pass, 13 skipped; no S3 path touched.
- **2026-10-06 — Unpinned retry window landed** ([PR #376](https://github.com/allens/s3cab/pull/376); no ADR).
  - **The gap was a test, not a seam.** `formatDuration` rounds to the second, so the few real
    milliseconds a test spends leave the full window and what is left of it both printing
    `up to 2 minutes`; reverting the relay to `windowMs` passed everything. The new relay test fakes
    `Date.now` so the second failure surfaces 90 s in, asserts `up to 30 seconds`, and was checked red
    against that revert.
  - **Not taken: the stream parameter.** Production has one stream, so it would be a seam with one
    adapter, kept for tests, and the `process.stderr.write` patch already works. The rejection is
    `captureStderr`'s comment in s3.test.mjs, which also drops the false "no stream to inject through
    SDK middleware".
  - **Copilot**: no comments.
  - `npm test` 1192 pass, 13 skipped; no `src/` behaviour touched.
- **2026-10-06 — Exclude subject side landed** ([PR #378](https://github.com/allens/s3cab/pull/378),
  grilled in-session; no ADR, since the rules are the doc comment on `compileExcludePatterns`).
  - **The whole match moved, not just the path's half.** `compileExcludePatterns(baseDir, patterns)`
    returns `(path, isDirectory) => pattern | undefined`, and owns the join onto the root, `\` → `/`
    on both sides, the directory's trailing `/` and first-match-wins. The walk's callback keeps the
    type triage and the two record lists.
  - **`isDirectory`, not the walk's `fileType` string**, so exclude.mjs never depends on the
    `"Directory"` spelling `getFileType` owns.
  - **One export.** The per-pattern compile is private, and the tests cross the walk's interface:
    the old trailing-`/` *subject* test now reads `excludedBy(["build/**"], "/root/build", true)`,
    and new ones cover a trailing-`/` pattern against a file and a directory, first-match-wins and a
    `\`-separated path.
  - **Not taken: the `.s3cab` skip.** It matches no pattern and records no row; moving it would
    have made those directories show up as `#EXCLUDED`.
  - **Left as of record:** ADR-0073, ADR-0088 and the ADR index still say `compileExclude`.
  - `npm test` 1194 pass, 13 skipped; behaviour unchanged.
- **2026-10-07 — Two knob tables landed** ([PR #380](https://github.com/allens/s3cab/pull/380); no ADR).
  - **The table moved; the gather names what it replaces.** `settingKeys` sits in lib/provider.mjs, and
    `gatherProviderConfig` returns `replaces`: the credential modes it did not choose. The command
    clears those instead of re-deriving them.
  - **Returns modes, not env keys** as the entry proposed: the confirmation names each replaced mode,
    and each mode keeps its own presence rule (`S3CAB_RA` counts only as `1`, pinned by a test that
    caught a generic "any key set" check).
  - **A fourth mode is now a compile error, not a silent miss.** Adding one to `CredentialMode` fails
    `typecheck` at `settingKeys` and at the command's `replacedName` until both name it; checked by doing so.
  - **Not taken: the endpoint's two spellings.** The write and the clear still sit apart; the
    clear's reason is the comment on `settingKeys.endpoint`.
  - `npm test` 1194 pass, 13 skipped; behaviour unchanged.
- **2026-10-09 — sixteenth pass.** Read the **22 `src/` commits since `7501768`** (66 files,
  +1810/−923) at HEAD `2820adf`: pass 15's landings, gzip snapshots (ADR-0097), #385's exclude
  suggestions and #388's line-break names. Three background sweeps, then every claim checked by
  hand. **New: status forgets the deletion record and the suggested exclude line (Strong); forget
  plans twice, tree's tab-separated output and codec damage on both sides (Worth exploring); five
  new smaller items.** Top pick: **status forgets the deletion record**. Overwrote the HTML report
  in place.
  - **The suggested exclude line was confirmed by experiment.** A scratch probe sent
    `relative(root, path)` back through the real `parseLines` and `compileExcludePatterns`, on
    Windows and on Linux: `#notes.pst` read back as a comment and ` lead.pst` trimmed, so neither
    excluded itself on either OS, and on Linux `a?.pst` and `a*.pst` also excluded `ab.pst`.
  - **Status's missing test was proved, not assumed.** A grep of `test/` for `status` found
    nothing; the same grep for `commands/backup|commands/restore` found six files.
  - **Tree's tab-separated output was read, not run.**
  - **Carried smaller items:** all three hold. Three failure-reason spellings is wider (five
    sites); `hashedFiles`' contradiction is with snapshot.mjs's doc, not `fileProps`'.
  - **The rejected/parked list was re-checked.** Codec damage on both sides moves knowledge into
    snapshot-file.mjs, so the codec-split rejection and ADR-0028 stand. The torn work file's
    declined half moved there from the open list.
- **2026-10-09 — Status deletion record landed** ([PR #391](https://github.com/allens/s3cab/pull/391); no ADR).
  - **One function reads the record.** `getUndeletedHashes(bucket, entries)` replaced
    `baselineHashes`. `storedHashes`' trusted branch and `status` both call it, so after a `delete`
    `status` counts what `backup` re-uploads.
  - **Review found the record alone was wrong, in `backup` too.** A row outlives a re-upload and is
    never trimmed while a snapshot references its hash, so every backup after delete-then-re-backup
    re-PUT the content. The function now HEADs the recorded hashes the snapshot references and
    subtracts only the absent ones (presence wins, guide/format.md), as `forget` does.
  - **Tests:** status.test.mjs runs through `s3Seam`: deleted gives 1 to upload, deleted then stored
    again gives 0, each red before its fix. The `baselineHashes` unit tests were deleted.
  - `npm test` 1209 pass, 13 skipped; `test:integration` 27 pass, 3 skipped (Roles Anywhere).
