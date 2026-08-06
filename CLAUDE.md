# CLAUDE.md

Working rules and orientation for **s3cab**, for contributors and AI assistants. How to *work* in
the codebase; the knowledge itself lives in purpose-built homes.

## Where knowledge lives

| What | Where |
| --- | --- |
| **Domain vocabulary** (the ubiquitous language) | [CONTEXT.md](CONTEXT.md) — glossary only: term + definition + `_Avoid_` synonyms. |
| **Decisions** (the *why*, "don't re-litigate") | [docs/adr/](docs/adr/) — one numbered ADR each, indexed by [docs/adr/README.md](docs/adr/README.md). |
| **Subsystem designs** | [docs/design/](docs/design/) |
| **Contributor how-tos** | [docs/](docs/) — [integration-testing](docs/integration-testing.md), [releasing](docs/releasing.md). Doesn't ship. |
| **Agent/skill config** | [docs/agents/](docs/agents/) — [domain](docs/agents/domain.md), [issue-tracker](docs/agents/issue-tracker.md), [triage-labels](docs/agents/triage-labels.md). |
| **User-facing docs** | [README.md](README.md), [guide/](guide/) — incl. the format spec, [guide/format.md](guide/format.md). Ships in the npm tarball, so the spec travels inside every install. |
| **Ideas we might do** (deleted when done/abandoned) | [proposals/](proposals/) — theme "epic" files, [misc.md](proposals/misc.md) unsorted, [bugs.md](proposals/bugs.md) the interim defect tracker. Provisional, *not* of record; see [proposals/README.md](proposals/README.md). |
| **How to work here** | this file |

The split is by **audience**: internal docs under [docs/](docs/) (sibling `adr/` *decisions* vs
`design/` *designs* — different in *kind*), user-facing prose as README + `guide/`. **The word
"spec" is reserved** for the format spec, kept user-side because the stored format is a
user-facing promise ([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)).

The seven foundational design principles, once numbered `#1`–`#7` here, are now
[ADR-0001](docs/adr/0001-file-level-content-addressable-dedup.md)–[ADR-0007](docs/adr/0007-plain-js-via-jsdoc.md).

### Documentation discipline

Both rules ground out in **transparency as a core project value**
([ADR-0002](docs/adr/0002-no-lock-in-hard-constraint.md)): docs that lie about behaviour
undermine the no-lock-in premise.

1. **Never let docs _mislead_ about what works — but they may describe agreed-but-unbuilt
   direction when clearly marked target-vs-built.** A settled-but-unimplemented redesign can land
   in an ADR (`Status: proposed`) or a design-doc banner, if a reader can't mistake it for live
   behaviour. Flag drift you notice — [proposals/](proposals/) is the running list.
2. **Each doc carries only what its home is for, and only what is _not_ trivially knowable from
   the code** — never restate `package.json` scripts or build/test/lint commands.

**Who user-facing prose is for** is settled in
[ADR-0012](docs/adr/0012-consumer-vocabulary-naming.md) ¶1 and governs prose, not just command
names — a *casual but technical* reader who can stand up an S3-compatible bucket with keys and
permissions, but doesn't live in git.

**README/`guide/` vs. the built-in CLI help topics** (`helpTopics` in `src/help.mjs`): the test is
*"would someone need this mid-task, without reaching for a browser?"* — exclude-pattern rules
pass, the storage format fails (a sit-down read → [guide/format.md](guide/format.md)). The small
overlap that leaves is accepted over sync machinery
([ADR-0006](docs/adr/0006-minimal-code.md)).

### Working conventions

1. **After non-trivial work, update the docs** in the right home (see the map): a design decision
   → an ADR; vocabulary → CONTEXT.md; a coding rule → this file. **Once a rule has settled,
   distill it to {rule + why + at most one example}** and let `git blame` hold the story —
   appending every correction without compressing is what bloats this file. **But distillation
   alone doesn't hold: when a rule keeps needing revision, automate it or delete it.** Four
   distillation passes (Jun 29, Jul 2, Jul 11, Jul 16) each cut 60–90 lines and the file regrew
   past its starting point every time — 472 → 544 in nine days. What *did* work was enforcement:
   the `git -C` rule took six revisions as prose and none since it became a `deny` entry, and the
   two `local/*` ESLint rules have never been re-argued.
