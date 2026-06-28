# CLAUDE.md

Working rules and orientation for **s3cab**, for contributors and AI assistants. This file
documents how to *work* in the codebase. The knowledge it used to lump together now lives in
purpose-built homes — see the map below.

## Where knowledge lives

| What | Where | Notes |
| --- | --- | --- |
| **Domain vocabulary** (the ubiquitous language) | [CONTEXT.md](CONTEXT.md) | Glossary only — canonical term + definition + `_Avoid_` synonyms. |
| **Architecture / design decisions** (the *why*, "don't re-litigate") | [docs/adr/](docs/adr/) | One numbered ADR per decision; [docs/adr/README.md](docs/adr/README.md) indexes them. |
| **Fuller designs & specs** | [docs/specs/](docs/specs/) | `auth.md`, `backup.md`, `testing.md`, `s3-provider-compatibility.md`. |
| **Other contributor how-tos** | [docs/](docs/) | Beside `docs/adr/` — e.g. [docs/integration-testing.md](docs/integration-testing.md) (setting up the gated S3 suite), [docs/releasing.md](docs/releasing.md) (checking + cutting a release). Doesn't ship. |
| **User-facing docs** | [README.md](README.md), [guide/](guide/) | What it is, install/usage, user reference (`guide/exclude.md`, `guide/compare.md`). `guide/` ships in the npm tarball. |
| **Ideas we might do** (rough → detailed; deleted when done/abandoned) | [proposals/](proposals/) | A bucket of provisional ideas — important stuff down to pipe dreams, *not* of record. Grouped into theme-based "epic" files (`output-ux.md`, `performance.md`, …), with [misc.md](proposals/misc.md) for the unsorted and [bugs.md](proposals/bugs.md) the interim defect tracker (→ GitHub Issues, gone by release). See [proposals/README.md](proposals/README.md). |
| **How to work here** (AI/contributor rules) | this file | Working conventions, coding conventions, architecture orientation, known gaps. |

