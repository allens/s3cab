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

The top-level split is by **audience**: everything contributor-facing and internal lives
under [docs/](docs/) — `adr/` = pinned *decisions* ("don't re-litigate"), `design/` =
subsystem *designs* (the fuller *what/how*, which evolves; a design and an ADR differ in
*kind*, hence sibling directories), and the loose `docs/*.md` = *how-tos* (task recipes) —
while user-facing prose is README + `guide/`. **The word "spec" is reserved** for the
*format spec*, [guide/format.md](guide/format.md) — the recovery-grade contract for
everything s3cab stores, kept on the *user* side because the stored format is a user-facing
promise ([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)); design docs are
*designs*, not specs. ([CONTEXT.md](CONTEXT.md) vocabulary stays at the root as a
single-purpose file; the [proposals/](proposals/) ideas bucket sits outside `docs/` on
purpose — it is provisional and *not* of record, the opposite of what `docs/` holds.)

The seven foundational design principles were once numbered `#1`–`#7` here; they are now
[ADR-0001](docs/adr/0001-file-level-content-addressable-dedup.md) through
[ADR-0007](docs/adr/0007-plain-js-via-jsdoc.md). Old `#N` references in code comments and
specs map straight across (`#1 → 0001`, … `#7 → 0007`); the full map is in
[docs/adr/README.md](docs/adr/README.md).

