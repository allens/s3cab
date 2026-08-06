# Over-engineering sweep — 2026-08-01

A cold read of `src/` against CLAUDE.md working rule #5. Ranked by complexity
removed, heaviest first. **Report only — no code changed.**

Scale of the pass: **6,912 code lines** across 58 production files (comments
excluded from that count and from judgement, per the skill). `package.json` major
is `0` (`0.1.0-alpha.1`), so large correct refactors are in bounds.

Two of these findings contradict a live ADR. That is deliberate — the skill reads
the code cold and treats ADRs as subjects, not constraints. Each says which ADR it
crosses so the trade is visible.

---

## 1. The `loadEnv()` / `__S3CAB_ENV_LOADED` tripwire guards a caller that doesn't exist

> **SHIPPED** — [PR #263](https://github.com/allens/s3cab/pull/263), merged
> 2026-08-05 as `6020f8a`. `loadEnv`, the flag and the `client()` assert are gone;
> ADR-0022 is amended (title included — "Env is loaded at the entry point" was the
> half that died) and its index entry updated.
>
> **The finding understated itself.** ADR-0022's own prose still described
> `loadEnv()` as applying the user layer — false since ADR-0055 — so the ADR was
> owed an amendment regardless of this change. Three further doc references had
> rotted identically (`auth.mjs`'s resolution order, `parseEnvFile`'s "synchronous
> because", `announceHome`'s placement rationale), and review caught a fourth in
> `docs/design/auth.md`.
>
> **Two things done that the finding didn't anticipate.** A test was *preserved*,
> not deleted: the `describe("loadEnv")` block held a real ADR-0055 regression
> guard — that `~/.s3cab/env` is ignored — which would have vanished with its host;
> it now runs through `loadSet` and is stronger for it. And the integration
> harness's comment was rewritten rather than dropped, since it justified relocating
> `S3CAB_HOME` via `loadEnv` (stale since 0055) while the relocation itself is still
> needed.
>
> **The review wave is the reason scope 2 exists**: Copilot flagged the wider
> `loadEnv` trail across docs. Live claims were fixed; ADR bodies were given
> forward pointers rather than rewritten, because a superseded decision's record is
> what stops the reversed choice being re-proposed
> ([docs/adr/README.md](docs/adr/README.md)).

**What the complexity is.** `loadEnv()` is now a one-line function whose entire
body is `process.env.__S3CAB_ENV_LOADED = "1"`, and `client()` asserts on that
breadcrumb before every S3 client construction. Since ADR-0055 removed the
per-user env layer, `loadEnv` loads nothing at all — the set layer is applied by
`loadSet`, which the assert does *not* check. What survives is a magic env var, an
assert, a call at the entry point, an import, and ~30 lines of comment across two
modules explaining a mechanism with nothing left to mechanise.

Its stated purpose is catching "a lib consumer who skipped `loadEnv`". There is no
library consumer: CLAUDE.md's architecture section states it outright — no
`package.json` `main`, no barrel, and the entry point runs dispatch as a top-level
side effect, so it is unsafe to import. Inside the CLI the flag is set
unconditionally at [s3cab.mjs:118](src/s3cab.mjs#L118) before any command body runs,
so the assert can never fire.

**How it surfaced.** Stage 2, tracing every command path to the S3 boundary: each
one passes through `client()`, and the assert was the one hop that added nothing
any path could observe.

**Path.** [src/s3cab.mjs:118](src/s3cab.mjs#L118) → [src/lib/env.mjs:160](src/lib/env.mjs#L160)
→ [src/lib/s3.mjs:208](src/lib/s3.mjs#L208)

**Proposed change.** Delete `loadEnv`, the `assert` in `client()`, the env var, the
entry-point import and call, and the two module-header paragraphs describing the
"two doors". `loadSet` stays exactly as it is — it is the door that actually does
work.

**Line delta.** −15 code lines, −1 magic env var, −1 assert on the client path,
−~30 comment lines.

**Category 3 (test-only structure) — call sites and replacement.**
Production: 1 setter, 1 asserter. Tests:
[env.test.mjs](src/lib/env.test.mjs) has a `describe("loadEnv")` block whose two
tests assert only that the breadcrumb is set and that a second call is inert —
both delete outright, since nothing behavioural is asserted. Eleven other
`t.loadEnv()` calls in the `loadSet` tests are setup mirroring the entry point and
simply drop. [s3.test.mjs:1117](src/lib/s3.test.mjs#L1117) and
[s3.multipart-tuning.test.mjs:64](src/lib/s3.multipart-tuning.test.mjs#L64) drop
their flag-setting lines, as does [test/helpers/integration.mjs:57](test/helpers/integration.mjs#L57).
**No coverage is lost** — no test asserts about behaviour that changes.

**Crosses ADR-0022** (the env-loading front door). ADR-0022's other half —
`loadSet` as the one door set commands route through — is untouched and still
earns its keep; only the tripwire half has outlived its subject.

---

## 2. `backupLifecycle()` builds an SDK-typed object its only caller immediately unwraps

> **SHIPPED** — [PR #257](https://github.com/allens/s3cab/pull/257), merged
> 2026-08-02 as `05c389c`. Three constants replace the object; the
> `@aws-sdk/client-s3` type import and the four `?.` chains are gone.
>
> **One claim below was wrong, and is left standing as written so the error is
> visible rather than quietly edited away.** The "Category 3" paragraph says the
> old tests "never look at the artifact that ships". They didn't — but a *sibling*
> test in the same file already did (`describe("awsCloudFormationTemplate")` →
> "carries the noncurrent-version lifecycle window, no current-object expiry"),
> asserting on the rendered YAML and already using the `\bExpiration:` guard.
> So a broken interpolation was **not** invisible, and the coverage gain was
> smaller than claimed: what is genuinely new is lifecycle coverage of the *Roles
> Anywhere* template, which that older test does not reach.
>
> The cause is a real gap in the sweep skill, now recorded there: the skill
> excludes test files from analysis (correctly), yet obliges every finding of this
> category to state what the test would do instead — an obligation that cannot be
> met honestly without opening the test file. **The leftover is closed** — the
> duplicate was folded into the parameterized block by
> [PR #258](https://github.com/allens/s3cab/pull/258) (`aa3678b`), absorbing the
> older test's stronger nested-key regex first and verifying it by mutation: with
> the value moved under a different key, the bare form still passes and the nested
> form fails.

**What the complexity is.** [aws.mjs:35](src/lib/aws.mjs#L35) returns a
`BucketLifecycleConfiguration` — an AWS SDK type, imported for this and nothing
else. Its only production consumer, `bucketResources`, does this:

```js
const [rule] = backupLifecycle().Rules ?? [];
const noncurrentDays = rule?.NoncurrentVersionExpiration?.NoncurrentDays;
const abortDays = rule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation;
// …then interpolates rule?.ID, rule?.Status, noncurrentDays, abortDays into YAML
```

Build a nested object, then take it apart again with four optional-chained
accesses — every `?.` present only because the SDK type admits `undefined` at each
level, which the literal never does. Four scalars go in, four scalars come out, and
a whole SDK shape exists in between. **The caller undoes what the callee did** —
the classic stage-2 tell.

The object is never handed to the SDK. `s3cab aws` is generative (ADR-0032/0056):
it writes YAML and makes no AWS calls. The only real
`PutBucketLifecycleConfiguration` in the repo is in
[scripts/setup-test-bucket.mjs](scripts/setup-test-bucket.mjs), which has its own,
deliberately different, lifecycle.

**How it surfaced.** Stage 1's zero-consumer export query flagged
`backupLifecycle`; stage 2 read it in context and found the unwrap.

**Path.** [src/lib/aws.mjs:35](src/lib/aws.mjs#L35) →
[src/lib/aws.mjs:197-199](src/lib/aws.mjs#L197-L199)

**Proposed change.** Four named constants (`LIFECYCLE_RULE_ID`,
`NONCURRENT_DAYS = 90`, `ABORT_DAYS = 1`, and the literal `Enabled`) interpolated
straight into the template. Drop the function, the export, and the
`@import { BucketLifecycleConfiguration }` tag. The comment explaining *why* 90 days
and no current-object expiry moves to sit with the constants — that comment is the
part carrying real value, and it survives intact.

**Line delta.** −20 code lines, −1 SDK type import, −4 `?.` chains.

**Category 3 — call sites and replacement.** Production: 1 (the unwrapper). Tests:
2, both in [aws.test.mjs:28-44](src/lib/aws.test.mjs#L28-L44). They would assert on
the **rendered template** instead — that `awsCloudFormationTemplate(bucket)`
contains `NoncurrentDays: 90` and `DaysAfterInitiation: 1`, and contains no
`Expiration:` line. That is strictly better coverage: today's tests pass even if the
YAML interpolation is broken, because they never look at the artifact that ships.

---

## 3. `listSnapshotNames`'s `latest` option changes the function's return type

**What the complexity is.** [snapshot-file.mjs:578-612](src/lib/snapshot-file.mjs#L578-L612)
carries **two `@overload` blocks**, a `string[] | string | undefined` union return,
and a branch — all so one boolean can flip the function between "a list" and "one
item". A reader must hold two contracts in their head for one function.

The six production call sites:

| Site | Call | Wants |
| --- | --- | --- |
| [list.mjs:98](src/commands/list.mjs#L98) | `(dir, {})` | array — and `{}` is what the default already gives |
| [list.mjs:131](src/commands/list.mjs#L131) | `(dir, {})` | array — same |
| [compare.mjs:85](src/lib/compare.mjs#L85) | `(dir)` | array |
| [snapshot-file.mjs:491](src/lib/snapshot-file.mjs#L491) | `(dir)` | array |
| [status.mjs:38](src/commands/status.mjs#L38) | `(dir, { latest: true })` | the newest name |
| [snapshot.mjs:69](src/lib/snapshot.mjs#L69) | `(dir, { latest: true })` | the newest name |

Both `latest` sites can write `.at(0)` on the array. The empty-directory case is
identical either way: `[]` → `.at(0)` → `undefined`, which is exactly what the
branch returns today.

**How it surfaced.** Stage 2, tracing `list` and `status`; the explicit `{}` at two
call sites was the thread to pull.

**Proposed change.** Drop the option, both overload blocks, and the branch; the
signature becomes `listSnapshotNames(snapshotDir): string[]`. Two call sites gain
`.at(0)`, two lose `, {}`.

**Line delta.** −20 net (the two `@overload` blocks are 12 of them), and one honest
return type in place of a union.

**Category 3 — call sites and replacement.** Production: 2 use `latest`. Tests:
[snapshot-file.test.mjs:199,206](src/lib/snapshot-file.test.mjs#L199-L206) assert
the `latest` behaviour on both a populated and an empty directory — they become
`.at(0)` assertions against the same fixtures, preserving both cases.
[backup.fused.test.mjs:120](src/commands/backup.fused.test.mjs#L120) and
[snapshot.test.mjs:237](src/commands/snapshot.test.mjs#L237) use it as a convenience
helper and gain `.at(0)`.

---

## 4. `notImplemented` and the `planned` stub convention have zero instances

> **SHIPPED (both halves — option B)** — [PR #267](https://github.com/allens/s3cab/pull/267),
> merged 2026-08-06 as `474e4e0`. The factory, the typedef property, the help
> ternary and the CLAUDE.md bullet are all gone; CLAUDE.md keeps the rule that
> earned the convention and notes it costs three lines to reinstate.
>
> **One coverage claim below is wrong.** The finding treats the `planned`
> machinery as untested. `help.test.mjs` drove the help ternary through a
> *synthetic fixture*, so that test was **not** vacuous — it asserted real
> behaviour, and it is the one genuine assertion this change gave up. It went
> because the behaviour went, not because it was idle. The registry test and
> `error.test.mjs`'s block were the vacuous ones.

**What the complexity is.** [error.mjs:243](src/lib/error.mjs#L243) exports a factory
with no production caller — its own doc concedes it ("No command uses it right
now"). It is kept alive by two tests, one of which asserts nothing at all:
[commands.test.mjs:48-64](src/commands.test.mjs#L48-L64) loops over
`Object.entries(commands).filter(c => c.planned)`, which is empty, so the test body
never executes. A green test that can never fail.

Adjacent, and the same question: `planned` is a `Command` typedef property
([commands.mjs:73](src/commands.mjs#L73)) and a ternary in the help renderer
([help.mjs:270](src/help.mjs#L270)), also with zero instances. This is structure for
a caller that does not exist — rule #5's actual target, as opposed to the
extractions the rule's permissive half authorises.

**How it surfaced.** Stage 1's zero-consumer export query, confirmed in stage 2.

**Proposed change.** Two separable pieces, so they can be taken independently:

1. **`notImplemented`** — delete it, its `describe` block in
   [error.test.mjs:143](src/lib/error.test.mjs#L143), and the vacuous registry test.
   Nothing else references it.
2. **`planned`** — delete the typedef property and the help ternary. This one is a
   judgement call rather than a clear win: CLAUDE.md documents the convention
   ("Stubs … carry `planned: true`, which help renders as `(not yet available)`"),
   so removing it means editing that line too. Reinstating it later is a
   three-line change.

**Line delta.** −10 code lines in `src`, −15 in tests. **No coverage is lost:** the
registry test currently asserts nothing, and `error.test.mjs`'s block tests a
function no command reaches.

---

## 5. Three byte-identical private `files(n)` helpers

> **SHIPPED (narrow fix)** — [PR #267](https://github.com/allens/s3cab/pull/267),
> `474e4e0`. `countOf(n, word)` lives in `format.mjs`; the three private copies
> and `unrestorable.mjs`'s fourth (`objects`) are gone. The wider ~20-site sweep
> stays **not done**, deliberately — line-neutral, and it would churn a lot of
> message text for one idiom.

**What the complexity is.** The same one-liner is defined privately in three
modules:

```js
const files = (n) => `${formatCount(n)} ${plural(n, "file")}`;
```

— [delete.mjs:449](src/lib/delete.mjs#L449),
[deletion-record.mjs:180](src/lib/deletion-record.mjs#L180),
[unrestorable.mjs:363](src/lib/unrestorable.mjs#L363). All three already import both
halves from `format.mjs`, which is the obvious home and is imported by all of
them. `unrestorable.mjs` carries a fourth of the same shape (`objects(n)`), and the
open-coded `formatCount(n) + plural(n, word)` pair appears about **20 more times**,
mostly in `render.mjs`.

**How it surfaced.** Stage 3 residue sweep of the shared formatting core.

**Proposed change (narrow — recommended).** Add one export to `format.mjs`:

```js
export const countOf = (n, word) => `${formatCount(n)} ${plural(n, word)}`;
```

and replace the three private copies with an import.

**Proposed change (wide — optional).** Sweep the ~20 open-coded sites too. Roughly
line-neutral; it buys one idiom instead of a repeated pair, at the cost of touching
a lot of message text. Worth doing only alongside other work in those files.

**Line delta.** −6 for the narrow fix (three definitions → one). Three production
call sites already exist, so this is the permissive half of rule #5, not
speculation.

---

## 6. Four exports with no consumer outside their own module — two with docs that misstate who calls them

> **SHIPPED (three of four)** — [PR #258](https://github.com/allens/s3cab/pull/258),
> merged 2026-08-02 as `aa3678b`. `parseS3Uri`, `networkError` and
> `deletionRecordKey` lost their `export`; both doc defects are corrected.
>
> **`formatSets` keeps its export — this finding overreached.** Its test asserts
> exact column alignment on a padded listing, which is the same fiddly-layout
> coverage the *"looked at and dismissed"* section below explicitly declines to
> strip from `progressLine`. Judging them differently would be one rule applied two
> ways, so the table's "0 production consumers ⇒ surplus" reasoning was too blunt:
> a test seam that buys real coverage is legitimate, and the sweep's own category 4
> says so. Its actual defect was only ever the false doc claim, which is fixed.
>
> The lesson, and the reason this is recorded rather than tidied away: the
> zero-consumer query answers *"who calls this?"*, never *"should anything?"*. The
> `self:`/`tests:` reading table now in the skill exists to force that second
> question, and its `>0 / >0` row — "judge whether the test earns the seam" — is
> exactly the case this finding fumbled.

**What the complexity is.** Interface surface that isn't used, and in two cases a
doc comment naming a consumer that doesn't exist — which is worse than the unused
keyword, because a reader trusts it.

| Export | Internal uses | External uses | Note |
| --- | --- | --- | --- |
| [`parseS3Uri`](src/lib/s3.mjs#L500) | 6 | 0 (no test either) | plain unused `export` |
| [`networkError`](src/lib/s3.mjs#L293) | 1 (the error table) | 0 (no test either) | plain unused `export` |
| [`formatSets`](src/lib/sets.mjs#L408) | 2 (both error messages) | 0 production | **doc says "the human-readable listing the `list` command prints"** — `renderList` builds its own listing and never calls this |
| [`deletionRecordKey`](src/lib/deletion-record.mjs#L26) | 1 | 0 production | JSDoc `{@link deletionRecordTimestamp}` names a function that does not exist (it is `deletionRecordMoment`) |

**How it surfaced.** Stage 1's zero-consumer export query; each resolved in stage 2.

**Proposed change.** Drop the `export` keyword from `parseS3Uri` and `networkError`.
For `formatSets` and `deletionRecordKey`, drop the `export` **and** fix the doc
claim — `formatSets`'s says the opposite of the truth, and `deletionRecordKey`'s
`{@link}` is a dead reference the type check does not catch in a doc comment.

**Line delta.** −4 keywords. The value is interface surface and doc honesty, not
lines.

**Category 3 note.** `deletionRecordKey` and `formatSets` are each reached by one
test. `formatSets` has a real `describe` block worth keeping — it can import the
non-exported function's *output* via `resolveSet`'s several-sets error, or the
export can stay with the doc corrected to say "exported for its unit test". Either
is honest; the current doc is not. `deletionRecordKey` is used by
[deletion-record.test.mjs:151](src/lib/deletion-record.test.mjs#L151) only to build
a URI key — that test can spell `s3://b/deletions/<name>.tsv` literally, which is
what it is actually asserting about.

---

## Smaller items

> **Resolved** — [PR #267](https://github.com/allens/s3cab/pull/267): **8 shipped**,
> **7 refuted**, **9 will not be done**. Details under each.

**7. `RaCanonicalizer`'s constructor is a no-op.** ❌ **REFUTED — the claim is
false, and the code stays.** `SignatureV4Base`'s constructor is `protected`; an
implicit constructor inherits that visibility, so the redeclaration is the only
thing that makes `new RaCanonicalizer(…)` legal. Removing it fails the type check
with TS2674. True of JavaScript's runtime semantics, false of the types — which is
precisely the blind spot of a cold read, and why the skill now requires running
`typecheck` against any "this does nothing" claim before reporting it. The code
carries a comment saying so, since it still *looks* removable.
The original claim, left as written: *"[roles-anywhere.mjs:608-611](src/lib/roles-anywhere.mjs#L608-L611):
`constructor(init) { super(init); }` is exactly what JavaScript supplies by
default. The two method wrappers below it are load-bearing (they widen `protected`
members); the constructor is not. −4 lines."* The second sentence was right about
the wrappers and wrong about the constructor, for the same reason it was right
about the wrappers.

**8. `SHA256_EMPTY_FILE` special-cases what the general path already handles.**
⚠️ **SHIPPED IN PART — half the finding was wrong.** #267, `474e4e0`. The
hard-coded constant is gone, replaced by `EMPTY_DIGEST`, derived once at module
load from `crypto.hash("sha256", "")`. **But the `size === 0` branch stays**, and
the sentence below calling its saving "negligible" is false: review asked for a
measurement, and it is ~81µs per empty file — 20,000 of them is **1,635ms with the
read against 15ms without**, on the walk/snapshot hot path CLAUDE.md warns about.
The finding conflated two things that only looked alike: a magic constant (a real
defect) and a cheap guard (not one). The shipped code now carries the measurement,
so the branch can only be removed against evidence.
[file-props.mjs:27,95-97](src/lib/file-props.mjs#L27): a hardcoded digest constant
and a third `else` branch, to avoid hashing zero bytes.
`crypto.hash("sha256", readFileSync(path), "hex")` returns exactly that constant
for an empty file, so the `else if (size)` guard and the constant both fall away.
It does save one `readFileSync` per empty file — negligible, and the walk `lstat`s
it either way. **−6 lines, one fewer branch, one fewer magic constant.**

**9. `deletionRecordMoment = snapshotMoment` is a rename with no behaviour.**
🚫 **WON'T DO** — decided 2026-08-06, so it isn't re-picked. The alias earns its
keep on two counts the finding already conceded: it carries a doc paragraph about
minute-precision collision that is genuinely about *deletion records*, not
snapshots, and `delete.test.mjs` `mock.module`s it — removing the alias would push
that mock onto `snapshot-file.mjs`, reaching further than the test intends. Three
lines is not worth either cost.

[deletion-record.mjs:41](src/lib/deletion-record.mjs#L41) re-exports another
module's function under a new name. Marginal, and reported last for that reason:
the alias carries a doc paragraph about minute-precision collision that is genuinely
about deletion records, and [delete.test.mjs:67](src/commands/delete.test.mjs#L67)
`mock.module`s it — mocking `snapshot-file.mjs` instead would reach further than
intended. If it goes, the cleaner replacement is passing the moment in as a
parameter (which `delete.mjs` already holds as a local) rather than re-pointing the
mock. **−3 lines, +1 parameter.** Take it only if #1–#6 land and it still reads as
noise.

---

## `[USER-FACING]`

**Nothing to report.** The command surface was examined — the registry, all 18
command shapes, the flag sets, the three-mode `upload` validation block, the
help/topic split, and the stdout/stderr discipline — and no finding cleared the bar
of "genuinely compelling". The functionality is honed, as the skill anticipated.
Recording the absence rather than manufacturing one.

---

## Looked at and dismissed

Coverage is a result too. These were examined in context and found to be earning
their keep, or to be the kind of seam this skill should be suspicious of *removing*.

- **The registry's 18 `exec` adapters** (`(options, [set] = []) => cmd(set, options)`).
  Reads at first glance like 18 lambdas that only reorder arguments — but each one
  names which positional binds where and supplies the empty-array default, which is
  precisely the parseArgs-shape-to-command-signature translation the registry exists
  to hold. Removing them would push `positionals[0]` into every command body.
- **`renderText`'s identity function.** A renderer that returns its argument
  unchanged is the honest degenerate case of the render layer, not indirection —
  and CLAUDE.md already settles it.
- **The preview-file write duplicated between `delete` and `forget`**
  (`mkdir(s3cabDir())` + `writeFile(join(s3cabDir(), PREVIEW_FILE), body)`). Two
  production callers, three lines each. Under the bar: extracting it would create a
  new `lib` seam for what is plainly each command's own I/O, and the two differ in
  when they write. This is the kind of extraction `/improve-codebase-architecture`
  would propose and this sweep should decline.
- **The three destructive commands' shared shape** (non-interactive gate →
  whole-bucket scan → unreadable interlock → summary → confirm → act). Structurally
  parallel across `delete`/`cleanup`/`forget`, but the *wording* of each gate is
  command-specific by ADR-0030's design and the *policy* genuinely differs (abort vs
  warn on unreadable; typed-bucket-name vs y/N). A shared helper would parameterise
  five things to share three lines.
- **`unreadableSnapshots` / `unreadableMessage` in `referenced.mjs`.** Three
  production callers each, with a stated reason for living apart from their producer
  (keeping the AWS SDK out of three pure planners). Earned.
- **`uploadObjects`' `ObjectUploader` shape** (`through` / `run` / `transfer` /
  `result`). Four members looks heavy for one function, but each has a distinct
  production consumer: `backup` uses `through` + `transfer` + `result`,
  `uploadSnapshot`/`uploadDir` use `run` + `result`. Two callers with different
  needs — the tie-break the skill names.
- **`progressLine` exported from `snapshot.mjs` for its test.** A genuinely pure
  function split out so the wording and width-trimming are assertable without a
  terminal. This is a test seam that buys real coverage of fiddly layout logic, not
  one `mock.module` makes redundant.
- **The remaining stage-1 export hits** — `sanitizeNamePart`, `GRACE_MS`,
  `remoteSnapshotsPrefix`, `remoteSetPrefix`, `clientConfig`, `putObjectParams`,
  `formatUploadProgress`, `networkRetryDelay`, `requestErrorRelay`,
  `isPreconditionFailed`, `buildIdentity`, `ARN_ENV`, `buildSignedRequest`,
  `parseSessionResponse`. Each is reached by a unit or integration suite that
  asserts about a *result* (signature bytes, retry jitter distribution, the SSE/
  storage-class gating, remote key layout). `remoteSnapshotsPrefix` and
  `remoteSetPrefix` are additionally used by three integration suites and the shared
  harness. Left alone.
- **The DER encoder in `roles-anywhere.mjs`.** ~180 lines of hand-rolled ASN.1 is a
  lot of code, and it is the right amount: Node cannot create X.509 certificates,
  the alternative is a dependency, and each primitive is used. Complexity in scale
  with its problem.
- **`compare.mjs`'s `diff`.** Dense, but the move/rename/duplicate classification is
  irreducibly a three-way matching problem; every branch is reachable and pinned.
- **`s3.mjs`'s `requestErrorRelay` and the error table.** Data-driven, one row per
  recognised failure, walked in order. The `hasStreamBody` guard has no live caller
  today and says so — kept, correctly, as a correctness tripwire against silent
  object corruption, which is a different thing from speculative structure.
- **`writeSnapshot`'s `through` seam.** Two production callers with different needs
  (`snapshot` passes nothing, `backup` passes the uploader). Earned.
- **`prompt.mjs`'s four readers.** `promptLine` / `stdinLines` / `promptYesNo` /
  `promptHidden` each have distinct production callers and a stated reason not to
  collapse (a single readline interface for multi-line stdin).
- **`progress.mjs`'s `due()` / `update()` / `clear()` / dispose.** Four members, four
  distinct call patterns in production, and a measured reason for `due()` existing
  separately from `update()`.

---

## Method note

Stage 1 ran the three queries the skill carries (size, production fan-in, unused
exports). Stage 2 traced all 18 registered commands end to end, entry point →
registry → command file → every `lib` module reached → the S3/filesystem boundary.
Stage 3 swept the residue: the high-fan-in core (`error`, `env`, `home`, `format`,
`style`, `read-lines`) and the format/protocol machinery (`snapshot-file`,
`exclude`, `atomic-file`, `env-file`, the DER encoder). Every one of the 58
production files in `src/` was read.
