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

Surfaced 2026-10-30 (eighteenth pass): **22 `src/` commits since `09a082f`** (80 files,
+8422/−2190), read at HEAD `68da4b0`. Three subsystems: locks in the bucket (ADR-0112:
`locks/<kind>-<instant>`, write first look second, pid liveness, `--wait`, `unlock`, the cleanup
top-up) with basic-form names (ADR-0113); the restore rework (ADR-0109 the full path under
`--output`, ADR-0110 paths, a list or `--all`, ADR-0111 `extract`); and the reader's validity rules
from three clean-room sets (#425 torn UTF-8, #428 one tree as files, #439/#452–#457 the spec's
gaps). Beside them #459's digest before completion, #460's uninspectable entries, #463's early temp.
Four background sweeps (the locks, restore and the reader, the carried list, the remainder); every
Strong and Worth-exploring claim below was checked by hand, and the one-reader divergences were
**run** against the real modules this time, not traced.

**Verdict: the new modules are deep; the friction is at the joins and in what the tests don't
say.** `locks.mjs` holds the whole rule behind two guards that take only a closure, and nothing
outside it re-derives liveness; `extract` composes `restoreTargets` rather than carrying a loop.
But three of the six lock sites and the `upload --file` guard #459 changed were asserted nowhere,
though the fakes already existed (**the upload lock's untested holds**, landed with this pass — see
the run log); the cleanup top-up is stated
in four modules and its interlocks run twice (**cleanup's top-up**); a restore fault kind is five
hand-enumerations (**a restore fault kind**); three destructive commands write to stdout before the
dispatcher prints JSON (**pre-decision stdout**); a typed snapshot name is normalized in two
commands of five (**snapshot-name spelling**). The carried list holds, two entries wider.

**Picking these up cold (a later session, or another machine).**
(1) **Line anchors rot on every landing, and so do file paths.** Two files of the same name exist in
`src/commands/` and `src/lib/` (`delete.mjs`, `verify.mjs`, `cleanup.mjs`, `provider.mjs`,
`snapshot.mjs`), so **write paths from `src/`, not bare filenames**. Re-verify before trusting any
anchor.
(2) **Ordering constraints.** **One classifier in the walk** and **tree's tab-separated output** both
edit `src/lib/walk.mjs`; **surplus positionals** and **one claim** both edit
`src/commands/takeover.mjs`; **one reader** and **codec damage on both sides** both edit
`src/lib/snapshot-file.mjs`'s reader. Land one of each pair before starting the other.
(3) **`.env.test` is gitignored and does not travel.** Every open candidate below is pure or sits
behind a fake (`s3Seam`, `lockSeam`), and verifies with `npm test` alone; none touches
the real S3 read/write path.

- **One reader for a valid s3cab file — the deletion record re-states the reading rules the
  snapshot reader owns, and the two disagree; run this pass.** _Strong; carried from the seventeenth
  pass, re-anchored, divergences reproduced._ #452/#457 made
  [deletion-record.mjs](../src/lib/deletion-record.mjs)'s `parseDeletionRecord` (:98–139) compose two
  more of the reader's row-level pieces (`rowFields` :113, `isInstant` :125) and left all eight
  file-level rules re-stated beside `parseSnapshotStream`
  ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):886–1092): heading (:103–105 vs :927–934), blank
  skip (:110 vs :935), rows after `.` (:114–115 vs :939), "`.` counts only with its LF" (:116–118 vs
  :981–1003), `.` plus junk (:119–120 vs :943–946, **new since filing**, word for word), hash and
  size regexes (:123–124 vs `fileRowFault` :1100–1104), unknown type (:131–133 vs :972–977), missing
  `.` (:135–137 vs :1021–1024); five error strings are the snapshot's minus its prefix. The two
  divergences, run against the real modules: a file ending `.\n.` is **valid** to the snapshot (the
  LF-less held `.` is skipped at :1001) and "rows follow the closing `.` line" to the record (:114);
  a 0xFF byte in a row is refused by the snapshot (`utf8Lines` :1189–1208, fatal decoder) and parsed
  as **valid** by the record, `by: "me@\uFFFD"`, because `getText` ([s3.mjs](../src/lib/s3.mjs):1009–1013)
  hands it `transformToString()`'s lenient text (`@smithy/core/serde`'s `toUtf8`, a
  `Buffer.toString("utf8")`), though ADR-0101 applies the refusal to both layouts. **Fix:** one
  line-walker in snapshot-file.mjs owning the file-level rules over bytes (heading, blank, terminator
  with its LF, nothing after, unknown type, UTF-8) and taking a per-type row handler, returning the
  file-level verdict as a value, so `parseDeletionRecord` contributes only what a `#deleted` row is
  and its own "a malformed row distrusts the record" verdict; the record's text arrives as bytes.
  Knowledge moves *into* snapshot-file.mjs, so ADR-0028 and the codec-split rejection stand.
  **Tests:** two hand-mirrored damage tables (snapshot-file.test.mjs:163–268;
  deletion-record.test.mjs:199–262); the record has no CRLF or UTF-8 case, neither has `.\n.`; the
  heading literal is hand-spelled in five test files (deletion-record.test.mjs:80,
  bucket-scan.test.mjs:77, status.test.mjs:89, snapshot-file.test.mjs:43,
  snapshot-file.torn-utf8.test.mjs:23) and the `HEADING + … + ".\n"` framing in three more
  (list.test.mjs:147, compare.test.mjs:798, remote.referenced-scan.test.mjs:92);
  test/helpers/write-snapshot.mjs:67–79 goes through `stringifySnapshot` but still no `openingRows`,
  no `START`. The new test is one damage table through both readers.