> **The skills convention this layout follows** (the `domain-modeling` skill): glossary →
> `CONTEXT.md`, decisions → `docs/adr/`. The `improve-codebase-architecture`, `codebase-design`,
> and `grill-with-docs` skills read these; keep them current as the model and decisions evolve.
> These skills come from [mattpocock/skills](https://github.com/mattpocock/skills) and are **not
> vendored into this repo** — install them into your personal **global** `~/.claude/skills/` (follow
> that repo's install instructions), not the project tree, so every checkout doesn't carry a copy.
> (That no-vendor rule targets those _general-purpose_ skills; a **project-specific** skill is the
> opposite case and **is** vendored — e.g. [`.claude/skills/cli-design/`](.claude/skills/cli-design/),
> the project's own CLI-design bible — so it travels with the repo and every checkout/agent gets it.)

### Documentation discipline (applies to every doc here)

Two standing rules govern the docs. They matter because **transparency is a core project
value** (see [ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md), no lock-in): docs that
lie about behaviour undermine the whole premise.

1. **Never let docs _mislead_ about what works — but they may describe agreed-but-unbuilt
   direction when it is clearly marked target-vs-built.** The hard requirement is honesty,
   not present-tense-only: before writing a claim, verify it against the actual code, and
   always **distinguish what is built today from what is planned/target** (the README's
   S3/backup descriptions are the target; the code in `src/` is what works now). With that
   line drawn, design docs are *allowed* to lead the code — a settled-but-unimplemented
   redesign can land in an ADR (`Status: proposed`), CONTEXT.md, or a design-doc banner, as
   long as a reader can't mistake it for live behaviour. Flag drift you notice — stale
   comments, `package.json` paths to non-existent files, etc.; the "Known gaps & cleanup
   items" section is the running list.
2. **Each doc carries only what its home is for, and only what is _not_ trivially knowable
   from the code.** Don't restate `package.json` scripts or build/test/lint commands. The
   split: vocabulary → CONTEXT.md; the non-obvious *why* of a decision → an ADR; fuller
   design → docs/design/; the user *contract* → README/guide/; how to work in the repo → this file.
   Developer setup, if wanted, belongs in the README, not here.

**Within the user-facing half, placement is decided by a doctrine:**
the website/repo docs (README, `guide/` — eventually a proper website) carry everything
someone needs *before trying s3cab* plus the advanced depth (e.g. the format spec); the
built-in CLI help topics (`s3cab help <topic>`, `helpTopics` in
`src/help.mjs`) carry only what a user needs *mid-task in a terminal*. The placement test:
*"would someone need this mid-task, without reaching for a browser?"* Exclude-pattern
rules pass (you're editing `exclude.txt` in a shell); the repository format fails (reading
it is a sit-down activity — it lives in [guide/format.md](guide/format.md), never in a help
topic). Each help topic ends with a link to its fuller online guide;
the overlap this leaves (e.g. the glob token table appears in both `helpTopics.exclude` and
`guide/exclude.md`) is accepted — small, and both copies change together with the matcher —
rather than papered over with generation/sync machinery
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
   don't carry it forward. "You're right that X is better" ≠ "do X now." One principle, four
   faces:
   - **Commits/pushes** — never `git commit`/`push` without an explicit "commit"/"pr" in that
     same message. (Exception: settings.json — see #2.)
   - **"Work through one by one"** — a strict per-step protocol: (a) propose the step and ask
     any questions; (b) once agreed, make the changes and present the diff *uncommitted*; (c)
     move on only when the user agrees, committing that step as you go (don't accumulate every
     step to the end — that keeps per-step commits splittable). A batch go-ahead ("execute",
     "go ahead") authorizes _starting_, not skipping the per-slice pause; run straight through
     only when told explicitly ("don't pause").
   - **"Review the PR comments"** — review them _with_ the user: assess each (valid / not /
     nuance) with a suggested action, then stop and let them decide. Holds for _every_ wave,
     including a manually-triggered re-review; a "fix and resolve" go-ahead is per-batch and never
     carries forward.
   - **A question** ("why is it done this way?", "wouldn't X be simpler?") wants an *answer* —
     explain, say whether their instinct is right, then **stop and offer**. Don't edit off the
     back of a question.
2. **Committing [.claude/settings.json](.claude/settings.json) is pre-authorised** — it needs
   no per-request go-ahead and may go straight to `main` (a standing exception to #1 *for this
   file only*: permission/config tweaks are low-risk housekeeping). Validate via the
   `update-config` skill first, and keep it as its own `chore:` commit; when a feature-PR
   go-ahead is given and the tree also has settings.json changes, fold them into that PR.
3. **After non-trivial work, update the docs** so what you learned is shared at the project
   level. Put it in the right home (see the map above): a design decision → an ADR; vocabulary
   → CONTEXT.md; a working/coding rule → this file; never only in local memory. **But recording
   a rule is only half the job — once it has _settled_, distill it to {rule + why + at most one
   example} and let `git blame` hold the story of how it got there.** Appending every correction
   without ever compressing is what bloats this file; the record is for the *current* rule, not
   its changelog.
4. **Refactors and minor chores may ride along with a feature** — a one-feature commit/PR
   carrying a small refactor, a settings.json tweak (#2), a `proposals/` addition (any
   provisional idea the work surfaces), or a doc fix needn't be split into its own PR. Don't
   over-engineer separation. (Still prefer a _separate commit_ per logical change within the PR.)
5. **Don't delete commented-out code or TODO notes as "dead code" without asking.** They may
   be the user's parked reminders of an unresolved question, not cruft. Flag them as
   candidates instead — then analyse and resolve on the user's say-so, recording the rationale
   so the decision isn't re-litigated. (Worked example: the commented-out SIGINT handler in
   `src/s3cab.mjs`, analysed and removed once its rationale was understood.)
6. **Always use the Bash tool, not PowerShell.** Bash is available even on Windows and the
   project's permission allowlist is Bash-based. The system prompt identifies PowerShell as
   the interactive shell — ignore that signal for tool selection. Reserve PowerShell only
   when a command genuinely requires it (e.g. `$env:VAR`, `Select-String`, or Windows-only
   cmdlets with no Bash equivalent).
7. **Do not over-engineer.** A standing edict from the user, the process-level twin of
   [ADR-0006](docs/adr/0006-minimal-code.md): build the small thing the current need justifies,
   and generalize only when the second case actually appears. (Worked example: `isENOENT` in
   `src/lib/error.mjs` was added once the check had four call sites, shaped as the specific
   predicate rather than a generic `isErrnoCode(error, code)`.) **Over-engineering is about the
   _solution_ being more complex than the problem warrants — not how much work or churn a change
   takes:** swapping one design for a simpler, very different one can be a lot of work yet the
   opposite of over-engineering. The guiding heuristic, in the project's spirit of keeping it
   simple, is to **minimize lines of code** as a proxy for complexity — clear, not obfuscated,
   but not overly verbose either. So this forbids _speculative_ structure, not _justified_
   refactoring: when restructuring genuinely simplifies, do it even if sizable. **And "simpler"
   means _clearer_, not only structurally smaller:** better names, consistent interfaces, and
   more legible code are worth the churn even when they add no capability — legibility _is_ part
   of getting the design right, so don't shy off a rename or reshape for it (e.g. `getData`→`getText`
   so the interface states its contract, or an inline `pipeline` async generator in place of a
   `Transform` subclass). **Version gates
   how bold to be:** while **pre-1.0** (`package.json` major `0`) you have **free rein** for
   large, correct refactors — favour getting the design *right* over minimizing churn or
   back-compat. **Once it ships 1.0 this reverses:** breaking changes then need real care and a
   migration story. Check the major version first: `0` → bold; `≥ 1` → conservative.
8. **Test coverage is judged by review, not a percentage gate**
    ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)). Good, *asserting* tests for new
    or changed behaviour are a per-PR obligation, checked by **reading the diff** — the
    `/review` skill's Standards axis, and Copilot code review via
    [.github/copilot-instructions.md](.github/copilot-instructions.md) — not by a CI
    threshold. When you add or change behaviour, add a test that makes a real assertion about
    the *result*, not one that merely executes the line.