2. **Refactors and minor chores may ride along with a feature** — a small refactor, a
   settings.json tweak, a `proposals/` note, or a doc fix needn't be its own PR (still prefer a
   separate *commit* each). This includes notes already sitting uncommitted in `proposals/`: roll
   them in rather than stepping around them.
3. **Do not over-engineer** — the process-level twin of
   [ADR-0006](docs/adr/0006-minimal-code.md): build the small thing the current need justifies,
   generalize when the second case appears, counted in call sites that **already exist**. Two
   clarifications, because the restrictive half gets misapplied to extractions the permissive half
   authorizes: over-engineering is the **solution** being more complex than the problem warrants,
   *not* the churn a change costs; and **"simpler" means clearer, not only smaller**. Pre-1.0
   (`package.json` major `0`) you have free rein for large, correct refactors. (Example:
   `isENOENT` in `src/lib/error.mjs`, added at four call sites as the specific predicate, not a
   generic `isErrnoCode`.)
4. **Test coverage is judged by review, not a percentage gate**
   ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)) — asserting tests for changed behaviour
   are a per-PR obligation, checked by reading the diff. Assert about the *result*, not that the
   line executed.
5. **Open PRs with `npm run pr`** — it is `gh pr create --reviewer "@copilot"`, so the review is
   requested by construction rather than by remembering; pass the rest through
   (`npm run pr -- --fill`). Then move on: don't verify or re-request, because
   `gh pr view --json reviewRequests` reads **empty even on success** and treating that as
   failure just duplicates the request. Harmless for contributors without Copilot enabled — the
   flag is a no-op for them.

### Coding conventions

*Style* rules; the tooling *decisions* (LF endings, Prettier-code-only, dependency policy) are
ADRs [0021](docs/adr/0021-lf-line-endings-prettier-code-only.md),
[0005](docs/adr/0005-builtins-over-dependencies.md),
[0018](docs/adr/0018-dependabot-not-renovate.md).

- **Each file in `src/commands/` exports exactly one symbol — its command function**
  ([ADR-0023](docs/adr/0023-porcelain-plumbing-lib-layers.md); enforced by
  `local/one-export-per-command`). If a sibling command *or a test* needs anything else from it,
  that's a `lib/` primitive not yet moved — extract it. Porcelain composes **plumbing primitives
  from `lib/`**, not sibling commands: `backup` fuses `generateSnapshot` with `uploadObjects` in
  one pass ([ADR-0069](docs/adr/0069-fused-snapshot-upload-pipeline.md)) rather than calling
  `snapshot()`/`upload()`.
- **Every imported type uses the JSDoc `@import` tag, never inline `import("…").Type`** — for
  built-in and third-party types too; the tag *is* the top-of-file `import type` you'd write in
  TS. Enforced by `local/no-inline-import-type` (`typeof import("…").value` is exempt).
- **Quarantine AWS provisioning to the `aws` command — the provider boundary**
  ([ADR-0059](docs/adr/0059-aws-provisioning-boundary-static-imports.md)). Only `aws` may touch
  the AWS CLI or a non-S3 provisioning API; the data plane is S3-only and auth is the pluggable
  seam, so both stay provider-agnostic. Keep heavy deps off the hot path by **placement, not a
  lazy `import()`** — CloudFormation is statically imported by `lib/stack-arns.mjs`, imported by
  nothing but `commands/aws.mjs`. (A JSDoc `@import` of its *types* is exempt — erased at
  runtime, so `lib/roles-anywhere.mjs` naming an `Output` type is not a boundary breach.)