The top-level split is by **audience**: everything contributor-facing and internal lives
under [docs/](docs/) — `adr/` = pinned *decisions* ("don't re-litigate"), `specs/` =
subsystem *designs* (the fuller *what/how*, which evolves), and the loose `docs/*.md` =
*how-tos* (task recipes) — while user-facing prose is README + `guide/`. A spec and an ADR
differ in *kind* (a design vs. a single pinned decision), which is why they are sibling
folders; both are contributor docs, which is why both sit under `docs/` rather than one
floating at the root. ([CONTEXT.md](CONTEXT.md) vocabulary stays at the root as a
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
   design → docs/specs/; the user *contract* → README/guide/; how to work in the repo → this file.
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

1. **Never `git commit`/`push` without an explicit go-ahead in that same message.** Do the
   work, show what changed, then wait to be told "commit" / "pr". A go-ahead is per-request,
   not standing — don't carry it forward to later changes.
2. **Multiple sessions may run on this repo at once.** Stage only the files _you_ changed
   (`git add <path>`, never `git add -A`/`.`), so you don't sweep up another session's
   in-flight work. (With #13 — a worktree per writing session, default-on — this is the
   belt-and-suspenders fallback for the rare main-tree edit, no longer the primary guard.)
3. **[.claude/settings.json](.claude/settings.json) is a shared, committed project file**
   (the team-wide permission allow/deny lists), not personal — `settings.local.json` is the
   gitignored personal override. **Committing `.claude/settings.json` changes is
   pre-authorised — it needs no per-request go-ahead, and may go straight to `main`** (the
   user granted this standing 2026-06-27, a deliberate exception to rule 1 *for this file
   only*: permission/config tweaks are low-risk housekeeping they were tired of approving).
   Every other commit still follows rule 1. Validate via the `update-config` skill first, and
   keep settings.json as its own `chore:` commit so it reads cleanly; when a feature
   commit/PR go-ahead is given and the tree also has settings.json changes, fold them into
   that PR rather than setting them aside as unrelated.
4. **After non-trivial work, update the docs** so what you learned is shared at the project
   level (this section exists because that wasn't being done for these very rules). Put it in
   the right home (see the map above): a design decision → an ADR; vocabulary → CONTEXT.md; a
   working/coding rule → this file. A cross-machine rule belongs in source, never only in
   local memory.
5. **Refactors and minor chores may ride along with a feature** — the user is relaxed about
   this; a one-feature commit/PR carrying a small refactor, a settings.json tweak (point 3),
   a `proposals/` addition (any provisional idea the work surfaces — fold it into the PR you're
   on rather than spinning a separate one), or a doc fix needn't be split into its own PR. Don't
   over-engineer separation. (Still prefer a _separate commit_ per logical change within the PR,
   as the `chore:` commits do.)
6. **Don't delete commented-out code or TODO notes as "dead code" without asking.** They may
   be the user's parked reminders of an unresolved question, not cruft. Flag them as
   candidates instead — then analyse and resolve on the user's say-so, recording the rationale
   so the decision isn't re-litigated. (Two worked examples: the `objectPaths.delete` note in
   `compare.mjs`, resolved in the 2026-06 compare pass; and the commented-out SIGINT handler in
   `src/s3cab.mjs`, analysed and removed 2026-06-26 once its rationale was understood.)
7. **Always use the Bash tool, not PowerShell.** Bash is available even on Windows and the
   project's permission allowlist is Bash-based. The system prompt identifies PowerShell as
   the interactive shell — ignore that signal for tool selection. Reserve PowerShell only
   when a command genuinely requires it (e.g. `$env:VAR`, `Select-String`, or Windows-only
   cmdlets with no Bash equivalent).
8. **Do not over-engineer.** A standing edict from the user (2026-06-12), the process-level
   twin of [ADR-0006](docs/adr/0006-minimal-code.md): build the small thing the current need
   justifies, and generalize only when the second case actually appears — the same
   later-when-needed bar as function extraction and module promotion. (Worked example:
   `isENOENT` in `src/lib/error.mjs` was added once the check had four call sites, and shaped
   as the specific predicate rather than a generic `isErrnoCode(error, code)` — no second
   error code needed it.) **This forbids _speculative_ structure, not _justified_ refactoring**
   (clarified by the user 2026-06-14): when restructuring existing code genuinely improves it
   — clearer separation, or making a real behaviour testable — don't shy off it out of
   minimalism, even a sizable refactor. Right-sizing cuts both ways: as small as the need
   allows, but as large as the need warrants. (Worked example: `clientConfig()` and
   `putObjectParams()` were extracted from `s3.mjs` so the non-AWS request-shaping gating
   became unit-testable without a live client — see [src/lib/s3.test.mjs](src/lib/s3.test.mjs).)
   **Version gates how bold to be (recorded 2026-06-15):** while the project is **pre-1.0**
   (`package.json` major version `0`), you have **free rein** for large, correct refactors —
   favour getting the design *right* over minimizing churn or preserving back-compat; there
   is no deadline, the goal is to get the project as close to perfect as possible, so do the
   massive refactor when it is the right thing. **Once it ships 1.0 this reverses:** breaking
   changes and sweeping refactors then need real care, justification, and a migration story.
   Check the major version first: `0` → bold; `≥ 1` → conservative.
9. **"Work through one by one" is a strict per-step protocol.** When the user says to work
   through a list one by one: (a) propose the step and ask any questions; (b) once the
   proposal is agreed, make the code changes and present the diff for review —
   *uncommitted*; (c) move to the next step only when the user has agreed to. Never commit
   a step sight-unseen, never start the next step unasked, and don't batch the per-step
   decisions into one up-front question round. The user will say explicitly when firing
   ahead without asking is wanted. (Recorded 2026-06-12 after three escalating corrections
   in one session.) **The default is to commit each step once approved** — present it
   uncommitted for review (b), then commit that step when the user agrees to move on (c),
   rather than accumulating every step uncommitted to the end. (Added 2026-06-13 after a
   slice was built end-to-end before the first commit, which then couldn't be split into
   per-step commits without interactive hunk-staging.) **A batch go-ahead ("execute", "go
   ahead", "do it") on a multi-slice plan authorizes _starting_ — it does not waive the
   per-slice pause.** After each slice, present its diff and stop for review before the next;
   only run straight through when the user says so explicitly ("don't pause", "do them all
   without stopping"). (Recorded 2026-06-19 after I read "execute and wire lint rule" as
   licence to land all six slices without pausing.)
10. **"Review the PR comments" means critically review them _with the user_ and give
    suggestions — not make changes.** When the user asks you to look at review comments on a
    PR, **assess each one and state your opinion** (valid / not / nuance) with a suggested
    action, then **stop and let the user decide** — do not automatically edit code or offer
    to push. Apply changes only once the user says which comments to action. **This holds
    for _every_ wave of comments, including a re-review triggered by a push: each new batch
    returns to discuss-first — give the rationale and suggestions, then wait. A prior "fix
    and comment and resolve" go-ahead is per-batch and never carries forward** to the next
    wave. (Recorded 2026-06-13 after I jumped from "look at the comments" straight to editing
    files; re-emphasised 2026-06-14 after I treated one batch's "fix" go-ahead as standing
    and auto-actioned two further review rounds without first reviewing them with the user.)
11. **Step-by-step feature work lands on a feature branch / PR, never straight on `main`.**
    The per-step commits of a multi-step feature (convention #9) belong on a `feat/…` branch
    that becomes one PR — `main` stays at `origin/main` so the feature merges *through* the
    PR. Branch before the first step's commit (or move the commits onto a branch and reset
    `main` back if you started on it). (Recorded 2026-06-14 after committing the restore
    slice's first four steps onto local `main` before the user asked for it to be a PR.)
12. **Test coverage is judged by review, not a percentage gate**
    ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)). Good, *asserting* tests for new
    or changed behaviour are a per-PR obligation, checked by **reading the diff** — the
    `/review` skill's Standards axis, and Copilot code review via
    [.github/copilot-instructions.md](.github/copilot-instructions.md) — not by a CI
    threshold. When you add or change behaviour, add a test that makes a real assertion about
    the *result*, not one that merely executes the line.
13. **Every session that will _write_ works in its own git worktree — default-on, no size
    threshold.** Multiple sessions share *one* main working tree, so one session's uncommitted
    edits are visible to (and confuse) the others; a per-session worktree removes that hazard
    entirely. So **branch a worktree before the first edit of any change you intend to commit,
    however small.** The old "trivial single-file edits stay in the main tree" carve-out is
    **dropped** — it was the very hole that let one session's "trivial" edit dirty the tree
    another session was working in. The only thing that stays in the main tree is **pure
    read-only / Q&A work** — there is nothing to isolate when you are not writing. (Reversed
    2026-06-21 after repeated cross-session collisions; supersedes the 2026-06-16 "only when it
    earns one" scoping, which this replaces outright.)
    - **The tax is acceptable, and we deliberately do _not_ share `node_modules`.** A fresh
      worktree is gitignored-empty, so code work runs `npm install` first — but from the warm
      npm cache that is tens of seconds, and **doc-only changes skip it entirely.** A
      junctioned/shared `node_modules` was weighed and **rejected** (2026-06-21): it
      re-introduces a shared mutable resource across sessions (the very thing the worktree
      removes) and, worse, a fallback `rm -rf <worktree>` can recurse *through* the junction and
      delete the **main** checkout's `node_modules`. Each worktree keeps its own — the seconds
      saved aren't worth the footgun (#8). If a task changes dependencies, it does its own install.
    - **Mechanics & cleanup.** Worktrees live where the harness puts them —
      **`.claude/worktrees/<name>`**, nested inside the repo (the real Claude Code convention:
      `EnterWorktree`/`ExitWorktree` in-session, or `isolation: "worktree"` when spawning an
      agent). The earlier "sibling path" rule was **dropped 2026-06-24**: the harness ignores it
      and creates worktrees under `.claude/worktrees/` regardless, so we follow the current rather
      than fight it. The one real downside of a nested tree — the main checkout's tools wandering
      in — is neutralised by **excluding `.claude/worktrees/`** in `.gitignore`, the `.vscode`
      `search.exclude`/`files.watcherExclude`, and eslint `ignores` (all added with this rule).
    - **Accept the harness's branch name** — `EnterWorktree(name: "feat/x")` creates the branch
      `worktree-feat+x` (it prefixes `worktree-` and swaps `/`→`+`). Don't rename it for a tidier
      PR branch: renaming orphans it from `ExitWorktree(remove)`'s auto-cleanup, so the branch
      lingers and needs a manual `git branch -D`. The PR *title* is clean regardless, and the
      branch is deleted on merge — the name is ephemeral cosmetics, not worth the friction.
    - **Teardown is `ExitWorktree(remove)`** — it deletes the worktree directory *and* its branch,
      so there's no manual `git worktree remove` / `git branch -D` (provided you didn't rename,
      above). Advancing local `main` afterwards is **optional**: a new worktree branches fresh from
      `origin/main` (`worktree.baseRef` default), so a stale local main blocks nothing — a bare
      `git fetch` when you want refreshed refs is enough. **Review the work on the GitHub PR; don't
      open the worktree folder in the IDE** — an open file there gives Windows a lock that can block
      removal (hit 2026-06-21); if it's locked, close it and retry.
    - **Run bare commands — don't prepend `cd` to the worktree.** `EnterWorktree` sets the session's
      working directory to the worktree and the Bash tool persists cwd between calls, so `git push …`
      / `npm test …` already run there. Prepending `cd <path> && …` is redundant *and* defeats the
      permission allowlist — a compound that leads with `cd` matches no `Bash(git …)` rule, so each
      one needlessly re-prompts (the Bash tool warns of this). Use `git -C <path> …` to act on a
      different checkout, never a `cd` compound. (Recorded 2026-06-24 after exactly this
      self-inflicted prompt.) **And only when it _is_ a different checkout:** when cwd is already
      the target repo (the main tree, or after `EnterWorktree`), run **bare `git …`**. `git -C
      <the-cwd-path>` is the same trap as the `cd` compound — it defeats the path-free **allow**
      rules (`Bash(git commit *)` etc. never match a `git -C …` command) *and* the path-free
      **deny** rules (`Bash(git reset --hard *)` won't match `git -C … reset --hard`), so it
      re-prompts on every call **and silently bypasses the destructive-command guards.** The same
      lesson generalizes: prefer the bare invocation the allowlist patterns are written against.
      (Extended 2026-06-25 after a whole session of `git -C d:/src/s3cab …` re-prompted because
      not one of the broad `git` rules matched.)
14. **When the user asks a question, answer it — do not start editing code off the back of it.**
    A question ("why is it done this way?", "wouldn't X be simpler?", "correct me if I'm
    wrong") wants an *answer*: explain the why, say whether their instinct is right, and then
    **stop and offer** to make the change — don't implement it unasked. Crucially, the user
    *agreeing with you* (or you concluding they're right) is **not** authorization to act:
    "you're right that X is better" ≠ "change it now." Wait for an explicit go-ahead, the same
    discuss-first discipline as #10 (review comments) and #9 (one-by-one). This is a strict
    instruction, not a judgement call — jumping to edits on a question needlessly burns tokens
    and pre-empts the user's decision. (Recorded 2026-06-19 after I answered two consecutive
    questions by immediately rewriting code instead of replying, the second time *while already
    being corrected* for having done it the first.)
15. **A Copilot code review is requested automatically on every PR you open.** A `PostToolUse`
    hook on `gh pr create` ([.claude/settings.json](.claude/settings.json)) runs
    [.claude/hooks/request-copilot-review.sh](.claude/hooks/request-copilot-review.sh), so the
    request rides inside the single "commit, create pr" step — no manual follow-up. It is the
    complement to the `/review` skill and the coverage-by-review rule #12, driven by
    [.github/copilot-instructions.md](.github/copilot-instructions.md). The script is best-effort:
    no PR for the branch, or Copilot review not enabled on the repo, → it logs and exits 0, never
    failing the PR flow it rides on. Run it by hand with `bash
    .claude/hooks/request-copilot-review.sh` if a request is ever missed.

    The mechanics below are retained for debugging the script. The requestable reviewer is the bot
    **`Copilot`** (REST login `Copilot`, app `copilot-pull-request-reviewer[bot]`, db id
    `175728472`, node `BOT_kgDOCnlnWA`; in a GraphQL `reviewRequests` it surfaces as Bot login
    `copilot-pull-request-reviewer`). **The working programmatic path — what the script runs — is
    the GraphQL `requestReviews` mutation with `botIds`** (confirmed 2026-06-21; it supersedes the
    unreliable REST call, and unlike the web-UI fallback an agent can actually run it). On success
    the mutation echoes `copilot-pull-request-reviewer` in its `reviewRequests` — that echo is the
    confirmation. Hard-won gotchas:
    - **It's `botIds`, not `userIds`.** The Copilot reviewer is a `Bot` node (`BOT_` prefix), so
      `userIds` rejects it (`Could not resolve to User node with the global id …`) — the dead end
      that earlier made GraphQL look impossible here. (Re-fetch the node with `gh api
      user/175728472 --jq .node_id` if `BOT_kgDOCnlnWA` ever changes.)
    - **The REST endpoint silently no-ops — don't rely on it.** `gh api
      repos/allens/s3cab/pulls/<n>/requested_reviewers -f "reviewers[]=Copilot"` (the previously
      documented path) can return `200/201` and add *nothing*: `-f "reviewers[]=…"` sends the
      *literal* key `reviewers[]` (not a `reviewers` array), and even a proper
      `{"reviewers":["Copilot"]}` body — and a **bogus** reviewer name — returned success on a
      Windows/gh-2.x setup without attaching anyone.
    - **`gh pr edit --add-reviewer` also silently no-ops** for this bot, and it isn't in
      `suggestedActors`.
    - **`gh pr view --json reviewRequests` does not surface this bot** — it can print `[]` even
      when the request landed. Trust the mutation's echo (or query `pullRequest.reviewRequests`
      via `gh api graphql`), never the HTTP status or `gh pr view`.
    - **Web-UI fallback** (Reviewers → Copilot) always works while Copilot review is enabled —
      for when you're driving by hand.
    When the review lands, bring its comments back to the user to discuss (convention #10) —
    don't auto-action them.

### Coding conventions

How to write code that looks like the rest of the codebase. (These are *style* rules; the
*decisions* about tooling — LF endings, Prettier-code-only, dependency policy — are ADRs
[0021](docs/adr/0021-lf-line-endings-prettier-code-only.md),
[0005](docs/adr/0005-builtins-over-dependencies.md),
[0018](docs/adr/0018-dependabot-not-renovate.md).)

- **Each file in `src/commands/` exports exactly one symbol — its command function.** The
  mechanical form of [ADR-0023](docs/adr/0023-porcelain-plumbing-lib-layers.md)'s
  porcelain/plumbing/`lib` layering: if anything else — a sibling command *or* a test — needs
  to import something from a command file that isn't the command, that thing is a `lib/`
  primitive that hasn't moved yet, so extract it to `lib/`. Porcelain still *composes* a
  plumbing command through that one export (`backup` calls `snapshot()`; `upload` and
  `snapshot` call `prop()`); what the rule bans is reaching past the command for a co-resident
  helper (the old `snapshot → tree.walkSet`, `* → list.listSnapshotNames`). A symbol used only
  inside its own command file just stops being `export`ed (it doesn't move to `lib/` without a
  second caller — #8); cross-module types travel by `@typedef`/`@import` — not `export` — so
  they don't count. Enforced by the `local/one-export-per-command` ESLint rule in
  [eslint.config.js](eslint.config.js) — a structural check, lighter than the
  signature-enforcement [0022](docs/adr/0022-prepare-remote-set-front-door.md)/0023 declined.
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
  [ADR-0006](docs/adr/0006-minimal-code.md) / convention #8).
- **Don't bury `await` inside a conditional or a member-access expression** — a compound
  `if`/`while` condition, a ternary, a short-circuit (`&&`/`||`), or a property/index access
  on the result. Await into a named local on its own line first, then use it: `const exists =
  await objectExists(uri); if (exists) …`, not `if (… && (await objectExists(uri)))`; and
  `const m = await readRemoteSnapshot(…); … m.entries`, not `(await readRemoteSnapshot(…)).entries`
  (the member-access slip that prompted this rule, 2026-06-16). The suspension point stays
  visible and the value gets a name. (When the inline form was guarding a short-circuit, a
  nested `if` preserves the same conditional evaluation without the inline await; a
  conditional-await ternary likewise becomes an `if` writing into a `let`.)
  - **These are all fine** — only conditionals and member access bury the await (scope
    clarified 2026-06-17, PR #59 review, after the rule had over-reached): a bare `const x =
    await …`, `return await …`, a standalone `await …;`, **destructuring an awaited result**
    (`const { lookup } = await readLatestRemoteSnapshot(…)`), and **`await` as a call
    argument** (`assert.deepEqual(await foo(), …)`). Each keeps the suspension point plainly
    visible on its own line and names the value. (Copilot review flags destructuring- and
    argument-position awaits as violations; they are not — decline them.)
  - **No linter enforces this** (a `no-restricted-syntax` rule was weighed and rejected
    2026-06-16: it can't tell the ugly cases from the occasionally-fine ternary-await, so it
    would trade real false positives for a cosmetic gain — against
    [ADR-0006](docs/adr/0006-minimal-code.md) / convention #8, same call as the
    removed organizeImports action). So **self-check instead: grep the diff for the buried
    shapes** before committing — `(await …).` / `(await …)[` (member/index access on the
    result) and a `? `/`: `/`&& `/`|| ` sitting immediately before `await` (ternary /
    short-circuit). An `await` that is a call argument or a destructuring/assignment
    initializer is not the smell; one wrapped in a conditional or a member access is.
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
  thousands of files.** A second `lstat`/`stat`/read on each file is invisible on one file
  and dominant on a backup set of tens of thousands. When you find one, the fix is to
  **thread the data you already have through the pipeline** — the `Dirent` from
  `readdirSync(…, { withFileTypes: true })` already carries the file type, and `prop` already
  takes one `stat` it reads `isFile`/`size`/`mtime` off — *not* a hidden module-level cache.
  A cache keyed on "the last path" is invisible to the type checker, makes a pure function
  order-dependent, and silently rots into dead code the day the redundant call it guarded
  goes away. (Worked example: `prop.mjs`'s `_lstatCache` was added when *multiple* `prop`
  calls hit each file; once the pipeline settled to one `prop` per file — single call site,
  one `lstat` each — the cache could never hit, yet sat there looking load-bearing. Removed
  2026-06-18 after a static-call-graph check confirmed it was dead. Keep the saving *in the
  interface*, where it's visible and the compiler can see it rot.)
- **User-facing error/warning text follows the Nielsen Norman Group error-message guidelines**
  ([ADR-0030](docs/adr/0030-error-message-guidelines.md)): plain-language headline framed by
  the user's *goal* (no codes/jargon up front — env-var names, paths and keys go in a
  parenthetical or follow-up line), polite (describe, don't blame), and *constructive* (give
  the exact fix, copy-pasteable command on its own indented line — mirror `collisionError` in
  [src/commands/sets.mjs](src/commands/sets.mjs)). Internal invariants and programmer errors
  (a malformed `s3://` URI, a broken assumption) are *out of scope* — keep those terse and
  factual; they signal bugs, not user guidance. Checked in review, not by a linter
  ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **Shape our own errors by the taxonomy in [src/lib/error.mjs](src/lib/error.mjs)'s header**
  (this is *shape*; ADR-0030 above is *wording*). Two orthogonal questions decide it: (1) is
  the error caught by *type* to branch behaviour? → an Error *subclass* (`ParseArgsError`,
  which `isUsageError` `instanceof`-checks), else a plain `Error`; (2) for plain errors, is the
  message heavy/actionable/reused? → a named factory (`noCredentialsError` /
  `expiredCredentialsError` in `auth.mjs`, `collisionError` in `sets.mjs`), else an inline
  `throw new Error`. Foreign SDK/Node errors we can't subclass are matched by `code`/`name`
  instead. A subclass nobody catches by type is unused identity, against convention #8 — don't
  reach for one until a catch site actually reads it. (Recorded 2026-06-26 after an
  `ExpiredCredentialsError` class was added that nothing caught by type, then downgraded to the
  `expiredCredentialsError` factory to match its siblings.)

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

---

## What this project is

**s3cab** = **S3 C**ontent **A**ddressable **B**ackup. [README.md](README.md) covers what
it is, why, what works today, and what's coming; [CONTEXT.md](CONTEXT.md) defines the
vocabulary. Treat the README's S3/backup descriptions as the _target_; treat `src/` as
_what works now_. A few layout notes the README and code don't carry:

- **Scratch and throwaway experiments go in [scripts/](scripts/)** — never a parked sandbox
  under `src/` (the old `src/_poc/` folder is retired) and never under `test/` (see the
  test-layout convention above).
- **Snapshots no longer land in the repo tree.** Since backup-sets slice 2 they live in
  `~/.s3cab/sets/<set>/snapshots/` (outside any working copy), so `.gitignore` no longer
  needs the old root-anchored `/.s3cab/snapshots/` rule — only the `/.s3cab/env*` secret
  guards remain for the committed [.s3cab/exclude.txt](.s3cab/exclude.txt) template.
- **The repo dogfoods itself via a set:** [.s3cab/exclude.txt](.s3cab/exclude.txt) is kept
  as a ready-made exclude template — to snapshot this repo, `s3cab sets s3cab .` then copy
  those patterns into `~/.s3cab/sets/s3cab/exclude.txt`. (It can't live in the repo and be
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
  **sibling** folders [src/commands/](src/commands/) (one file per command) and
  [src/lib/](src/lib/) (shared modules). The siblings sit beside each other on purpose — the
  shared modules are _depended on by_ the commands, not a layer above — and it's taste-driven,
  not a hard boundary: a `lib/` module importing a `commands/` one would be fine if a real
  need arose, though today none does (the lone such import, `snapshot-file.mjs` → `commands/prop.mjs`,
  was retired when its only user, the `writeSnapshot` test helper, moved to `test/helpers/`).
  Grouping is by **subsystem/cohesion, not abstract layer**: no `lib/util/` junk-drawer. If
  `lib/` ever grows enough to cleave, extract a folder named for the subsystem and leave the
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
  [docs/specs/auth.md](docs/specs/auth.md).
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

- **`verify` flow not built yet** — the design *and* the five-slice
  implementation plan are settled in [docs/specs/backup.md](docs/specs/backup.md) (backup sets,
  set-first porcelain, `snapshots/<set>/`, snapshot-last invariant,
  diff-vs-latest-remote + objects-cache upload set). **Slices 1–3 and slice 4's restore
  path are built** (2026-06):
  slice 1 gave the set store (`src/lib/sets.mjs`), the real `setup`/`sets` commands, and
  the set env layer in auth; slice 2 moved the local engine onto sets —
  `snapshot`/`list`/`compare`/`tree` take `[<set>]` (sole-set default), walk every member
  dir with the set's `exclude.txt`, write one snapshot (with `#SNAPSHOT` identity + `#DIR`
  headers) into `~/.s3cab/sets/<set>/snapshots/`, and the per-dir `<dir>/.s3cab/` has
  retired; slice 3 (PR #39) built the cloud half — the remote engine
  ([src/lib/remote.mjs](src/lib/remote.mjs)) plus `backup`, `status`, and `list --remote`,
  so the read-stream/bucket ops in `s3.mjs` now have callers. `upload` still owes its
  **`--if-modified-from <snapshot>` skip** — the snapshot-aware "only upload what changed"
  *hashing* optimization (snapshot-time machinery via `prop`'s `lookup`, distinct from
  `backup`'s upload-set diff; see the TODO in
  [src/commands/upload.mjs](src/commands/upload.mjs); load-bearing, don't lose it). A
  `node:sqlite`-backed cache was spiked for this and **rejected** (2026-06-13): the
  in-memory `Map` built from the previous snapshot beats it on both build (~4×) and lookup
  (~40×), and a flat file would cover the only case sqlite might win (a persistent
  cross-run remote-hash set). See
  [scripts/sqlite-hash-cache-spike.mjs](scripts/sqlite-hash-cache-spike.mjs).
  slice 4's restore path (PR #44) added `restore` (its own `src/commands/restore.mjs`, on
  the verified download — added then as `remote.mjs`'s `downloadObject`, since moved to
  `objects.mjs` as `getObject` (2026-06-17)); `restore --output` re-rooting followed
  (`reroot`, on `parseSnapshotStream` now surfacing the `#DIR`/`#SNAPSHOT` headers it used to
  drop). Remaining scaffold: `verify` is still an inline registry stub — promote it into its
  own `src/commands/` file as it gains a real body (rest of slice 5). **`compare --remote` was
  dropped, not built** (PR #89, [ADR-0027](docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)):
  `compare` is local-only (the `--remote` flag + `notImplemented()` stub are gone), and
  `setup --inherit` instead pulls the set's remote manifests down (verbatim `.tsv.zst` copies,
  no objects, via `downloadRemoteSnapshots` in [src/lib/remote.mjs](src/lib/remote.mjs)) so a
  fresh machine's local `compare`/`list`/`restore` work on full history.
- **The 2026-06-20 local-config/remote-structure redesign has fully landed** (ADR-0024/0025/0026):
  the set **name** is the whole identity (no `user@machine`), the remote snapshot namespace
  flattened to `snapshots/<set>/`, and `setup` now requires `--bucket` and touches S3 — it
  claims the name "first person wins" via the remote `sets/<set>/` marker
  ([src/lib/set-marker.mjs](src/lib/set-marker.mjs): `info` + pushed `dirs.txt`/`exclude.txt`),
  with `--inherit` for machine succession (this replaced the old `setup --from` adoption +
  `remote.mjs`'s `listRemoteNamespaces`, both removed). ADR-0026's resolver cleanup landed last:
  `resolveRemoteSet` folded into `resolveSet`, `BackupSet.bucket` is non-optional (enforced once
  in `readSet`), and `formatSets`' "(no bucket — local only)" branch is gone — the redesign
  proposal file was deleted and `docs/specs/backup.md` rewritten to the new model at that point.
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
