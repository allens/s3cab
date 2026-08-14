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
([ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)). The name-only HEAD that
fix introduced has since become a byte-identity GET
([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md), 2026-08-14).</sub>

---

<sub>An **adversarial durability audit of the 1.0 format freeze** (2026-08-12, Claude Fable at
xhigh reasoning, reading `88fbc70`) contributed five entries; its brief was the one failure that
matters — *a backup that reports success but cannot be restored*. Each entry was pinned by a
deterministic current-behaviour test in the model-based suite ([test/model/](../test/model/)),
and **all five are fixed, 2026-08-14**, their pinning tests flipped to the correct behaviour: a
file mutated *during* its upload stored as wrong bytes under a right hash, by `putFile`'s
streamed-digest check ([ADR-0083](../docs/adr/0083-streamed-digest-upload-guard.md)); `backup`
exiting 0 with unreadable files, by setting `process.exitCode = 1` whenever the pass recorded
`#ERROR` rows; the pair rooted in snapshot *names* not identifying snapshots — another machine's
same-name snapshot vouching for a never-uploaded baseline, and a retried manifest PUT harvesting
a 412 from its own lost-response success — by keying both checks on byte-identity with the local
file ([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md)); and the mtime-precision
staleness escape (a same-size rewrite that puts the old mtime back, confirmed on real NTFS), by
distrusting any size+mtime match whose ctime postdates the baseline's instant
([ADR-0085](../docs/adr/0085-ctime-cross-check-on-hash-reuse.md)). The audit's full report —
state model, reproduction sequences, and the **ruled-out** list (what was attacked and which
guard held) — is kept **outside the repo** as `s3cab-durability-audit-2026-08-12.pdf`; the state
model is now [docs/design/repository-protocol.md](../docs/design/repository-protocol.md).
Headline result: the objects-first/snapshot-last invariant **holds under process termination at
every step** — what broke was concurrency and time.</sub>

<sub>The model-based test suite itself (prompt #3, 2026-08-14) found three more, **all fixed
2026-08-14**, each pinned by a test that now asserts the correct behaviour: a truncated stored
manifest parsing as a valid empty snapshot while `verify` called the store healthy, by the
`#END` trailer ([ADR-0082](../docs/adr/0082-snapshot-end-trailer.md)); case-colliding manifest
paths restoring to one silently-overwritten file with exit 0 — the same hazard APFS's
unicode-normalisation folding poses for NFC/NFD neighbour paths — by keying collision detection
on the filesystem's own equivalence rather than lowercasing
([ADR-0086](../docs/adr/0086-restore-collision-filesystem-equivalence.md)); and the latent
percent-encoding of non-ASCII S3 keys (`parseS3Uri` took `new URL(...).pathname`, so a set
named `café` — reachable only if `validateSetName`'s `[a-z0-9-]+` charset is ever loosened —
stored its manifests under `snapshots/caf%C3%A9/…`, breaking
[guide/format.md](../guide/format.md)'s promise that keys are `snapshots/<set>/…`), by parsing
the URI as a plain string split so keys reach the bucket verbatim; only the Tier 2 inspector
could see that one, since every seam call encoded identically
([test/model/conformance/store-semantics.test.mjs](../test/model/conformance/store-semantics.test.mjs)).</sub>

- **The loser of a same-name manifest race loses its snapshot behind a misleading error.**
  **Confirmed live, multi-process** (2026-08-14, crash tier): two real CLI processes, separate
  `S3CAB_HOME`s, different tree content, same set and same minute — the loser of the manifest
  no-clobber race fails with *"Snapshot '…' is already backed up … Snapshots are immutable and
  never overwritten"*, which is true of the **name** and false of the loser's **data** (its
  differing file's object is uploaded, but no manifest records it). Repro: *"same set, same
  snapshot name"* in [test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs).
  [ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md) settled the *identity* half of
  this — the byte comparison tells a run's own retried PUT (identical, quiet success) from a
  foreign snapshot (different) — but the *different* case still ends the run with that message
  and nothing published.
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