- **Don't bury `await` in a larger expression — give it its own line and a name.** Two smells:
  member/index access on an awaited result (`(await read(…)).entries`) and a compound
  `if`/`while`/`&&`/`||` condition containing an await. Fine: `const x = await …`, `return await
  …`, a standalone `await …;`, a ternary branch, destructuring, and `await` as a call argument
  (Copilot flags the last three — decline those). Deliberately **not** linted: too
  false-positive-prone ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **Before committing code, run _both_ halves of CI's `lint` job — `format:check` *and* `lint`.**
  eslint passing alone is not enough; the job also runs `prettier --check .`, so unformatted hand
  edits fail CI every time. The pre-commit gate is format + lint + typecheck + test, mirroring CI.
- **The whole-project type check (`typecheck`) is kept clean**, `scripts/` included.
  `jsconfig.json` maps `events`/`punycode`/`string_decoder` back to the builtin declarations —
  transitive deps install shims that would otherwise shadow them (mechanism in the jsconfig
  comment).
- **Test layout** ([ADR-0049](docs/adr/0049-centralize-cross-cutting-test-tiers.md), full
  rationale in [test/README.md](test/README.md)): **co-locate the unit tier** (`*.test.mjs` beside
  its module), **centralize the cross-cutting ones** in [test/](test/) — real-bucket integration
  in [test/integration/](test/integration/), where the *folder* is the tier marker and a run that
  opts in without a bucket **hard-fails** rather than silently skipping. An absent co-located test
  is honest "tested elsewhere" signal, not a gap. A second unit file takes a dotted aspect
  (`walk.unknown-dirent.test.mjs`), never a hyphen.
- **Before pushing a change to the S3 read/write/stream path, run `npm run test:integration`.**
  Mocks can't exercise the stream *teardown/abort* behaviour only a real S3 body exhibits — green
  units, red integration. (Worked example: #171's `stream.compose(body, …)` aborted the live
  GetObject on completion while every unit test passed.) This is *the* reason the suite is
  real-bucket ([ADR-0019](docs/adr/0019-s3-test-strategy.md)); setup in
  [docs/integration-testing.md](docs/integration-testing.md).
- **`--test-isolation=none` is slower here, not faster — don't re-try it for speed** (~1.8×: 12s
  vs 7s). Node's per-file isolation parallelizes across workers; one process loses that. Fine for
  debugging shared state, never for speed.
- **Coverage flags must precede the glob positionals** —
  `npm run test -- --experimental-test-coverage` collects nothing and exits 0. Coverage is
  reported, never gated ([ADR-0020](docs/adr/0020-coverage-review-not-gate.md)); `package.json`
  can't carry a comment saying so, which is why this line exists.
- **Watch for per-file overhead in the walk/snapshot hot path** — a second `lstat`/`stat`/read is
  invisible on one file, dominant on tens of thousands. Fix it by **threading data you already
  have through the pipeline** (the `Dirent` carries the file type; `prop` already takes one
  `stat`), *not* a module-level cache — that's invisible to the type checker, makes a pure
  function order-dependent, and rots into dead code.
- **`realpathSync.native` is the one reliable path canonicalizer — capture it once at the
  low-frequency edges, then trust the fast string functions.** Pure-string
  `resolve`/`normalize`/`join` can return subtly different strings for the same real file (case,
  `..`, symlinks), silently breaking anything **keyed on the path** — snapshot lookups are
  path-keyed, so a mismatched key reads as a different file. But realpath hits the filesystem: one
  call fine, per-file-in-a-loop deadly. So realpath only at the capture points (`setup`'s
  `resolveDirectories`, the walk root — once per root, never per entry), pure-string `path`
  downstream (the compare renderer must **not** reintroduce a per-path `realpathSync`).
- **Memory/async stance: assume a modern user PC, not a headless VM.** Don't needlessly use
  memory, but don't be shy either. No sync-purity dogma — async engine interfaces are welcome,
  mainly because progress reporting can hook in later. Where a streamed and a materialized form
  are both correct, pick by what the *consumer* needs: the fused pipeline asks "is this hash
  stored?" one row at a time, so `storedHashes` materializes the store LIST into a Set
  ([ADR-0069](docs/adr/0069-fused-snapshot-upload-pipeline.md)).
