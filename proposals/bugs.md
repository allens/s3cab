# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

<sub>Last cleared 2026-07-19: the HIGH baseline-trust hole (`backup` trusting a local
`--since` baseline whose remote snapshot a `forget` + `cleanup --delete` had since removed —
publishing a snapshot referencing a deleted object) was fixed by trusting the baseline **iff
it still exists remotely**: `uploadSnapshot` HEADs the baseline's remote snapshot before
believing it, and on a miss drops the baseline and LISTs the store as a first backup would.
The same check also covers a baseline snapshotted locally but never uploaded. The deletion
rework's interlock — subtracting deletion-record hashes from any trusted baseline — landed
with the path-scoped `delete`
([ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)).</sub>

---

<sub>The five entries below came from an **adversarial durability audit of the 1.0 format
freeze**, 2026-08-12 (Claude Fable at xhigh reasoning), reading `88fbc70`. Its brief was the one
failure that matters — *a backup that reports success but cannot be restored* — and its full
report, including the state model, the reproduction sequences and the **ruled-out** list (what was
attacked and which guard held), is kept **outside the repo** as
`s3cab-durability-audit-2026-08-12.pdf`. The state model it had to build first is now
[docs/design/repository-protocol.md](../docs/design/repository-protocol.md). Headline result: the
objects-first/snapshot-last invariant **holds under process termination at every step** — no kill
sequence broke it. What broke was concurrency and time.

**2026-08-14 update: each of these five entries is now pinned by a deterministic test** in the
model-based suite ([test/model/](../test/model/)) — each cited test asserts *current* (wrong)
behaviour with a TODO, so fixing the bug flips the test loudly and hands the fixer a ready-made
regression test.</sub>

- **The baseline HEAD matches on snapshot *name*, so another machine's snapshot can vouch for one
  that was never uploaded.** `storedHashes` ([upload.mjs](../src/lib/upload.mjs)) trusts the local
  baseline as the complete skip-list once `objectExists(remoteSnapshotUri(bucket, set, since))`
  returns true — **presence by name, with no ETag, size or content comparison.** Snapshot names are
  minute-precision *local* wall-clock with the zone recorded inside the file but not in the name,
  and two live machines on one set is a tolerated state (`reattach` never disables the prior
  machine, [ADR-0053](../docs/adr/0053-reattach-command.md)).
  - **Repro:** machine A runs `snapshot` offline at its local `2026-08-12T0915` and never uploads
    it (nothing on a local snapshot records whether it was uploaded). Machine B — another timezone,
    or simply the same minute — publishes a remote `2026-08-12T0915` for the same set. A's next
    `backup` picks its own local `0915` as baseline, the HEAD finds B's remote `0915`, A trusts its
    own never-uploaded hashes as stored, skips those objects, and publishes a manifest referencing
    objects that were never uploaded — reporting success.
  - **This is a corner of a hole believed closed.** The 2026-07-19 note at the top of this file
    says the HEAD check "also covers a baseline snapshotted locally but never uploaded". That is
    true single-machine — no remote snapshot with that name exists, the HEAD misses, and the run
    falls back to a full LIST. The case it does not cover is a *second machine* occupying that
    name.
  - Caught later by `verify` as unexplained-missing (exit 1), so it is silently-incomplete rather
    than silently-corrupt — but the backup that created it said it succeeded.
  - The same collision also defeats snapshot immutability quietly in the other direction: A never
    learns that its local `0915` and the remote `0915` are different documents.
  - **That other direction is confirmed live, multi-process** (2026-08-14, crash tier): two real
    CLI processes, separate `S3CAB_HOME`s, different tree content, same set and same minute —
    the loser of the manifest no-clobber race fails with *"Snapshot '…' is already backed up …
    Snapshots are immutable and never overwritten"*, which is true of the **name** and false of
    the loser's **data** (its differing file's object is uploaded, but no manifest records it).
    Repro: *"same set, same snapshot name"* in
    [test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs).
  - Pinned by *"another machine's same-name snapshot vouches for a never-uploaded baseline"*
    ([test/model/model.findings.test.mjs](../test/model/model.findings.test.mjs)).
- **A retried manifest PUT after a lost response reports a false failure.** If the no-clobber
  manifest PUT succeeds but its response is lost and the retry relay
  ([ADR-0068](../docs/adr/0068-network-retries-above-the-sdk.md)) re-sends, the retry collects a
  412 from its own success and `uploadSnapshotFile` throws *"Snapshot '<name>' is already backed
  up… immutable"*. The backup is complete and correct; only the report is wrong. Fails in the safe
  direction, but it teaches the user to distrust a message that otherwise means something serious.
  The same shape applies to `setup`'s `info` claim. Pinned by *"a manifest PUT whose lost response
  is retried reports a false failure"*
  ([test/model/model.findings.test.mjs](../test/model/model.findings.test.mjs)).
