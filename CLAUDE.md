# CLAUDE.md

Working rules and orientation for **s3cab**, for contributors and AI assistants. This file
documents how to *work* in the codebase. The knowledge it used to lump together now lives in
purpose-built homes — see the map below.

## Where knowledge lives

| What | Where | Notes |
| --- | --- | --- |
| **Domain vocabulary** (the ubiquitous language) | [CONTEXT.md](CONTEXT.md) | Glossary only — canonical term + definition + `_Avoid_` synonyms. |
| **Architecture / design decisions** (the *why*, "don't re-litigate") | [docs/adr/](docs/adr/) | One numbered ADR per decision; [docs/adr/README.md](docs/adr/README.md) indexes them. |
| **Subsystem designs** | [docs/design/](docs/design/) | `auth.md`, `backup.md`, `testing.md`, `s3-provider-compatibility.md`. |
| **Other contributor how-tos** | [docs/](docs/) | Beside `docs/adr/` — e.g. [docs/integration-testing.md](docs/integration-testing.md) (setting up the gated S3 suite), [docs/releasing.md](docs/releasing.md) (checking + cutting a release). Doesn't ship. |
| **User-facing docs** | [README.md](README.md), [guide/](guide/) | What it is, install/usage, user reference (`guide/exclude.md`, `guide/compare.md`) — and **the format spec**, [guide/format.md](guide/format.md): the stored-format recovery contract, the no-lock-in pillar ([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)) as a document. `guide/` ships in the npm tarball, so the spec travels inside every install. |
| **Ideas we might do** (rough → detailed; deleted when done/abandoned) | [proposals/](proposals/) | A bucket of provisional ideas — important stuff down to pipe dreams, *not* of record. Grouped into theme-based "epic" files (`output-ux.md`, `performance.md`, …), with [misc.md](proposals/misc.md) for the unsorted and [bugs.md](proposals/bugs.md) the interim defect tracker (→ GitHub Issues, gone by release). See [proposals/README.md](proposals/README.md). |
| **How to work here** (AI/contributor rules) | this file | Working conventions, coding conventions, architecture orientation, known gaps. |

The top-level split is by **audience**: contributor/internal docs live under [docs/](docs/)
(`adr/` = pinned *decisions*, `design/` = evolving subsystem *designs* — different in *kind*,
hence sibling directories — loose `docs/*.md` = *how-tos*); user-facing prose is README +
`guide/`. **The word "spec" is reserved** for the *format spec*,
[guide/format.md](guide/format.md) — the recovery-grade stored-format contract, kept
*user*-side because the format is a user-facing promise
([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)); design docs are *designs*, not
specs. ([CONTEXT.md](CONTEXT.md) stays at root; [proposals/](proposals/) sits outside `docs/`
on purpose — provisional, *not* of record.)

The seven foundational design principles, once numbered `#1`–`#7` here, are now
[ADR-0001](docs/adr/0001-file-level-content-addressable-dedup.md)–[ADR-0007](docs/adr/0007-plain-js-via-jsdoc.md)
(old `#N` maps straight across; full map in [docs/adr/README.md](docs/adr/README.md)).

