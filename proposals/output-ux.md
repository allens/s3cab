# Output & compare UX

Epic: make s3cab's output consumer-friendly. The headline item — human-readable output by
default, `--json` for machines, and the compare-diff/formatting work that feeds it — graduated
to its own build spec, now **implemented** and deleted; the decision lives in
[ADR-0043](../docs/adr/0043-human-first-output.md). This file keeps the surrounding output/UX
niceties.

- **`compare` calls a previously-unreadable file "added"** (user, 2026-07-29). X.doc is locked
  when snapshot 1 is taken, so it lands as an `#ERROR` row and is absent from `entries`; it
  hashes fine in snapshot 2; `compare 1 2` therefore reports it as **added**, when it sat there
  the whole time. The handling is one-directional today:
  [compare.mjs](../src/lib/compare.mjs) pulls the *newer* snapshot's errored paths back out of
  `deleted` (so a file that becomes locked never reads as deleted) but never looks at the
  *older* snapshot's errors, so the reverse case is unguarded. A third hole sits beside it: a
  file unreadable in 1 and genuinely deleted by 2 shows up in no category at all.
  _Not obviously a bug:_ in snapshot terms it *is* new — a file that can't be hashed is in no
  manifest and was never stored, so "added" tracks new-to-the-backup rather than new-on-disk.
  A precise fix needs `since`'s errors threaded through the fast path `snapshot` uses to avoid
  re-parsing the baseline (it hands over `entries` only), plus a category decision: it can't be
  `modified`, because with no hash on the older side we genuinely don't know whether the bytes
  changed — so either drop it from `added` silently or add a "was unreadable, now readable"
  line. **Settle this before** [ADR-0069](../docs/adr/0069-fused-snapshot-upload-pipeline.md)'s
  open `#ERROR`-on-drift follow-up, which would make the scenario routine rather than rare (an
  autosaving document would flip between errored and recorded on most runs).
