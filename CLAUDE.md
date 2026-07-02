# CLAUDE.md

Working rules and orientation for **s3cab**, for contributors and AI assistants. This file
documents how to *work* in the codebase. The knowledge it used to lump together now lives in
purpose-built homes — see the map below.

## Where knowledge lives

| What | Where | Notes |
| --- | --- | --- |
| **Domain vocabulary** (the ubiquitous language) | [CONTEXT.md](CONTEXT.md) | Glossary only — canonical term + definition + `_Avoid_` synonyms. |
| **Architecture / design decisions** (the *why*, "don't re-litigate") | [docs/adr/](docs/adr/) | One numbered ADR per decision; [docs/adr/README.md](docs/adr/README.md) indexes them. |
| **Subsystem designs** | [docs/design/](docs/design/) | `auth.md`, `backup.md`, `testing.md`, `s3-provider-compatibility.md`. (Renamed from `specs/` 2026-07-02: "spec" is reserved for the format spec below.) |
| **Other contributor how-tos** | [docs/](docs/) | Beside `docs/adr/` — e.g. [docs/integration-testing.md](docs/integration-testing.md) (setting up the gated S3 suite), [docs/releasing.md](docs/releasing.md) (checking + cutting a release). Doesn't ship. |
| **User-facing docs** | [README.md](README.md), [guide/](guide/) | What it is, install/usage, user reference (`guide/exclude.md`, `guide/compare.md`) — and **the format spec**, [guide/format.md](guide/format.md): the stored-format recovery contract, the no-lock-in pillar ([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)) as a document. `guide/` ships in the npm tarball, so the spec travels inside every install. |
| **Ideas we might do** (rough → detailed; deleted when done/abandoned) | [proposals/](proposals/) | A bucket of provisional ideas — important stuff down to pipe dreams, *not* of record. Grouped into theme-based "epic" files (`output-ux.md`, `performance.md`, …), with [misc.md](proposals/misc.md) for the unsorted and [bugs.md](proposals/bugs.md) the interim defect tracker (→ GitHub Issues, gone by release). See [proposals/README.md](proposals/README.md). |
| **How to work here** (AI/contributor rules) | this file | Working conventions, coding conventions, architecture orientation, known gaps. |

The top-level split is by **audience**: everything contributor-facing and internal lives
under [docs/](docs/) — `adr/` = pinned *decisions* ("don't re-litigate"), `design/` =
subsystem *designs* (the fuller *what/how*, which evolves), and the loose `docs/*.md` =
*how-tos* (task recipes) — while user-facing prose is README + `guide/`. A design doc and an
ADR differ in *kind* (a design vs. a single pinned decision), which is why they are sibling
directories; both are contributor docs, which is why both sit under `docs/` rather than one
floating at the root. **The word "spec" is reserved** (2026-07-02) for the *format spec*,
[guide/format.md](guide/format.md) — the recovery-grade contract for everything s3cab stores.
It lives on the *user* side because the stored format is a user-facing promise
([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)): recovery must be possible from the
files alone, and writing the contract down both eases that and keeps the project honest — a
human-readable mirror of the true format. Evolving design docs are *designs*, not specs. ([CONTEXT.md](CONTEXT.md) vocabulary stays at the root as a
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
   redesign can land in an ADR (`Status: proposed`), CONTEXT.md, or a spec banner, as long as
   a reader can't mistake it for live behaviour. (Earlier this rule said "never aspirational
   or stale"; that was too strict for a pre-1.0 project that redesigns in the open — softened
   2026-06-20.) Flag drift you notice — stale comments, `package.json` paths to non-existent
   files, etc.; the "Known gaps & cleanup items" section is the running list.
2. **Each doc carries only what its home is for, and only what is _not_ trivially knowable
   from the code.** Don't restate `package.json` scripts or build/test/lint commands. The
   split: vocabulary → CONTEXT.md; the non-obvious *why* of a decision → an ADR; fuller
   design → docs/design/; the user *contract* → README/guide/; how to work in the repo → this file.
   Developer setup, if wanted, belongs in the README, not here.

