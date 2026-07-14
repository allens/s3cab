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

Surfaced 2026-07-14 (seventh pass) over the Roles Anywhere subsystem (ADR-0055–0058, PRs
#186–#191) — the churn since the 2026-07-10 empty. The subsystem is mostly deep (the
SigV4-X509 signer is the in-repo exemplar of the pure-core/thin-I/O pattern). **A and B
landed in [PR #192](https://github.com/allens/s3cab/pull/192)** (pure `arnsFromOutputs` +
single-sourced `ARN_ENV` contract), **D in [PR #193](https://github.com/allens/s3cab/pull/193)**
(the RA-aware `authNotice`), **and C — as its narrow marker-drift fix — in
[PR #194](https://github.com/allens/s3cab/pull/194)** (both `provider.mjs` marker reads routed
through the canonical `isRolesAnywhereMode`); the fuller `credentialMode()` classifier C
originally floated was **declined** (see Rejected & parked), **and E — the pure
`awsSaveConfirmation` relocation — in [PR #195](https://github.com/allens/s3cab/pull/195)**. Run
log below.

_The seventh-pass open list is now empty: every candidate either landed (A/B/#192, D/#193,
C/#194, E/#195) or was parked (the `credentialMode()` classifier, below). The next
`/improve-codebase-architecture` run starts from the source and the rejected list, not from
stale entries._

**Examined & left alone this pass** (not candidates — skip next run): the SigV4-X509 signer
(the exemplar to cite, not fix); the RA credential arm's unit-test gap (coverage, not a boundary
— ADR-0020; the `new Date(expiration)` shaping could be cheaply covered); the dead
`buildSignedRequest` RSA branch (ADR-0058 discusses key type, parity is cheap — characterize);
`readSigningIdentity`'s catch-all conflating not-usable with crashed (marginal); moving
`saveArnsFromStack` off `roles-anywhere.mjs` (would leak the identity's env-file layout — keep);
`set-marker.mjs` pure parsing behind S3 I/O (tangential, mild); `aws-profiles.mjs` shallow
wrapper (inlining *moves* the sentinel — legit thin adapter); the region-default dup with
`scripts/setup-test-bucket.mjs` (minor).

---

## Rejected & parked — do not re-suggest

Recorded so future runs (and reviewers) skip them. Each was verified against the source at
least once; re-open only if the stated reason no longer holds.

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

- **2026-06-23 — first pass.** Four candidates. #1 (collapse the snapshot-writing pipeline —
  the walk imported `excludedLine` and wrote grammar rows mid-walk) **landed** as
  [ADR-0028](../docs/adr/0028-snapshot-writer-owns-the-grammar.md). #2 (diff test discipline)
  still open above. #3 (narrow the read surface) rejected on verification. #4 (resolved-set
  unification) parked behind ADR-0022.
- **2026-06-24 + 06-29 follow-up — second pass.** Surfaced `planUpload`, `downloadToFile`, the
  name authority, and the structured-diff split (all still open above). The `fileProps`
  extraction **landed** ([PR #127](https://github.com/allens/s3cab/pull/127)): the hashing
  engine moved to `lib/file-props.mjs`, `prop` became a thin command over it, closing the last
  `commands → lib` reach in the write path; glossary term **Props** added to CONTEXT.md. The
  codec split and the list-and-strip unification were re-floated and re-rejected.
- **2026-07-02 — third pass.** Re-verified every open candidate against the source (all still
  hold, line refs updated). New: *thread the previous snapshot through `snapshot → compare`*.
  Remote engine and config layer again found deep. Merged the two prior capture files
  (`architecture.md`, `architecture-deepening.md`) and the overlapping bullets in
  `performance.md`/`engine-robustness.md`/`output-ux.md` into this file; superseded the
  2026-06-23 HTML report.
- **2026-07-03 — fourth pass.** Re-verified all six open candidates (all hold; the `diff`
  test count grew 22→27). Explored the churn since the third pass (PRs #144–#147, the settled
  verify/cleanup design). Five new entries: *one stderr-progress module* (Strong — snapshot's
  counter writes `\r` ungated, a live inconsistency PR #147 missed; takes over as top pick),
  *`rewriteObjects`* (Strong — ADR-0042/cleanup both need an atomic cache rewrite that doesn't
  exist), *size-carrying `listStoredObjects`*, *the `referenced` union's seam placement*, and
  *lift `seedStarterExclude`* — the middle three are slice-5 prep. Recorded as leave-alone:
  the exclude-grammar prose triplication, and the help/registry seam (clean after
  #144/#145). Superseded the 2026-07-02 HTML report.
- **2026-07-03 — *one stderr-progress module* landed** ([PR #148](https://github.com/allens/s3cab/pull/148)).
  `lib/progress.mjs` now owns the TTY-gate + `\r`-redraw + drawn-only-newline mechanic; snapshot,
  restore, the upload bar, and the walk all route through it. Verification caught the candidate
  undercounting the problem: there were **four** ungated `\r` writers, not three — the walk's
  `Found N files...` counter in `walk.mjs` was the fourth, and `snapshot` still spammed carriage
  returns off a TTY until it too was folded in (which also fixed a latent "Found 0 files..."
  display quirk for sets under 500 files). Interface shipped as `createProgress(stream, { logLines })
  → { update(text, { cursor }), [Symbol.dispose] }` (per-caller renderers kept as plain strings).
- **2026-07-08 — fifth pass.** Re-verified all opens against the source after heavy churn (PRs
  #150–#160: `verify`/`delete`/`cleanup` built, human-first output + `render.mjs` (ADR-0043),
  unified `upload` (ADR-0044), the objects cache **dropped** (ADR-0045), tests co-located
  (ADR-0046)). **Four candidates retired as done/moot:** `rewriteObjects` (dead — no cache),
  size-carrying `listStoredObjects` (landed — yields `{hash,size,lastModified}`), the
  `referenced`-union seam (landed as `referencedObjects` in remote.mjs), and the structured
  `CompareResult` split (landed, ADR-0043). `planUpload` re-scoped (cache gone; first-backup diff
  inlined) and `s3.mjs` re-scoped (`deleteObject` now production; kill the dead `emptyBucket`).
  New top pick: *extract a pure `planCleanup`* — the verify/cleanup twin realized in code only on
  verify's side. **Landed as [PR #164](https://github.com/allens/s3cab/pull/164):** pure
  `planCleanup` in `src/lib/cleanup.mjs` (mirroring `verifySet`), 8 mock-free lib tests, the
  cleanup command thinned to I/O + policy; a Copilot-review pass also fixed a pre-existing
  cross-set `damaged` under-count the extraction had preserved. Its open-candidate entry is
  deleted (the pair is noted in docs/design/backup.md). Superseded the prior HTML report (now
  overwritten in place at `architecture-review.html`).
- **2026-07-10 — sixth pass** (with a user-requested extra: score the project against the
  `codebase-design` / `domain-modeling` / `tdd` / `code-review` skills; scorecard in the HTML
  report). Re-verified all seven opens against HEAD `0f19353` — **all hold**; line anchors
  refreshed (several had drifted: `downloadRemoteSnapshots` 119→272, `normalizeName` 21→62,
  compare baseline 99→113, `emptyBucket` 569→559, `seedStarterExclude` 179→189 + its
  `(name)`→`(set)` signature). One finding **strengthened**: `diff`'s `export` has zero
  importers anywhere — not even its tests — so it's speculative surface, not a test seam.
  Examined the PR #166 churn (`auth`→`provider` rebuild, ADR-0047, the largest command file at
  352 lines): genuinely deep — pure helpers behind one export, discriminated-union `Scope`
  typedef, 456 lines of tests — **no new candidates**; its CLI-surface follow-ups
  (`--profile` flag collision) already live in `provider-ux.md`. Scorecard net: strong on all
  four skills; the one systematic weakness is plan/execute interleaving pushing pure decision
  logic behind I/O-only test access (exactly the `planUpload` / `diff` / `seedStarterExclude`
  candidates). Minor ubiquitous-language slips noted: user-facing "adopts" in `setup.mjs:256`
  (canonical: **inherit**), comment-level "garbage collector"/"orphan GC"/"blob"
  (`cleanup.mjs:13`, `objects.mjs:116`, `verify.mjs:149`). Top pick: **pure `planUpload`**
  (runner-up: test `diff` directly). Superseded the prior HTML report in place.
- **2026-07-10 — the 1+5+7 bundle landed** ([PR #167](https://github.com/allens/s3cab/pull/167),
  grilled in-session then built step-by-step). **Four candidates retired as done:** *pure
  `planUpload`* (landed as the **`lib/upload.mjs` verb module** — planner + `uploadSnapshot`
  moved in beside it, the subsystem-cohesion rule honestly applied since restore/verify/cleanup
  already had verb modules and upload was the outlier embedded in the store module; `remote.mjs`
  −169 lines to the snapshot-store read/manage side, still sole owner of the `snapshots/`
  prefix; `uploadCandidates`/`candidatesNotIn` subsumed, `status` reuses the planner; the
  first-backup LIST diff gained ungated unit tests), *test `diff` at its own interface* (13
  classification tests on in-memory Maps, 12 shell tests kept; the export is now a deliberate
  internal test seam), *lift `seedStarterExclude`* (name-keyed `sets.mjs` primitive returning
  wrote/skipped; a Copilot review comment then upgraded it to **atomic write-if-absent** — the
  `wx` flag replaces the check-then-write, making the never-clobber guarantee kernel-enforced
  and *smaller*), and *trim `s3.mjs`* (`emptyBucket` deleted; the versioned-bucket manual-test
  script it was meant to be is parked in [misc.md](misc.md) — a per-key delete only adds delete
  markers on a versioned bucket, so a faithful move was impossible). Ride-alongs: the
  CONTEXT.md vocabulary sweep (adopts→inherits incl. one user-facing string, GC→orphan
  sweep/deleter, blob→object) and the user-stated memory/async stance recorded in CLAUDE.md
  ("modern user PC, not a headless VM; async engine interfaces welcome — progress can hook in").
  Three opens remain: `downloadToFile` (spell the option `hasher`, not "tap" — and rename the
  `tap` local in objects.mjs when it lands), the snapshot-name authority, and threading the
  previous snapshot through `snapshot → compare`.
- **2026-07-10 — the remaining-three bundle landed**
  ([PR #168](https://github.com/allens/s3cab/pull/168), grilled in-session, decisions recorded
  in the entries first, then built small-to-large). **All three opens retired as done,
  emptying the open list for the first time.** *Thread the previous snapshot* (the first
  shape: `compareSnapshots`' `since` accepts `{ name, entries }`, `snapshot` hands its parse
  through, `--rehash` still reads; a test hands in synthetic entries under a since name that
  doesn't exist on disk, proving no re-read). *`downloadToFile`* — grilling reshaped the
  recorded sketch twice, both times smaller: the injected `hasher` became the plain
  `{ sha256 }` expected digest (the injection was over-engineering — the entry's post-mortem
  is in git history), and the first parameter became the **source stream** rather than a URI
  after implementation surfaced that a URI form would sink the integrity logic below the
  "mock at s3.mjs" test line — it now tests mock-free against `Readable.from` in s3.test.mjs
  (plus new verbatim-copy and mid-stream-failure cases), with objects.test.mjs keeping the
  key-as-digest pairing; the `tap` local is gone. *The snapshot-name authority* (one step
  past the sketch: `snapshotName()` mints the name from one clock read and `writeSnapshot`
  **derives the header datetime from the name**, dropping its `datetime` parameter —
  consistent by construction, not by shared capture; `normalizeSnapshotName` moved home to
  snapshot-file.mjs, ending the extension-grammar leak into compare.mjs).
- **2026-07-14 — seventh pass** (after the open list sat empty since 2026-07-10). First review
  of the **Roles Anywhere subsystem** (ADR-0055–0058, PRs #186–#191) — `roles-anywhere.mjs` (879
  lines, now the largest lib file), `onboarding.mjs`, the fourth credential mode in `auth.mjs`,
  the `aws` command. Three parallel Explore agents (RA subsystem / onboarding+aws / s3.mjs+cred
  flow) plus an independent read of the core; all findings re-verified against HEAD `2b48495`.
  Verdict: the subsystem is **mostly deep** — the SigV4-X509 signer (`createSession` flanked by
  pure `buildSignedRequest`/`parseSessionResponse`) is the in-repo exemplar of the pattern the
  project keeps missing. Five open candidates recorded above (A–E); top pick **A — extract pure
  `arnsFromOutputs`** (convergent across two explorers, textbook pure-logic-behind-I/O, smallest
  blast radius, no ADR tension). Parked items (SetContext, remote/config restructure) confirmed
  untouched. Overwrote the prior HTML report in place at `architecture-review.html`.
- **2026-07-14 — the A+B bundle landed** ([PR #192](https://github.com/allens/s3cab/pull/192),
  grilled in-session then built). **Two candidates retired as done.** *Pure `arnsFromOutputs`*
  (A) lifted the stack-output → identity-env mapping out of `saveArnsFromStack`'s CloudFormation
  I/O into a pure exported `arnsFromOutputs(outputs) → { arns, missing }` — the mapping and the
  missing-output check now unit-test against a plain array (4 mock-free cases) instead of a
  mocked SDK; the wrapper thinned to fetch → delegate → throw-or-write, keeping the ADR-0030
  error (which needs the stack/region context) on its side; typed with the real
  `import("@aws-sdk/client-cloudformation").Output[]` (already a dependency, house idiom for SDK
  types) rather than a hand-rolled structural type — the grilling flipped this once the dep
  status was checked. *The ARN contract* (B) — `ARN_ENV` exported as the one home of the three
  (output-name → env-key) pairs: `readSigningIdentity` reads the ARNs back through it (was bare
  `S3CAB_RA_*` literals), and a **contract test** in `onboarding.test.mjs` asserts the RA
  template emits every Output name the reader expects — chosen over a shared symbol (grilling
  decision) so the template stays readable literal YAML and no `onboarding → roles-anywhere`
  edge appears (ADR-0006: a test guard, not machinery; the asymmetric `RoleArn ← Role.Arn`
  GetAtt meant a shared symbol would only own half the pairing anyway). Three opens remained (C,
  D, E) — all on the credential-mode surface; **D is C's concrete symptom**, so the order taken
  was D (Strong, cheap) then C (the deeper classifier, ADR-0055 tension to grill), with E as a
  ride-along whenever the recipe prose is next touched.
- **2026-07-14 — D landed** ([PR #193](https://github.com/allens/s3cab/pull/193)). *Teach
  `authNotice` the RA mode*: an RA-mode set carries no `AWS_PROFILE` and (RA is AWS-only) no
  endpoint, so `authNotice` fell through to the anonymous `"Contacting the cloud…"` for every
  Roles Anywhere command — degrading its "which identity?" promise for the one mode where the
  identity is known. Added an RA-first branch (`"Using Roles Anywhere (keyless)"`) fed by
  `isRolesAnywhereMode()` from `client()`; `authNotice` stays pure (receives the boolean, never
  reads env), RA takes precedence over any hand-left profile/endpoint (mirrors `resolveCredentials`'
  RA-before-chain check), plus the missing `s3.test.mjs` RA case. C and E remain open; C is next
  (grilled before building — the ADR-0055 read-only-classifier decision), E a ride-along.
- **2026-07-14 — C landed as a narrow fix; the classifier declined** ([PR #194](https://github.com/allens/s3cab/pull/194),
  grilled first). Grilling + source verification **undercut C's premise**: the ~5 "sites" ask
  distinct per-layer questions, not one (details in the Rejected & parked entry above), so the full
  `credentialMode()` classifier was declined and parked. What shipped is the genuine, verified
  defect: `commands/provider.mjs` read the `S3CAB_RA` marker two ways — `describeScope:95` used
  `=== "1"`, clear-on-replace `:319` a loose truthy — so `S3CAB_RA=0` read not-RA everywhere except
  the clear path. Both now route through the canonical `isRolesAnywhereMode`, with a regression test
  for the degenerate `=0` case. A worked case of grilling shrinking a candidate to its honest core.
- **2026-07-14 — E landed (narrowed)** ([PR #195](https://github.com/allens/s3cab/pull/195)).
  On close read E's advertised "duplication" was loose (different numbering/indentation, real-vs-
  placeholder bucket), but a *second* rationale — aws.mjs's header asserts "recipe text lives in
  onboarding.mjs (pure, unit-testable)" while `saveRolesAnywhere` hand-wrote its `--save`
  confirmation inline (I/O-path-only, untested) — was the real win. Relocated the confirmation to a
  pure `awsSaveConfirmation({ stackName, region, dir })` (byte-identical string, first unit
  coverage); the marginal step-3 dedup was skipped (ADR-0006/#5). **This emptied the seventh-pass
  open list** — every candidate landed or was parked.