- **Cleanup's top-up has four homes, and its interlocks run twice.** _Worth exploring; eighteenth
  pass, read._ Understanding ADR-0112's top-up means [bucket-scan.mjs](../src/lib/bucket-scan.mjs):45–47,
  :67 (keeps `snapshotFiles` for it), [commands/cleanup.mjs](../src/commands/cleanup.mjs):103 (destructures
  it), :116–122 (interlocks on the scan), :218 (hands it back, never read),
  [lib/cleanup.mjs](../src/lib/cleanup.mjs):213 (`topUp`, the arithmetic) and :269–283 (`reclaim`, the
  orchestration, the same two interlocks `unreadableSnapshots`/`invalidRowSnapshots` on the
  additions, acknowledged at commands/cleanup.mjs:114–115), and [remote.mjs](../src/lib/remote.mjs):297
  (`readNewSnapshots`, the key diff and the read). `CleanupPlan` (:50–59) has two producers,
  `planCleanup` from scratch and `topUp` patched, and the patched one's `missing`/`damaged`/
  `unreadable` describe only the scan's snapshots with nothing saying so; `reclaim` reads four of its
  eight fields. The lib's header (:1–2, :8–11) still says "the read-only twin of `verifySet`" and
  "the interlock *policy* is the command's", :48–49 "the command owns the wording" — true only of
  `planCleanup`, since `reclaim` throws `unreadableSnapshotsError` :169 / `invalidRowsError` :189
  from this file. **Fix:** state the top-up once — the scan returns what it read as one value,
  `reclaim` re-lists and applies one interlock to scanned and added alike — and rewrite the header.
  `planCleanup` stays pure (the tenth pass's plan/execute verdict is untouched). **Tests:**
  commands/cleanup.test.mjs:185–280 pins the order (lock → top-up → delete → compact → unlock), the
  kept object and the abort under lock; lib/cleanup.test.mjs:124–168 tests `topUp` alone.
- **A restore fault kind is five hand-enumerations.** _Worth exploring; eighteenth pass, read._ The
  twelve lists of `RestoreResult` are enumerated by hand in [restore.mjs](../src/lib/restore.mjs)'s
  typedef (:38–55), the return (:649–665) and `hasFaults` (:681–700), and in
  [render.mjs](../src/render.mjs)'s `renderRestore` destructure (:1327–1345) and its "anything
  happened" condition (:1353–1363, which already omits `clamped` and `unmatched`). #466 added
  `unmatched` to four of the five; `renderRestore`'s three newest blocks (`blocked` :1451, `clamped`
  :1470, `unmatched` :1510) arrived by copying the six before them, so nine blocks (:1384–1562) share
  heading-sentence / indented list / blank / fix sentence / `shellCommand`, varying only in clause
  agreement and the entry formatter. **Fix:** one table of fault kinds — whether it exits 1, its
  heading clause, its fix — that the result's shape, `hasFaults` and `renderRestore`'s block loop all
  read. This is inside `renderRestore`, not the `section()` grammar pass 13 declined to fold it into;
  ADR-0043's data/wording split is kept. **Tests:** render.test.mjs's restore cases and
  restore.downloads.test.mjs assert per kind; a table makes "every kind that exits 1 renders a fix"
  one assertion.
