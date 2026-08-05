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

> **Trap, learned the hard way:** build regexes as *literals*, not from string
> concatenation. A `"\\b"` inside a string literal does not survive into
> `new RegExp` here, and the query silently reports everything as unused. The
> scripts below tokenize instead, so they need no escapes.

**Size the pass — code vs comment, so you know what you are actually reading:**

```bash
node -e '
const fs=require("fs"),path=require("path");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,o):(e.name.endsWith(".mjs")&&!e.name.endsWith(".test.mjs")&&o.push(p));}return o;}
let code=0,cmt=0;const rows=[];
for(const f of walk("src")){let inb=false,c=0,m=0;
  for(const l of fs.readFileSync(f,"utf8").split(/\r?\n/)){const t=l.trim();
    if(inb){m++;if(t.includes("*/"))inb=false;continue;}
    if(t==="")continue;
    if(t.startsWith("/*")){m++;if(!t.includes("*/"))inb=true;continue;}
    if(t.startsWith("//")){m++;continue;}
    c++;}
  code+=c;cmt+=m;rows.push([f,c,m]);}
rows.sort((a,b)=>b[1]-a[1]);
for(const [f,c,m] of rows.slice(0,15))console.log(f.padEnd(34),String(c).padStart(4),String(m).padStart(4));
console.log("TOTAL code",code,"comment",cmt);'
```

**Production fan-in — which modules have earned being modules:**

```bash
node -e '
const fs=require("fs"),path=require("path");
function walk(d,o=[]){if(!fs.existsSync(d))return o;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,o):(e.name.endsWith(".mjs")&&!e.name.endsWith(".test.mjs")&&o.push(p));}return o;}
const files=walk("src"),imp=new Map();
for(const f of [...files,...walk("scripts")]){const s=fs.readFileSync(f,"utf8");
  for(const m of s.matchAll(/(?:^|\n)\s*(?:import[\s\S]*?from|export[\s\S]*?from)\s*["\x27](\.[^"\x27]+)["\x27]/g)){
    const t=path.normalize(path.join(path.dirname(f),m[1]));
    if(!imp.has(t))imp.set(t,new Set());imp.get(t).add(f);}}
files.map(f=>[f,(imp.get(f)||new Set()).size]).sort((a,b)=>a[1]-b[1])
  .forEach(([f,n])=>console.log(String(n).padStart(3),f));'
```

Read it **ascending**. High fan-in is evidence a module is *earned*; the interesting
end is the tail. Ignore `commands/*.mjs` sitting at 1 — the registry imports each
exactly once, which is structural, not signal. A `lib/` module with one production
caller is the question *"does this deserve to be a module?"* asked mechanically.
Importers are counted from `src/` **and `scripts/`**, so a module that exists only
for a dev utility shows its real caller rather than reading as an orphan.

**Exports with zero production consumers, with the three numbers that sort them:**

```bash
node -e '
const fs=require("fs"),path=require("path");
function walk(d,o=[]){if(!fs.existsSync(d))return o;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p,o):e.name.endsWith(".mjs")&&o.push(p);}return o;}
const all=[...walk("src"),...walk("test"),...walk("scripts")];
const prod=new Set(all.filter(f=>f.startsWith("src")&&!f.endsWith(".test.mjs")));
const scr=new Set(all.filter(f=>f.startsWith("scripts")));
const toks=new Map(all.map(f=>[f,fs.readFileSync(f,"utf8").match(/[A-Za-z0-9_$]+/g)??[]]));
const sets=new Map(all.map(f=>[f,new Set(toks.get(f))]));
for(const f of prod){const t=fs.readFileSync(f,"utf8"),names=new Set();
  for(const m of t.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z0-9_$]+)/gm))names.add(m[1]);
  for(const m of t.matchAll(/^export\s*\{([^}]+)\}/gm))for(const p of m[1].split(",")){const n=p.trim().split(/\s+as\s+/).pop().trim();if(n)names.add(n);}
  for(const n of names){
    if([...prod].some(g=>g!==f&&sets.get(g).has(n)))continue;
    const inTests=all.filter(g=>!prod.has(g)&&!scr.has(g)&&sets.get(g).has(n)).length;
    const inScripts=all.filter(g=>scr.has(g)&&sets.get(g).has(n)).length;
    const self=toks.get(f).filter(x=>x===n).length-1;
    console.log(f.padEnd(30),"->",n.padEnd(22),`self:${self}`.padEnd(8),`tests:${inTests}`.padEnd(9),`scripts:${inScripts}`);}}'
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

## Not yet built

Deliberately deferred until a real run gives evidence, so it is not re-derived:

- **No durable findings file, run log, or standing-rejections memory.** If a later
  run shows it is needed, the answer is **rejections as an _output_ filter**: read
  `src/` clean, draft the findings, and only *then* consult the rejection list to
  suppress duplicates. That is the only arrangement that keeps the cold read
  genuinely cold while stopping the same dismissed candidate returning every run.
  Reading prior findings *first* would re-create in a new file precisely the
  inherited-justification problem this skill exists to escape.
- **No hard-coded baseline numbers** — the stage-1 queries are carried instead, so
  the skill cannot rot as the codebase moves.