9. **Every session that will _write_ works in its own git worktree — default-on, no size
   threshold.** Sessions share *one* main working tree, so one session's uncommitted edits are
   visible to (and confuse) the others; a per-session worktree removes that hazard. **Branch a
   worktree before the first edit of any change you intend to commit, however small.** Only
   **pure read-only / Q&A work** — and **doc-only changes** — stay in the main tree. **A doc-only
   commit goes straight to `main`, no worktree and no PR** (Markdown/prose only: `docs/`, `guide/`,
   README, CONTEXT.md, ADRs, this file, `proposals/` — nothing under `src/` or config): it carries
   no code-conflict risk with another session and needs no review ceremony. Feature work, by
   contrast, lands on the worktree branch → one PR, with `main` left at `origin/main` (it merges
   *through* the PR). In any main-tree edit (doc-only commits included), stage only the files _you_
   changed (`git add <path>`, never `-A`/`.`) so you don't sweep up another session's in-flight
   work, and still commit only on an explicit go-ahead (#1).
   - **No shared `node_modules`.** A junctioned/shared copy was rejected: it re-introduces a
     shared mutable resource, and a fallback `rm -rf <worktree>` can recurse *through* the
     junction into the **main** checkout's `node_modules`. Code work runs `npm install` first
     (seconds from the warm cache; doc-only changes skip it).
   - **Mechanics.** Worktrees live at **`.claude/worktrees/<name>`**
     (`EnterWorktree`/`ExitWorktree` in-session, or `isolation: "worktree"` for agents); the
     path is excluded in `.gitignore`, the `.vscode` search/watcher excludes, and eslint
     `ignores`. **Accept the harness's branch name** (`worktree-feat+x`) — renaming orphans it
     from `ExitWorktree(remove)`'s auto-cleanup; the PR *title* is clean regardless.
   - **Teardown is `ExitWorktree(remove)`** — deletes the directory *and* its branch (a new
     worktree branches fresh from `origin/main`, so a stale local `main` blocks nothing).
     **Review the work on the GitHub PR; don't open the worktree directory in the IDE** — an
     open file there gives Windows a lock that can block removal.
   - **Run bare commands — don't prepend `cd`, and don't use `git -C`.** The session cwd
     already *is* the worktree. Both forms defeat the path-free allowlist (re-prompting every
     call), and `git -C …` *also* slips past the path-free **deny** guards. To act on **another
     worktree**, `EnterWorktree` (it sets cwd), then run bare `git …` — do **not** reach in with
     `git -C .claude/worktrees/<name> …` (the recurring trap). This is now **enforced by a
     one-line deny rule** — `Bash(git -C *)` in [.claude/settings.json](.claude/settings.json)
     hard-blocks any command that *starts* with `git -C` (chosen over a path-resolving hook per
     #7 — the leading form is the actual trap). The accepted gaps: a `git -C` buried
     mid-compound (`cd x && git -C …`) isn't caught, and `git -C` into a genuinely external repo
     is also blocked — both rare enough not to warrant the heavier hook.
10. **Request a Copilot code review at PR create** — pass `--reviewer "@copilot"` to
    `gh pr create`. That one create-time request **always works; fire it once and move on** —
    do **not** verify it, re-request it (`gh pr edit --add-reviewer`), or re-run after pushes.
    `gh pr view --json reviewRequests` reads **empty even on success** (Copilot's request
    doesn't surface there), so treating that empty array as failure is a false alarm that only
    leads to a forbidden re-request. When a review lands, bring its comments back to the user to
    discuss (#1) — don't auto-action them.
11. **The permission-prompt fix is settled — do NOT re-litigate it.** The fix is the "run all
    Bash without prompts except a few blocked" pattern: a **bare `"Bash"` entry in
    `permissions.allow`** plus **`"defaultMode": "acceptEdits"`** — both nested **under
    `permissions`**, not at the file's top level — in the committed
    [.claude/settings.json](.claude/settings.json), so **every machine inherits it**. This is
    safe, **not** `bypassPermissions`: the `deny` list and the PreToolUse hooks still guard
    everything (deny-first precedence runs before allow) — the `Bash(git -C *)` deny rule blocks
    the `git -C` deny-bypass (#9), and the `block-destructive-rm.sh` hook catches recursive/force
    `rm` in any flag ordering. **Never "solve" recurring prompts by adding specific allow entries or
    re-running `fewer-permissions`** — that is the failed layer that never converges (it only
    appends dead one-shot rules). If prompts persist, `defaultMode` applies on *next session
    start* (restart once), or the command genuinely hit a `deny` rule (a real safety block —
    surface it, don't widen the allow-list).

### Coding conventions

How to write code that looks like the rest of the codebase. (These are *style* rules; the
*decisions* about tooling — LF endings, Prettier-code-only, dependency policy — are ADRs
[0021](docs/adr/0021-lf-line-endings-prettier-code-only.md),
[0005](docs/adr/0005-builtins-over-dependencies.md),
[0018](docs/adr/0018-dependabot-not-renovate.md).)

- **Each file in `src/commands/` exports exactly one symbol — its command function.** The
  mechanical form of [ADR-0023](docs/adr/0023-porcelain-plumbing-lib-layers.md)'s
  porcelain/plumbing/`lib` layering: if anything else — a sibling command *or* a test — needs
  something from a command file that isn't the command, that thing is a `lib/` primitive that
  hasn't moved yet, so extract it to `lib/`. Porcelain still *composes* a plumbing command
  through that one export (`backup` calls `snapshot()` and `upload()`; `upload` and `snapshot` call `prop()`);
  what the rule bans is reaching past the command for a co-resident helper. A symbol used only
  inside its own command file just stops being `export`ed (it doesn't move to `lib/` without a
  second caller — #7); cross-module types travel by `@typedef`/`@import`, not `export`. Enforced
  by the `local/one-export-per-command` ESLint rule in [eslint.config.js](eslint.config.js).
- **Cross-module types use the JSDoc `@import` tag, not inline `import("…").Type`.** One
  `/** @import { Foo } from "./bar.mjs" */` near the top (as `remote.mjs` does for
  `SnapshotEntries`), then bare `{Foo}` in annotations — cleaner than repeating the inline
  form at each use, and the modern TS-supported style (TS 5.5+). An unused `@import` name is
  flagged by the type check, so they don't rot.
- **Don't bury `await` in a larger expression — give it its own line and a name.** A "buried"
  await is one nested inside a bigger expression rather than standing alone; the two smells are
  **member/index access on an awaited result** (`(await read(…)).entries`, `(await xs())[0]`)
  and **a compound `if`/`while` or `&&`/`||` condition** containing the await. Hoist into a
  named local first: `const m = await read(…); … m.entries`; `const ok = await exists(uri); if
  (ok) …`. **Not buried — all fine:** `const x = await …`, `return await …`, a standalone
  `await …;`, a ternary branch (`cond ? await f() : g()`), destructuring an awaited result
  (`const { lookup } = await read(…)`), and `await` as a call argument
  (`assert.deepEqual(await foo(), …)`). (Copilot flags the destructuring, argument, and ternary
  cases as violations — decline those.) No linter enforces this (rejected as too
  false-positive-prone, against [ADR-0006](docs/adr/0006-minimal-code.md) / #7); self-check by
  grepping the diff for `(await …).` / `(await …)[` and a `&& `/`|| ` immediately before `await`.
- **The whole-project type check (`tsc -p jsconfig.json`, the `typecheck` script) is kept
  clean**, and covers `scripts/` too (JSDoc only, no extra deps). One non-obvious bit makes
  the check possible: `jsconfig.json` maps `events`/`punycode`/`string_decoder` back to the
  builtin type declarations — transitive deps install npm shims that would otherwise shadow
  them; the full mechanism is the comment in jsconfig.json.
- **Before committing code, run _both_ halves of CI's `lint` job locally — `format:check`
  (Prettier) *and* `lint` (eslint).** eslint passing alone is **not** enough: the job also runs
  `prettier --check .`, so hand-written edits that aren't Prettier-formatted fail CI every time
  (a recurring trip-up). Run `npm run format` to fix, then re-check. (Same spirit as keeping
  `typecheck` clean — the pre-commit gate is format + lint + typecheck + test, mirroring CI.)
- **Test layout convention** ([ADR-0046](docs/adr/0046-test-layout-colocated-tier-suffix.md)):
  tests are **co-located**, with the tier in the filename — unit as `*.test.mjs`, real-bucket
  integration as `*.integration.test.mjs` (gated; `test:integration` is the glob
  `src/**/*.integration.test.mjs`, so new suites auto-enrol) — while the subprocess e2e suite
  and the shared `fixtures/`/`helpers/` (incl. the gated-suite harness `helpers/integration.mjs`)
  live in [test/](test/). A module's *absent* test file is honest "tested elsewhere / too thin"
  signal, not a gap; VS Code file nesting keeps the tree lean. A second test file for one module
  takes a dotted aspect (`setup.remote-first.test.mjs`), never a hyphen. Full layout +
  explicit-glob rationale: [test/README.md](test/README.md). (The
  `--experimental-test-module-mocks` flag on the `test` scripts exists for `objects.test.mjs`'s
  `mock.module` — [ADR-0019](docs/adr/0019-s3-test-strategy.md).) Scratch goes in
  [scripts/](scripts/).
- **`--test-isolation=none` is slower here, not faster — don't re-try it for speed**
  (measured 2026-06-13: ~1.8× slower, 12s vs 7s). Node's default per-file isolation runs
  test files across worker processes in parallel; collapsing to a single process loses
  that. The suite _is_ in-process-safe (no cross-file leakage), so the flag is fine for
  debugging shared state — just not a speedup.
- **Before pushing a change to the S3 read/write/stream path, run the gated real-S3 suite
  (`npm run test:integration`), not just the mocked unit tests.** Mocks and a plain local `npm
  test` can't exercise stream *teardown/abort* behaviour that only the real S3 body exhibits —
  green units, red integration. Worked example: #171's `stream.compose(body, …)` aborted the
  live GetObject request on completion (`ABORT_ERR` in `restore.integration.test.mjs`) while
  every unit test passed. Setup (bucket + `.env.test`) is in
  [docs/integration-testing.md](docs/integration-testing.md); this is *the* reason the suite is
  real-bucket rather than mocked ([ADR-0019](docs/adr/0019-s3-test-strategy.md)).
- **Watch for per-file overhead in the walk/snapshot hot path — small costs mount up over
  thousands of files.** A second `lstat`/`stat`/read per file is invisible on one file and
  dominant on tens of thousands. The fix is to **thread the data you already have through the
  pipeline** (the `Dirent` already carries the file type; `prop` already takes one `stat`) —
  *not* a hidden module-level cache, which is invisible to the type checker, makes a pure
  function order-dependent, and silently rots into dead code (worked example: `prop.mjs`'s
  `_lstatCache` went dead once the pipeline settled to one `prop` per file — keep the saving
  *in the interface*, where the compiler can see it rot).
- **Memory/async stance (user-stated, 2026-07-10): assume a modern user PC, not a little
  headless VM.** Don't needlessly use memory, but don't be shy about using it either. And no
  sync-purity dogma for engine functions — async interfaces are welcome, mainly because
  progress reporting can hook in later (worked example: `planUpload` accepts the LIST as an
  async iterable rather than forcing a materialized Set).
- **`realpathSync.native` is the one reliable path canonicalizer — capture it once, at the
  low-frequency edges, then trust the fast string functions.** Node's pure-string path
  functions (`resolve`/`normalize`/`join`) can return subtly *different* strings for the same
  real file (case, `..` handling, symlinks), which silently breaks anything that **keys on the
  path** — snapshot lookups are path-keyed, so a mismatched key reads as a different file.
  `realpathSync.native` is the sure-fire truly-normalized form — **but it hits the filesystem
  and is slow: one call is fine, a call *per file in a loop* is deadly.** So realpath at the
  handful of capture points (a set's member dirs in `setup`'s `resolveDirectories`; the walk
  root in `walk.mjs` — once per root, never per entry), and once the canonical path is captured
  there, rely on the fast pure-string `path` functions downstream (e.g. the compare renderer
  shortens already-canonical paths with plain `relative`/`split` — it must **not** reintroduce a
  per-path `realpathSync`).
- **Two UX references govern user-facing design — treat them as the bibles.** Command *shape*
  (commands, flags vs. positional args, naming, output) follows the **Command Line Interface
  Guidelines** (clig.dev), distilled into the **`cli-design` skill**
  ([.claude/skills/cli-design/](.claude/skills/cli-design/)) — consult it for any command-shape
  decision; error/warning *wording* follows **Nielsen's usability heuristic #9** (the next
  bullet, [ADR-0030](docs/adr/0030-error-message-guidelines.md)). Same shape-vs-wording split as
  the two bullets that follow this one. The most recent shape decision worked under clig.dev is
  [ADR-0036](docs/adr/0036-setup-mutates-list-shows-drop-sets.md) (the `setup`/`list` surface).
  Both are checked in review, not by a linter ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **User-facing error/warning text follows ADR-0030's error-message standard (Nielsen's usability
  heuristic #9)** ([ADR-0030](docs/adr/0030-error-message-guidelines.md)): plain-language headline framed by
  the user's *goal* (no codes/jargon up front — env-var names, paths and keys go in a
  parenthetical or follow-up line), polite (describe, don't blame), and *constructive* (give
  the exact fix, copy-pasteable command on its own indented line — mirror `collisionError` in
  [src/commands/setup.mjs](src/commands/setup.mjs)). Internal invariants and programmer errors
  (a malformed `s3://` URI, a broken assumption) are *out of scope* — keep those terse and
  factual; they signal bugs, not user guidance. Checked in review, not by a linter
  ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **Shape our own errors by the taxonomy in [src/lib/error.mjs](src/lib/error.mjs)'s header**
  (this is *shape*; ADR-0030 above is *wording*). Two orthogonal questions decide it: (1) is
  the error caught by *type* to branch behaviour? → an Error *subclass* (`ParseArgsError`,
  which `isUsageError` `instanceof`-checks), else a plain `Error`; (2) for plain errors, is the
  message heavy/actionable/reused? → a named factory (`noCredentialsError` /
  `expiredCredentialsError` in `auth.mjs`, `collisionError` in `setup.mjs`), else an inline
  `throw new Error`. Foreign SDK/Node errors we can't subclass are matched by `code`/`name`
  instead. A subclass nobody catches by type is unused identity, against convention #7 — don't
  reach for one until a catch site actually reads it.
- **A command whose result already _is_ its final output text returns that string and points
  `render` at the shared `renderText` passthrough — don't invent structured data or a bespoke
  renderer for output that is inherently prose** (a recipe, a confirmation/status line). The
  identity renderer is the honest degenerate case of the render layer
  ([ADR-0043](docs/adr/0043-human-first-output.md)); with `render` now required, forcing a
  structured `--json` shape onto prose just to satisfy the pattern is the over-engineering #7
  forbids. (Worked example: `aws`'s onboarding recipe and `provider`'s status/confirmation lines,
  in [src/commands/aws.mjs](src/commands/aws.mjs) / [src/commands/provider.mjs](src/commands/provider.mjs).)

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
  under `src/` (the old `src/_poc/` directory is retired) and never under `test/` (see the
  test-layout convention above).
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
  not a hard boundary: a `lib/` module importing a `commands/` one would be fine if a real
  need arose, though today none does (the lone such import, `snapshot-file.mjs` → `commands/prop.mjs`,
  was retired when its only user, the `writeSnapshot` test helper, moved to `test/helpers/`).
  Grouping is by **subsystem/cohesion, not abstract layer**: no `lib/util/` junk-drawer. If
  `lib/` ever grows enough to cleave, extract a directory named for the subsystem and leave the
  generic leaves (`format`, `read-lines`, `error`) flat at the root.
- **The S3/remote engine.** The remote layout and its module ownership
  (`objects/<sha256>` → [src/lib/objects.mjs](src/lib/objects.mjs);
  `snapshots/<namespace>/` → [src/lib/remote.mjs](src/lib/remote.mjs); the generic SDK
  boundary → `src/lib/s3.mjs`) follow from
  [ADR-0013](docs/adr/0013-one-repository-one-bucket.md) and
  [ADR-0014](docs/adr/0014-backup-sets.md). The atomic, integrity-checked *landing* of a
  downloaded stream to local disk is **not** an SDK concern, so it sits outside that boundary in
  [src/lib/atomic-file.mjs](src/lib/atomic-file.mjs) (`writeFileAtomic`) — where design #1's hash
  check is enforced on the way in. Auth splits in two: *credential resolution* is
  `resolveCredentials` in [src/lib/auth.mjs](src/lib/auth.mjs) (see
  [ADR-0015](docs/adr/0015-standard-aws-credential-chain.md)), and *env-file layering* is
  `loadEnv`/`loadSet` in [src/lib/env.mjs](src/lib/env.mjs) — the **user** layer loaded once at
  the entry point, the **set** layer added by the `loadSet` door each set command routes through
  ([ADR-0022](docs/adr/0022-prepare-remote-set-front-door.md)) — both specified in
  [docs/design/auth.md](docs/design/auth.md).
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

- **Backup/restore/admin all built — retention policy + one doc note remain** — the
  five-slice plan in [docs/design/backup.md](docs/design/backup.md) is **complete**: slices 1–4
  plus slice-5's `verify`/`delete`/`cleanup` are built (status detail there, not re-narrated
  here). Still open from slice 5: **retention-policy automation** (keep-last/daily/weekly/monthly
  on top of `delete`/`cleanup` — deferred until real usage shows the shapes) and the
  **versioning/ransomware user-doc note**. (The **everyday-vs-elevated delete-rights** question
  is **resolved, don't re-litigate**: the everyday identity keeping `s3:DeleteObject` is the
  settled model — [ADR-0033](docs/adr/0033-bucket-onboarding-security-model.md)'s
  *soft-vs-permanent* seam (delete-marker, no `DeleteObjectVersion`) is the blast-radius
  boundary, not delete-vs-no-delete — so `bucketPolicy` needs no everyday/elevated split and
  `delete` rightly runs under per-set creds; the old backup.md "everyday should lack delete"
  prose was stale and is now aligned.) (The
  `upload`/change-detection reshape the old `--if-modified-from` TODO belonged to is **done** —
  ADR-0044/0045: `upload` is unified and set-scoped, `backup` = `snapshot()` + `upload()` with a
  `--since` baseline, and `backup --snapshot` retired; the "load-bearing for backup" premise was
  wrong. A `node:sqlite` hash cache was spiked for it and **rejected** — the in-memory `Map`
  wins; see [scripts/sqlite-hash-cache-spike.mjs](scripts/sqlite-hash-cache-spike.mjs).) `compare`
  is local-only ([ADR-0027](docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)); `setup
  --inherit` instead pulls a set's remote manifests down so a fresh machine's
  `compare`/`list`/`restore` work on full history.
- **Local-config/remote-structure model** (ADR-0024/0025/0026, fully landed; detail in
  `docs/design/backup.md`): the set **name** is the whole identity (no `user@machine`), the
  remote namespace is `snapshots/<set>/`, and `setup` requires `--bucket` and claims the name
  "first person wins" via the remote `sets/<set>/` marker
  ([src/lib/set-marker.mjs](src/lib/set-marker.mjs)), with `--inherit` for machine succession.
- **Native-executable packaging works and is validated on real runners** (the full matrix
  has run for real: binaries build, smoke-test, archive; macOS ad-hoc sign, npm publish,
  and GitHub Release all succeed). Since the `createRequire` regression, ci.yml's `exe
  smoke` job also boots the Linux binary + bundle on **every PR**, so artifact-only
  breakage no longer waits for a tag (see [ADR-0016](docs/adr/0016-native-executable-build.md)).
  Open items:
  - **macOS notarization — deliberately skipped (costs money).** Ad-hoc signing is enough
    to _run_; Gatekeeper-clean distribution would need a paid Apple Developer ID. The
    README documents the `xattr` workaround for browser downloads.
  - **macOS is labelled `macos`, not `darwin`,** in release-asset + `sea/` config names
    (friendlier on a download); `test/e2e.test.mjs` maps `process.platform` to the label.
  - **Only `macos-arm64` ships** — Intel Macs are legacy; those users have `npm` or the
    portable bundle. Adding it later is one `sea/` config + one `macos-13` matrix row.
  - **Drop esbuild** if Node ever bundles multi-file SEA inputs natively.
- **"Latest snapshot uncompressed"** currently only happens behind `S3CAB_DEBUG`. Decide
  whether keeping the latest snapshot uncompressed for transparency is a real feature.
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
- **Stable doc URLs — resolved: commit to GitHub paths (no website pre-1.0).** Help topics,
  the help footer, and the `compare`/`aws`/`auth` command descriptions print GitHub URLs (the
  placement doctrine's "link to the fuller online guide"), and a shipped binary freezes them
  forever. Decision: the `github.com/allens/s3cab/blob/main/guide/*.md` file paths are the
  permanent form — no website is stood up before 1.0. The stability commitment this buys is: **don't
  rename `guide/*.md` files or move the repo slug** without updating the printed URLs. One outlier
  remains as a nicety, not a blocker: the `auth` topic's footer points at the `#authentication`
  README *anchor* (fragile if the heading is reworded, and mildly circular since that README
  section defers back to `s3cab help auth`) — fold a fix into the next auth-doc touch.
- **Re-measure the slurp/stream hash boundary** in [src/commands/prop.mjs](src/commands/prop.mjs)
  during any future perf/test pass. Files ≥ 5 MB stream through a hash; smaller ones slurp
  via one-shot `crypto.hash`. The 5 MB cutoff was chosen empirically on real data but
  predates the one-shot-hash path, so the optimum may have moved. (`streamHash`'s old
  explicit 8 MB buffer was already dropped as a relic — reads now use Node's default
  `highWaterMark`, with no measured loss for SHA-256.)
