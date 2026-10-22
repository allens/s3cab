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

Surfaced 2026-10-15 (seventeenth pass): **17 `src/` commits since `2820adf`** (89 files,
+5266/−2972), read at HEAD `09a082f`. Nearly all of it is two subsystems: the snapshot-format
revision (ADR-0098–0107: five columns, `-`/`@`/`#` marks, validity, the lone `.`, `@S3CAB
SPEC`/`@CLIENT`) and set ownership (ADR-0108: `snapshots/<set>.info`, a read-only `reattach`,
`takeover`). Beside them the bucket and identity stacks (ADR-0105), `**/` mid-name and macOS folding
(#399), names with no UTF-8 form (#398) and the resized progress line (#410). Three background
sweeps (the format and ownership code, the carried list, the remainder); every claim below was
checked by hand before it was written down, the three reader divergences by tracing, not by running.

**Verdict: the format revision landed its writer in one module and its reader in two.** The
deletion record composes the snapshot writer's `HEADING`/`openingRows`/`formatLine`/`TERMINATOR`
and then re-states the reading rules in a parser of its own, which already disagrees with the
snapshot's on three of them (**one reader for a valid s3cab file**). The same shape in miniature:
the walk refuses a name the snapshot can't hold by two mechanisms that disagree on directories
(**one classifier in the walk**), and `takeover` asks "is this machine the holder" twice
(**takeover reads the holder twice**). A second shape: a rule the registry already states, which
two commands re-check by hand while every other command ignores it (**surplus positionals**).

**Picking these up cold (a later session, or another machine).**
(1) **Line anchors rot on every landing, and so do file paths.** Two files of the same name exist in
`src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`, `provider.mjs`,
`snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify before trusting any
anchor.
(2) **Ordering constraints.** **One classifier in the walk** and **tree's tab-separated output**
both edit `src/lib/walk.mjs`; **surplus positionals** and **one claim** both edit
`src/commands/takeover.mjs`; **one reader** and **codec damage on both sides** both edit
`src/lib/snapshot-file.mjs`'s reader. Land one of each pair before starting the other.
(3) **`.env.test` is gitignored and does not travel.** Every open candidate below is pure or sits
behind the `s3.mjs` fake (**one claim** and the takeover item through `s3Seam`), and verifies with
`npm test` alone; none touches the real S3 read/write path.

- **One reader for a valid s3cab file — the deletion record re-states the reading rules the
  snapshot reader owns, and the two already disagree.** _Strong; seventeenth pass, the divergences
  traced by hand._ [deletion-record.mjs](../src/lib/deletion-record.mjs)'s `parseDeletionRecord`
  (:97–139) composes the writer's `HEADING`, `openingRows`, `formatLine`, `TERMINATOR`,
  `isHeadingRow` and `isInstant` from [snapshot-file.mjs](../src/lib/snapshot-file.mjs), then
  implements ADR-0101/0106's whole-file rules a second time beside `parseSnapshotStream`
  (:877–1041): the blank-line skip, "`.` counts only with its LF", rows after `.`, `.` plus junk,
  the unknown-type rule, the hash and size regexes (:1050/:1053 vs :123–124), the three error
  strings word for word. They differ on two: a file ending `.\n.` (the snapshot
  holds the LF-less `.` back unread, :1001, so valid; the record says rows follow, :114); and
  UTF-8, which the snapshot refuses through its fatal decoder (:1097–1104) and the record never
  can, because `getText` ([s3.mjs](../src/lib/s3.mjs):1029–1033) hands it `transformToString()`'s
  lenient text, though ADR-0101 applies the refusal to both layouts. **Fix:** one line-walker in
  snapshot-file.mjs owning the file-level rules over bytes (heading, blank, terminator with its LF,
  nothing after, unknown type, UTF-8) and taking a per-type row handler, returning the file-level
  verdict as a value, so `parseDeletionRecord` contributes only what a `#deleted` row is and its own
  "a malformed row distrusts the record" verdict. Knowledge moves *into* snapshot-file.mjs, so
  ADR-0028 and the codec-split rejection stand. **Tests:** two hand-mirrored damage tables
  (snapshot-file.test.mjs:159–254; deletion-record.test.mjs:201–240); the record has no CRLF or UTF-8
  case, neither has `.\n.`, and five test files spell the file framing by hand
  (deletion-record.test.mjs:79–82 the heading literal; test/helpers/write-snapshot.mjs:68–79 no
  `openingRows`, no `START`; list.test.mjs:147; compare.test.mjs:798;
  remote.referenced-scan.test.mjs:92). The new test is one damage table through both readers.
- **One classifier in the walk — the walk refuses a name the snapshot can't hold by two
  mechanisms, which disagree on a directory.** _Worth exploring; seventeenth pass, read._
  [walk.mjs](../src/lib/walk.mjs): tab/CR/LF in the kept-files loop (:312–320,
  `UNREPRESENTABLE_IN_TSV`, relying on the callback having dropped excluded entries); no UTF-8 form
  in `createWalkCallbackFn` (:389–401, with its own `excludedBy` call). Both feed
  `found.unrepresentable` and one throw (:333–348). A tab-named directory is descended and every
  file beneath it listed (walk.test.mjs:642–654, whose comment "keeps it out of the walk callback
  entirely" is half true since #398); a non-UTF-8 directory returns false, is listed once and never
  descended. With it: `UNREPRESENTABLE_IN_TSV`'s doc (:44–55) and walk.test.mjs:603–604 justify
  the CR refusal by a parser that no longer exists (`crlfDelay: Infinity`; the reader is
  `utf8Lines`, LF-only, and `pathFault` :1071–1075 refuses a CR), and the export has no importer
  outside walk.mjs. **Fix:** the callback is the one classifier (type, excluded, representable) and
  the loop keeps only `seen`; rewrite the CR reason in place and un-export. **Tests:**
  walk.test.mjs:570–736 cover both paths through the thrown message; one classifier lets a test
  assert per-entry outcomes as data, as the exclusion-record tests (:198) do.
- **Surplus positionals — the registry says `reattach` and `takeover` take one positional, and
  each refuses extras by hand while every other command ignores them.** _Worth exploring;
  seventeenth pass, read._ [commands.mjs](../src/commands.mjs):366–371 and :388–393 declare
  `args: { set }` without `variadic`, yet `exec` (:380–381, :402–403) destructures
  `[name, ...directories]` only so [reattach.mjs](../src/commands/reattach.mjs):52–56 and
  [takeover.mjs](../src/commands/takeover.mjs):55–59 can refuse them, in two wordings.
  [s3cab.mjs](../src/s3cab.mjs):115–130 hands `positionals` through with no count, and `variadic`
  is read only by help.mjs's `displayArg` (:81–82), so `s3cab backup photos extra` drops `extra`
  silently (`[set] = []`, commands.mjs:429) while `reattach photos extra` refuses. The same two
  commands and `setup` share an eleven-line preamble, comment included (setup.mjs:71–84,
  reattach.mjs:42–51, takeover.mjs:45–54). **Fix:** the dispatcher refuses a surplus positional
  from the `args` declaration; both blocks and the `...directories` parameters go, and
  `validateSetName` (sets.mjs:202) can take `undefined` and throw `MissingArgError` itself.
  **Touches ADR-0011's rejected option** (a registry-driven scheme), worth reopening on two counts:
  `variadic` is now a structured property, not a parsed display string; and a surplus positional is
  a CLI-only fact, since a library caller can't pass one to a function with no such parameter, so
  the guard the ADR wants on the library surface is the type. **Tests:** reattach.test.mjs:52
  asserts the refusal for one command; a dispatcher test covers every non-variadic command.
- **One claim — "PUT the marker and store the same text locally" is composed by hand at two
  sites, and the lost race is untested.** _Worth exploring; seventeenth pass, read._
  [setup.mjs](../src/commands/setup.mjs):266–273 does `freshInfo → claimRemoteSet → writeSet →
  writeClaim`; [takeover.mjs](../src/commands/takeover.mjs):90–103 does `freshInfo(info?.created)
  → (writeRemoteInfo | claimRemoteSet) → writeClaim`. The invariant "the claim file holds the bytes
  written to `.info`" (asserted takeover.test.mjs:107–108) is caller discipline; ADR-0108 §5's
  rule (a marker → overwrite, none → conditional create) lives in the command; and
  [set-marker.mjs](../src/lib/set-marker.mjs) offers two write adapters differing only in
  `noClobber` (:106, :128). takeover.mjs:94–101, where another machine won the conditional PUT, is
  reached by no test (its message appears in `src/` only). **Fix:** set-marker owns the claim end
  to end — the conditional create for `setup`, read-decide-write for `takeover` — each ending in
  the local write, so a third writer can't forget the local half. Two callers, so the gain is
  locality and a testable lost race at the lib seam, not leverage. **Tests:** takeover.test.mjs's
  four cases stay; the lost race becomes testable through `s3Seam`.
- **`held` means two things — `list` and `reattach` report a `held` field that answers different
  questions, in the same words.** _Worth exploring; seventeenth pass, read._
  [list.mjs](../src/commands/list.mjs):37–38 and `heldHere` (:136–146): a `claim` file exists,
  offline, "as far as it knows"; [reattach.mjs](../src/commands/reattach.mjs):15 and set-marker's
  `holding` (:168–175): the stored pair matches the bucket's marker, which is GLOSSARY's
  **Holder**. [render.mjs](../src/render.mjs) says "Held by this machine" and dirs-vs-read-only
  for both (:111–114, :426–437). **Fix:** name the offline fact for what it is (`claimed`), or
  export the offline predicate from set-marker beside `holding` so the two definitions sit
  together with their difference stated once; a GLOSSARY line either way. **Tests:**
  list.test.mjs:138–156 covers no-claim; nothing asserts a stale claim (file present, marker
  disagrees), which is exactly where the two meanings part.

**Carried from the sixteenth pass, re-verified 2026-10-15.** All four hold; two changed shape.
- **Suggested exclude line.** _Strong; holds._ `excludePattern`
  ([backup.mjs](../src/commands/backup.mjs):239–247) still returns `relative(root, path)` raw;
  `parseLines` still trims and drops `#` lines; `globSource` still has no escape. The render block
  ([render.mjs](../src/render.mjs):1026–1038) says nothing about renaming; backup.test.mjs:295–297
  and :312 cover plain names only. #399's case and accent folding make a suggestion match *more*
  siblings on macOS; #398's refusal throws from the walk and never reaches `pass.errors`. The fix
  (an inverse beside `compileExcludePatterns` in [exclude.mjs](../src/lib/exclude.mjs), or nothing
  when the grammar has no exact spelling, and a render that says to rename or write the pattern by
  hand) and the round-trip test stand as filed.
- **Forget plans twice.** _Worth exploring; holds._ [forget.mjs](../src/commands/forget.mjs):193
  (`.orphaned`) and :210 (`{ gone }`) are still two `planUnrestorable` calls around one
  intersect-and-HEAD (:200–202); `getUndeletedHashes` ([upload.mjs](../src/lib/upload.mjs):186–205)
  makes the same step, so a pure lib function for "the recorded hashes this forget would orphan"
  has a second caller. `.orphaned` is read at :193 and unrestorable.test.mjs:171 only.
- **Tree's tab-separated output.** _Worth exploring; changed, narrower._ snapshot-file.mjs no
  longer imports `UNREPRESENTABLE_IN_TSV`; the reader refuses a tab or CR with its own checks
  (`pathFault`, :1071–1075). Patterns holding a tab or CR are refused at walk.mjs:81–95, so
  `entry.pattern` can't carry one; `entry.path` still can on Linux and macOS, and `renderTree`
  ([render.mjs](../src/render.mjs):529–534) still writes `${path}\t${pattern}` raw
  ([tree.mjs](../src/commands/tree.mjs):40 passes the raw path). The inconsistency is now the path
  column alone: spell it out as the snapshot's `#excluded` row does, or refuse it. Lands beside
  **one classifier in the walk**.
- **Codec damage on both sides.** _Worth exploring; changed, wider._ `parseCompressedSnapshotStream`
  (:818–845) still folds only `Z_BUF_ERROR` into "Truncated snapshot" and rethrows `Z_DATA_ERROR`
  raw; `isCorruptSnapshotError` ([referenced.mjs](../src/lib/referenced.mjs):100–110) still matches
  both codes plus `AssertionError`, so its `Z_BUF_ERROR` arm stays unreachable from the reader. New
  since: `utf8Lines` (:1096–1104) and the `.` check (:1021–1024) are two more AssertionError
  sources the classifier catches by name. referenced.test.mjs:174–190 feeds `gunzipSync` errors
  straight to the classifier; snapshot-file.test.mjs:452–472 cuts bytes through the reader but
  never calls it. Still no bad bytes → reader → classifier. The fix stands as filed: the reader
  turns every codec failure into its own damage error, and the classifier names no codec.

**Smaller items (seventeenth pass)** — verified, too small for an entry of their own; the
sixteenth pass's items that still hold are carried here, re-anchored.
**takeover reads the holder twice, and the early exit skips the bucket check.** _Worth exploring,
small._ takeover.mjs:61–70 calls `holding`, then `attachSet` ([attach.mjs](../src/lib/attach.mjs):29–37)
calls it again and returns `held`, which the command ignores: two `.info` GETs on an attached set.
So `takeover <set> --bucket <wrong>` on a held set prints "already holds … (bucket 'right')" and
exits 0 before attach.mjs's mismatch check (:31–35). reattach.test.mjs:90 covers the mismatch for
reattach only; takeover.test.mjs:145–158 passes `{}`.
**AWS template file names re-spell the stack suffixes.** _Speculative._
[lib/aws.mjs](../src/lib/aws.mjs):96–114 names the stacks through `bare()`;
[commands/aws.mjs](../src/commands/aws.mjs):125, :137 and :155 write `${name}-bucket`,
`${name}-${fingerprint}` and `${name}-user` without it, and the comment at :168–171 argues only the
prefix difference; the identity-stack pattern is a literal again at commands/aws.mjs:104 and
commands.mjs:241. The ARN layout itself is one spelling (`identityEnvPath`).
**Progress width read twice per frame.** _Speculative._ `terminalWidth`
([progress.mjs](../src/lib/progress.mjs):92–101) is the one refresh point, but each fused-line
frame calls it from `compose` (snapshot.mjs:465, tail-preserving) and again from `draw`'s backstop
(progress.mjs:142, head cut); `clockedLine` could pass the width it just read to `compose(width)`,
and the fused-line test would drop its own `_refreshSize` fake.
**exclude's platform facts are import-time constants.** _Speculative._ `FOLDS_CASE`/`FOLDS_ACCENTS`
([exclude.mjs](../src/lib/exclude.mjs):50–52) and `spell`'s `sep`, so exclude.test.mjs:88–134
asserts per platform and skips, where the shape-keyed `foldsCase`/`preparePath` test anywhere. The
platform-vs-shape split is argued three times (path-match.mjs:27–29, exclude.mjs:22–27,
find.mjs:114–121); two should point at one. One production caller and CI on three OSes, so the
gain is test locality only.
**`formatByteValue`'s widest output restated by consumers.** _Speculative._ format.test.mjs:41 pins
`1234.6PB` (8 chars) since #397; s3.mjs `SIZE_COL = 8` (:630–632, "999.9GB is 7 chars") and
snapshot.mjs `BYTES_COLUMNS = 7` (:660–662, "999.9MB is the widest") each restate the width and
disagree. Export the width beside the function.
**Provider's switch re-spells the env keys.** _Holds._ [commands/provider.mjs](../src/commands/provider.mjs)'s
`replacedName` (:52–61) reads the three `AWS_*` keys itself though `settingKeys`
(lib/provider.mjs:35–41) is the home; the `--unset` ternary (:270–275) still branches on the raw
string. Routing it through `readProviderConfig` is a behaviour change to decide: that sees no
secret-only set.
**A set with no bucket breaks every "which set?" listing.** _Speculative; holds._
[sets.mjs](../src/lib/sets.mjs)'s `readSet` (:334–342) and `resolveSet` (:407–409) list every set
through the strict `readSet`, which throws at :347–349 without `S3CAB_BUCKET`. Its message is
actionable, so this may be acceptable fail-fast.
**Failure-reason spellings: five, across more sites.** Inline
`Error.isError(e) ? e.message : String(e)` at remote.mjs:309, snapshot.mjs:360, walk.mjs:459 (new,
`checkLink`) and inside auth.mjs's `reasonFrom` (:49); `errorText` ([error.mjs](../src/lib/error.mjs):291,
which also unwraps a message-less `AggregateError`) at find.mjs:229, help.mjs:179, s3cab.mjs:109
and s3.mjs:343; `instanceof Error` at backup.mjs:160; a bare `String(cause).trim()` at
auth.mjs:352. Still a consistency fix, not a defect.
**`preparePath`'s unread fields — narrower.** `pathMatcher` (via `normalize`,
path-match.mjs:89–92) is now a third consumer (restore's filters, the walk's link test, the
reader's `@SET DIR` check) reading `.path` and `.foldCase`; restore.mjs:130/:159 and
snapshot-file.mjs:1077 read `.path`; only find's basename mode (find.mjs:157) reads `.base`. No
caller reads only `.base`, so the per-row cost claim is unmeasured and smaller than filed.
**`hashedFiles` counts empty files.** _Holds._ file-props.mjs:139–151 returns `hashDuration` from
the `EMPTY_DIGEST` branch; snapshot.mjs:353–356 counts on it, against its own "only on a path that
actually hashed". Cosmetic.
**The empty file's hash is spelled three times.** delete.mjs:20–21 a literal; file-props.mjs:34
`EMPTY_DIGEST`, unexported, "so it cannot be mistyped"; delete.test.mjs:92 a third.
**Debug decompression outside the codec's owner.** _Speculative; holds._ snapshot.mjs:4 imports
`createGunzip`; :371–377 spells `.snapshot.tsv`. A debug aid with one caller.
**Stale prose.** remote.mjs's `backup`/`status` line **landed** in #391. Still stale:
[commands/cleanup.mjs](../src/commands/cleanup.mjs):15–16 and :103 "the read-only twin of
`verify`", though it deletes; [compare.mjs](../src/lib/compare.mjs):393–398 "no header, so no
instant reaches here" (a true conclusion with a stale reason: `readBaseline` parses `instant`,
commands/snapshot.mjs:48–55 just doesn't pass it); [objects.mjs](../src/lib/objects.mjs):186 "50 at
a time" for `REQUESTS_IN_FLIGHT`, and its header (:19) missing HEAD and DELETE; walk.mjs:44–55 and
walk.test.mjs:603–604's `crlfDelay` reason (goes with **one classifier in the walk**).

**Examined & left alone (seventeenth pass)** (not candidates — skip future runs). **Ownership:**
the holder question is derived in one module (`holding`, `assertHeld`, `readClaim`) and asked from
six sites; `backup` reads `.info` twice by ADR-0108's own design, refusing before any read
(backup.test.mjs:267–275) and again just before the PUT (upload.test.mjs:763 asserts the order);
`assertHeld`'s `rmSync` is argued and tested; `attach.mjs` has two callers with different
follow-ups and earns its keep; `pushSetConfig`'s delete-the-remote-exclude rule is
integration-tested; set-marker takes a path and knows no layout; `parseInfo` is `#`-safe and
CR-tolerant. **Format:** `isHeadingRow` has one definition; `openingRows` is reached by every
production writer (the parked file is the same stream renamed); `SPEC_DATE` is tested against
guide/format.md; `pathMatcher` now serves three consumers, a deepening that landed; compare and
render consume `entries`/`errors`/`instant`/`by` only; `.tsv.gz` is spelled in code only in
snapshot-file.mjs; the gzip settings sit at one site; `REQUESTS_IN_FLIGHT` is imported only by the
crash test. **Walk:** links as `#error`, overlapping roots and the UTF-8 refusal are tested; one
`resolveWalkRoot` per member directory. **Elsewhere:** the ARN layout (`identityEnvPath`) and the
ADR-0059 boundary; "which stack holds what" is prose restated, not re-derived; `globSource`'s
`**/` rule in one place, tested from both matchers; find's always-NFC and exclude's darwin-only are
different policies, each argued; #411's `applyEnv` has two production callers and widens nothing;
#396's exit rule is one `if` per command with cross-references; `terminalWidth`'s refresh,
failed-read and zero-columns cases are each tested; `caFingerprint`/`ensureMachineIdentity` are
single-source; #397's callers re-format nothing.

---

Surfaced 2026-10-09 (sixteenth pass): **22 `src/` commits since `7501768`** (66 files,
+1810/−923), read at HEAD `2820adf`: pass 15's landings, gzip snapshots (ADR-0097), #385's exclude
suggestions and #388's line-break names. The seventeenth pass re-verified every open entry: all four
candidates hold (two in a changed shape) and are carried above, re-anchored, with the smaller items
that still hold; **status forgets the deletion record** landed as #391.

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
`delete` pair** (ADR-0088/0089/0090), the **end-of-file trailer** (ADR-0082), the **streamed-digest
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
  [GLOSSARY.md](../GLOSSARY.md)'s **Deletion record** entry defines the distinction, coins
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
> 2026-10-02 fourteenth and its landing) recorded landings that are already of record in their ADRs, PRs and `git log`,
> and re-verification notes superseded by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

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
- **2026-10-15 — seventeenth pass.** Read the **17 `src/` commits since `2820adf`** (89 files,
  +5266/−2972) at HEAD `09a082f`: the snapshot-format revision (ADR-0098–0107), set ownership
  (ADR-0108), the bucket and identity stacks (ADR-0105), #398/#399/#410. Three background sweeps
  (the format and ownership code, the carried list, the remainder), then every claim checked by
  hand. **New: one reader for a valid s3cab file (Strong); one classifier in the walk, surplus
  positionals, one claim and `held` means two things (Worth exploring); five new smaller items.**
  Top pick: **one reader for a valid s3cab file**. Overwrote the HTML report in place.
  - **The three reader divergences were traced, not run.** Each was followed through both parsers'
    branches by hand (the whitespace-only line, `.\n.`, and UTF-8 through `getText`'s lenient
    decode); none was executed against the real modules. A grilling should start by running them.
  - **The carried list was re-verified by a sweep and then by hand.** All four candidates hold;
    **tree's tab-separated output** narrowed to the path column (patterns with a tab or CR are now
    refused), **codec damage on both sides** widened (two more AssertionError sources); remote.mjs's
    stale line landed in #391; one more inline failure-reason spelling (walk.mjs's `checkLink`).
  - **The rejected/parked list was re-checked and stands.** **One reader** moves knowledge *into*
    snapshot-file.mjs, so ADR-0028 and the codec-split rejection stand; **surplus positionals**
    touches ADR-0011's rejected option and says so on the entry rather than contradicting it
    silently.
  - **The fourteenth pass's run-log entries were retired under the three-pass cap.** Its landing is
    ADR-0093 and PR #355; `git log -p` on this file keeps the rest.