- **Two UX references govern user-facing design.** Command *shape* (commands, flags vs.
  positionals, naming, output) follows clig.dev, distilled into the vendored **`cli-design` skill**
  ([.claude/skills/cli-design/](.claude/skills/cli-design/)) — consult it for any command-shape
  decision. Error/warning *wording* follows the next bullet. Both checked in review, not a linter.
- **User-facing error/warning text follows [ADR-0030](docs/adr/0030-error-message-guidelines.md)**
  (Nielsen's heuristic #9): plain-language headline framed by the user's *goal* (codes, env-var
  names and paths go in a parenthetical), polite, and *constructive* — the exact fix as a
  copy-pasteable command on its own indented line, mirroring `collisionError` in
  [src/commands/setup.mjs](src/commands/setup.mjs). Internal invariants and programmer errors are
  out of scope: terse and factual.
- **Every URL we print is `https://s3cab.plantegral.com/...`, never a `github.com` link** —
  extension-less (`/guide/<topic>`), since `.md` would weld the URL to the file format. A shipped
  binary freezes its URLs and `setup` writes one into a starter `exclude.txt` s3cab never
  rewrites, so a printed URL can never be corrected after install; blob URLs can't redirect, a
  domain we own always can. Two commitments follow: **don't rename `guide/*.md`** (the redirect
  maps `/guide/<topic>` → `guide/<topic>.md`), and the domain must keep resolving — it is
  load-bearing for released software.
- **Shape our own errors by the taxonomy in [src/lib/error.mjs](src/lib/error.mjs)'s header**
  (*shape*; ADR-0030 is *wording*). Caught by type to branch behaviour → an Error subclass, else a
  plain `Error`; message heavy, actionable or reused → a named factory (`noCredentialsError`),
  else inline `throw new Error`. Foreign SDK/Node errors match on `code`/`name`. A subclass nobody
  catches by type is unused identity.