- **Surplus positionals — the registry says which commands take one positional, and three refuse
  extras by hand in three wordings while thirteen drop them silently.** _Worth exploring; carried,
  wider._ [s3cab.mjs](../src/s3cab.mjs):115–130 still hands `positionals` through with no count;
  `variadic` is read only by help.mjs's `displayArg` (:81–82). [commands.mjs](../src/commands.mjs):
  reattach :369–384 and takeover :391–406 declare `args: { set }` and destructure
  `[name, ...directories]` so [reattach.mjs](../src/commands/reattach.mjs):52–56 and
  [takeover.mjs](../src/commands/takeover.mjs):55–59 can refuse; **new:** extract :494–498 declares
  `path` single and :526 passes `paths` whole so [extract.mjs](../src/commands/extract.mjs):39–45 can
  refuse `more` after filtering blank positionals (:39), a rule no other command has. Of 22 commands,
  6 are variadic (find, setup, restore, forget, delete, unlock), 3 refuse, 13 drop a surplus via
  `[x] = []` (snapshot, list, compare, status, aws, provider, backup, verify, cleanup, hashes, upload,
  tree, prop): `s3cab backup photos extra` drops `extra`, `reattach photos extra` refuses. The
  eleven-line preamble (setup.mjs:71–84, reattach.mjs:42–51, takeover.mjs:45–54) is unchanged.
  **Fix:** the dispatcher refuses a surplus positional from the `args` declaration; the three blocks
  and the `...directories` parameters go, and `validateSetName` (sets.mjs:202) can take `undefined`
  and throw `MissingArgError` itself. **Touches ADR-0011's rejected option** (a registry-driven
  scheme), worth reopening on two counts: `variadic` is a structured property, not a parsed display
  string; and a surplus positional is a CLI-only fact a library caller can't produce, so the guard
  the ADR wants on the library surface is the type. **Tests:** reattach.test.mjs:52–58 asserts the
  refusal for one command; a dispatcher test covers every non-variadic command.
