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

Surfaced 2026-11-11 (nineteenth pass): **22 `src/` commits since `68da4b0`** (69 files,
+5423/−1276), read at HEAD `124c7868` (`src/`, `test/` and `site/` unchanged at `60c16b90`). Three
subsystems: one reader for every s3cab file (#474, ADR-0101 amended); the durability work (#503 and
ADR-0116 restore rechecks its target, #506/#511 and ADR-0117 the two audits and the adversarial
read, #507 and ADR-0118 verify's versioning, #508 the multipart abort); and patterns with the docs
site (#478 and ADR-0115 backslash escapes, #502, the playgrounds #482/#484, the command reference
generated from the registry #490). Five background sweeps (the reader and the records, restore and
landing bytes, the bucket-wide read side, patterns and help, the carried list) and a hand read of
`test/`; every Strong and Worth-exploring claim below was checked by hand, and five were **run**
against the real modules.

**Verdict: the durability fixes landed as local guards, and the friction is where a guard's rule
stops one step short.** #474's reader is deep (`parseS3cabFile` is the only TSV line reader in
`src/`), `putFile` owns its abort, and ADR-0116's writer asks nothing of its caller. But restore
re-checks everything about its target except whether a file is already there (**restore decides
once**, a live defect); "damaged" is still an error's class name, now at three callers (**damage by
class name**); a download's body sits outside ADR-0068's retry (**a download's body**, a live
defect); #511's `isSetName` is asked again by five consumers and not by a sixth (**what counts as a
set**); ADR-0115's "which system" is three parameters (**which system's pattern rules**); and each
audit's model tests rebuild their world by copy (**the model tier's scenario world**). The carried
list holds entire.