- **Confirmed 2026-08-14: both staleness guards compare mtime at millisecond precision, so a
  same-size write that preserves mtime escapes.** The baseline reuse check
  ([file-props.mjs](../src/lib/file-props.mjs)) and `fileChange` ([upload.mjs](../src/lib/upload.mjs))
  both test `size` plus `mtime.toISOString()`. A deliberate `touch -r`, or a filesystem with coarse
  timestamps (FAT32's 2 s, some network mounts), records an old hash against new bytes — and restore
  then "succeeds" with the wrong content. `--rehash` exists as the escape hatch. Was *suspected* from
  reading the code path; now **confirmed on real NTFS** — a same-size rewrite plus `utimensat`-style
  mtime restoration makes the next `backup` upload nothing, and the restore returns the old bytes.
  Pinned by *"a same-size rewrite preserving mtime escapes the staleness guards"*
  ([test/model/model.findings.test.mjs](../test/model/model.findings.test.mjs)).

<sub>The three entries below were **found by the model-based test suite itself** (prompt #3,
2026-08-14) — the first two by Tier 1 hostile/targeted cases, the third by the Tier 2 conformance
run against real S3. Same convention as above: each is pinned by a current-behaviour test that
flips when the bug is fixed.</sub>

- **Case-colliding manifest paths restore to one file — silently, exit 0.** Two rows whose paths
  differ only in basename case (legal in a manifest: a case-sensitive source filesystem, another
  machine, or a crafted edit) restore onto a case-insensitive volume as *one* file holding the
  **last** row's bytes, while `restore` reports both files restored and exits 0. Nielsen would
  call the count a lie; either an overwrite warning or a collision error is defensible, silence is
  not. Pinned by *"restore claims both case-colliding paths while disk keeps one"*
  ([test/model/model.hostile.test.mjs](../test/model/model.hostile.test.mjs)). APFS's
  unicode-normalisation folding is the same hazard for NFC/NFD neighbour paths — macOS CI
  collapsed the hostile suite's café pair on 2026-08-14 — so whatever fix lands here must key on
  the filesystem's own equivalence, not on lowercasing.
- **Latent: a non-ASCII name fed to the S3 layer lands under a percent-encoded key.**
  `parseS3Uri` ([s3.mjs](../src/lib/s3.mjs)) splits the URI with `new URL(...)` and takes
  `url.pathname`, which percent-encodes — a set named `café` would store its manifests under
  `snapshots/caf%C3%A9/…`, verbatim, in the real bucket (observed on real S3 by the Tier 2
  conformance run, driving the seam below the validation layer). Three consequences: the stored
  layout breaks [guide/format.md](../guide/format.md)'s promise that keys are `snapshots/<set>/…`
  (a no-lock-in reader must know to percent-decode); names derived from LIST results don't match
  the names that produced them; and two different names (`café` and the literal string
  `caf%C3%A9`) alias to one key. **Latent, not user-reachable today:** `validateSetName`
  ([sets.mjs](../src/lib/sets.mjs)) restricts set names to `[a-z0-9-]+` at both entry points
  (`setup`, `reattach`), and snapshot names, object keys and the fixed filenames are all
  ASCII-safe — [remote.mjs](../src/lib/remote.mjs) documents that charset as the reason "no
  escaping anywhere downstream" is safe. So this is the *seam* that validation guard is silently
  load-bearing for: loosen the set-name charset (a plausible pre-1.0 ask) and the encoding bug is
  live. Round-trips still work because every code path encodes identically — which is exactly why
  Tier 1's fake (same URL parsing) could never see it and only Tier 2's independent inspector
  did. Pinned by *"a unicode set name is stored under a percent-encoded key"*
  ([test/model/conformance/store-semantics.test.mjs](../test/model/conformance/store-semantics.test.mjs)).

- **`uploadDir`'s drift tests fail intermittently — undiagnosed.** Seen 2026-07-30 during
  [#252](https://github.com/allens/s3cab/pull/252) (a PR touching none of this code). Two tests in
  [src/lib/upload.test.mjs](../src/lib/upload.test.mjs) — *"never stores a file that changed while
  it was being hashed"* and *"seeds every other file, and succeeds — the seed publishes no
  manifest"* — failed **together** in one full `npm test`, then passed on three consecutive full
  runs and passed with the file run in isolation. Not reproduced since; **no cause established.**
  - **Why it matters more than a normal flake:** these are the tests
    [#248](https://github.com/allens/s3cab/pull/248) added to prove `upload --dir` closes
    ADR-0069's hash-then-PUT corruption window. An intermittent red on a *corruption-detection*
    test is the kind that gets waved through as "just flaky" — and it is also the kind that could
    be masking a real race in the code under test rather than in the test.
  - ~~**Timing — the drift leans on real mtime resolution.**~~ **Struck 2026-08-07, statically.**
    The guard is `current.size !== recorded.size || current.mtime… !== recorded.mtime`
    ([upload.mjs](../src/lib/upload.mjs), `fileChange`), `c.txt` is seeded as `"world"` (5 bytes)
    and the drift mock overwrites it with a 38-byte string. **The size differs, so detection is
    deterministic** and clock granularity never enters into it.
  - ~~**Cross-test interference via shared mock state.**~~ **Also weaker than it reads:** there
    are 9 module-level `let` bindings in the file, but its single `beforeEach` resets **all
    nine** — no binding is missed.
  - ~~**The live lead: contention on the shared `test/` directory.**~~ **Struck 2026-08-07,
    empirically.** 29 concurrent processes running the exact `mkdtempDisposable(join("test",
    ".tmp"))` → build-fixture → dispose cycle, 300 rounds each (8,700 cycles), raised no
    `EPERM`/`ENOTEMPTY`/`EBUSY` at all. Windows tolerates this pattern far better than the theory
    assumed, so the "not in `upload.mjs` at all" reassurance it offered **does not hold** — the
    "masking a real race" worry above stays open.
  - **Did not reproduce, 2026-08-07.** 500 runs of the file alone; ~50 full `npm test` runs, 20 of
    them with two further full suites running concurrently (16.9s against a ~12s idle baseline, so
    the contention was real). All green, `fail 0`.
  - **The narrowing that survived.** Because detection is deterministic on size, these two tests
    can fail *together* only if **the drift write never happened** — `driftAfterHash.has(path)`
    was false, or `c.txt` never reached the hasher. (Once it fires, test 1's `skipped` and test
    2's `putFiles`/`uploaded` are all forced.) So the fault is in the fixture or the path fed to
    the mock, not in the guard.
  - ~~**A transient FS error in `fileProps` skipping the rewrite.**~~ **Struck 2026-08-07,
    empirically.** The wrapper hashes before it edits, so a throw does skip the edit — but a throw
    from `fileProps` is **not** absorbed into an `#ERROR` row on this path. Injecting one shows it
    propagating straight out of `uploadDir`, failing the test with the raw error, its `code`, and a
    stack, and taking out **six** `uploadDir` tests rather than two. So this mechanism cannot
    produce the observed signature — a quiet failure of exactly the two drift tests. (Note the
    contrast with `fileChange`'s own `lstat`, which *is* caught deliberately.) It also means the
    trap's message is sound as written: whenever it prints, hashing did not throw.
  - **So a path mismatch is the last mechanism standing** for a quiet two-test failure, and the
    trap already reports it precisely, printing both strings. Start there.
  - **Never seen in CI, 2026-08-07.** 134 `ci` runs since [#248](https://github.com/allens/s3cab/pull/248)
    added these tests — each with a `windows-latest` leg — and not one drift failure. Of the three
    red runs in that window, one was GitHub infrastructure (*"Failed to resolve action download
    info"*), one an unrelated ubuntu job, one unrelated. [#252](https://github.com/allens/s3cab/pull/252)'s
    own runs were green on a single attempt, so the sighting was **local, not CI**. A CI loop is
    therefore the wrong instrument: it is 134 samples of not-reproducing. Whatever this is, it
    involves the local Windows box.
  - **Diagnose before fixing** — a fix cannot be verified while the suite is green either way. The
    cheap loops are now exhausted; the next sighting is worth more than more running, so
    `upload.test.mjs` now records whether the drift actually fired and asserts it in both tests: a
    future red states *"the drift never happened"* outright instead of leaving the theories tied.
    Still **capture the full failure text, not the test name.** Note `--test-isolation=none`
    destroys per-file isolation, so it is a probe only, never a speed fix (~1.8× slower anyway).
  - **Stopping rule: if it has not recurred by 2026-08-31, delete this entry.** Close it as an
    un-reproducible local-environment artifact and **leave the trap in place** — the trap is the
    thing of value, and it costs nothing to keep. Every cheap instrument is spent and every named
    mechanism but one is struck, so what remains is waiting, and waiting needs an end: this is the
    only entry in the file, and the file must be empty to release. Deleting it is then a
    deliberate call on stated evidence, not the entry rotting open by default.
    - **What counts as recurring:** a red on *either* drift test, on any machine. If that happens,
      the clock is void — capture the full failure text and start from the trap's message, which
      distinguishes a path mismatch (the last mechanism standing) from anything else.
    - **What does not reset it:** the suite passing. It has passed ~50 full local runs, 500
      isolated runs and 134 CI runs already; more green is not new evidence, and re-running to
      build confidence is the trap this rule exists to stop.
  - Noticed in passing, not a cause: [snapshot.test.mjs](../src/commands/snapshot.test.mjs) is the
    only one of the 30 temp-dir users that skips `mkdtempDisposable`, building a deterministic
    `test/.tmp/<test name>` instead — safe only because Node runs one file per worker, and the
    reason a bare `test/.tmp` sits in the tree.
