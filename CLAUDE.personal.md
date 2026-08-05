# CLAUDE.personal.md — staging file, not project policy

> **This file is a migration staging area. It is not read by anything.**
>
> These rules were extracted from `CLAUDE.md` because they describe **how one person's AI
> sessions should behave**, not how s3cab is built. They were being enforced on everyone who
> clones the repo, including contributors using a different tool or no agent at all.
>
> **To adopt:** copy what you want into `~/.claude/CLAUDE.md` on each machine, then
> `git rm CLAUDE.personal.md`.
>
> **Caveat on the sync problem.** The original reason these lived in source is stated in the old
> file: *"kept here in source rather than any one machine's local memory so every session — on any
> computer — follows them."* Moving them to `~/.claude/` reintroduces that problem. The repo was
> acting as your dotfiles sync. A small private dotfiles repo (or a symlink into one) solves it
> properly; the project repo shouldn't.

Each rule below carries its **revision count** — how many commits touched it across the 151
commits that touched `CLAUDE.md` between 2026-06-02 and 2026-07-31. High counts are rules that
resisted settling, and are the expensive ones to lose.

---

## 1. Act only on an explicit go-ahead (≥3 revisions; consent rules merged Jun 29, re-split Jul 30)

**Your agreeing isn't authorization.** Do the work, show what changed, then *wait*; a go-ahead is
per-request, never standing. The recurring failure is treating a **partial signal as settlement**:
a question wants an *answer* (explain, then stop and offer), ruling one option out doesn't decide
the question, a batch "go" authorizes *starting* rather than skipping the per-step pause, and a
"fix and resolve" never carries to the next wave of review comments. Never `git commit`/`push`
without an explicit "commit"/"pr" in that same message.

*This is the most-corrected behavioural rule in the file's history and the one least likely to be
re-derived. Migrate this one first.*

## 2. Per-session git worktrees (10 revisions, Jun 17 – Jul 18 — the most-revised rule in the file)

**Every session that will _write_ works in its own git worktree.** Sessions share one main tree,
so uncommitted edits confuse each other. Branch before the first edit you intend to commit,
however small; land it as worktree branch → one PR, `main` left at `origin/main`. Three things
stay in the main tree, the last two going **straight to `main`, no PR**: read-only/Q&A work;
**doc-only changes** (Markdown anywhere — and **a comment-only edit under `src/` counts**, since
prose in a `.mjs` file changes no behaviour); and **`.claude` config**. In a main-tree edit stage
only the files *you* changed (`git add <path>`, never `-A`).

### Mechanics

- Worktrees live at **`.claude/worktrees/<name>`** — `EnterWorktree`/`ExitWorktree` in-session,
  `isolation: "worktree"` for agents.
- **Accept the harness's branch name** (`worktree-feat+x`). Renaming orphans it from
  `ExitWorktree(remove)`'s auto-cleanup; the PR *title* is clean regardless.
- **Teardown is `ExitWorktree(remove)`**, which deletes the directory *and* its branch.
- **Review on the GitHub PR; don't open the worktree in the IDE** — an open file gives Windows a
  lock that can block removal.
- **No shared `node_modules`** — a junction was rejected (shared mutable resource, and
  `rm -rf <worktree>` could recurse into **main**'s copy). Code work runs `npm install` first.
- **Run bare commands — don't prepend `cd`, don't use `git -C`.** The session cwd already *is* the
  worktree; both forms defeat the path-free allowlist, and `git -C` also slips past the **deny**
  guards. To act on another worktree, `EnterWorktree` (it sets cwd) then run bare `git …`.

> **Note:** the `git -C` half of this rule *was* successfully automated — a `deny` rule in
> `.claude/settings.json` (Jul 9) replaced a path-resolving hook. It took 6 revisions as prose and
> **0 since**. That deny rule stays in the project `settings.json`; only the prose moves here.

## 3. Copilot review at PR create (16 revisions — the most-churned rule of all)

**Pass `--reviewer "@copilot"` to `gh pr create`, then fire and forget** — don't verify or
re-request. `gh pr view --json reviewRequests` reads **empty even on success**, so treating that
as failure only leads to a forbidden re-request after pushes.

*Four different mechanisms were tried: GraphQL botIds (Jun 21) → a PR-create hook (Jun 24) → the
hook removed in favour of this convention (Jun 30) → fire-once-don't-verify (Jul 1). Churn
continued to Jul 13 after the hook was removed. **Recommend re-automating this** — it is the
clearest case in the repo of prose failing where enforcement worked.*

## 4. The permission-prompt fix — settled, do NOT re-litigate (1 revision, fought out locally first)

A bare `"Bash"` entry in `permissions.allow` plus `"defaultMode": "acceptEdits"`, both under
`permissions` in the committed `.claude/settings.json` so every machine inherits it. This is
**not** `bypassPermissions` — `deny` and PreToolUse hooks still run, and run first. **Never
"solve" recurring prompts with specific allow entries or `fewer-permissions`.** If prompts
persist, `defaultMode` applies on *next* session start, or you hit a real `deny` (surface it,
don't widen the allow-list).

> The `settings.json` config itself stays in the project — it's enforcement, not instruction.
> Only this note about *not re-litigating it* is personal.

## 5. Use Bash with Unix syntax, not PowerShell (5 revisions, 2 of them distillation sweeps)

The `deny` rules and the `block-destructive-rm.sh` hook are Bash-string matchers, so
`Remove-Item -Recurse` would slip a destructive command *past* the safety net. Reserve PowerShell
for what genuinely needs it.

*Machine-conditional, not universal: this matters on a Windows box where the system prompt
advertises PowerShell as primary. It is inert on Linux/macOS sessions. Scope it accordingly when
you migrate.*

## 6. Global skill install

The engineering skills come from [mattpocock/skills](https://github.com/mattpocock/skills) and are
**not vendored** — install into your **global** `~/.claude/skills/`, kept current with
`npx skills@latest update --global`. (The two *project-specific* skills, `cli-design` and
`over-engineering`, stay vendored in the repo and are documented in `CLAUDE.md`.)

---

## What was deliberately left in the project `CLAUDE.md`

For the record, so you don't migrate them by mistake:

- **Don't over-engineer** — marked "a standing edict from the user", but it governs code review
  for any contributor and twins with ADR-0006. Project.
- **Memory/async stance** — marked "(user-stated)", but it's a decision about the *product's*
  target environment and shapes how the engine is written. Project.
- **Reply to every review comment; chores may ride along; update the docs** — repo review and PR
  culture, applies to any contributor.
- **All coding conventions** — project by definition.