**Picking these up cold (a later session, or another machine).**
(1) **Line anchors rot on every landing, and so do file paths.** Two files of the same name exist in
`src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`, `provider.mjs`,
`snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify before trusting any
anchor.
(2) **Ordering constraints.** **One classifier in the walk** and **tree's tab-separated output** both
edit `src/lib/walk.mjs`; **surplus positionals** and **one claim** both edit
`src/commands/takeover.mjs`; **restore decides once** and **a restore fault kind** both edit
`restoreTargets`' loop; **what counts as a set** and **cleanup's top-up** both edit
`src/lib/bucket-scan.mjs`. Land one of each pair before starting the other.
(3) **`.env.test` is gitignored and does not travel.** Every open candidate below is pure or sits
behind a fake (`s3Seam`, `lockSeam`, a temp folder) and verifies with `npm test` alone, **except a
download's body**, which changes the S3 read path: `npm run test:integration` before pushing.
(4) **The probes went with the session's scratch folder.** Each entry marked *run* says what was fed
to which real function and what came back, which is enough to run it again.

- **Restore decides "skip an existing file" once, before the loop.** _Strong; nineteenth pass, run.
  A live defect._ [restore.mjs](../src/lib/restore.mjs): `planRestore` :102–131 stats every target
  before anything is fetched (`restoreTargets` :415–421 binds it to `lstatSync`); the loop :518–589
  asks again about folder links (`linkedFolder` :826, fresh per write since ADR-0116), the collision
  (:540–543), the temp (`writeFileAtomic`) and the copy source (`copyFileAtomic`), and never about
  the plan's `skip`. So a file that appears at a destination after the plan is replaced by the
  rename and reported restored, exit 0, with no `--overwrite`. **Run:** a loopback S3 serving two
  objects created `b.txt` while `a.txt` downloaded, through the real `restoreTargets`:
  `restored: [a.txt, b.txt]`, `skipped: []`, and `b.txt` held the backup's bytes. `restoreTargets`'
  doc (:345–348) and guide/restore.md:156 ("Existing files are never touched") promise otherwise.
  `planRestore` has one production caller, and its injected `stat` serves only its own unit test,
  which is why restore.counts.test.mjs:46 mocks `node:fs.lstatSync`. **Fix:** the loop judges what
  is at the destination at each write (refuse, skip, block, link, collision, write) in one place,
  and `planRestore` goes. The window left is ADR-0116's own, between the check and the rename.
  **Extends ADR-0116**, which scopes itself to `--output` (this is the in-place restore too), and
  reverses the tenth and fifteenth passes' "left alone" on `planRestore` as a pure plan: ADR-0116's
  rule is what changed. **Tests:** restore.target-changes-mid-run.test.mjs is the home; a folder
  appearing mid-run is pinned (restore.downloads.test.mjs:1268), a file appearing is not.
- **Damage is decided by an error's class name** (was **codec damage on both sides**). _Strong;
  carried, wider, run._ `isCorruptSnapshotError` ([referenced.mjs](../src/lib/referenced.mjs):134–144)
  matches `name === "AssertionError"` or `Z_DATA_ERROR`/`Z_BUF_ERROR`; `parseCompressedSnapshotStream`
  ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):928–955) folds only `Z_BUF_ERROR` (:948–952)
  into the `Damaged snapshot` assert (:1058) and rethrows `Z_DATA_ERROR` raw, so the classifier's
  `Z_BUF_ERROR` arm is unreachable from the reader. Three callers now: [find.mjs](../src/lib/find.mjs):143,
  [remote.mjs](../src/lib/remote.mjs):385 and, new, [commands/status.mjs](../src/commands/status.mjs):130;
  two of the three read *local* snapshots under a doc (:121–123) that says remote. Every other
  assertion on a read path counts as damage too: `getStream`'s `assert(Body instanceof Readable)`
  ([s3.mjs](../src/lib/s3.mjs):623, on `readRemoteSnapshot`'s path) and `readSnapshot`'s argument
  checks (snapshot-file.mjs:760–761). **Run:** `readSnapshot("", "x")` and a `getStream`-style
  assert both classify `true`, so the doc's "Unknown → not corruption → abort" (:130) is false: an S3
  reply with no body would be recorded as an unreadable snapshot. **Fix:** the reader turns every
  codec and validity failure into its own damage error (error.mjs's taxonomy: caught by type → a
  subclass), the three callers catch that type, and the classifier names no codec and no Node class.
  Knowledge moves *into* snapshot-file.mjs, so ADR-0028 and the codec-split rejection stand; **read
  ADR-0074 first**, which put the classifier in a zero-import referenced.mjs. **Tests:**
  referenced.test.mjs:216–246 builds its errors by hand; snapshot-file.damage.test.mjs:202–209
  checks `name === "AssertionError"` without calling the classifier; none sends a non-reader
  assertion through a caller. `heldHere` ([commands/list.mjs](../src/commands/list.mjs):136–146)
  reads the latest local snapshot with no handling at all, so `list <set>` throws on a damaged one
  where `find` and `status` carry on.
- **A download's body is outside the retry.** _Worth exploring; nineteenth pass, run. A live
  defect._ `requestErrorRelay` ([s3.mjs](../src/lib/s3.mjs):504–568) wraps `next(args)`, which for a
  `GetObject` returns at the headers; `getStream` (:620–628) hands the unread body to `getObject`
  ([objects.mjs](../src/lib/objects.mjs):93), `readRemoteSnapshot` ([remote.mjs](../src/lib/remote.mjs):194)
  and `downloadRemoteSnapshots` (:436), which drain it outside the relay. **Run:** a loopback server
  sent 1,000 of 1,000,000 bytes and cut the socket; `getObject` threw `ECONNRESET` "aborted" after
  one GET and about 120 ms, with no retry window and no `networkError`. `restoreTargets`
  ([restore.mjs](../src/lib/restore.mjs):578–588) sees no `path` on it and rethrows, so a restore
  stops on a dropped connection with a bare "aborted". The model tier can't see it: `fake-s3`
  replaces `getStream`. **Fix:** s3.mjs owns the whole GET, body included, with the guarantee a
  request already has. **Touches ADR-0068, ADR-0065 and ADR-0091**, all written about uploads and
  requests. **Tests:** s3.test.mjs's loopback cases are the shape to follow.
- **What counts as a set in the bucket is decided again by each consumer, and a set's name has two
  definitions.** _Worth exploring; nineteenth pass, run._ `listSnapshotFiles`
  ([remote.mjs](../src/lib/remote.mjs):264) keeps every folder under `snapshots/`, a set's or not
  (:247–249, "for `cleanup` alone"), so `referencedBySet` mixes the two. `isSetName`
  ([sets.mjs](../src/lib/sets.mjs):220, #511) is asked again at [set-marker.mjs](../src/lib/set-marker.mjs):40
  and :336, [commands/verify.mjs](../src/commands/verify.mjs):80, [lib/cleanup.mjs](../src/lib/cleanup.mjs):144
  and [referenced.mjs](../src/lib/referenced.mjs):314, and not by `planUnrestorable`
  ([unrestorable.mjs](../src/lib/unrestorable.mjs):136–140), which subtracts every folder. **Run:**
  with a hand-copied `snapshots/photos_2025/` holding the content, forget's preview reports 0 files
  unrestorable ("held elsewhere"); without the folder, 1. No `restore` can read that folder.
  `isSetName` (`/^[a-z0-9-]+$/`) also accepts `a-`, `-a` and `a--b`, which `validateSetName` (:202)
  refuses, so an empty `snapshots/a-/` is a "no snapshots" set: `verify` exits 1, `cleanup` refuses,
  and `emptySetsMessage` (lib/cleanup.mjs:186) advises `s3cab takeover a-`, which takeover refuses
  ([commands/takeover.mjs](../src/commands/takeover.mjs):51). **Fix:** one definition of a set's
  name; the scan sorts folders into sets and other folders once; and a decision, written down, on
  whether forget's "held elsewhere" counts a folder that isn't a set. **Touches ADR-0024 and
  ADR-0117 §1.** `listRemoteSets` (set-marker.mjs:309, for `attach.mjs`:72) is a third answer to
  "which sets are in this bucket" (a marker or a folder, never a config alone) and lands here.
  **Tests:** `photos_2025` appears in the cleanup, unrestorable, render and model.adversarial-506
  tests and not in verify.test.mjs; no test uses a name the two rules disagree on.
- **Which system's pattern rules: one question through three parameters, and three steps the caller
  orders.** _Worth exploring; nineteenth pass, run._ ADR-0115's "read by the rules of the system
  reading it" is asked as a `platform` string (`compileExcludePatterns`,
  [exclude.mjs](../src/lib/exclude.mjs):47); as an `escapes` boolean (`parseExclude` :95,
  `unusableExcludeError` :119, and `strayEscape` :234, `literalPattern` :262 and `globSource` :286 in
  [path-match.mjs](../src/lib/path-match.mjs)); and of this machine alone (`ESCAPES`
  path-match.mjs:217, `exactPattern` exclude.mjs:174, `compileFindPattern`
  [find-pattern.mjs](../src/lib/find-pattern.mjs):57 with `sep` at :74, `starterExclude`
  sets.mjs:130). The callers work around it: site/.vitepress/exclude-playground.mjs:46 derives
  `escapes = platform !== "win32"` beside exclude.mjs:53–54's own; find-playground.test.mjs:9–10
  mocks `node:path`; find-playground.mjs:3–4 says the page can't show Windows `find`; eleven
  ADR-0115 tests skip on this machine's `ESCAPES` (the sweep's count, in exclude, find, walk and
  backup tests). And both consumers of exclude text run parse → refuse → compile themselves
  (`readExcludePatterns` [walk.mjs](../src/lib/walk.mjs):83–95; exclude-playground.mjs:47–52), a
  precondition written only at `globSource`'s `@param` (:280–281). **Run:** compiled without the
  refusal under Linux rules, `**\Thumbs.db` matches `/r/myThumbs.db` and `a\` compiles to
  `\x61undefined`. Not reachable in production: both routes go through `readExcludePatterns`.
  **Fix:** every pattern function takes the same "which system" value, this machine by default, and
  exclude text goes through one entry that returns a matcher or a refusal. **Touches ADR-0115 and
  ADR-0051**; absorbs the smaller item **exclude's platform constants** (find-pattern.mjs:44 says
  "key on `process.platform`" where the code uses `sep`). **Tests:** exclude.test.mjs, find.test.mjs
  and both playground tests.
- **The model tier's scenario world is hand-built in seven files.** _Worth exploring; nineteenth
  pass, read and counted._ test/model/model.{findings,hostile,smoke,clock,durability,durability-audit,adversarial-506}.test.mjs
  each open with the same world: the env saved and restored key by key; the exit code saved (not in
  `clock`), and reset to 0 before each test in two of the seven; `new VirtualClock(Date.UTC(2026, 0, 5))`;
  `new FakeS3()`; then a home and a held set (`useHome` and `makeSet` verbatim in three, a variant
  in three more); and `process.exitCode = 0; await cmd(); assert(process.exitCode)` 31 times.
  `runSequence` (test/model/harness/runner.mjs:102) builds the same world for generated steps. Three
  of the seven arrived in one week from audits, each by copy. **Fix:** the harness owns the scenario
  world: one module installs it and runs a command for its exit code and output. **Tests:** the
  seven files are the tests, and model.smoke.test.mjs is the harness's own. The wider form, not this
  entry: the env loop is copied in 39 test files across `src/` and `test/`, 11 of which also save
  the exit code.

**Carried from the eighteenth pass, re-verified 2026-11-11.** All hold; every count was recounted.
- **Cleanup's top-up has four homes, and its interlocks run twice.** _Worth exploring; carried,
  wider._ [bucket-scan.mjs](../src/lib/bucket-scan.mjs): `scanBucket` :80–112 keeps `snapshotFiles`
  and now also prunes from it every snapshot it didn't read (:86–95, `starts.has` standing in for
  "was read"), so the listing encodes what the scan read. [commands/cleanup.mjs](../src/commands/cleanup.mjs)
  destructures it (:106), runs the two interlocks (:117–125, its comment saying `reclaim` repeats
  them) and hands it back unread (:227). [lib/cleanup.mjs](../src/lib/cleanup.mjs): `topUp` :261–285,
  `reclaim` :317–345 with the same interlocks (:324–331). [remote.mjs](../src/lib/remote.mjs):
  `readNewSnapshots` :321–337 (key and ETag). `CleanupPlan` (:53–63, nine fields) has two producers,
  and a topped-up plan's `missing`/`damaged`/`unreadable`/`emptySets` describe only the scan; it
  carries `unreadable` as a field while its twin is recomputed (`invalidRowSnapshots`, the command's
  :122). The wording is single now (`unreadableSnapshotsError` :217, `invalidRowsError` :237), and
  the header's stale lines are under *Stale prose*. **Fix:** as filed — the scan returns what it
  read as one value, `reclaim` applies one interlock to scanned and added alike, and the header is
  rewritten. `planCleanup` stays pure. **Tests:** commands/cleanup.test.mjs:178–276 (a refused row
  under the lock at :259), lib/cleanup.test.mjs:124–168, bucket-scan.test.mjs:150.
- **A restore fault kind is five hand-enumerations.** _Worth exploring; carried, counts corrected._
  `RestoreResult`'s eleven lists and one number (`coarseTimes`) are enumerated by hand in
  [restore.mjs](../src/lib/restore.mjs)'s typedef (:35–55), the return (:661–677) and `hasFaults`
  (:693–712), and in [render.mjs](../src/render.mjs)'s `renderRestore` destructure (:1476–1495) and
  its "anything happened" condition (:1502–1512, which omits `clamped`, `unmatched` and
  `coarseTimes`); twice more in prose (`hasFaults`' doc :680–685, `restoreTargets`' :370–388).
  `renderRestore` has ten list blocks (:1533–1711), eight sharing heading-sentence / indented list /
  blank / fix sentence / `shellCommand`. #503 added no kind. **Fix:** as filed — one table of fault
  kinds (whether it exits 1, its heading clause, its fix) that the result's shape, `hasFaults` and
  `renderRestore`'s block loop all read; inside `renderRestore`, not the `section()` grammar pass 13
  declined. **Tests:** render.test.mjs's restore cases and restore.downloads.test.mjs assert per
  kind.
- **Surplus positionals — the registry says which commands take one positional, and three refuse
  extras by hand while thirteen drop them silently.** _Worth exploring; carried, holds._
  [s3cab.mjs](../src/s3cab.mjs):110–125 hands `positionals` through with no count; `variadic` is
  read only by help.mjs's `displayArg` (:86–87). [commands.mjs](../src/commands.mjs): reattach
  :364–389, takeover :390–412, extract :490–529; the refusals at
  [reattach.mjs](../src/commands/reattach.mjs):52–56, [takeover.mjs](../src/commands/takeover.mjs):55–59
  and [extract.mjs](../src/commands/extract.mjs):39–45. Of 22 commands, 6 are variadic (find, setup,
  restore, forget, delete, unlock), 3 refuse, 13 drop a surplus via `[x] = []`. **Fix:** as filed —
  the dispatcher refuses a surplus positional from the `args` declaration, and `validateSetName`
  (sets.mjs:202) can take `undefined` and throw `MissingArgError` itself. **Touches ADR-0011's
  rejected option**, worth reopening on two counts: `variadic` is a structured property, not a
  parsed display string; and a surplus positional is a CLI-only fact a library caller can't produce.
  **Tests:** reattach.test.mjs:52–58 and extract.test.mjs:225 assert two of the three refusals;
  takeover's is untested.
- **One classifier in the walk — the walk refuses a name the snapshot can't hold by two mechanisms,
  which disagree on a directory.** _Worth exploring; carried, holds._ [walk.mjs](../src/lib/walk.mjs):
  tab/CR/LF in the kept-files loop (:309–313, `UNREPRESENTABLE_IN_TSV` :60); no UTF-8 form in
  `createWalkCallbackFn` (:378–418, :385–393); `excludedBy` asked at :387 and :411 (the dirent's
  type), :434 (`recordUninspectable`, always a file) and :526 (`checkLink`, the stat'd type); one
  throw (:326–341). A tab-named directory is descended and every file beneath it refused
  (walk.test.mjs:710–795, the comment :788–791 half true); a non-UTF-8 directory is listed once and
  never descended, and no test has one (:826–876 makes files only). The doc (:49–59) and
  walk.test.mjs:743–744 still justify the CR refusal by `crlfDelay`; the reader is `byteLines`
  (snapshot-file.mjs:1326) and `pathFault` refuses a CR (:1156); the export has no importer.
  **Fix:** as filed — the callback is the one classifier (type, excluded, representable), the loop
  keeps only `seen`, the CR reason is rewritten in place and the constant un-exported. **Tests:**
  walk.uninspectable.test.mjs:99–132 already asserts per-entry outcomes as data.
- **Pre-decision stdout under `--json`, thrice.** _Worth exploring; carried, holds._
  [delete.mjs](../src/commands/delete.mjs):212–220, [forget.mjs](../src/commands/forget.mjs):243–253
  and [unlock.mjs](../src/commands/unlock.mjs):90–96 each `console.log` a preview; the dispatcher
  strips `json` before `exec` ([s3cab.mjs](../src/s3cab.mjs):124–125), so under `--json` a consumer
  gets prose then JSON on one stream, and guide/output.md:70–71 doesn't mention it. **Fix:** as
  filed — one home the dispatcher owns, or the stream mix recorded once in ADR-0043 and the guide.
  **Touches ADR-0043.** **Tests:** nothing asserts the `--json` stream.
- **A typed snapshot name is normalized in two commands of five.** _Worth exploring; carried, holds._
  `normalizeSnapshotName` ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):839) is applied by
  [compare.mjs](../src/lib/compare.mjs):101–118 and [commands/upload.mjs](../src/commands/upload.mjs):109–110;
  `chooseSnapshot` ([restore.mjs](../src/lib/restore.mjs):290–297, for `restore` and `extract`) and
  [forget.mjs](../src/commands/forget.mjs):155/:165 compare the raw string, each with its own
  not-found wording ("not found for set", "is not backed up for set"). **Fix:** as filed — one place
  where a typed snapshot name meets the listing. **Tests:** upload.test.mjs:284 is the only
  `.tsv.gz` case.
- **One claim.** _Worth exploring; holds._ [setup.mjs](../src/commands/setup.mjs):266–273 does
  `freshInfo → claimRemoteSet → writeSet → writeClaim`; [takeover.mjs](../src/commands/takeover.mjs):90–103
  does `freshInfo(info?.created) → (writeRemoteInfo | claimRemoteSet) → writeClaim`; the lost race
  :94–101 is reached by no test. [set-marker.mjs](../src/lib/set-marker.mjs): `freshInfo` :86,
  `claimRemoteSet` :143, `writeRemoteInfo` :165, `writeClaim` :191, `holding` :205.
  takeover.test.mjs:93–163 has five cases, claim-text == marker-text at :108. The fix stands as
  filed: set-marker owns the claim end to end, each path ending in the local write.
- **`held` means two things.** _Worth exploring; holds._ [list.mjs](../src/commands/list.mjs):37–38
  and `heldHere` (:136–146): a `claim` file exists; [reattach.mjs](../src/commands/reattach.mjs):15/:59
  and set-marker's `holding`: the stored pair matches the marker, GLOSSARY's **Holder**.
  [render.mjs](../src/render.mjs) says "Held by this machine" in `renderReattach` (:115–118) and
  "read-only on this machine" in `renderList` (:430–441) and for both meanings. `list --remote`, online,
  still uses the offline `heldHere`. Nothing asserts a stale claim.
- **Forget plans twice.** _Worth exploring; holds._ [forget.mjs](../src/commands/forget.mjs):216
  (`.orphaned`) and :234 (`{ gone }`) are two `planUnrestorable` calls around one intersect-and-HEAD
  (:222–233), which reads only `{ deleted }` and ignores the record's `invalid`; `getUndeletedHashes`
  ([upload.mjs](../src/lib/upload.mjs):205–224) makes the same step but refuses on `invalid`
  (:206–209), and has a second caller now (commands/status.mjs:142). `.orphaned` is read at
  forget.mjs:216/:225 and unrestorable.test.mjs:171 only.
- **Tree's tab-separated output.** _Worth exploring; holds, narrow form._ `renderTree`
  ([render.mjs](../src/render.mjs):533–538) writes `${entry.path}\t${entry.pattern}` raw
  ([tree.mjs](../src/commands/tree.mjs):40). Patterns with a tab or CR are refused by
  `unusableExcludeError` (exclude.mjs:119–140, called at walk.mjs:87); an excluded entry is recorded
  (walk.mjs:389, :413, :436, :528) before the loop's tab check (:309), so `entry.path` can hold a
  tab on Linux and macOS (walk.test.mjs:750–766). Spell it out as the `#excluded` row does
  (snapshot-file.mjs:686–692, `showControlChars`), or refuse it. Lands beside **one classifier in
  the walk**.