> **The skills convention this layout follows** (the `domain-modeling` skill): glossary →
> `CONTEXT.md`, decisions → `docs/adr/`; the `improve-codebase-architecture`, `codebase-design`,
> and `grill-with-docs` skills read these — keep them current. They come from
> [mattpocock/skills](https://github.com/mattpocock/skills) and are **not vendored** — install
> into your **global** `~/.claude/skills/`, not the project tree. (That targets _general-purpose_
> skills; a **project-specific** one **is** vendored — e.g.
> [`.claude/skills/cli-design/`](.claude/skills/cli-design/), so it travels with the repo.)

### Documentation discipline (applies to every doc here)

Two standing rules, both grounded in **transparency as a core project value**
([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md), no lock-in): docs that lie about
behaviour undermine the whole premise.

1. **Never let docs _mislead_ about what works — but they may describe agreed-but-unbuilt
   direction when clearly marked target-vs-built.** The requirement is honesty, not
   present-tense-only: verify a claim against the code, and always **distinguish built-today
   from planned** (the README's S3/backup prose is the target; `src/` is what works now).
   Design docs *may* lead the code — a settled-but-unimplemented redesign can land in an ADR
   (`Status: proposed`), CONTEXT.md, or a design-doc banner, if a reader can't mistake it for
   live behaviour. Flag drift you notice; "Known gaps & cleanup items" is the running list.
2. **Each doc carries only what its home is for, and only what is _not_ trivially knowable from
   the code** — don't restate `package.json` scripts or build/test/lint commands. Split:
   vocabulary → CONTEXT.md; the non-obvious *why* → an ADR; fuller design → docs/design/; the
   user *contract* → README/guide/; how to work here → this file. Developer setup → the README.

**Within the user-facing half, placement follows a doctrine:** README/`guide/` carry everything
needed *before trying s3cab* plus advanced depth (e.g. the format spec); the built-in CLI help
topics (`helpTopics` in `src/help.mjs`) carry only what's needed *mid-task in a terminal*. The
test: *"would someone need this mid-task, without reaching for a browser?"* — exclude-pattern
rules pass (editing `exclude.txt` in a shell), the repository format fails (a sit-down read →
[guide/format.md](guide/format.md), never a help topic). Each help topic links to its fuller
online guide; the small overlap this leaves (e.g. the glob token table in both
`helpTopics.exclude` and `guide/exclude.md`) is accepted over sync machinery
([ADR-0006](docs/adr/0006-minimal-code.md)).

### Working conventions (for AI assistants)

Standing operating rules, kept **here in source** rather than any one machine's local
memory so every session — on any computer — follows them. **When the user has to correct
you on a decision, record that decision here** (that is how this list grows) — local memory
is invisible to other machines, so a correction kept only there gets re-litigated elsewhere.
These are **defaults, not shackles:** if you think the context behind a rule has changed,
it is fine — encouraged, even, once in a while — to ask the user whether it still holds
rather than assuming it is fixed forever.

1. **Act only on an explicit go-ahead — your agreeing isn't authorization.** The default is to
   do the work, show what changed, then *wait*. A go-ahead is per-request, never standing —
   don't carry it forward; "you're right that X is better" ≠ "do X now." One principle, four
   faces:
   - **Commits/pushes** — never `git commit`/`push` without an explicit "commit"/"pr" in that
     same message.
   - **"Work through one by one"** — a strict per-step protocol: (a) propose the step and ask
     any questions; (b) once agreed, make the changes and present the diff *uncommitted*; (c)
     move on only when the user agrees, committing that step as you go (don't accumulate to the
     end — that keeps per-step commits splittable). A batch go-ahead ("execute", "go ahead")
     authorizes _starting_, not skipping the per-slice pause; run straight through only when
     told ("don't pause").
   - **"Review the PR comments"** — review them _with_ the user: assess each (valid / not /
     nuance) with a suggested action, then stop and let them decide. Holds for _every_ wave; a
     "fix and resolve" go-ahead is per-batch and never carries forward.
   - **A question** ("why is it done this way?", "wouldn't X be simpler?") wants an *answer* —
     explain, say whether their instinct is right, then **stop and offer**. Don't edit off the
     back of a question.
2. **After non-trivial work, update the docs** so what you learned is shared at the project
   level. Put it in the right home (see the map above): a design decision → an ADR; vocabulary
   → CONTEXT.md; a working/coding rule → this file; never only in local memory. **But recording
   a rule is only half the job — once it has _settled_, distill it to {rule + why + at most one
   example} and let `git blame` hold the story.** Appending every correction without compressing
   is what bloats this file; the record is for the *current* rule, not its changelog.
3. **Refactors and minor chores may ride along with a feature** — a one-feature commit/PR
   carrying a small refactor, a settings.json tweak, a `proposals/` addition (any provisional
   idea the work surfaces), or a doc fix needn't be split into its own PR. Don't over-engineer
   separation. (Still prefer a _separate commit_ per logical change within the PR.)
4. **Use the Bash tool with Unix syntax, not PowerShell.** The `deny` rules and the
   `block-destructive-rm.sh` hook are Bash-string matchers, so a PowerShell equivalent
   (`Remove-Item -Recurse`) would slip a destructive command *past* the safety net; and the
   system prompt's "PowerShell (primary)" signal is misleading for tool selection. Reserve
   PowerShell for the rare command that genuinely needs it (e.g. `$env:VAR`).
5. **Do not over-engineer.** A standing edict from the user, the process-level twin of
   [ADR-0006](docs/adr/0006-minimal-code.md): build the small thing the current need justifies,
   generalize only when the second case appears. (Worked example: `isENOENT` in
   `src/lib/error.mjs`, added once the check had four call sites, as the specific predicate
   rather than a generic `isErrnoCode`.) **Over-engineering is the _solution_ being more complex
   than the problem warrants — not the churn a change takes:** swapping one design for a simpler,
   very different one can be a lot of work yet the opposite of over-engineering. The heuristic is
   to **minimize lines of code** as a proxy for complexity — clear, not obfuscated. So this
   forbids _speculative_ structure, not _justified_ refactoring; and **"simpler" means _clearer_,
   not only smaller** — better names and consistent interfaces are worth the churn even with no
   new capability. **Version gates how bold to be:** pre-1.0 (`package.json` major `0`) you have
   **free rein** for large, correct refactors — get the design *right* over minimizing churn;
   once 1.0 ships, breaking changes need care + a migration story. Check the major version: `0` →
   bold, `≥ 1` → conservative.
6. **Test coverage is judged by review, not a percentage gate**
   ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)). Good, *asserting* tests for new or
   changed behaviour are a per-PR obligation, checked by **reading the diff** (the `/review`
   skill's Standards axis + Copilot review) — not a CI threshold. Add a test that asserts about
   the *result*, not one that merely executes the line.
7. **Every session that will _write_ works in its own git worktree — default-on, no size
   threshold.** Sessions share *one* main working tree, so one session's uncommitted edits
   confuse the others; a per-session worktree removes that hazard. **Branch a worktree before
   the first edit of any change you intend to commit, however small.** Only **pure read-only /
   Q&A work** stays in the main tree — plus two things that go **straight to `main`, no worktree
   and no PR**: **doc-only changes** (Markdown/prose: `docs/`, `guide/`, README, CONTEXT.md,
   ADRs, this file, `proposals/`) and **`.claude` config** (`settings.json`/`settings.local.json`;
   validate via `update-config` first) — nothing under `src/`. Feature work instead lands on the
   worktree branch → one PR, with `main` left at `origin/main`. In any main-tree edit, stage only
   the files _you_ changed (`git add <path>`, never `-A`/`.`) so you don't sweep up another
   session's in-flight work, and still commit only on an explicit go-ahead (#1).
   - **No shared `node_modules`** — a junction was rejected (shared mutable resource, and
     `rm -rf <worktree>` could recurse through it into **main**'s copy). Code work runs
     `npm install` first (seconds from warm cache; doc/config changes skip it).
   - **Mechanics.** Worktrees live at **`.claude/worktrees/<name>`**
     (`EnterWorktree`/`ExitWorktree` in-session, `isolation: "worktree"` for agents). **Accept
     the harness's branch name** (`worktree-feat+x`) — renaming orphans it from
     `ExitWorktree(remove)`'s auto-cleanup; the PR *title* is clean regardless. **Teardown is
     `ExitWorktree(remove)`**, which deletes the directory *and* its branch. **Review the work on
     the GitHub PR; don't open the worktree in the IDE** — an open file there gives Windows a lock
     that can block removal.
   - **Run bare commands — don't prepend `cd`, don't use `git -C`.** The session cwd already
     *is* the worktree; both forms defeat the path-free allowlist, and `git -C` also slips past
     the **deny** guards. To act on **another worktree**, `EnterWorktree` (it sets cwd) then run
     bare `git …` — never reach in with `git -C .claude/worktrees/<name> …` (the recurring trap),
     which a `deny` rule in [.claude/settings.json](.claude/settings.json) now hard-blocks (a
     hook was rejected per #5 — the leading `git -C` form is the actual trap).
8. **Request a Copilot code review at PR create** — pass `--reviewer "@copilot"` to
   `gh pr create`. **Fire it once and move on:** don't verify or re-request it.
   `gh pr view --json reviewRequests` reads **empty even on success**, so that empty array is
   *not* failure — treating it as one only leads to a forbidden re-request after pushes.
9. **The permission-prompt fix is settled — do NOT re-litigate.** The pattern: a **bare
   `"Bash"` entry in `permissions.allow`** plus **`"defaultMode": "acceptEdits"`**, both nested
   **under `permissions`**, in the committed [.claude/settings.json](.claude/settings.json) so
   **every machine inherits it**. This is **not** `bypassPermissions` — the `deny` list and
   PreToolUse hooks still guard everything (deny runs before allow): the `git -C` deny rule (#7)
   and the `block-destructive-rm.sh` hook stay in force. **Never "solve" recurring prompts with
   specific allow entries or `fewer-permissions`** — the failed layer that only appends dead
   one-shot rules. If prompts persist, `defaultMode` applies on *next session start* (restart
   once), or the command hit a real `deny` block (surface it, don't widen the allow-list).
10. **Reply to every review comment you act on — whether you fixed it or deliberately won't.**
    When you address a PR review comment (human or Copilot), post a reply on that thread: cite
    the commit if you fixed it, or give the reasoning if you're declining. Never silently push a
    fix or resolve a thread — the reviewer and the next reader need the trail of *why*. This
    closes the loop #8 opens (requesting the review) and the "review the PR comments" bullet
    under #1 (deciding on each); a decision that never lands back on the thread is invisible.

### Coding conventions

How to write code that looks like the rest of the codebase. (These are *style* rules; the
*decisions* about tooling — LF endings, Prettier-code-only, dependency policy — are ADRs
[0021](docs/adr/0021-lf-line-endings-prettier-code-only.md),
[0005](docs/adr/0005-builtins-over-dependencies.md),
[0018](docs/adr/0018-dependabot-not-renovate.md).)

- **Each file in `src/commands/` exports exactly one symbol — its command function.** The
  mechanical form of [ADR-0023](docs/adr/0023-porcelain-plumbing-lib-layers.md)'s
  porcelain/plumbing/`lib` layering: if anything else — a sibling command *or* a test — needs
  something from a command file that isn't the command, that thing is a `lib/` primitive not yet
  moved, so extract it. Porcelain still *composes* a plumbing command through that one export
  (`backup` calls `snapshot()`/`upload()`); what's banned is reaching past the command for a
  co-resident helper. A symbol used only in its own file just stops being `export`ed (no move to
  `lib/` without a second caller — #5); cross-module types travel by `@typedef`/`@import`.
  Enforced by the `local/one-export-per-command` ESLint rule.
- **Cross-module types use the JSDoc `@import` tag, not inline `import("…").Type`.** One
  `/** @import { Foo } from "./bar.mjs" */` near the top (as `remote.mjs` does), then bare
  `{Foo}` in annotations — the modern TS-supported style (TS 5.5+). An unused `@import` name is
  flagged by the type check, so they don't rot.
- **Don't bury `await` in a larger expression — give it its own line and a name.** The two
  smells: **member/index access on an awaited result** (`(await read(…)).entries`,
  `(await xs())[0]`) and **a compound `if`/`while`/`&&`/`||` condition** containing the await.
  Hoist first: `const m = await read(…); … m.entries`; `const ok = await exists(uri); if (ok)
  …`. **Not buried — all fine:** `const x = await …`, `return await …`, a standalone `await …;`,
  a ternary branch, destructuring (`const { lookup } = await read(…)`), and `await` as a call
  argument (`assert.deepEqual(await foo(), …)`). (Copilot flags the destructuring, argument, and
  ternary cases — decline those.) No linter (too false-positive-prone, per
  [ADR-0006](docs/adr/0006-minimal-code.md)/#5); self-check by grepping the diff for
  `(await …).`/`(await …)[` and `&& `/`|| ` before `await`.
- **The whole-project type check (`tsc -p jsconfig.json`, the `typecheck` script) is kept
  clean** and covers `scripts/` too (JSDoc only). One non-obvious bit: `jsconfig.json` maps
  `events`/`punycode`/`string_decoder` back to the builtin type declarations — transitive deps
  install npm shims that would otherwise shadow them (full mechanism in the jsconfig.json comment).
- **Before committing code, run _both_ halves of CI's `lint` job — `format:check` (Prettier)
  *and* `lint` (eslint).** eslint passing alone is **not** enough: the job also runs
  `prettier --check .`, so unformatted hand edits fail CI every time (a recurring trip-up).
  `npm run format` fixes, then re-check. The pre-commit gate is format + lint + typecheck +
  test, mirroring CI.
- **Test layout convention** ([ADR-0049](docs/adr/0049-centralize-cross-cutting-test-tiers.md),
  superseding [0046](docs/adr/0046-test-layout-colocated-tier-suffix.md)): **co-locate the
  module-owned tier (unit `*.test.mjs` beside its module); centralize the cross-cutting tiers.**
  Real-bucket integration lives in [test/integration/](test/integration/) — the **folder** is the
  tier marker (no `.integration.` suffix), `test:integration` globs `test/integration/**/*.test.mjs`
  so new suites auto-enrol; a run that opts in without a bucket **hard-fails**, never silently
  skips. The subprocess e2e suite ([test/e2e.test.mjs](test/e2e.test.mjs)) and shared
  `fixtures/`/`helpers/` (incl. the gated harness `helpers/integration.mjs`) also live in
  [test/](test/). A module's *absent* co-located test file is honest "tested elsewhere / too thin"
  signal, not a gap. A second *unit* file for one module takes a dotted aspect
  (`setup.remote-first.test.mjs`), never a hyphen; integration files name by the truest thing
  (scenario where cross-cutting — `backup-restore-roundtrip` — else module — `remote`). Scripts:
  `test` = unit + e2e (hermetic), `test:integration` = the folder, `test:all` = both. Full
  rationale: [test/README.md](test/README.md). (The `--experimental-test-module-mocks` flag
  exists for `objects.test.mjs`'s `mock.module` — [ADR-0019](docs/adr/0019-s3-test-strategy.md).)
  Scratch → [scripts/](scripts/).
- **`--test-isolation=none` is slower here, not faster — don't re-try it for speed**
  (measured: ~1.8× slower, 12s vs 7s). Node's default per-file isolation parallelizes test
  files across workers; one process loses that. The suite _is_ in-process-safe, so the flag is
  fine for debugging shared state — just not a speedup.
- **Before pushing a change to the S3 read/write/stream path, run the gated real-S3 suite
  (`npm run test:integration`), not just mocked units.** Mocks and a local `npm test` can't
  exercise stream *teardown/abort* behaviour that only the real S3 body exhibits — green units,
  red integration. Worked example: #171's `stream.compose(body, …)` aborted the live GetObject
  on completion (`ABORT_ERR` in `test/integration/backup-restore-roundtrip.test.mjs`) while every unit test passed.
  Setup: [docs/integration-testing.md](docs/integration-testing.md); this is *the* reason the
  suite is real-bucket ([ADR-0019](docs/adr/0019-s3-test-strategy.md)).
- **Watch for per-file overhead in the walk/snapshot hot path — small costs mount up over
  thousands of files.** A second `lstat`/`stat`/read per file is invisible on one, dominant on
  tens of thousands. The fix: **thread the data you already have through the pipeline** (the
  `Dirent` already carries the file type; `prop` already takes one `stat`) — *not* a hidden
  module-level cache, which is invisible to the type checker, makes a pure function
  order-dependent, and rots into dead code. Keep the saving *in the interface*, where the
  compiler can see it rot.
- **Memory/async stance (user-stated): assume a modern user PC, not a headless VM.** Don't
  needlessly use memory, but don't be shy either. No sync-purity dogma for engine functions —
  async interfaces are welcome, mainly because progress reporting can hook in later (worked
  example: `planUpload` accepts the LIST as an async iterable rather than a materialized Set).
- **`realpathSync.native` is the one reliable path canonicalizer — capture it once at the
  low-frequency edges, then trust the fast string functions.** Node's pure-string
  `resolve`/`normalize`/`join` can return subtly *different* strings for the same real file
  (case, `..`, symlinks), silently breaking anything that **keys on the path** (snapshot lookups
  are path-keyed → a mismatched key reads as a different file). `realpathSync.native` is
  sure-fire but **hits the filesystem: one call fine, per-file-in-a-loop deadly.** So realpath
  only at the capture points (`setup`'s `resolveDirectories`; the walk root in `walk.mjs` — once
  per root, never per entry), then use pure-string `path` downstream (the compare renderer
  shortens with plain `relative`/`split` — must **not** reintroduce a per-path `realpathSync`).
- **Two UX references govern user-facing design — treat them as bibles.** Command *shape*
  (commands, flags vs. positionals, naming, output) follows the **Command Line Interface
  Guidelines** (clig.dev), distilled into the **`cli-design` skill**
  ([.claude/skills/cli-design/](.claude/skills/cli-design/)) — consult it for any command-shape
  decision; error/warning *wording* follows **Nielsen's heuristic #9** (next bullet,
  [ADR-0030](docs/adr/0030-error-message-guidelines.md)). Most recent shape decision:
  [ADR-0036](docs/adr/0036-setup-mutates-list-shows-drop-sets.md). Both checked in review, not a
  linter ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **User-facing error/warning text follows ADR-0030** (Nielsen's heuristic #9,
  [ADR-0030](docs/adr/0030-error-message-guidelines.md)): plain-language headline framed by the
  user's *goal* (no codes/jargon up front — env-var names, paths, keys go in a parenthetical),
  polite (describe, don't blame), *constructive* (the exact fix as a copy-pasteable command on
  its own indented line — mirror `collisionError` in [src/commands/setup.mjs](src/commands/setup.mjs)).
  Internal invariants/programmer errors (a malformed `s3://` URI) are *out of scope* — keep
  those terse and factual. Checked in review, not a linter ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **Shape our own errors by the taxonomy in [src/lib/error.mjs](src/lib/error.mjs)'s header**
  (this is *shape*; ADR-0030 above is *wording*). Two questions: (1) caught by *type* to branch
  behaviour? → an Error *subclass* (`ParseArgsError`, which `isUsageError` `instanceof`-checks),
  else a plain `Error`; (2) for plain errors, is the message heavy/actionable/reused? → a named
  factory (`noCredentialsError` in `auth.mjs`, `collisionError` in `setup.mjs`), else inline
  `throw new Error`. Foreign SDK/Node errors are matched by `code`/`name`. A subclass nobody
  catches by type is unused identity (#5) — don't reach for one until a catch site reads it.
- **A command whose result already _is_ its final output text returns that string and points
  `render` at the shared `renderText` passthrough** — don't invent structured data or a bespoke
  renderer for inherently prose output (a recipe, a confirmation line). The identity renderer is
  the honest degenerate case of the render layer ([ADR-0043](docs/adr/0043-human-first-output.md));
  forcing a `--json` shape onto prose just to satisfy the pattern is the over-engineering #5
  forbids. (Worked example: `aws`'s onboarding recipe and `provider`'s status lines.)

---

## Agent skills

Per-repo configuration for the engineering skills (from
[mattpocock/skills](https://github.com/mattpocock/skills), installed **globally** — see the
skills blockquote under "Where knowledge lives", not vendored here). Scaffolded once via the
`setup-matt-pocock-skills` skill; keep the global install current with
`npx skills@latest update --global`.

### Issue tracker

Skills use `.scratch/<feature-slug>/` as **ephemeral, gitignored** working-space during a run
(per-machine, throwaway — *not* a durable or shared tracker). **Durable** work-to-be-done and
decisions live in [proposals/](proposals/) and this file — committed, so every machine sees
them; promote anything worth keeping out of `.scratch/` into those before it's cleaned. See
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, identity-mapped — all already exist as repo labels, so `/triage`
only applies them. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: root [CONTEXT.md](CONTEXT.md) glossary + [docs/adr/](docs/adr/) decision log.
See [docs/agents/domain.md](docs/agents/domain.md).

### Architecture reviews

`/improve-codebase-architecture` reads and updates
[proposals/architecture-improvements.md](proposals/architecture-improvements.md) — the durable
capture of every run (open candidates, standing rejections, run log). Verify its open
candidates against the source before exploring (don't re-derive), record new rejections there,
and replace [proposals/architecture-review.html](proposals/architecture-review.html) (latest
only — each run's report overwrites it).

---

## What this project is

**s3cab** = **S3 C**ontent **A**ddressable **B**ackup. [README.md](README.md) covers what
it is, why, what works today, and what's coming; [CONTEXT.md](CONTEXT.md) defines the
vocabulary. Treat the README's S3/backup descriptions as the _target_; treat `src/` as
_what works now_. A few layout notes the README and code don't carry:

- **Scratch and throwaway experiments go in [scripts/](scripts/)** — never a parked sandbox
  under `src/` and never under `test/` (see the test-layout convention above).
- **Snapshots no longer land in the repo tree.** Since backup-sets slice 2 they live in
  `~/.s3cab/sets/<set>/snapshots/` (outside any working copy), so `.gitignore` no longer
  needs the old root-anchored `/.s3cab/snapshots/` rule — only the `/.s3cab/env*` secret
  guards remain for the committed [.s3cab/exclude.txt](.s3cab/exclude.txt) template.
- **The repo dogfoods itself via a set:** [.s3cab/exclude.txt](.s3cab/exclude.txt) is kept
  as a ready-made exclude template — to snapshot this repo, `s3cab setup s3cab . --bucket <bucket>`
  then copy those patterns into `~/.s3cab/sets/s3cab/exclude.txt`. (It can't live in the repo and be
  wired automatically now that excludes are per-set under `~/.s3cab`.)

The licensing model (GPL-3.0-or-later; CLA not DCO) is in
[ADR-0008](docs/adr/0008-gpl-3-license.md) / [ADR-0009](docs/adr/0009-cla-not-dco.md). The
removed bespoke SSO `login` command and the standard-credential-chain model are in
[ADR-0015](docs/adr/0015-standard-aws-credential-chain.md) — **don't rebuild the login.**

---

## Architecture orientation

The *decisions* behind the structure are in [docs/adr/](docs/adr/); this is just the map
for finding your way around the code. The *what* is best read from the code itself:
[src/s3cab.mjs](src/s3cab.mjs) is an ~80-line entry point, the registry in
[src/commands.mjs](src/commands.mjs) is the command list, and each command file carries its
own doc comment.

- **Adding a command = adding one entry to the registry.** Stubs for unbuilt commands are
  kept *inline* in the registry (not given their own `src/commands/` files) until they gain
  real bodies — per [ADR-0006](docs/adr/0006-minimal-code.md), a file is earned by logic, not
  reserved ahead of it. They carry `planned: true`, which help renders as `(not yet available)`.
- **Source layout.** App-level shell files at the `src/` root (`s3cab.mjs` entry,
  `commands.mjs` registry, `help.mjs` renderer — root, not `lib/`, because it's bespoke
  CLI-shell glue tied to the registry shape, not a reusable primitive); the rest splits into
  **sibling** directories [src/commands/](src/commands/) (one file per command) and
  [src/lib/](src/lib/) (shared modules). The siblings sit beside each other on purpose — the
  shared modules are _depended on by_ the commands, not a layer above — and it's taste-driven,
  not a hard boundary (a `lib/` module importing a `commands/` one would be fine; today none
  does). Grouping is by **subsystem/cohesion, not abstract layer**: no `lib/util/` junk-drawer.
  If `lib/` ever grows enough to cleave, extract a directory named for the subsystem and leave
  the generic leaves (`format`, `read-lines`, `error`) flat at the root.
- **The S3/remote engine.** Module ownership (`objects/<sha256>` →
  [src/lib/objects.mjs](src/lib/objects.mjs); `snapshots/<namespace>/` →
  [src/lib/remote.mjs](src/lib/remote.mjs); generic SDK boundary → `src/lib/s3.mjs`) follows
  from [ADR-0013](docs/adr/0013-one-repository-one-bucket.md) and
  [ADR-0014](docs/adr/0014-backup-sets.md). The atomic, integrity-checked *landing* of a
  downloaded stream to disk is **not** an SDK concern, so it sits outside that boundary in
  [src/lib/atomic-file.mjs](src/lib/atomic-file.mjs) (`writeFileAtomic`, where design #1's hash
  check is enforced). Auth splits in two: *credential resolution* is `resolveCredentials` in
  [src/lib/auth.mjs](src/lib/auth.mjs) ([ADR-0015](docs/adr/0015-standard-aws-credential-chain.md)),
  and *env-file layering* is `loadEnv`/`loadSet` in [src/lib/env.mjs](src/lib/env.mjs) — the
  **user** layer loaded once at the entry point, the **set** layer added by the `loadSet` door
  each set command routes through ([ADR-0022](docs/adr/0022-prepare-remote-set-front-door.md));
  both specified in [docs/design/auth.md](docs/design/auth.md).
- **No `package.json` `main`, no `src/index.mjs` barrel.** s3cab is a CLI, not a library, and
  the entry point runs dispatch as a top-level side-effect (unsafe to `import`). The
  per-command functions in `src/commands/` are already cleanly exported, so a side-effect-free
  barrel is trivial to add the day a real library consumer appears — until then it would be
  speculative structure ([ADR-0006](docs/adr/0006-minimal-code.md)). (If the dispatch flow
  itself ever needs unit testing, guard the run block with `if (import.meta.main)`; today
  [test/e2e.test.mjs](test/e2e.test.mjs) covers it as a subprocess.)
- **`--version` is a single source-of-truth chain:** `package.json` `version` → imported as a
  JSON module → inlined by esbuild into the SEA bundle, so the native binary reports the same
  number without reading a file at runtime. The release guard keeps the git tag in lockstep;
  docs avoid pinning the number (README uses a live npm badge) so nothing drifts.

For how the structure is reasoned about and named, see
[ADR-0010](docs/adr/0010-cli-output-conventions.md) (output/stream discipline),
[ADR-0011](docs/adr/0011-validation-in-command-functions.md) (validation in commands), and
[ADR-0012](docs/adr/0012-consumer-vocabulary-naming.md) (naming).

---

## Known gaps & cleanup items

Pre-release housekeeping and open decisions surfaced from the code:

- **Backup/restore/admin all built — retention policy remains** — the
  five-slice plan in [docs/design/backup.md](docs/design/backup.md) is **complete** (slices 1–4
  plus slice-5's `verify`/`delete`/`cleanup`; detail there). Still open from slice 5:
  **retention-policy automation** (keep-last/daily/weekly/monthly on top of `delete`/`cleanup` —
  deferred until real usage shows the shapes). The **versioning/ransomware user-doc note** is
  **done** (README's versioning section + [guide/aws.md](guide/aws.md)'s soft-delete model).
  Settled, **don't re-litigate**: the **everyday-vs-elevated delete-rights** question
  ([ADR-0033](docs/adr/0033-bucket-onboarding-security-model.md) — the everyday identity keeps
  `s3:DeleteObject`; the *soft-vs-permanent* seam, not delete-vs-no-delete, is the blast-radius
  boundary, so `delete` runs under per-set creds); the **`upload` reshape** (ADR-0044/0045 —
  `upload` unified/set-scoped, `backup` = `snapshot()` + `upload()` with `--since`, `backup
  --snapshot` retired; a `node:sqlite` hash cache was spiked and **rejected** for the in-memory
  `Map`, see [scripts/sqlite-hash-cache-spike.mjs](scripts/sqlite-hash-cache-spike.mjs)).
  `compare` is local-only ([ADR-0027](docs/adr/0027-compare-local-only-adoption-syncs-manifests.md));
  `reattach` (ADR-0053, split from `setup --inherit`) pulls a set's remote manifests down so a
  fresh machine's `compare`/`list`/`restore` work on full history.
- **Native-executable packaging works and is validated on real runners** (the full matrix
  has run for real: binaries build, smoke-test, archive; macOS ad-hoc sign, npm publish,
  and GitHub Release all succeed). ci.yml's `exe smoke` job also boots the Linux binary +
  bundle on **every PR**, so artifact-only breakage no longer waits for a tag (see
  [ADR-0016](docs/adr/0016-native-executable-build.md)).
  Open items:
  - **macOS notarization — deliberately skipped (costs money).** Ad-hoc signing is enough
    to _run_; Gatekeeper-clean distribution would need a paid Apple Developer ID. The
    README documents the `xattr` workaround for browser downloads.
  - **macOS is labelled `macos`, not `darwin`,** in release-asset + `sea/` config names
    (friendlier on a download); `test/e2e.test.mjs` maps `process.platform` to the label.
  - **Only `macos-arm64` ships** — Intel Macs are legacy; those users have `npm` or the
    portable bundle. Adding it later is one `sea/` config + one `macos-13` matrix row.
  - **Drop esbuild** if Node ever bundles multi-file SEA inputs natively.
- **"Latest snapshot uncompressed" stays `S3CAB_DEBUG`-only — settled, don't re-litigate.**
  The `.snapshot.tsv` sidecar `snapshot` writes under debug ([src/commands/snapshot.mjs](src/commands/snapshot.mjs))
  is *not* promoted to an always-on transparency feature: the no-lock-in pillar
  ([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)) is already met by the standard,
  tool-decompressible `.tsv.zst` (`zstd -d`, documented in [guide/format.md](guide/format.md)),
  so an always-uncompressed second artifact per snapshot would be cost for no gain
  ([ADR-0006](docs/adr/0006-minimal-code.md)/#5). The ~7-line debug-gated sidecar stays as-is.
- **Type check runs in CI; coverage is reported but not gated** (the ci.yml Linux `lint`
  job): `npm run typecheck` plus a `test:coverage:report` run that **prints** the coverage
  table as advisory output ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)). One
  standing trap: the coverage flags must **precede** the glob positionals — the
  `npm run test -- --experimental-test-coverage` shape collects nothing and exits 0, so
  don't reintroduce it (package.json can't carry a comment saying so; this is the warning).
- **Revisit plain-JS-vs-TypeScript** now that Node runs TS natively (see
  [ADR-0007](docs/adr/0007-plain-js-via-jsdoc.md)).
- **Define behaviour** for paths containing tabs/newlines in the TSV (see
  [ADR-0004](docs/adr/0004-tsv-snapshot-manifests.md)).
- **Stable doc URLs — resolved: GitHub `guide/*.md` paths are permanent (no website pre-1.0).**
  Help/footer/command text prints these URLs and a shipped binary freezes them, so the
  commitment is: **don't rename `guide/*.md` or move the repo slug** without updating the printed
  URLs. One open outlier: the `auth` topic's footer points at the `#authentication` README
  *anchor* (fragile if reworded) — fold a fix into the next auth-doc touch.
- **Re-measure the slurp/stream hash boundary** in [src/commands/prop.mjs](src/commands/prop.mjs)
  during any future perf/test pass. Files ≥ 5 MB stream through a hash; smaller ones slurp
  via one-shot `crypto.hash`. The 5 MB cutoff was chosen empirically on real data but
  predates the one-shot-hash path, so the optimum may have moved. (`streamHash`'s old
  explicit 8 MB buffer was already dropped as a relic — reads now use Node's default
  `highWaterMark`, with no measured loss for SHA-256.)