**Within the user-facing half, placement is decided by a doctrine (settled 2026-06):**
the website/repo docs (README, `guide/` — eventually a proper website) carry everything
someone needs *before trying s3cab* plus the advanced depth (e.g. the repository/snapshot-file
format); the built-in CLI help topics (`s3cab help <topic>`, `helpTopics` in
`src/help.mjs`) carry only what a user needs *mid-task in a terminal*. The placement test:
*"would someone need this mid-task, without reaching for a browser?"* Exclude-pattern
rules pass (you're editing `exclude.txt` in a shell); the repository format fails (reading
it is a sit-down activity — and per [ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)
the format is self-evident from the stored files themselves; its docs just save the recoverer
time, so online-only is fine). Each help topic ends with a link to its fuller online guide;
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
   refactoring: when restructuring genuinely simplifies, do it even if sizable. **Version gates
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
   - **We deliberately do _not_ share `node_modules`.** A fresh worktree is gitignored-empty,
     so code work runs `npm install` first (tens of seconds from the warm cache; doc-only
     changes skip it). A junctioned/shared `node_modules` was **rejected**: it re-introduces a
     shared mutable resource, and a fallback `rm -rf <worktree>` can recurse *through* the
     junction and delete the **main** checkout's `node_modules`. The seconds saved aren't worth
     the footgun (#7); a task that changes dependencies does its own install.
   - **Mechanics.** Worktrees live where the harness puts them — **`.claude/worktrees/<name>`**,
     nested in the repo (`EnterWorktree`/`ExitWorktree` in-session, or `isolation: "worktree"`
     when spawning an agent). The one downside of a nested tree — the main checkout's tools
     wandering in — is neutralised by **excluding `.claude/worktrees/`** in `.gitignore`, the
     `.vscode` `search.exclude`/`files.watcherExclude`, and eslint `ignores`.
   - **Accept the harness's branch name** — `EnterWorktree(name: "feat/x")` creates branch
     `worktree-feat+x`. Don't rename it: that orphans it from `ExitWorktree(remove)`'s
     auto-cleanup. The PR *title* is clean regardless and the branch is deleted on merge.
   - **Teardown is `ExitWorktree(remove)`** — it deletes the worktree directory *and* its
     branch (a new worktree branches fresh from `origin/main`, so a stale local `main` blocks
     nothing — a bare `git fetch` is enough when you want refreshed refs). **Review the work on
     the GitHub PR; don't open the worktree directory in the IDE** — an open file there gives
     Windows a lock that can block removal; if it's locked, close it and retry.
   - **Run bare commands — don't prepend `cd`, and don't use `git -C <cwd>`.** `EnterWorktree`
     sets the session cwd to the worktree and the Bash tool persists it, so bare `git …` /
     `npm test …` already run there. A leading `cd <path> && …` *and* `git -C <the-cwd-path> …`
     both defeat the path-free allowlist (`Bash(git commit *)` never matches a `git -C …`
     command), so they re-prompt on every call — and `git -C …` *also* slips past the path-free
     **deny** guards (`Bash(git reset --hard *)` won't match it), bypassing the
     destructive-command blocks. Use `git -C <path>` *only* to act on a genuinely different
     checkout; when cwd is already the target, run bare.
10. **Request a Copilot code review once, at PR create** — pass `--reviewer "@copilot"` to
    `gh pr create` (so the request rides inside the single "commit, create pr" step, no manual
    follow-up). This create-time request is the **only** one you make: Copilot does **not**
    auto-review on push, so **never** re-request it after pushing — any further review passes are
    the user's to trigger manually. The sole fallback use of `gh pr edit --add-reviewer "@copilot"`
    is when the create flag failed to attach the bot at all. The `@copilot` special value needs a recent `gh` (the
    [March 2026 CLI feature](https://github.blog/changelog/2026-03-11-request-copilot-code-review-from-github-cli/));
    it replaced a hand-rolled GraphQL hook once the CLI gained native support. It's the
    complement to the `/review` skill and the coverage-by-review rule #8, driven by
    [.github/copilot-instructions.md](.github/copilot-instructions.md). Copilot review must be
    enabled on the repo; if it isn't (or the PR is on a fork), the request silently no-ops — so
    **verify the bot actually landed**, since these CLI paths have historically returned success
    while attaching nobody. Don't verify with `gh pr view --json reviewRequests` — it does *not*
    surface the Copilot bot (prints `[]` even when attached); confirm via the web Reviewers panel
    or the GraphQL `reviewRequests` query (`requestedReviewer ... on Bot { login }` →
    `copilot-pull-request-reviewer`). When the review lands, bring its comments back to the user
    to discuss (#1) — don't auto-action them.
11. **The permission-prompt fix is settled — do NOT re-litigate it.** After ~20 sessions of
    constant Bash prompts (every prior attempt failed by working the wrong layer), the fix
    (applied 2026-06-27) is the documented "run all Bash without prompts except a few blocked"
    pattern: a **bare `"Bash"` entry in `permissions.allow`** plus **`"defaultMode":
    "acceptEdits"`** — both nested **under `permissions`**, not at the file's top level. This is
    safe, **not** `bypassPermissions`: the `deny` list and the PreToolUse hooks still guard
    everything (deny-first precedence runs before allow) — `block-redundant-git-c.sh` blocks the
    `git -C <cwd>` deny-bypass (#9), and `block-destructive-rm.sh` catches recursive/force `rm`
    in any flag ordering. It lives in the committed
    [.claude/settings.json](.claude/settings.json) so **every machine inherits it**. **The
    behavioral rule: never "solve" recurring prompts by adding specific allow entries or
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
  through that one export (`backup` calls `snapshot()`; `upload` and `snapshot` call `prop()`);
  what the rule bans is reaching past the command for a co-resident helper. A symbol used only
  inside its own command file just stops being `export`ed (it doesn't move to `lib/` without a
  second caller — #7); cross-module types travel by `@typedef`/`@import`, not `export`. Enforced
  by the `local/one-export-per-command` ESLint rule in [eslint.config.js](eslint.config.js).
- **Cross-module types use the JSDoc `@import` tag, not inline `import("…").Type`.** One
  `/** @import { Foo } from "./bar.mjs" */` near the top (as `remote.mjs` does for
  `SnapshotEntries`), then bare `{Foo}` in annotations — cleaner than repeating the inline
  form at each use, and the modern TS-supported style (TS 5.5+). An unused `@import` name is
  flagged by the type check, so they don't rot.
- **Import order is author-managed; no tool enforces or rewrites it.** A
  `source.organizeImports`-on-save action was removed from `.vscode/settings.json` (2026-06):
  it silently reordered/removed imports on save, but only for contributors who had the VS
  Code setting — an unenforced asymmetry that churned diffs. Dead imports are already caught
  by `no-unused-vars` (in `js/recommended`) in CI; the only thing organizeImports added was
  *sorting*, which isn't worth an ESLint import-ordering plugin (cosmetic, against
  [ADR-0006](docs/adr/0006-minimal-code.md) / convention #7).
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
- **The whole-project type check (`tsc -p jsconfig.json`) is kept clean** and runnable via
  the `typecheck` script, and covers `scripts/` too (it was once excluded as untyped
  scratch, but excluded files just get squiggles from VS Code's inferred project instead —
  cheaper to keep them typed; they need no extra deps, only JSDoc). One non-obvious bit
  makes the check possible: `jsconfig.json` maps `events`/`punycode`/`string_decoder` back
  to the builtin type declarations — transitive deps install npm shims of those Node
  builtins, which would otherwise shadow them at type-resolution time and drag their
  untyped CJS internals into the check (see the comment in jsconfig.json).
- **Test layout convention:** unit tests are **co-located** with their source as
  `*.test.mjs`; [test/](test/) holds cross-cutting tests (`e2e.test.mjs`), shared
  `fixtures/`, and shared `helpers/`. See [test/README.md](test/README.md). The runner is
  pointed at an **explicit glob** — `node --test --experimental-test-module-mocks
  "src/**/*.test.mjs" "test/**/*.test.mjs"` (the `test` script; the flag is for
  `objects.test.mjs`'s `mock.module` — see
  [ADR-0019](docs/adr/0019-s3-test-strategy.md)) — *not* default discovery, which would also
  run every `.mjs` under `test/`. That's what lets `test/helpers/` hold shared, importable
  helpers (e.g. [test/helpers/temp-home.mjs](test/helpers/temp-home.mjs)) without them
  executing as phantom empty tests. So a cross-cutting test helper goes in `test/helpers/`;
  scratch still goes in [scripts/](scripts/).
- **`--test-isolation=none` is slower here, not faster — don't re-try it for speed**
  (measured 2026-06-13: ~1.8× slower, 12s vs 7s). Node's default per-file isolation runs
  test files across worker processes in parallel; collapsing to a single process loses
  that. The suite _is_ in-process-safe (no cross-file leakage), so the flag is fine for
  debugging shared state — just not a speedup.
- **Watch for per-file overhead in the walk/snapshot hot path — small costs mount up over
  thousands of files.** A second `lstat`/`stat`/read on each file is invisible on one file and
  dominant on tens of thousands. The fix is to **thread the data you already have through the
  pipeline** — the `Dirent` from `readdirSync(…, { withFileTypes: true })` already carries the
  file type, and `prop` already takes one `stat` it reads `isFile`/`size`/`mtime` off — *not* a
  hidden module-level cache. A cache keyed on "the last path" is invisible to the type checker,
  makes a pure function order-dependent, and silently rots into dead code the day the redundant
  call it guarded goes away. (Worked example: `prop.mjs`'s `_lstatCache`, added when multiple
  `prop` calls hit each file, became dead once the pipeline settled to one `prop` per file —
  removed after a static-call-graph check. Keep the saving *in the interface*, where the
  compiler can see it rot.)
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

---

## Agent skills

Per-repo configuration for the engineering skills (from
[mattpocock/skills](https://github.com/mattpocock/skills), installed **globally** — see the
skills blockquote under "Where knowledge lives", not vendored here). Scaffolded once via the
`setup-matt-pocock-skills` skill; keep the global install current with
`npx skills@latest update --global`.

### Issue tracker

GitHub Issues via the `gh` CLI (repo `allens/s3cab`); external PRs are **not** a triage
surface. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

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
  [ADR-0014](docs/adr/0014-backup-sets.md). Auth splits in two: *credential resolution* is
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

- **`verify` flow not built yet** — design + the five-slice implementation plan are settled in
  [docs/design/backup.md](docs/design/backup.md) (read it for the slice detail; not re-narrated
  here). **Slices 1–4 are built:** the set store ([src/lib/sets.mjs](src/lib/sets.mjs)), the
  local engine on sets (`snapshot`/`list`/`compare`/`tree` over `[<set>]`, one snapshot into
  `~/.s3cab/sets/<set>/snapshots/`), the cloud half ([src/lib/remote.mjs](src/lib/remote.mjs)
  with `backup`/`status`/`list --remote`), and the `restore` / `restore --output` path.
  Remaining: `verify` is still an inline registry stub — promote it to its own `src/commands/`
  file as it gains a body (rest of slice 5); and `upload` still owes its **`--if-modified-from
  <snapshot>` skip** — the snapshot-aware "only upload what changed" *hashing* optimization
  (snapshot-time machinery via `prop`'s `lookup`, distinct from `backup`'s upload-set diff; see
  the TODO in [src/commands/upload.mjs](src/commands/upload.mjs); load-bearing, don't lose it). A
  `node:sqlite`-backed cache was spiked for this and **rejected** — the in-memory `Map` from the
  previous snapshot wins on build and lookup; see
  [scripts/sqlite-hash-cache-spike.mjs](scripts/sqlite-hash-cache-spike.mjs). `compare` is
  local-only ([ADR-0027](docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)); `setup
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
  job, alongside lint/format): `npm run typecheck` plus a `node --test
  --experimental-test-coverage` run (`test:coverage:report`) that **prints** the coverage
  table as advisory debug output — it no longer enforces thresholds (see
  [ADR-0020](docs/adr/0020-coverage-review-not-gate.md)). **Footnote on why demoting cost
  nothing:** the prior threshold gate was a silent no-op — `node --test` only collects
  coverage when `--experimental-test-coverage` precedes the glob positionals, but the
  `npm run test -- …` pattern appended it *after*, so the gate (and the `test:coverage` lcov
  script) ran the suite, collected **zero** coverage, and exited 0 against the thresholds.
  Both scripts were rebuilt standalone (flags first). Don't reintroduce the
  `npm run test -- --experimental-test-coverage` shape — it measures nothing.
- **Revisit plain-JS-vs-TypeScript** now that Node runs TS natively (see
  [ADR-0007](docs/adr/0007-plain-js-via-jsdoc.md)).
- **Concurrency guard** for snapshots is only the temp-file check (its existence doubles
  as a crude in-progress lock); a proper lock file is a `TODO` in
  [src/commands/snapshot.mjs](src/commands/snapshot.mjs).
- **Define behaviour** for paths containing tabs/newlines in the TSV (see
  [ADR-0004](docs/adr/0004-tsv-snapshot-manifests.md)).
- **Stable doc URLs before release.** Help topics, the help footer, and the `compare`
  command description print GitHub URLs (the placement doctrine's "link to the fuller
  online guide"); a shipped binary freezes the URLs it prints forever. Before release, stand up the planned proper website (or
  commit to permanent GitHub paths) and point the help text at stable addresses.
- **Re-measure the slurp/stream hash boundary** in [src/commands/prop.mjs](src/commands/prop.mjs)
  during any future perf/test pass. Files ≥ 5 MB stream through a hash; smaller ones slurp
  via one-shot `crypto.hash`. The 5 MB cutoff was chosen empirically on real data but
  predates the one-shot-hash path, so the optimum may have moved. (`streamHash`'s old
  explicit 8 MB buffer was already dropped as a relic — reads now use Node's default
  `highWaterMark`, with no measured loss for SHA-256.)