**Smaller items (nineteenth pass)** — verified, too small for an entry of their own. **New:**
**An invisible character is spelled two ways.** `showControlChars`
([control-chars.mjs](../src/lib/control-chars.mjs):14; walk, exclude, snapshot-file, deletion-record)
writes `␉␍␊`; `withVisibleControls` ([render.mjs](../src/render.mjs):1724, eight uses) writes
`\xNN`. A link whose name holds a line feed reads `␊` in its `#error` row (snapshot-file.mjs:1555)
and `\x0a` in backup's report (render.mjs:1176; pinned at render.test.mjs:1402, :1432, :2120).
ADR-0100 says the pictures hold "in error messages too": one speller, or the split recorded there.
**Forget's retire step is spelled twice** (forget.mjs:284–292 and `retire` :352–360, both
`listRemoteSnapshots` → empty → `removeRemoteSet`), and `removeRemoteSet` (set-marker.mjs:343–356)
documents "once its last snapshot is gone" without checking it. forget.mjs:161 stores `interactive`
and :264 asks `isInteractive` again.
**`renderVerify`'s verdict assumes the last cause is versioning** (render.mjs:817–825 re-walks
`verifyHasFindings`' three causes; a fourth would read "versioning suspended").
**status restates two of upload's rules:** `matchRemoteSnapshot`'s byte comparison
(commands/status.mjs:85–89 against remote.mjs:176–177; ADR-0117 argues the saved GET) and
`storedHashes`' fallback without its warning (:142–143 against upload.mjs:102–123).
**A folder removed mid-restore reads as a refused name.** `isRefusedName` (restore.mjs:777–783)
takes any `ENOENT` with a `path`; exit 1 either way, the reason wrong. With **restore decides once**.
**"Check, then PUT, a mismatch means changed" is written twice** (`uploadObjects` upload.mjs:389–426,
`uploadFile` :930–945), against the module's own header (:54–57); both tested.
**The snapshot's opening rows have a second writer in the site build.** `writeSnapshot`
(snapshot-file.mjs:660) reads who, the home and the finish time from the machine, so
site/.vitepress/challenge-bucket.mjs:94–110 spells the ten rows by hand and
snapshot-sample.data.mjs:89–130 patches `Temporal.Now` and rewrites `BY`. Speculative: one caller in
`src/`.
**Reader-side repeats.** The hash and size patterns are stated in `fileRowFault`
(snapshot-file.mjs:1134) and `parseDeletionRecord` (deletion-record.mjs:110–114); `Snapshot.dirs` is
returned and read by no production code; `parseInfo("")` equals a marker with no `OWNER`/`CLAIMED`,
so `holding` (set-marker.mjs:205) matches a blank claim to a blank marker.
**render.mjs copies.** "First N, then *and N more*" three times (:1118–1124, :1131–1139,
`failedFileLines` :1170); `renderUpload`'s snapshot mode (:1394–1412) copies `renderBackup`'s
"Couldn't be backed up" block (:1090–1107) and aligns its counts differently.
**The walk's `*` and the exclude refusal's `?`.** The unrepresentable-name error still suggests
`odd*name.jpg` (walk.mjs:339, relied on at walk.test.mjs:760); `unusableExcludeError` says `?`, not
`*`, since a `*` can join one beside it (exclude.mjs:120).
**Around `src/`.** README.md:293–301's global-options table is hand-kept beside `globalOptionRows`
(help.mjs:139; command-pages.test.mjs:93–116 checks only the heading); test/doc-examples.test.mjs:230–236
copies the dispatcher's parse (s3cab.mjs:110–118 can't be imported); find.mjs:13–14 re-exports
`compileFindPattern` so its tests can stay in find.test.mjs; its refusal pulls `shellCommand`, and so
style.mjs and `node:util`, into the browser bundle (site/.vitepress/config.mjs:356–358 defines
`process.stderr` for it); the site origin is spelled at config.mjs:32, command-pages.mjs:76 and
scripts/docs-urls.mjs:21; test/model/harness/seam.mjs's mock carries `objectExists` and
`isPreconditionFailed`, which no production module imports.
**Unused exports.** `formatInfo` (set-marker.mjs:96); `noBackupsError` and `snapshotNotFoundError`
(restore.mjs:262, :276) for test/doc-examples.test.mjs only.
**Carried and holding, re-anchored.** **Failure-reason spellings** (locks.mjs:266–267 `reason`;
inline at auth.mjs:48–49, remote.mjs:388, snapshot.mjs:360, walk.mjs:440; `errorText` error.mjs:311–322
at s3cab.mjs:104, help.mjs:250, find.mjs:149, s3.mjs:344 and, new, :875; `instanceof` at
backup.mjs:87; `String(cause).trim()` at auth.mjs:352). **Two `--from-file` openers**
(commands/restore.mjs:157–182 `readPathList`, file or `-`; commands/delete.mjs:127–142, file only by
ADR-0089; `parseLines` read-lines.mjs:9 has five caller modules, and exclude.txt now has its own
`parseExclude` over `activeLines` :17). **`KEY=value`: one reader, two writers** (`infoFields`
set-marker.mjs:108 serves `parseInfo` :127 and locks.mjs:119; `formatInfo` :96–97 and `formatLock`
locks.mjs:92 each hand-join, only `formatLock` with optional lines; the writer-side invariants are
stated nowhere, and `userAtMachine` guards no newline). **`hold`'s unstated precondition**
(`eachInFlight` objects.mjs:144–151 states "settled"; `hold` locks.mjs:359–384 speaks of Ctrl+C
only; pinned at objects.test.mjs:280). **Lock typing** (`holdUploadLock.command` is `string`
locks.mjs:413, `holdDeleteLock.command` `"cleanup" | "delete"` :447; `goalOf`'s fallback :263
unreachable from the six sites). **`Drift.cause` is a raw Error in a result** (upload.mjs:257, :467;
read at render.mjs:1439–1440 and commands/upload.mjs:270; under `--json` an fs error serializes to
`{errno, code, syscall, path}` and a `ContentMismatchError` to `{"name": …}` alone).
**Bucket-name validation** (`validateBucketName` in all five `--bucket` commands — delete.mjs:118,
unlock.mjs:39, setup.mjs:83, reattach.mjs:50, takeover.mjs:53 — and in one of the four that take the
bucket as a positional, aws.mjs:119; cleanup.mjs:80, verify.mjs:68 and hashes.mjs:24 use `requireArg`
only, so `cleanup s3://b` gets the SDK's error). **"Absolute by shape" ×5, "segments past the
root" ×3** (extract.mjs:47, `reroot` restore.mjs:209, `pathFault` snapshot-file.mjs:1153,
`isMatchableDir` path-match.mjs:102, and commands/restore.mjs:96–100, which proposals/bugs.md lists
as a live defect; the root cut at `namesOf` restore.mjs:166–167, `pathFault` :1171–1173,
`isMatchableDir` :105–106, all over `rootLength` path-match.mjs:89; drive-letter upper-casing in
`reroot` :215–219 and `itemName` :231–238). **`restoreTargets`' pass-through and its agreeing pair**
(`selected` restore.mjs:409, copied out :674/:676; `outDir` :401/:411 beside `destFor`; callers
commands/restore.mjs:88/:115–116, extract.mjs:52/:60–63/:84–85; `extractTo` :252–254 against
`selectTargets(…, [item])` extract.mjs:83). **"Transport failure first, then drift" ×3**
(upload.mjs:594–614, :802–809, :893–896; deliberate per ADR-0069's amendment). **`pathMatcher` vs
`unmatchedFolders` on a blank folder** (path-match.mjs:147, :189–191; unreachable).
**`snapshotFiles` is a token the command carries** (commands/cleanup.mjs:106 → :227; with
**cleanup's top-up**). **takeover reads the holder twice** (takeover.mjs:61–70; attach.mjs:37 again,
`held` ignored at :73). **AWS template file names** (lib/aws.mjs:96–114 via `bare()`;
commands/aws.mjs:125, :137, :155 without; the literal pattern at commands/aws.mjs:104 and
commands.mjs:246). **Progress width read twice per frame** (snapshot.mjs:465, progress.mjs:142,
`clockedLine` :268). **`formatByteValue`'s widest output** (format.test.mjs:41 pins `1234.6PB`;
s3.mjs:631–633 `SIZE_COL = 8`; snapshot.mjs:660–662 `BYTES_COLUMNS = 7`). **Provider's switch**
(commands/provider.mjs:52–61, :270–275; `settingKeys` lib/provider.mjs:35). **A set with no bucket**
(`readSet` sets.mjs:342–376 throws :356–364; `resolveSet` :403). **`hashedFiles` counts empty files**
(file-props.mjs:180–199; snapshot.mjs:353–356). **The empty file's hash spelled three times**
(delete.mjs:16–17, file-props.mjs:35, delete.test.mjs:103–104). **Debug decompression**
(snapshot.mjs:4, :371–377).
**Stale prose.** New: [restore.mjs](../src/lib/restore.mjs):345–348 and guide/restore.md:156 (with
**restore decides once**); [referenced.mjs](../src/lib/referenced.mjs):121–130 (with **damage by
class name**); [remote.mjs](../src/lib/remote.mjs):184–187 (`status` reads through
`readLatestRemoteSnapshot`), :205–206 (`referencedObjects` is `forget`'s, not `verify`'s), :247–249
("for cleanup alone"), :34–36 ("the layout stays spelled in one place": set-marker.mjs:361/:366 and
referenced.mjs:332 spell it too), :125–126; [unrestorable.mjs](../src/lib/unrestorable.mjs):95–97,
:111–114 ("a set whose every snapshot failed to read has no entry"); [commands/verify.mjs](../src/commands/verify.mjs):24–27
(omits `invalid` and `archived`); [snapshot-file.mjs](../src/lib/snapshot-file.mjs):58–60, :624–625
("the grammar never leaves this module": spelled at site/.vitepress/challenge-bucket.mjs:94–110,
snapshot-sample.data.mjs:128 and test/helpers/write-snapshot.mjs:69); [render.mjs](../src/render.mjs):12–13
("bar one list": `ERRORS_SHOWN` cuts four); [objects.mjs](../src/lib/objects.mjs):84–85 ("the
`restore` command composes this"); [atomic-file.mjs](../src/lib/atomic-file.mjs):9–10 ("for the
download path"); docs/adr/0100:28–29 ("with `*` as the fix") and exclude.test.mjs:285's name;
test/doc-examples.test.mjs:10–11, :223–224 ("the dispatcher's own `parseArgs` call");
site/.vitepress/node-shim.mjs:6–7. Carried, all still present:
[lib/cleanup.mjs](../src/lib/cleanup.mjs):1–2, :8–11, :51–52 and [commands/cleanup.mjs](../src/commands/cleanup.mjs):19–20,
:31–33, :111 (with **cleanup's top-up**); [s3.mjs](../src/lib/s3.mjs):954–963 (`objectExists`'
caller); snapshot-file.mjs:968 ("what `restore --output` re-roots by");
[path-match.mjs](../src/lib/path-match.mjs):3–11, :58–62; [commands/restore.mjs](../src/commands/restore.mjs):89–95;
[commands/upload.mjs](../src/commands/upload.mjs):36–37; docs/design/backup.md:313; walk.mjs:49–59
and walk.test.mjs:743–744 (with **one classifier**); objects.mjs:12–22, :212;
[compare.mjs](../src/lib/compare.mjs):395.

**Examined & left alone (nineteenth pass)** (not candidates — skip future runs). **The reader and
the records:** one reader landed deep — `parseS3cabFile` (snapshot-file.mjs:1250) is the only TSV
line reader in `src/` (a grep for `split("\t")` and the row literals hits it and the record's writer
only), and snapshot-file.damage.test.mjs:173–209 pins both file kinds to the same rules; `.info` and
locks keep their own lenient `KEY=value` grammar on purpose (guide/format.md:163–166), `infoFields`
with two consumers; lock `PID` validity is judged in `parseLock` only; the record's refusal of `-`
rows sits in its row callback because it depends on the file kind; the work file's lifecycle after
#506/#511 is tested on its failure, takeover and interrupt paths; `tolerant` is set only by
`readParkedLookup`; `compactDeletionRecords`' write-then-delete order; read-lines.mjs,
control-chars.mjs. **Restore and landing bytes:** the abort after a failed upload is owned inside
`putFile` (s3.mjs:847–903, tested at s3.test.mjs:1543–1761), so no caller sees an upload id and no
fake needs to model it; the four `putFile` fakes (three plan-loop ones returning `true`, kept honest
by the stencil's throw-by-default; `fake-s3.mjs`:219 honouring `sha256`); `writeFileAtomic` (a
caller needs to know only that the folder exists) and `copyFileAtomic` (the source's faults an
answer, the destination's a throw, split by `syscall`, atomic-file.test.mjs:178–215); the failure
judgement has one meaning per direction (`ContentMismatchError` is drift, `IntegrityError` is
corrupt); `tempPathFor` exported for tests, the `REQUESTS_IN_FLIGHT` precedent; `statProps` still
the one mtime rounding; snapshot.mjs, file-props.mjs, commands/backup.mjs and commands/upload.mjs
unchanged in shape. **The bucket-wide read side:** unreadable snapshots (`unreadableSnapshots`
referenced.mjs:222) and refused rows (`invalidRowSnapshots`) each have one derivation and one policy
per consumer (verify reports, cleanup refuses, forget warns and ignores refused rows, as restore
refuses the same row), and they agree; a damaged deletion record errs toward alarm in every
consumer (ADR-0101); a set with no snapshots has ADR-0117's three policies, each tested;
versioning has its call in s3.mjs:1100, its judgement in lib/verify.mjs:224–227 and its wording in
render.mjs:880–900; `takenLater` has one site (tested in model.adversarial-506.test.mjs only);
`readNewSnapshots`' ETag diff; `damagedSnapshotsMessage`'s two producers; `unreadableMessage`;
lib/delete.mjs, `unlock`, `delete` and `list` unchanged. **Patterns, help and rendering:** help.mjs
feeds the terminal, the site's command reference and the README tables from one model (`argRows`,
`optionRows`, `globalOptionRows`, `commandGroups`, `synopsis`) with two real adapters (`usage`,
`commandPage`), held by command-pages.test.mjs — the registry seam is still clean; the escape rule
(`STRAY_ESCAPE`, `strayEscape`, `ESCAPE_RULE`, `asFolders`) is stated once and `globSource` is the
one token compiler, exclude and find wording their refusals apart on purpose (path-match.mjs:280);
`preparePath`/`foldsCase` state the path-shape question once; the playgrounds import public exports
only, and node-shim's `normalize` is held to Node by node-shim.test.mjs:49; render.mjs's new blocks
(`versioningNote` :880, `renderStatus` :756, forget's retired branch :1746) are single lines, not
label-and-list, so `section()` doesn't apply; `backupMatcher`'s `.s3cab` rule restates `walkFiles`'
in the same module, cross-referenced; test/doc-examples.test.mjs copies no error text. **Tests:**
the unit stencil (test/helpers/s3-seam.mjs) and the model tier's backend differ on purpose, and
test/s3-seam.test.mjs still holds the stencil's surface in both directions. **Not read:**
scripts/cleanroom/ (three commits since the last pass, two of them run records); auth, env, provider
and aws (unchanged).

---

Surfaced 2026-10-30 (eighteenth pass): **22 `src/` commits since `09a082f`** (80 files,
+8422/−2190), read at HEAD `68da4b0`: locks in the bucket (ADR-0112) with basic-form names
(ADR-0113), the restore rework (ADR-0109–0111, `extract`), and the reader's validity rules from
three clean-room sets. The nineteenth pass re-verified every open entry: all eleven candidates hold
and are carried above, re-anchored (**cleanup's top-up** wider; **codec damage on both sides** wider,
now **damage by class name**; **a restore fault kind** with its counts corrected), with the smaller
items, four of them corrected; **`exclude`'s platform constants** is absorbed by **which system's
pattern rules**. **The upload lock's untested holds** landed with that pass (#472) and **one reader
for a valid s3cab file** after it (#474).

**Examined & left alone (eighteenth pass)** (not candidates — skip future runs). **Locks:** the
liveness rule has one home (`liveLocks`, `processAlive`, `pidNamespace`), nothing outside re-derives
it (grep for `process.kill|processAlive|pidNamespace|/proc/self/ns|ESRCH` hits locks.mjs and its
test only), and it is pinned through the holds (locks.test.mjs:469–655: dead pid swept and announced,
alive kept, EPERM alive, other OS / PIDNS / machine never judged, no PID kept). Write-first/look-second
and finally-removal are invariants of `hold` (:366–376), not discipline: the six sites pass only a
closure, request order is pinned (:368–373, :683–688), a LIST failure and a failed removal are
tested (:439, :450, :830). `--wait` is one loop (:444–474), lock-free while waiting by construction,
stepped under a timers mock (:98–109, :759–818) and run for real in the crash tier
(test/crash/concurrency.test.mjs:313–383); the knob forwarded through `reclaim`/`deleteContent` is
the cost of "lock inside the lib", two sites. `basicForm` (format.mjs:282) is one formatter with
three producers, `snapshotNames` (snapshot-file.mjs:754) the one recognizer, and lock ids are never
parsed by digits (`kindOf` by prefix, `instantOf` by first hyphen); roles-anywhere.mjs:745–748's
`[:-]` strip is SigV4's wire format behind the ADR-0059 boundary. `infoFields` now has two production
consumers, a deepening; cleanroom's `check-backup.mjs` reader is independent by design.
`readNewSnapshots` diffs by key, never by name or time (remote.mjs:301–306). `scanBucket` keeping
`snapshotFiles` is argued at bucket-scan.mjs:45–47. `unlock` composes `listLocks`/`removeLock`/
`describeLock` and never judges liveness (:11–16). Dry run and a declined prompt take no lock
(pinned). Record-first under the lock with the instant read under it (lib/delete.mjs:37, argued
:22–26). `eachInFlight` settles every worker before rejecting (objects.test.mjs:270). The `hold`
doc's Ctrl+C claim is correct via snapshot-file.mjs:348–355 and `propsRows` :1293–1295.
`WAIT_MS`/`writeLock` exported for tests only, the `REQUESTS_IN_FLIGHT` precedent. `uploadSet`
(upload.mjs:560): its three options are the command's bag relocated and it has one production
caller, but what is behind it is deep (the lock, the baseline, the trust-checked skip-list, the
splice, the failure-vs-drift judgement, the holder check and no-clobber manifest) and the
lock-placement rule earns the seam; backup.test.mjs:78–90 fakes it, upload.set.test.mjs tests it
with the engine faked. `describeLock`'s hand-made-lock branch and `goalOf`'s fallback are the only
unexercised lines. `lib/delete.mjs` has no co-located test and runs for real inside
commands/delete.test.mjs — honest "tested elsewhere". The ADR-0112 audit in proposals/bugs.md
already covers privileged pids, versioned buckets, clock skew and `unshare --pid` inode reuse.
**Restore and the reader:** `restoreTargets`' loop (fate-by-hash, collision by
`realpathSync.native`, `firstMissing`/`removeMade`, `isRefusedName`/`isInTheWay` measured codes,
`linkedFolder` memo, the mtime read-back) — one deep function behind seven named args, two
production callers with different `destFor`; `chooseSnapshot`; `selectTargets`' all-vs-some rule
(:315–322); `extract`'s pre-read refusal and `alreadyThereError`'s three flag-preserving commands
(extract.test.mjs:128–160); `reroot`/`extractTo`/`placeUnder` separator-agnostic, tested on every
shape from one OS, `reroot`'s relative branch pinned dead (restore.test.mjs:208);
`writeFileAtomic`/`land`/`copyFileAtomic` after #463 (temp opened before any byte flows, `rm force`
on any failure, `IntegrityError` only with `hash`) and all three callers (`getObject` objects.mjs:93
with hash; `downloadRemoteSnapshots` remote.mjs:408 without — gzip's CRC is the check; the copy
restore.mjs:533), with atomic-file.temp-handle.test.mjs pinning the early open by mocking both
`open`s on purpose; `statProps` (file-props.mjs:51–56) as the one mtime rounding, three consumers,
with the format's year bound (:64–67) and restore's NTFS bound (restore.mjs:591, :707–711) correctly
separate; `pathFault`'s NUL/CR/tab/segment rules and the post-read tree pass (:1026–1084, both rows
refused, exact comparison per guide/format.md, the root `DIR`'s bogus parent key harmless — traced
for `/` and `C:\`); the writer sharing no predicate with the reader is by construction (the walk
yields real files under real roots, `@SET DIR` rows are `resolveWalkRoot`; ADR-0028); `parseS3cabFile`'s
held-line LF logic (#425) including the stray-lead-byte case; `rowFields` (:1235–1238) leaving
column five untrimmed; `formatLine`'s code-point padding (#443, writer only); the reader →
`refused` → restore (`selectTargets` :307–310) / verify (remote.mjs:367–369, verify.mjs:56–61) /
cleanup (`invalidRowSnapshots`) consumers; "a path that names nothing" decided in `selectTargets`
(:311–322), policy in `hasFaults` (:689, :699), rendered once (render.mjs:1510–1527), tested
(restore.downloads.test.mjs:453–481, :1254–1262; extract.test.mjs:276–281; path-match.test.mjs:64–116);
`nothingNamedError` reading `dirs.txt`, not the snapshot; `readPathList`'s TTY gate;
`recordUninspectable`'s file-only match (walk.uninspectable.test.mjs:126–131). `path-match.mjs`
holds one shape per family: `globSource` (:226) one token compiler with two anchoring wrappers
(exclude.mjs:60, find.mjs:143); `pathKey`/`pathMatcher`/`unmatchedFolders`/`up` one containment key
scheme; `pathMatcher` has two production consumers (restore's `selectEntries`, the reader's
`parseSnapshotStream` :1036), a real seam; `isMatchableDir` and `rootLength` are reader/restore
helpers that landed there. Snapshot fixtures spelled by hand in three command tests
(extract.test.mjs:40, restore.counts.test.mjs:35, restore.downloads.test.mjs:81–85) sit at the
`readRemoteSnapshot` seam; `planRestore`'s injected `stat` (:98) serves its unit test while
`restoreTargets` hard-binds `lstatSync` (:399), so restore.counts.test.mjs:41–51 mocks
`node:fs.lstatSync` — a candidate since the nineteenth pass, **restore decides once**. guide/restore.md and docs/design/backup.md §restore
are current with ADR-0109/0110/0111 bar the line above. No last-name-layout prose survives.
**Elsewhere:** the registry and dispatch (`--wait` is one boolean carried command → lib →
`holdDeleteLock` by ADR-0112's design; nine commands validate their own flag combinations under
ADR-0011, each with distinct semantics); the destructive gate ×4 (cleanup.mjs:86, delete.mjs:176,
forget.mjs:146, unlock.mjs:53), the tenth pass's reasoning holds; `putFile` (s3.mjs:741–877) after
#459 — the interface's three options unchanged, the promise strengthened (sent bytes hashed in a
`Readable.from` wrapper and compared when the body ends, before lib-storage completes; mismatch →
`ContentMismatchError` with nothing stored, abort-time error as `cause`; `noClobber` + 412 → `false`),
the three plan-loop fakes that return `true` without hashing (upload.test.mjs:76,
upload.set.test.mjs:56, backup.fused.test.mjs:32) kept honest by the stencil's throw-by-default,
`test/model/harness/fake-s3.mjs:196` honouring `sha256`, loopback tests s3.test.mjs:1472–1600, real
bucket test/integration/s3.test.mjs:99–116; `error.mjs`: every class caught by type in production,
`ChangedWhileReadError` (:177) thrown at file-props.mjs:186 and caught at commands/upload.mjs:169 and
upload.mjs:504; `bucket-scan.mjs` still body-ordered (:66–85), two consumers destructure and
re-derive nothing; `remote.mjs`'s `listSnapshotFiles`/`readReferencedObjects` split with
`referencedObjects` kept for `forget`'s snapshot-only need; the START-dating rule in two shapes
(`explainingDeletions` referenced.mjs:104, bucket-wide, callers bucket-scan.mjs:82 and forget.mjs:201;
`recordFor` restore.mjs:462–471, one snapshot, cross-referenced) — the verify/restore "deliberate ≠
fault" rejection's reasoning holds, both tested (referenced.test.mjs:43–88,
restore.downloads.test.mjs:998), and the deletion-record lookup now has four consumer shapes, two
sharing one function; `attach.mjs` unchanged, two callers with different follow-ups; `help.mjs`,
`command-details.mjs`, `sets.mjs`, `list.mjs`, `lib/snapshot.mjs`, `lib/verify.mjs`: no code change
beyond doc lines; `renderUnlock` returns `""` when nothing was removed and the dispatcher's
empty-output contract (s3cab.mjs:150) handles it; `renderRestore`'s `to` branch tested
(render.test.mjs:1595–1614), its verb chosen by the presence of a data field for a renderer both
registry entries share — a type-tag by proxy, noted with **a restore fault kind**; pass 13's verdict
on folding restore's sentence-headed blocks into `section()` not revisited.

---

Surfaced 2026-10-15 (seventeenth pass): **17 `src/` commits since `2820adf`** (89 files,
+5266/−2972), read at HEAD `09a082f`: the snapshot-format revision (ADR-0098–0107), set ownership
(ADR-0108), the bucket and identity stacks (ADR-0105), #398/#399/#410. The eighteenth pass
re-verified every open entry: all five candidates and all four carried hold and are carried above,
re-anchored (**one classifier in the walk** and **surplus positionals** wider, **suggested exclude
line** with a wider input, **forget plans twice** with two policies), with the smaller items that
still hold; **`preparePath`'s unread fields** is dead.

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
(model.hostile.test.mjs:308–368) and the `IntegrityError` path. `selectEntries`/`reroot`
as pure functions (`planRestore` was one until ADR-0116: see **restore decides once**). `shellCommand` and the
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
planUnrestorable / planCleanup / verifySet / planUpload all pure and all say so; `planRestore` was
one until ADR-0116, see **restore decides once**);
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
> 2026-10-09 sixteenth and its landing, PR #391) recorded landings that are already of record in
> their ADRs, PRs and `git log`, and re-verification notes superseded by every pass since. They
> live in this file's history: `git log -p --follow -- proposals/architecture-improvements.md`.
> Keep this section bounded — a pass that lands a candidate should retire the *open* entry, not
> append indefinitely here.

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
- **2026-10-30 — eighteenth pass.** Read the **22 `src/` commits since `09a082f`** (80 files,
  +8422/−2190) at HEAD `68da4b0`: locks in the bucket (ADR-0112) and `unlock`, basic-form names
  (ADR-0113), the restore rework (ADR-0109–0111, `extract`), the clean-room sets' reader rules
  (#425/#428/#439/#443/#452–#457), #459/#460/#463. Four background sweeps (the locks, restore and
  the reader, the carried list, the remainder), then every Strong and Worth-exploring claim checked
  by hand. **New: the upload lock's untested holds (Strong); cleanup's top-up, a restore fault
  kind's five enumerations, pre-decision stdout under `--json` and the snapshot-name spelling
  (Worth exploring); nine new smaller items.** Top pick **the upload lock's untested holds**, grilled
  and landed with this pass: `uploadSnapshot`, `uploadDir` and `uploadFile` assert their holds
  (lock → the operation's hashes and PUTs → unlock, and the lock's args) in upload.test.mjs,
  `uploadFile` its whole interface including the `ContentMismatchError` → `change` path, and the
  four hand-written lock fakes became `test/helpers/lock-seam.mjs`, typed from the real holds; no
  surface test, because it deliberately covers the two holds and not the `unlock` command's reads.
  The deepening to take next is **one reader**. Overwrote the HTML report in place.
  - **The one-reader divergences were run, not traced.** A scratch probe imported the worktree's
    real `deletion-record.mjs` and `snapshot-file.mjs` and fed each a file ending `.\n.` and one
    with a 0xFF byte in a row: the record said "rows follow" and "valid" where the snapshot said
    valid and "isn't UTF-8 text". The S3 body's `transformToString` is `@smithy/core/serde`'s
    `toUtf8`, a lenient `Buffer.toString("utf8")`. A grilling can start from that output.
  - **The untested holds were proved by grep, not assumed.** `lockCalls` is written at
    upload.test.mjs:120/:129, reset at :202 and read nowhere; `ContentMismatchError` appears in
    tests only at the `putFile` level (s3.test.mjs, the integration suite) and as a constructed
    cause (commands/upload.test.mjs:296); no test under `src/` or `test/` called the lib
    `uploadFile` (commands/upload.test.mjs runs `upload --file` with it mocked).
  - **The carried list was re-verified by a sweep and then by hand.** Every candidate holds; two
    wider (the walk's classifier, surplus positionals), one dead (`preparePath`'s unread fields),
    and one claim inside **progress width** dead (the `_refreshSize` fake is a module mock now).
  - **The rejected/parked list was re-checked and stands.** **Cleanup's top-up** keeps
    `planCleanup` pure (pass 10's plan/execute verdict); **a restore fault kind** stays inside
    `renderRestore`, not the `section()` grammar pass 13 declined; **pre-decision stdout** touches
    ADR-0043 and says so on the entry; the verify/restore "deliberate ≠ fault" rejection holds, the
    START-dating rule's two tested shapes noted beside it.
  - **The fifteenth pass's run-log entries were retired under the three-pass cap.** Its landings
    are PRs #366–#380; `git log -p` on this file keeps the rest.
- **2026-11-11 — nineteenth pass.** Read the **22 `src/` commits since `68da4b0`** (69 files,
  +5423/−1276) at HEAD `124c7868`: one reader (#474), the durability work (#503 and ADR-0116,
  #506/#511 and ADR-0117, #507 and ADR-0118, #508), backslash escapes (#478 and ADR-0115, #502),
  the playgrounds and the generated command reference (#482/#484/#490). Five background sweeps (the
  reader and the records, restore and landing bytes, the bucket-wide read side, patterns and help,
  the carried list) and a hand read of `test/`, then every Strong and Worth-exploring claim checked
  by hand. **New: restore decides once (Strong, a live defect); a download's body (a live defect),
  what counts as a set, which system's pattern rules and the model tier's scenario world (Worth
  exploring); twelve new smaller items.** Codec damage on both sides is Strong now, as **damage by
  class name**. Top pick: **restore decides once**. Overwrote the HTML report in place.
  - **Five claims were run, one counted.** Scratch probes imported the real modules:
    `restoreTargets` against a loopback S3 that created `b.txt` while `a.txt` downloaded; `getObject`
    against a loopback server that cut the socket after 1,000 of 1,000,000 bytes;
    `isCorruptSnapshotError` on what `readSnapshot("", "x")` and a `getStream`-style assert throw;
    `planUnrestorable` with and without a `photos_2025` folder, and `isSetName` beside
    `validateSetName`; `compileExcludePatterns` under Linux rules without the refusal. The model
    tier's copies were counted by grep. A grilling can start from each entry's *Run* line.
  - **Neither live defect was in proposals/bugs.md when this pass ran.**
  - **The carried list was re-verified by a sweep and then by hand.** All ten candidates hold:
    **cleanup's top-up** wider (the scan prunes its own listing), **a restore fault kind** with its
    counts corrected, **codec damage on both sides** wider (a third caller, `status`) and renamed.
    Four smaller items were corrected (`formatInfo` never had optional lines; a
    `ContentMismatchError` serializes its name; bucket-name validation is five of five flag commands
    and one of four positional; "absolute by shape" has a fifth site), and **`exclude`'s platform
    constants** went into **which system's pattern rules**.
  - **The rejected/parked list was re-checked and stands, with one "left alone" reversed.** Passes
    10, 15 and 18 kept `planRestore` as a pure plan with a test-only `stat`; ADR-0116 has since
    made restore's rule "recheck the target at each write", and the plan's `skip` is the one
    judgement that doesn't, so those three notes now point at **restore decides once**. **Damage by
    class name** moves knowledge *into* snapshot-file.mjs, so ADR-0028 and the codec-split rejection
    stand. **The model tier's scenario world** is a harness module with seven existing callers, not
    a seam in `src/`.
  - **The sixteenth pass's run-log entries were retired under the three-pass cap.** Its landing is
    PR #391; `git log -p` on this file keeps the rest.
