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
  - **Two hypotheses, and the evidence favours the second.** (a) Timing: the drift is reproduced
    through the real mechanism (hash the bytes, then edit the file), so it leans on real mtime
    resolution. (b) **Cross-test interference** — shared temp dir, mock state, or a lingering
    handle. Both failures landed in the *same file in the same run*, which independent timing
    jitter would not usually produce, and Node's isolation is per **file**, so tests inside
    `upload.test.mjs` do share a process.
  - **Diagnose before fixing** — a fix cannot be verified while the suite is green either way.
    Start by running that file alone in a loop, then with `--test-concurrency=1`, and check what
    the two tests share (temp dirs, `mock.module` state, the fake clock).
