---
name: over-engineering
description: >-
  s3cab's over-engineering sweep — a cold read of src/ hunting needless
  indirection, dead structure and cognitive complexity, judged against CLAUDE.md
  working rule #5. Use ONLY when explicitly asked to run a complexity or
  over-engineering sweep of the codebase, or of a named subsystem within it. It is
  a whole-codebase audit producing a ranked report — NOT a review tool. Do not
  invoke it to review a diff or a PR (that's /code-review or /simplify), for
  ordinary refactoring, or to judge whether one specific proposed change is
  over-engineered.
---

# Over-engineering sweep

A **cold, hostile read** of `src/` looking for solutions more complex than their
problems warrant. The authority is CLAUDE.md working rule #5, *Do not
over-engineer* — but read the whole rule, because half of it cuts the other way
and that half is the one that gets forgotten.

## The metric: complexity, with lines as a proxy

Rule #5 nominates "minimize lines of code" as a **proxy for complexity**, not as
the goal. Three things it says explicitly, all of which bind this sweep:

- **"'simpler' means _clearer_, not only smaller"** — better names and consistent
  interfaces are worth churn even with no new capability.
- **"Over-engineering is the _solution_ being more complex than the problem
  warrants — not the churn a change takes."** A large, correct refactor is not
  over-engineering. Cost-to-implement is not evidence against a finding.
- **Version-gated boldness.** Check `package.json`. Major `0` → free rein for
  large, correct refactors; `≥ 1` → breaking changes need a migration story.

So: **a finding may add lines locally** if it removes branches, indirection hops,
or interface surface. Report line deltas as a signal; never use them as the
pass/fail bar. What you are actually measuring is how much a reader must hold in
their head to follow one behaviour end to end.

The failure mode to avoid: rule #5's restrictive half is the memorable one, so it
gets misapplied to extractions its permissive half plainly authorizes. Structure
with **real consumers today is not speculation.** Only speculative structure —
built for a caller that does not exist — is in scope on that axis.

## Read the code cold

**Do not read `docs/adr/` or `proposals/` during analysis.** Dozens of ADRs exist.
**You are not bound by them.** They are subjects of this sweep, not constraints on
it: if a decision costs more than it buys, say so and explain the cost. Ten passes
of accumulated justification is exactly the context that makes structure look
inevitable, and the point of this skill is a reader who has not absorbed it.

Two consequences:

- **CLAUDE.md auto-loads, and its "Coding conventions" section is itself prior
  art.** Read it as a *description of the status quo*, not a defence of it. A
  convention listed there is as questionable as anything else — including the
  lint-enforced ones. Where acting on a finding would mean **editing CLAUDE.md**
  (any section, not just that one), say so *in the finding* — a documented
  convention losing its last instance is part of what the change costs, and the
  reader must not discover it at implementation time.
- **Never write to `proposals/architecture-improvements.md`.** That file is
  curated across many passes of a different skill; you have not read it and cannot
  merge into it safely. Your output goes to its own file (see *Output*).

**This file deliberately does not cross-link ADRs**, unlike the sibling
`cli-design` skill. That is not an oversight to be tidied up later — links would
invite exactly the reading this skill exists to avoid.

## Scope: internal by default

Findings should be **behaviour-preserving**. The command set, their flags, and the
stored repository format are normally fixed inputs; the question is how they are
*implemented*.

The functionality is well honed, so there is probably not much scope in the
user-facing surface — but it is not out of the question. If you find a genuinely
compelling surface finding, report it tagged **`[USER-FACING]`** so it triages
separately from the internal ones.

## What does not count

- **Comments.** They are roughly half of every non-blank line in `src/`, and that
  is a **separate concern the user has deliberately parked.** Judge code only. Do
  not report comment volume, do not propose comment deletions, do not let a
  comment-heavy file read as a large file.
- **Test files.** They are not the subject and their length is not a finding.
  **But the exclusion is from the _analysis_, not from the _claims_.** *Structure
  that only tests use* obliges a finding to state what the test would do instead,
  and that cannot be answered honestly from the production side alone — so before
  writing any test claim, open the test file and read what is *already* there.
  (Learned the
  hard way: a finding asserted that the existing tests "never look at the shipped
  artifact", when a sibling test one screen away did exactly that. The refactor was
  still right; the justification was overstated, and the change duplicated a test
  that already existed.)

## Run the type check before reporting a redundancy

A shape can be **load-bearing in the type system while looking redundant in
JavaScript**, and reading `src/` cold is exactly the vantage point that misses it.
The cheapest guard is mechanical: for any finding whose claim is *"this does
nothing"*, delete it locally and run `npm run typecheck` before writing it up.

Worked example, and the reason this section exists: a finding called a subclass's
`constructor(init) { super(init); }` "exactly what JavaScript supplies by default".
True of the runtime semantics, false of the types — the base constructor was
`protected`, an implicit constructor inherits that visibility, and the redeclaration
was the only thing making `new Subclass(…)` legal. `tsc` caught it; the cold read
could not have.

This generalizes past constructors: an `@overload` block, a seemingly pointless cast,
a re-export, a widened parameter type. **If the only argument for a finding is that
the code looks like a no-op, that argument is not yet evidence.**

## Finding categories

Rank by complexity removed, heaviest first. These are the veins worth working:

1. **Needless indirection** — a layer that forwards without adding: a wrapper that
   only reorders arguments, a value threaded untouched through three modules, a
   module whose whole job is to call one other module.
2. **Unnecessary abstraction** — a shape imposed where none was called for: a
   structure built only to be taken apart again by its one caller, a parameter
   generalizing over cases that never needed unifying, a type standing in for what
   could be named values. Distinct from *needless indirection*, and the pair is
   worth holding side by side: indirection *forwards* without adding, abstraction
   *imposes a form*
   nothing asked for. **The disqualifier is part of the category** — an abstraction
   with **two or more production consumers with different needs** is a deep module
   earning its keep, not a finding. This is the most misapplicable name in the
   list, so every such finding must say which consumers were checked. (Shape to
   recognize: a function returning a typed config object whose sole caller
   immediately destructures four scalars back out of it, optional-chaining at every
   level because the type admits `undefined` where the literal never does.)
3. **Dead and unreachable structure** — exports nothing calls, branches no entry
   point reaches, parameters that are the same literal at every call site, options
   objects where one field is ever set.
4. **Structure that only tests use.** A test-only caller is **not** a real call
   site — rule #5's "a caller that already exists" means a *production* caller.
   Reportable: a parameter whose only non-default caller is a test, an `export`
   needed solely so a unit test can reach an otherwise-internal function, a seam
   that `mock.module` already makes redundant. **Because you are not reading the
   tests, every such finding must state what the test would do instead** — never
   silently cost coverage, which is a per-PR obligation here.
5. **Duplication with a single obvious home** — the same computation spelled out
   in several modules, where one of them already exports a better version.
6. **Complexity out of scale with its job** — a state machine for something with
   two states, or configurability nothing configures. (The one-implementation
   abstraction moved out to *unnecessary abstraction*, where the disqualifier can
   travel with it.)

## Method

Three stages. Stage 1 is mechanical and cheap; stage 2 gets the budget.

### Stage 1 — query (minutes)

Run these first. They produce **candidates, not verdicts** — a single-caller
module can be deliberate placement, and a dead export can be a genuine seam. Do
not report a stage-1 hit until stage 2 has seen it in context.

**Size the pass — code vs comment, so you know what you are actually reading:**

```bash
node scripts/sweep.mjs size
```

**Production fan-in — which modules have earned being modules:**

```bash
node scripts/sweep.mjs fan-in
```

Read it **ascending**. High fan-in is evidence a module is *earned*; the interesting
end is the tail. Ignore `commands/*.mjs` sitting at 1 — the registry imports each
exactly once, which is structural, not signal. A `lib/` module with one production
caller is the question *"does this deserve to be a module?"* asked mechanically.
Importers are counted from `src/` **and `scripts/`**, so a module that exists only
for a dev utility shows its real caller rather than reading as an orphan.

**Exports with zero production consumers, with the three numbers that sort them:**

```bash
node scripts/sweep.mjs exports
```

Every hit already has no production consumer outside its own file. The counts say
*which kind* of hit it is, so the sort is mechanical rather than 20-odd follow-up
greps — and `tests:` is the production/test call-site count *structure that only
tests use* obliges every such finding to state, so it is gathered here rather than
re-derived:

| `self:` | `tests:` | Reading (all rows assume `scripts:0`) |
| --- | --- | --- |
| 0 | 0 | dead outright — nothing anywhere refers to it |
| 0 | >0 | **dead, kept alive only by its test** (*structure that only tests use* — say what the test would do instead) |
| >0 | 0 | used internally; the `export` keyword alone is surplus |
| >0 | >0 | internal + a test reaches in; judge whether the test earns the seam |

**`scripts:>0` overrides every row above — the export is earned, not surplus.**
`scripts/` holds *kept dev tooling*, not scratch, and it imports `src/` directly, so
a script is a real consumer that a dropped `export` would break. It is not a
*production* consumer, so the hit is still shown rather than suppressed: worth
knowing an export exists only for tooling, but never grounds for calling it dead.
(This is why the query walks `scripts/` at all — a symbol used by one script and no
test would otherwise read `self:N tests:0` and land in the "surplus keyword" row.)

`tests:` counts **files**, so it doubles as blast radius: a symbol at `tests:7` is
wired into the gated integration suites and its removal is a much bigger edit than
one at `tests:1`. All three are **token mentions, not resolved references** —
`self:` subtracts one for the declaration but still counts mentions in the module's
own doc comments, and a `{@link Foo}` inflates it. Treat them as triage, not
verdicts; stage 2 reads the hit in context either way.

### Stage 2 — trace every command path (the main budget)

Walk **each registered command end to end**: entry point → registry → its command
file → every `lib/` module it reaches → the S3/filesystem boundary. Get the
command list from the registry rather than assuming it.

At every hop, ask:

- **What does this layer add?** Could its caller do the work directly?
- **Is this branch reachable from this entry point?** Which paths can never fire?
- **Is this parameter ever a different value?** Across *all* call sites.
- **Does the caller immediately undo what the callee did** — wrap then unwrap,
  serialize then parse, sort then re-sort?
- **How many files must a reader open** to follow one behaviour to its effect?

This stage is the one that sees needless indirection, because **indirection is a
relationship, not a property** — a thin wrapper looks perfectly reasonable read on
its own and obviously pointless read from its one caller. Resolve stage-1
candidates here, as you meet each in context.

Shared leaf modules will recur on many paths. Note a module as read and move on;
do not re-analyse it per path.

### Stage 3 — sweep the residue

Read whatever neither stage reached: the high-fan-in shared core, and format or
protocol machinery that every path uses identically so tracing never singles it
out. Uniform use hides uniform complexity.

## Output

Two artifacts:

1. **A ranked markdown report** at `proposals/over-engineering-sweep.md` — heaviest
   complexity reduction first. Each finding carries: what the complexity *is*, the
   path or query that exposed it, the change proposed, the line delta as a signal,
   and for *structure that only tests use* the production/test call-site counts plus
   what the test would do instead. Tag surface findings `[USER-FACING]`. **Refer to
   a category by its name, never its number** — the numbering has already shifted
   once, and a report or rejection record citing "category 3" silently rots the next
   time one is inserted.
2. **An HTML report** beside it at `proposals/over-engineering-sweep.html`, in the
   style of the existing `proposals/architecture-review.html` — before/after
   structure diagrams and the visual context that does not survive in markdown.
   Committed reports are established practice here. Self-contained or CDN-loaded to
   match the sibling.

Both filenames are **fixed**, and both are **latest-only** — a later run overwrites
them, so a superseded report cannot accumulate. (Naming them per run would make
"latest-only" unenforceable: the next run would write beside the old pair rather
than over it.)

**Mark every test claim as a hypothesis, in the report itself.** A sentence
beginning "the existing test…" is the one kind of claim this sweep is structurally
worst at, because it is made from the production side about files the sweep is not
reading. Requiring the sweep to open the test file first (see *What does not
count*) reduces the error rate; it does not make the claim safe. So the report must
say, once and near the top, that its test claims are **to be re-verified before
implementing** — the implementer reads the file warm, with the change in hand, and
is the second line of defence rather than an accidental one. This is not
belt-and-braces: on the first run, all three findings that touched tests had their
test claim corrected at implementation time, and one of them called a live
regression guard inert. Trusting it would have deleted real coverage silently.

Findings are ranked by complexity removed, which says nothing about what a change
*costs* — so **say so where the cost is unusually high or low**, since that is what
the reader triages on. A surplus `export` keyword and a removal that reworks five
test files sit at opposite ends and should not read alike. One clause per finding,
not a field on every one.

Include a **"looked at and dismissed"** section. Coverage is as informative as
hits — a subsystem examined and found tight is a real result, and without it the
user cannot tell what you never reached.

**Report only. Change no code.** Present the ranking and stop; implementing any
finding needs an explicit go-ahead, and would then follow the normal worktree +
PR route.

## Where a rejection goes

The reports above are disposable; a **rejection is not.** A finding the user
declines stays true of the code, so the next cold run will re-derive it with equal
confidence — and the reasoning that spared it must outlive the report that carried
it.

**Primary rule: record it in the code, at the point a future reader would undo
it.** The symbol's own doc comment, or the module header if the rejection is about
the module. This is the most robust home there is — a cold reader cannot propose
removing the thing without first reading why it stands — and CLAUDE.md already
holds that a code comment is often the right home for a settled rationale, "the one
place someone about to undo it will look." It needs no apparatus and cannot fall
out of sync, because it travels with what it describes.

The worked example is `formatSets` in `sets.mjs`: proposed for removal as a surplus
`export`, kept because its test pins column alignment that is worth pinning. Its
JSDoc now says exactly that, so the next run meets the argument before it can
repeat the proposal.

**Fallback, for rejections with no such point:** a short list at
`proposals/over-engineering-rejections.md` — created the first time one exists, not
before. Two kinds land here: a finding that spanned several modules with no single
home, and one rejected as *right but not worth the churn*, which is a judgement
about the project's state rather than a fact about the code.

Two constraints on that list:

- **It is consulted _after_ findings are drafted, never during analysis** — as a
  filter on output, not an input to attention. Reading prior rejections first would
  reintroduce exactly the inherited-justification problem the cold read exists to
  escape. Say how many findings it suppressed, and why, so a rejection that has gone
  stale is visible rather than silently permanent.
- **It records the user's decisions, not the run's own dismissals.** The "looked at
  and dismissed" section is one run's judgement and is fine to re-derive; a
  rejection is a decision that should stick.

## Do not escalate any of this into an ADR

**"The way the code is" is itself an architecture decision.** An ADR earns its
place only when *both* halves hold: the reasoning is not recoverable from the code,
**and** someone would plausibly re-argue the decision. ADRs exist to stop obscure or
hard-to-reason-about decisions being re-litigated — not to narrate what the next
reader can simply see.

This binds the sweep at both ends.

**On output.** A rejection belongs in the code, at the point someone would undo it
(above). Never promote one to an ADR instead. The doc comment already satisfies both
halves — unrecoverable reasoning, sitting exactly where the re-argument would start
— and an ADR moves it somewhere a cold reader has been *told not to look*. (Worked
example: a weekly canary job and an auto-merge switch were both proposed as an ADR
and built as workflow-header comments instead. The file a person edits is the file
that has to carry the why.)

**On findings.** `docs/adr/` is a subject of this sweep. An ADR that only describes
what the code plainly shows is the documentation form of exactly what this skill
hunts: shape that costs a reader something and buys nothing. Report it like any
other finding.

Apply the second half of the test carefully, though, because it is the one that
protects the good ones: an ADR recording **why not the obvious alternative** is
doing real work even when the decision itself is visible in the code. Code shows
what was built. It can never show the road deliberately not taken, which is
precisely the thing a cold reader re-proposes.

## Relationship to `/improve-codebase-architecture`

> *Assistant-proposed framing — not part of the original brief.*

That skill and this one are **antagonists, by design.** Its stated epic is to turn
shallow modules into deep ones — more behaviour behind a smaller interface — so it
*creates* seams. This one *destroys* seams that do not pay for themselves. Each is
a check on the other's overreach, which is the point of running both.

They will therefore sometimes recommend opposite changes to the same module. That
is not a malfunction, and neither skill wins automatically: the tie-break is
whether the seam has **real consumers today**. Two or more genuine production
callers with different needs is a deep module earning its keep; one caller is a
split looking for a reason.

## Not built, on purpose

- **No run log, and no durable findings file.** The first run settled this: what
  needs to outlive a report is not the findings but the *rejections*, and those now
  go in the code (see *Where a rejection goes*). Findings that land need no memory
  at all — implementing one removes the complexity, so a cold read cannot re-find
  it. That self-correction is why the reports can stay disposable, and why the
  large memory apparatus this section once anticipated was never justified.
- **No hard-coded baseline numbers** — the stage-1 queries are carried instead, so
  the skill cannot rot as the codebase moves.
