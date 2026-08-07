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
  - **This now needs a stopping rule, not more investigation.** Every cheap instrument is spent
    and every named mechanism but one is struck. The trap is armed and costs nothing to leave, but
    the entry cannot sit open indefinitely when it is the last thing between here and a release
    that requires this file to be empty. If it has not recurred by the time the rest of the
    release checklist is clear, close it as an un-reproducible local-environment artifact **with
    the trap left in place** — that is a decision to take deliberately, not by default.
  - Noticed in passing, not a cause: [snapshot.test.mjs](../src/commands/snapshot.test.mjs) is the
    only one of the 30 temp-dir users that skips `mkdtempDisposable`, building a deterministic
    `test/.tmp/<test name>` instead — safe only because Node runs one file per worker, and the
    reason a bare `test/.tmp` sits in the tree.