- **A command whose result already _is_ its final output text returns that string and points
  `render` at the shared `renderText` passthrough** — don't invent structured data or a bespoke
  renderer for inherently prose output. The identity renderer is the honest degenerate case of the
  render layer ([ADR-0043](docs/adr/0043-human-first-output.md)). (Examples: `aws`'s onboarding
  recipe, `provider`'s status lines.)

---

## What this project is

**s3cab** = **S3 C**ontent **A**ddressable **B**ackup. [README.md](README.md) covers what it is,
why, and what's coming; [CONTEXT.md](CONTEXT.md) defines the vocabulary. Treat the README's
S3/backup descriptions as the _target_ and `src/` as _what works now_. Licensing
(GPL-3.0-or-later; CLA not DCO) is [ADR-0008](docs/adr/0008-gpl-3-license.md) /
[ADR-0009](docs/adr/0009-cla-not-dco.md); the removed bespoke SSO `login` and the
standard-credential-chain model are
[ADR-0015](docs/adr/0015-standard-aws-credential-chain.md) — **don't rebuild the login.**

Three layout notes the README and code don't carry:

- **Standalone dev utilities live in [scripts/](scripts/)** — ad-hoc tools run by hand with
  `node`, outside the package and the test suite: benchmarks, `setup-test-bucket.mjs`, preserved
  rejected spikes. Not "scratch" as in disposable — a script earns its place. Never a parked
  sandbox under `src/` or `test/`.
- **Snapshots no longer land in the repo tree** — since backup-sets slice 2 they live in
  `~/.s3cab/sets/<set>/snapshots/`, outside any working copy, so `.gitignore` only keeps the
  `/.s3cab/env*` secret guards for the committed [.s3cab/exclude.txt](.s3cab/exclude.txt)
  template.
- **The repo dogfoods itself via a set** — [.s3cab/exclude.txt](.s3cab/exclude.txt) is a
  ready-made exclude template: `s3cab setup --set s3cab --bucket <bucket> .`, then copy those
  patterns into `~/.s3cab/sets/s3cab/exclude.txt`.

**Vendored skills.** [`cli-design`](.claude/skills/cli-design/) and
[`over-engineering`](.claude/skills/over-engineering/) travel with the repo. `/over-engineering`
is the deliberate **antagonist** of `/improve-codebase-architecture`: that one *creates* seams,
this one destroys ones that don't pay. Running both is the point; the tie-break when they collide
is whether the seam has two or more **production** callers with different needs. It reads the code
**cold** — during analysis it opens neither `docs/adr/` nor `proposals/`, and must never touch
[proposals/architecture-improvements.md](proposals/architecture-improvements.md), which
`/improve-codebase-architecture` owns as the durable capture of every run. Its own reports are
disposable (fixed names, latest-only); what has to survive a run is a **rejection**, and those go
in the code — the doc comment on the thing a future reader would otherwise remove — with
`proposals/over-engineering-rejections.md` as the fallback for the ones that have no such home,
consulted only *after* findings are drafted. **That file does not exist yet and shouldn't until
it does: create it with the first rejection that has nowhere better to live** — an empty one is
the speculative structure #3 forbids.

---

## Architecture orientation

**Before any structural change — module placement, a command's shape or name, auth/credentials,
output/errors, the storage format — find the governing decision via the topic-grouped
[ADR index](docs/adr/README.md) and read that ADR _first_. Don't reason from memory about whether
a constraint exists or how fixed it is**; some ADRs leave explicit doors open (e.g.
[0032](docs/adr/0032-generative-onboarding-not-active-provisioning.md)'s optional active `--run`).
The *what* is best read from the code: [src/s3cab.mjs](src/s3cab.mjs) is the entry point,
[src/commands.mjs](src/commands.mjs) is the registry, and each command file carries a doc comment.
(No line counts here — a number in prose rots silently, which is how the previous "~80-line"
claim survived the file doubling in size.)

Module *ownership* (`objects/` → `objects.mjs`, `snapshots/` → `remote.mjs`, SDK boundary →
`s3.mjs`) reads straight from the code and its ADRs; the auth split is in
[docs/design/auth.md](docs/design/auth.md). Only the placements the code **can't** tell you are
listed here:

- **Stubs for unbuilt commands stay _inline_ in the registry**, marked `planned: true` (help
  renders `(not yet available)`) — a file is earned by logic, not reserved ahead of it
  ([ADR-0006](docs/adr/0006-minimal-code.md)).
- **[src/commands/](src/commands/) and [src/lib/](src/lib/) are siblings on purpose** — `lib/` is
  depended on *by* commands, not a layer above them. Group by **subsystem/cohesion, not abstract
  layer**: no `lib/util/` junk-drawer. If `lib/` ever cleaves, extract a directory named for the
  subsystem and leave the generic leaves (`format`, `error`) flat.
- **Landing a downloaded stream atomically is not an SDK concern**, so `writeFileAtomic` sits
  *outside* the `s3.mjs` boundary in [atomic-file.mjs](src/lib/atomic-file.mjs) — which is where
  ADR-0001's hash check is enforced.
- **No `package.json` `main`, no `src/index.mjs` barrel** — the entry point runs dispatch as a
  top-level side-effect, so it's unsafe to `import`. Commands are already cleanly exported, so a
  barrel is trivial to add the day a library consumer appears. (If dispatch ever needs unit
  testing, guard the run block with `if (import.meta.main)`.)
- **`--version` is a single source-of-truth chain** — `package.json` → JSON module import →
  inlined by esbuild into the SEA bundle, so the binary never reads a file at runtime. Docs avoid
  pinning the number (README uses a live npm badge).

Naming and output discipline: [ADR-0010](docs/adr/0010-cli-output-conventions.md),
[ADR-0011](docs/adr/0011-validation-in-command-functions.md),
[ADR-0012](docs/adr/0012-consumer-vocabulary-naming.md).