- **One classifier in the walk — the walk refuses a name the snapshot can't hold by two mechanisms,
  which disagree on a directory; now four pattern sites.** _Worth exploring; carried, wider._
  [walk.mjs](../src/lib/walk.mjs): tab/CR/LF in the kept-files loop (:311–319,
  `UNREPRESENTABLE_IN_TSV` :55); no UTF-8 form in `createWalkCallbackFn` (:391–400, its own
  `excludedBy` :393). **New since filing:** #460's `recordUninspectable` (:439–443, matches as a
  file) and `checkLink` (:531–535, matches with the stat'd type) are a third and fourth asking of
  `excludedBy`, so "which type to match a pattern against" is spelled three ways (the dirent's
  :392–393/:416–417, always-a-file :440, the stat'd :531–532). Both mechanisms feed
  `found.unrepresentable` and the one throw (:332–347); a tab-named directory is descended and every
  file beneath it refused (walk.test.mjs:732–744, the comment :738–741 still half true), a non-UTF-8
  directory listed once and never descended (:776–826). The doc (:44–54) and walk.test.mjs:693–694
  still justify the CR refusal by `crlfDelay: Infinity`; the reader is `utf8Lines` (LF-only) and
  `pathFault` (:1122–1127) refuses a CR; the export has no importer outside walk.mjs. **Fix:** the
  callback is the one classifier (type, excluded, representable) and the loop keeps only `seen`;
  rewrite the CR reason in place and un-export. **Tests:** walk.test.mjs:660–745 and :776–826 cover
  both paths through the thrown message; walk.uninspectable.test.mjs:99–132 already asserts
  per-entry outcomes as data — the shape the fix wants.
- **Pre-decision stdout under `--json`, thrice — three destructive commands print their preview to
  stdout before the dispatcher prints the result, and the rule has no home.** _Worth exploring;
  eighteenth pass, read._ [delete.mjs](../src/commands/delete.mjs):212–215,
  [forget.mjs](../src/commands/forget.mjs):221–224 and [unlock.mjs](../src/commands/unlock.mjs):90–93
  (new) each `console.log` a listing under the same three-line comment ("pre-decision output goes to
  stdout here rather than through `render`"); the dispatcher strips `json` before `exec`
  ([s3cab.mjs](../src/s3cab.mjs):129–130), so a command can't know, and under `--json` a consumer
  gets prose then JSON on one stream. guide/output.md:41–43 says `--json` governs "a command's
  successful result on stdout" and doesn't mention this. **Fix:** give the pre-decision preview one
  home the dispatcher owns, so `--json` can route it — or, if the stream mix is the decision, record
  it once in ADR-0043 and guide/output.md and point the three comments at it. **Touches ADR-0043's
  one render layer**; worth reopening only because the guide and the code disagree and the count
  went 2→3. **Tests:** delete.test.mjs/forget.test.mjs/unlock.test.mjs capture stdout per command;
  nothing asserts the `--json` stream.
- **A typed snapshot name is normalized in two commands of five.** _Worth exploring; eighteenth
  pass, read._ `normalizeSnapshotName` ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):737, "so
  callers taking user-supplied names never learn the extension grammar") is applied by
  [compare.mjs](../src/lib/compare.mjs):101–118 and [commands/upload.mjs](../src/commands/upload.mjs):106–107;
  `chooseSnapshot` ([restore.mjs](../src/lib/restore.mjs):274, for `restore` and `extract`) and
  [forget.mjs](../src/commands/forget.mjs):161–162 compare the raw string against
  `listRemoteSnapshots`, so `--snapshot 20260612T0915.tsv.gz` is found by two commands and "not
  found" by three, each with its own not-found wording. **Fix:** one place where a typed snapshot
  name meets the listing, used by all five. **Tests:** restore.downloads.test.mjs and forget.test.mjs
  each assert their not-found error; one case per command for the `.tsv.gz` spelling.

**Carried from the seventeenth pass, re-verified 2026-10-30.** All hold; unchanged files confirmed by
`git log` with a control that printed commits for the changed ones.
- **One claim.** _Worth exploring; holds._ [setup.mjs](../src/commands/setup.mjs):266–273 does
  `freshInfo → claimRemoteSet → writeSet → writeClaim`; [takeover.mjs](../src/commands/takeover.mjs):90–103
  does `freshInfo(info?.created) → (writeRemoteInfo | claimRemoteSet) → writeClaim`; the lost race
  :94–101 is reached by no test (its message appears in `src/` only). [set-marker.mjs](../src/lib/set-marker.mjs):
  `claimRemoteSet` :118–120, `writeRemoteInfo` :140–142, `writeClaim` :166–168, `holding` :180–187.
  takeover.test.mjs:107–108 still asserts claim-text == marker-text; five cases, none the lost race.
  The fix stands as filed: set-marker owns the claim end to end, each path ending in the local write.
- **`held` means two things.** _Worth exploring; holds._ [list.mjs](../src/commands/list.mjs):37–38
  and `heldHere` (:136–146): a `claim` file exists; [reattach.mjs](../src/commands/reattach.mjs):15 and
  set-marker's `holding` (:180–187): the stored pair matches the marker, GLOSSARY's **Holder**.
  [render.mjs](../src/render.mjs):113–116 and :428–439 say "Held by this machine" for both.
  list.test.mjs:116–120 and :138–156 cover claim-present and none; nothing asserts a stale claim.
- **Suggested exclude line.** _Strong; holds, wider input._ `excludePattern` moved to
  [backup.mjs](../src/commands/backup.mjs):168–179; #461 keeps a folder link's trailing separator
  (:175–178) and it still returns `relative(root, path)` raw (:177) — no escaping of `*`/`?`/`[`/`#`
  or edge spaces; `parseLines` (read-lines.mjs:11–15) trims and drops `#`; `globSource`
  (path-match.mjs:226–229) has no inverse. #460 widened the source: an uninspectable entry is an
  `#error` (walk.mjs:439–449) → `pass.errors` → suggestion (backup.mjs:149–151). The render
  ([render.mjs](../src/render.mjs):1028–1040) says nothing about renaming; backup.test.mjs:230–280
  cover plain names. The fix (an inverse beside `compileExcludePatterns`, or nothing when the grammar
  has no exact spelling, and a render that says so) and the round-trip test stand as filed.
- **Forget plans twice.** _Worth exploring; holds, and the "same step" now has two policies._
  [forget.mjs](../src/commands/forget.mjs):194 (`.orphaned`) and :212 (`{ gone }`) are still two
  `planUnrestorable` calls around one intersect-and-HEAD (:200–211), which now pre-filters through
  `explainingDeletions` ([referenced.mjs](../src/lib/referenced.mjs):105–119, #456) and reads only
  `{ deleted }`, ignoring the record's `invalid`; `getUndeletedHashes`
  ([upload.mjs](../src/lib/upload.mjs):204–223) makes the same step but refuses on `invalid`
  (:205–208) and intersects the raw map. `.orphaned` is read at forget.mjs:194 and
  unrestorable.test.mjs:171 only.
- **Tree's tab-separated output.** _Worth exploring; holds, narrow form._ `renderTree`
  ([render.mjs](../src/render.mjs):531–535) writes `${entry.path}\t${entry.pattern}` raw
  ([tree.mjs](../src/commands/tree.mjs):40 passes the raw path). Patterns with a tab or CR are refused
  at walk.mjs:78–96; an excluded entry is recorded (:417–420, :442, :534) before the loop's tab check
  (:315), so `entry.path` can hold a tab on Linux and macOS (walk.test.mjs:700–716 asserts one such
  record). Spell it out as the `#excluded` row does (snapshot-file.mjs:584–591, `showControlChars`),
  or refuse it. Lands beside **one classifier in the walk**.
- **Codec damage on both sides.** _Worth exploring; holds._ `parseCompressedSnapshotStream`
  ([snapshot-file.mjs](../src/lib/snapshot-file.mjs):826–853) folds only `Z_BUF_ERROR` (:846–850) and
  rethrows `Z_DATA_ERROR` raw; `isCorruptSnapshotError` ([referenced.mjs](../src/lib/referenced.mjs):133–143)
  matches both codes plus `AssertionError`, its `Z_BUF_ERROR` arm unreachable from the reader;
  `AssertionError` sources are `utf8Lines` :1197, the `.` check :1021–1024 and `parseLine`'s asserts
  (:928, :939, :946, :973). referenced.test.mjs:216–245 feeds `gunzipSync` errors to the classifier;
  snapshot-file.test.mjs:710–780 cuts bytes through the reader and never calls it. The fix stands:
  the reader turns every codec failure into its own damage error, and the classifier names no codec.

**Smaller items (eighteenth pass)** — verified, too small for an entry of their own; the seventeenth
pass's items that still hold are carried here, re-anchored. **New:**
**Failure-reason spellings: six.** [locks.mjs](../src/lib/locks.mjs):258–259 adds a local `reason`
beside the inline form at auth.mjs:49 (`reasonFrom`), remote.mjs:360, snapshot.mjs:360, walk.mjs:446
(`recordUninspectable`); `errorText` ([error.mjs](../src/lib/error.mjs):311–322) at s3cab.mjs:109,
help.mjs:179, find.mjs:229, s3.mjs:342; `instanceof` at backup.mjs:85; `String(cause).trim()` at
auth.mjs:352.
**Two `--from-file` openers.** [restore.mjs](../src/commands/restore.mjs)'s `readPathList` (:157–182:
file or `-`, ENOENT → ADR-0030 message) and [delete.mjs](../src/commands/delete.mjs):127–142 (file
only, by ADR-0089's "no piping"); `parseLines` (read-lines.mjs:11) is the one grammar, with five
callers.
**`KEY=value`: one reader, two writers.** `infoFields` ([set-marker.mjs](../src/lib/set-marker.mjs):83)
serves the marker and the lock (locks.mjs:119); `formatInfo` (:71) and `formatLock` (locks.mjs:92)
each hand-join with their own optional-line handling, and the writer-side invariants (LF-terminated,
no newline in a value, no `=` in a key) are stated nowhere.
**`hold`'s unstated precondition.** "`work` rejects only after its requests have settled" is what
makes "remove the lock on any failure" safe; it is written at the adapter
([objects.mjs](../src/lib/objects.mjs):155–158, `eachInFlight`) and in ADR-0112, not at the seam
(locks.mjs:352–359 speaks of Ctrl+C only). Every current `work` satisfies it (traced: `eachInFlight`
for HEAD/DELETE; sequential awaits in `writeDeletionRecord`, `compactDeletionRecords`,
`uploadSnapshotFile`; the transform's `await putObject`), pinned at objects.test.mjs:270.
**Lock typing.** `holdUploadLock.command` is `string` (locks.mjs:405), `holdDeleteLock.command` is
`"cleanup" | "delete"` (:439); `goalOf`'s fallback (:255) is unreachable from the six sites.
**`Drift.cause` is a raw Error in a result.** upload.mjs:256; render.mjs:1291 and
commands/upload.mjs:258 read `cause?.code` off it; under `--json` an fs error serializes to
`{errno, code, syscall, path}` and a `ContentMismatchError` to `{}`.
**Bucket-name validation splits by operand position, 6:3.** `validateBucketName` runs in every
`--bucket`-flag command (delete.mjs:118, unlock.mjs:39, setup.mjs:83, reattach.mjs:50,
takeover.mjs:53, aws.mjs:119) and in none of the positional-bucket ones (cleanup.mjs:77,
verify.mjs:53, hashes.mjs:24 — `requireArg` only), so `cleanup s3://b` reaches `parseS3Uri`
(s3.mjs:584) and gets the SDK's error instead of ADR-0030's.
**"Absolute by shape" ×4, "segments past the root" ×3.** `!foldsCase(x) && !x.startsWith("/")` at
extract.mjs:47, restore.mjs:209 (`reroot`), snapshot-file.mjs:1119 (`pathFault`), path-match.mjs:102
(`isMatchableDir`, as `posix.sep`); the root cut at `namesOf` (restore.mjs:166, drops empties),
`pathFault` (:1137–1138, keeps empties to refuse them), `isMatchableDir` (:105–106, strips trailing
then splits). The drive-letter upper-casing is spelled in `reroot` (:215–219) and `itemName`
(:231–239).
**`restoreTargets`' pass-through and its agreeing pair.** It takes `selected: { targets, invalid,
unmatched }` (restore.mjs:389) and acts only on `targets`, copying the other two into the result
(:662–664); it takes `outDir` (:381, :391) beside a `destFor` that already encodes it (`linkedFolder`
:808 needs the prefix), and both callers build the pair from one value (restore.mjs:88/:115,
extract.mjs:52/:60–63/:84). `extractTo(item, to)` (:252) and `selectTargets(…, [item])`
(extract.mjs:83–84) derive the item's depth and the filter from the same string independently
(:244–246 is caller discipline).
**"Transport failure first, then drift" restated at three coordinators** — upload.mjs:599–613
(`uploadSet`), :784–792 (`uploadSnapshot`), :876–879 (`uploadDir`). Deliberate per ADR-0069's
amendment; the lock move made the triplication adjacent.
**`pathMatcher` vs `unmatchedFolders` on a blank folder.** `pathMatcher` drops a blank
(path-match.mjs:147); `unmatchedFolders` doesn't (:189–191), and `pathKey("")` = `pathKey("/")` =
`""`. Unreachable: both commands trim blanks (restore.mjs:62, extract.mjs:39) and `parseLines` drops
them. `selectEntries`' doc (restore.mjs:139–140) describes one of the two functions `selectTargets`
feeds.
**`snapshotFiles` is a token the command carries** (commands/cleanup.mjs:103 → :218) — with
**cleanup's top-up**.
**Carried and holding.** **takeover reads the holder twice** (takeover.mjs:61–70 `holding`;
attach.mjs:37 again, `held` ignored at :73; the early exit :64–69 precedes attach.mjs:31–35's bucket
check; takeover.test.mjs:157/:171 pass `{}`). **AWS template file names** (lib/aws.mjs:96–114 via
`bare()`; commands/aws.mjs:125, :137, :155 without; the literal pattern at commands/aws.mjs:104 and
commands.mjs:244). **Progress width read twice per frame** (snapshot.mjs:465, progress.mjs:142;
`clockedLine` :268–277) — the "`_refreshSize` fake would drop" claim is dead,
snapshot.progress.test.mjs:77 stubs `terminalWidth` by module mock. **exclude's platform constants**
(exclude.mjs:50–52, `spell` :69–72; argued at path-match.mjs:27–29, exclude.mjs:22–29,
find.mjs:114–121). **`formatByteValue`'s widest output** (format.test.mjs:41 pins `1234.6PB`;
s3.mjs:629–631 `SIZE_COL = 8` "7 chars"; snapshot.mjs:660–662 `BYTES_COLUMNS = 7`). **Provider's
switch** (commands/provider.mjs:52–61 `replacedName`, :270–275; `settingKeys` lib/provider.mjs:35–41).
**A set with no bucket** (sets.mjs:334–355 throws :348–355; `resolveSet` :395–410 lists via it).
**`hashedFiles` counts empty files** (file-props.mjs:180–199; snapshot.mjs:347–356). **The empty
file's hash spelled three times** (delete.mjs:16–17, file-props.mjs:35, delete.test.mjs:110).
**Debug decompression** (snapshot.mjs:4, :371–377).
**Dead.** **`preparePath`'s unread fields** — `.base` now has two production readers (find.mjs:157,
`folderOf` snapshot-file.mjs:1042) and every field is read somewhere; path-match.mjs:59–62 states
the per-row design and snapshot-file.mjs:1031–1034 records the DIR passes as measured.
**Stale prose.** [lib/cleanup.mjs](../src/lib/cleanup.mjs):1–2, :8–11, :48–49 (with **cleanup's
top-up**); [commands/cleanup.mjs](../src/commands/cleanup.mjs):30–32 "single pass — no second
enumeration" (the top-up is a second `snapshots/` LIST plus reads), :18–19 and :108 "read-only twin
of `verify`"; [s3.mjs](../src/lib/s3.mjs):915–919 `objectExists` names "upload.mjs's baseline-trust
check" as a caller, which ADR-0084's `matchRemoteSnapshot` replaced (nothing outside s3.mjs imports
it); [snapshot-file.mjs](../src/lib/snapshot-file.mjs):866 "`@SET DIR` into `dirs` (what
`restore --output` re-roots by)" — `reroot` reads no `dirs` since #464;
[path-match.mjs](../src/lib/path-match.mjs):3–11 omits the reader, the walk's `backupMatcher` and
`extract`, :59–62 "called once per row" is ≥3 on read (measured at snapshot-file.mjs:1026–1034);
[commands/restore.mjs](../src/commands/restore.mjs):89–95 "a hand-edited one would write files
relative to the cwd" — the reader refuses a relative row now; [commands/upload.mjs](../src/commands/upload.mjs):35–36
points the baseline-trust check at proposals/bugs.md, whose open list is empty (the decision is
ADR-0084); docs/design/backup.md:315 "those three are the whole degrade" (eight kinds); walk.mjs:44–55
and walk.test.mjs:693–694 (`crlfDelay`, with **one classifier**); [objects.mjs](../src/lib/objects.mjs):14–22
header missing HEAD and DELETE, :201 "50 at a time" vs `REQUESTS_IN_FLIGHT` :130;
[compare.mjs](../src/lib/compare.mjs):393–398 "no header, so no instant" (a true conclusion with a
stale reason: commands/snapshot.mjs:48–55 just doesn't pass it).

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
yields real files under real roots, `@SET DIR` rows are `resolveWalkRoot`; ADR-0028); `utf8Lines`'
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
`node:fs.lstatSync` — noted, not a candidate. guide/restore.md and docs/design/backup.md §restore
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
> 2026-10-04 fifteenth and its landings, PRs #366–#380, the last on 2026-10-07) recorded landings
> that are already of record in their ADRs, PRs and `git log`, and re-verification notes superseded
> by every pass since. They live in this file's history:
> `git log -p --follow -- proposals/architecture-improvements.md`. Keep this section bounded —
> a pass that lands a candidate should retire the *open* entry, not append indefinitely here.

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
    cause (commands/upload.test.mjs:296); no test under `src/` or `test/` calls `uploadFile` or
    runs `upload --file`.
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
