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
    ([upload.mjs](../src/lib/upload.mjs), `fileChanged`), `c.txt` is seeded as `"world"` (5 bytes)
    and the drift mock overwrites it with a 38-byte string. **The size differs, so detection is
    deterministic** and clock granularity never enters into it.
  - ~~**Cross-test interference via shared mock state.**~~ **Also weaker than it reads:** there
    are 9 module-level `let` bindings in the file, but its single `beforeEach` resets **all
    nine** — no binding is missed.
  - **The live lead: contention on the shared `test/` directory.** 29 test files create temp dirs
    with `mkdtempDisposable(join("test", ".tmp"))`, and Node isolates per *file* across parallel
    workers — so ~29 processes concurrently create and remove siblings in one directory, and
    `await using` disposal is the least visible part of the call site. On Windows that is the
    usual home of `EPERM`/`ENOTEMPTY`/`EBUSY` under load. It fits the shape better than either
    hypothesis above: two *adjacent* tests failing together, on a PR touching none of the code,
    never reproducible alone. **It also predicts the fault is not in `upload.mjs` at all** — which
    would retire the "masking a real race" worry above.
  - **Diagnose before fixing** — a fix cannot be verified while the suite is green either way.
    Loop the file alone (expect: clean), then loop the full `npm test`, then compare against
    `--test-concurrency=1`: clean sequential + dirty parallel is the contention signature.
    **Capture the full failure text, not the test name** — an `EPERM` on disposal and a blown
    assertion read nothing alike, and that one line picks between the theories. Note
    `--test-isolation=none` destroys the per-file isolation under suspicion, so it is a probe
    here, never a speed fix (and it is ~1.8× slower anyway).