- ~~**"Did you mean…?" for misspelled commands**~~ — **rejected 2026-08-07**, built and closed
  unmerged ([#233](https://github.com/allens/s3cab/pull/233)). It is redundant by construction
  here: `git` doesn't print its 150+ subcommands on a miss, so edit distance is the only signal
  a user gets — s3cab has 18 and already prints all of them, grouped, directly below the error,
  so the hint lands on top of a full enumeration of the answers. ~62 lines of DP (including four
  `?? 0` branches unreachable by construction) to save a glance at a list already on screen —
  working rule #3. **Reopen only if the registry grows past what's worth printing**, which is the
  condition that made it pay for git. The entry's other half — `help <unknown-topic>` falling
  silently through to the command list on stdout under exit 0 — was the real defect and is fixed.
- **Retire `helpTopics` — it is down to one member** (user, 2026-08-07, noticing the topics path
  still existed at all: *"I thought that was all rolled into command help."*). The consolidation
  did happen — [ADR-0041](../docs/adr/0041-auth-command-hosts-credential-guide.md) folded the
  `auth` topic into that command's registry `details` and
  [ADR-0047](../docs/adr/0047-provider-command-neutral-config-door.md) did the same for
  `provider`, with `help.test.mjs`'s "no topic shares a command's name" case guarding the return
  trip. What it left behind is `exclude`, alone, holding up a whole dispatch path: the
  `helpTopics` map in [src/help.mjs](../src/help.mjs), the topics-first lookup in
  [src/s3cab.mjs](../src/s3cab.mjs), the disjointness test, and a footer line reading
  `topics: exclude`. Retiring it deletes all four.
  _Blocked on a host, not on appetite:_ exclude patterns govern `snapshot`, `backup` and `status`
  alike, so no existing command naturally owns the guide — which is presumably why this one
  survived. `setup` only writes the starter `exclude.txt`, so it's a poor fit. The clean opening
  is **an `exclude` command**, if pattern management is ever built; the guide would move to its
  `details` and the topic mechanism would go with it. Until then the one-member map is the honest
  cost of CLAUDE.md's rule that exclude-pattern rules earn a mid-task, browser-free guide —
  keeping it isn't an oversight, but it should stop being invisible.
- **An "under the hood" subsection for every command in the guide** (user request,
  2026-07-20): detailed but definitely not code — what the command reads, what it writes,
  and what decides, as a numbered walk (the `delete` section in
  [guide/maintenance.md](../guide/maintenance.md) is the template). Best done as its own
  docs-only session sweeping the whole guide.
- **`--quiet`** to suppress stderr progress (for cron/scripts), and richer progress: bytes
  hashed + ETA, not just file-count percent.
- **The fused pass's progress line retains its last state, unlabelled**
  ([ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md)). `withProgress` closes
  the line the ordinary way, so a finished run leaves ` 256,776/256,776  Uploaded 13.2GB in 14m
  02s` sitting directly above the command's real summary — saying roughly the same thing, but
  without the header that named it (that has scrolled away by then). The machinery to fix it is
  already there and already used for this exact reason by the upload byte bar: `progress.clear()`
  instead of letting disposal retain. **Not obviously right, which is why it wasn't just done:**
  on a run that *fails* part-way the retained line is the only record of how far it got, and the
  error text doesn't carry a file count. So the choice is either clear unconditionally and accept
  that, or clear only on success — which means `withProgress` learning whether the pipeline
  finished, a fact it currently has no reason to know.
- **The progress lines' *timing* is untested** — deliberately, for now. Two behaviours rest on
  real elapsed time: `lib/progress.mjs`'s 100ms redraw pacing, and the 1-second `setInterval`
  that drives the `Scanning existing objects` line in [upload.mjs](../src/lib/upload.mjs) (a LIST
  page yields 1,000 keys at once, so gating on the redraw interval made the count appear only
  ever as a multiple of 1,000 *plus one*, then freeze until the next round trip). Both were
  verified by simulation rather than by a committed test: asserting them needs a test that
  actually sleeps across two pages, which is slow and timing-flaky for what is a display
  property. One such test exists already (`progress.test.mjs`'s "draws again once the redraw
  interval has passed", a 150ms sleep) and is the pattern we don't want to multiply. If the
  module ever gains a fake clock — `node:test`'s timer mocking, or taking `now` as a seam — that
  is the moment to come back and lock all of this down properly.
- **Display formatting** — the byte/time humanizers the size and progress output above lean on
  (the bytes-hashed progress, the `4.2 GB` first-snapshot line, `list --stat` total size). Built
  from the JS standard library (`Intl`), no `pretty-bytes`-style dependency.
  - **Bytes** (✅ done) — `formatByteValue` in [format.mjs](../src/lib/format.mjs) was *buggy*:
    `notation: "compact"` collided the English short-scale "B"(illion) suffix with the byte unit
    (`1500000000 → "1.5BB"`) and emitted `"KB"` instead of SI `"kB"`. Now it picks the unit by
    magnitude (base 1000) and renders with
    `Intl.NumberFormat("en", { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: 1 })`,
    where `unit` takes a canonical identifier (`byte`, `kilobyte`, …, `petabyte`) that `narrow`
    renders as the symbol (`B`, `kB`, …, `PB`) — *not* the symbol itself (`unit: "kB"` is
    invalid). Decimal SI (matches Finder / pretty-bytes; `Intl` has no binary unit anyway).
    Accepted edge: `999999 → "1,000kB"` (no roll-up to MB) — rare, not worth the extra logic.
    Live caller: the S3 upload-progress line ([s3.mjs](../src/lib/s3.mjs), `formatUploadProgress`),
    plus the `S3CAB_DEBUG` heap readout.
    - **How the byte progress was lost** (don't repeat it): the upload-progress *plumbing* never
      went away — `@aws-sdk/lib-storage`'s `Upload` + its `httpUploadProgress` event (a plain
      `PutObjectCommand` emits no progress), rendered in place via `node:readline`
      `clearLine`/`cursorTo` with an ASCII bar. What broke was just the *formatting*: commit
      `79c93e4` (2025-12-08) dropped the `pretty-bytes` dep, introduced the buggy `compact`
      formatter for the memory-debug line *only*, and downgraded the upload line from
      `prettyBytes(loaded) of prettyBytes(total)` to raw integers (`uploaded 5242880 of …`) —
      never re-pointing it at the replacement. This change reconnects it.
  - **Times** (settled, not yet implemented) — three buckets, two display formatters:
    - *Per-step* (one hash, one upload — operations with human-perceptible latency): a **new**
      `formatSeconds` → `"2.4s"`, seconds with 1 decimal (≈0.1s resolution = the perception
      threshold). For the future hash/upload progress lines.
    - *Overall / aggregate* (tree duration, whole run): **keep** `secondsSince` as-is — the
      composite `"1 hr, 2 mins, 5 secs"` reads better than raw seconds at scale, and
      integer-second precision is enough.
    - *Times of record* (e.g. `prop`'s `hashDuration`, stored as fractional seconds at
      millisecond resolution): already precise enough — data, not display, so unchanged. mtime
      is likewise serialized as ISO / applied via `utimes`, never humanized → out of scope.
- **Richer `list`**: snapshot date *and* file count / total size (cheap to read from the
  snapshot), maybe `list --stat`. Today it's bare names.
- **Flexible snapshot references — rejected 2026-07-30; don't re-propose without new
  evidence.** Accepting unambiguous name prefixes, `latest`/`latest~1`, or free-form dates on
  `--since`/`--until`/`--snapshot`/`forget`. Snapshot names are copy-pasted out of `list`, and
  three of the four commands that take one already default correctly, so a resolver would
  optimize typing nobody does — real complexity capital (a shared resolver, ambiguity rules,
  four call sites) for a benefit the clipboard already provides. `latest~1` fell separately: a
  snapshot is not an atomic unit of work the way a commit is. The idea's stated motivation, a
  silent-typo bug, has since been fixed. The useful residue — naming the snapshots that *do*
  exist when one isn't found — is built, so only the rejection is kept here.
- **The walk's `#SKIPPED` entries never surface in output.** A symlink (or any unsupported type)
  is recorded in the snapshot file and parsed back into `Snapshot.skipped`, but no renderer ever
  shows it, so a backup omits it silently. That sits awkwardly beside `assertWalkableDirs`'s own
  principle — *"a backup must never silently skip a directory the user means to keep"* — and it
  was the deciding argument against skip-and-record in
  [ADR-0073](../docs/adr/0073-refuse-tab-newline-paths.md), so it is currently visible only as a
  supporting clause in an ADR. Surfacing a count in the snapshot/backup summary would retire it.
  **Settled by [ADR-0078](../docs/adr/0078-backup-run-report.md) (2026-08-08), not yet built:** a
  count in the backup summary's `Couldn't be backed up` block, and the full list in `compare`.
  Delete this entry when 0078 lands. The hole is not theoretical — in the set that prompted 0078,
  `D:\OneDrive\Personal Vault` was skipped on one run and absent from the previous snapshot
  entirely, so the skipped set *changed between runs* and nothing said so.
- **Snapshot labels** (`snapshot -m "before reorg"`) — a commit-message-like note, storable as
  a header comment line without breaking the TSV format.
- **Friendlier failure for "no snapshots found"** — suggest running `s3cab snapshot` rather
  than a bare error.
- **Exit-code doctrine**: document the codes (0/1/2/127 today); decide whether `compare`
  should signal "differences found" diff-style (probably not, for a consumer tool — but
  decide).
- **Show more in the progress line's in-flight detail — needs experimentation, not a decision**
  (user, 2026-08-08, while settling [ADR-0078](../docs/adr/0078-backup-run-report.md)). Today a
  row earns its name only by taking a second
  ([ADR-0076](../docs/adr/0076-one-progress-line-driven-by-a-clock.md) §5), so a run of tens of
  thousands of ordinary files names none of them and the detail column mostly sits empty.
  _Why it matters, and why 0078 does not cover it:_ 0078 answers "what did it just do", **after**
  the run. It cannot answer **"crikey, what is it uploading all that for?"** — the question you
  ask at minute two, when the only useful response is Ctrl-C. That is the one thing an
  rsync-style scroll genuinely bought and this design gives up. The suggestion is not to restore
  the scroll but to lower the naming threshold: names flickering past far too fast to *read*
  would still let the eye catch a steady root — a `node_modules` or a cache directory
  repeating — which is exactly the signal that sends you to the exclude file.
  _Unresolved, and only settleable by trying it:_ whether a name changing 10×/sec reads as
  information or as noise; whether the eye really does catch a repeated root at that rate;
  what it costs in the hot path (0076 §5's threshold exists partly so naming tens of thousands
  of fast files doesn't hide the one actually holding things up — the opposite worry to this
  one); and whether a `--verbose`-style opt-in is the honest home for it. Try it on a real set
  before writing anything down.
  _Adjacent:_ a pre-flight "what would this back up" is the other answer to the same question
  and may be the better one — `status` already reports what a backup would upload without
  transferring anything. Check whether it is enough before changing the live line.
