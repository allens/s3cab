# Architecture deepening — snapshot pipeline

Epic: deepen the **local snapshot pipeline** (walk → prop → snapshot file → compare) so the
snapshot grammar lives in one place, the write path is testable through one interface, and the
pure diff core is tested at its own seam. From an `/improve-codebase-architecture` review
(2026-06-23). Vocabulary is the `codebase-design` skill's: *module / interface / seam / deep /
shallow / leverage / locality*. The accompanying HTML report (the four candidates with
before/after diagrams) is [architecture-review-2026-06-23.html](architecture-review-2026-06-23.html).

Scope note: the **remote engine** (`s3.mjs`/`objects.mjs`/`remote.mjs`) and the **config layer**
(`sets.mjs`/`env.mjs`/`home.mjs`/`auth.mjs`) were also reviewed and found already deep and
cleanly seamed — nothing proposed there. (Separate, pre-existing remote-engine ideas live in
[engine-robustness.md](engine-robustness.md).)

**Candidate 1 (collapse the snapshot-writing pipeline into one deep module) has landed** —
see [ADR-0028](../docs/adr/0028-snapshot-writer-owns-the-grammar.md): the snapshot grammar now
lives in one place and the write path is testable through one `writeSnapshot` seam (the first
two epic goals). Its section was deleted per the proposals convention. What remains below is
candidate 2 (the diff-seam test discipline — the third goal) plus the recorded reject/parked
notes (3 and 4).

**Follow-up review (2026-06-29).** A second `/improve-codebase-architecture` pass mostly
retread this ground; recording its outcome so a third doesn't:

- **`fileProps` extracted — landed** ([PR #127](https://github.com/allens/s3cab/pull/127)). The
  file-hashing core moved to `lib/file-props.mjs`; `prop` is now a path-only command over it
  (both its `lookup: SnapshotEntries | string` and `path: string | File` unions gone), and the
  snapshot writer injects `fileProps` directly rather than the `prop` command — closing the last
  `commands → lib` reach in the write path. `getProps` stays as `writeSnapshot`'s test seam.
  Glossary term **Props** added to [CONTEXT.md](../CONTEXT.md).
- **"Extract a snapshot codec/grammar module" — reconsidered, still rejected.** It re-floated
  splitting the grammar (`parseSnapshotStream`/`snapshotNames`/the writers) out of
  `snapshot-file.mjs` into a module the local and remote readers both compose. It contradicts
  [ADR-0028](../docs/adr/0028-snapshot-writer-owns-the-grammar.md) (the grammar is deliberately
  the writer's, in one module) and re-treads the section-3 rejection below — those exports are
  real seams; the reader half is deep. Don't re-suggest. The "500-line file" that prompted it is
  ~200 lines of code under heavy JSDoc — file size is not a depth signal.
- **"Concentrate the list-and-strip mechanic across `objects`/`remote`/`set-marker`" — not worth
  it.** The shared part (iterate `listObjects`, slice the prefix) is ~1–2 lines; each caller's
  real work diverges (bare hash / datestamp filter+sort / segment+dedup+filter). Both reviews
  found the remote engine cleanly seamed, and merging the per-prefix modules would contradict
  [ADR-0013](../docs/adr/0013-one-repository-one-bucket.md)/[ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md).
  Skip (#7).

---

## 2. Test `diff` at its own interface, not through the I/O shell — *worth exploring*

### The problem (verified)

`diff` in `src/lib/compare.mjs:196` is a **pure, in-process** function (two `SnapshotEntries`
Maps in, four classification sets out) and it holds the codebase's most intricate logic: the
greedy move-pairing and copy-annotation at `:226-272`. It is `export`ed — but **every one of its
tests reaches it through `compareSnapshots`**: `compare.test.mjs` calls `compareSnapshots` 22
times and `diff` zero times, each test building real compressed `.tsv.zst` fixture files via
`withSnapshotFile` + `stringifySnapshot`. The deepest logic has the most expensive test access,
and edge cases of the pairing (rotations, swaps, copies-of-moves) are costly to set up through
file I/O.

### The deepening

This is a **test-discipline** change, not a structural one — `diff` already sits at the right
seam (exported, pure). Drive it directly with in-memory Maps; keep a thin set of
`compareSnapshots` tests for the parts only it adds (snapshot resolution defaults — `since`/`until`
— and `relativeToRoot` display). Dependency category 1 (in-process): no adapter, test through the
interface directly.

Wins: interface is the test surface; pairing edge cases cheap to enumerate; tests survive I/O and
format refactors. Pairs with CLAUDE.md convention #8 (coverage by review). Cheap, high-value;
could even ride along with candidate 1 since both touch this corner.

Decision for later: keep `diff` exported purely as a test surface (a deliberate internal seam
exposed), or is direct testing of a still-`export`ed-for-one-reason function fine? It has no
non-test caller besides `compareSnapshots` — so the export is *only* a test seam today. That's
acceptable (an internal seam used by its own tests) but worth a conscious call.

---

## 3. Narrow the snapshot read surface — *considered, REJECTED on verification*

Recorded so a future review doesn't re-suggest it. The HTML report's candidate 3 floated
collapsing the three read paths and making `snapshotNames` internal. **It does not hold** — each
read/list export has a distinct real caller, so they are three genuine seams, not a wide-shallow
surface:

- `parseSnapshotStream` (`snapshot-file.mjs:261`) — real second caller `remote.mjs:95`
  (reads a snapshot straight from the S3 body stream, no temp file). Real seam; keep public.
- `snapshotNames` (`snapshot-file.mjs:176`) — real second caller `remote.mjs:51` (the remote
  lister runs S3 keys through the same name filter/sort as the local lister). Real seam; keep
  public.
- `readSnapshotFile` (`snapshot-file.mjs:226`) — real external caller `prop.mjs:53` (the
  `prop --lookup <path>` case reads a snapshot file by path). Not just a shallow resolver.
- `readSnapshot` (`snapshot-file.mjs:154`) — four callers (`status`, `snapshot`, `remote`,
  `compare`), the by-name-in-a-set's-dir path.

The only shallow link is `readSnapshot` → `readSnapshotFile` (one delegation), but both are
independently called, so collapsing them removes a real entry point. Candidate 1 already
consolidates the *writer* half of `snapshot-file.mjs`; the *reader* half is genuinely deep. No
action.

---

## 4. Unify the "resolved backup set" (set + applied env) — *parked: contradicts ADR-0022*

### The friction (real)

"A resolved set" is two things in two files: `resolveSet` (`sets.mjs`) builds the `BackupSet`
value; `loadSet` (`env.mjs:126`) wraps it and **mutates `process.env`** as a side effect to apply
the set's env layer. Calling `resolveSet` directly gets you a correct `BackupSet` but silently
**skips the env layer** — a latent trap for a new command or a library consumer. Understanding
the full picture means bouncing between `sets.mjs` (the typedef + bucket invariant) and `env.mjs`
(the layering + once-per-run guard).

### Why it's parked, not proposed

This contradicts **ADR-0022** (env is loaded at the entry point; the set layer goes through the
`loadSet` door) — a *pinned* decision, and the two-door split is deliberate. The
`/improve-codebase-architecture` rule is to surface an ADR conflict only when friction warrants
reopening; the friction here is real (the `resolveSet`-vs-`loadSet` trap; env-as-global-side-effect
is awkward to test) but not clearly worth reopening a settled ADR.

If revisited: the shape would be one resolution call returning the set *and* its resolved config
together (no global side effect), e.g. `resolveSet(name) → { set, env }`, with callers reading
config from the returned value rather than `process.env`. That's a large blast radius (every set
command + `s3.mjs`'s credential/region reads). **Likely outcome: leave it, or record the
rationale in ADR-0022** so it stops surfacing. Don't action without an explicit decision to reopen
the ADR.
