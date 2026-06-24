# Architecture — module deepening

Epic: turn shallow modules into deep ones — more behaviour behind a smaller interface, placed
at a clean seam, testable through that interface (leverage for callers, locality for
maintainers). Candidates surfaced by the 2026-06-24 architecture review
(`/improve-codebase-architecture`); the ephemeral HTML report is gone, this is the lasting
capture. Strength tags carried over: **Strong** / **Worth exploring** / **Speculative**. When one
lands, its decision moves to an [ADR](../docs/adr/) (or the design to
[docs/specs/](../docs/specs/)) and the entry is deleted.

- **Pure `planUpload` — give `backup` the `planRestore` treatment.** _(Strong — top pick.)_
  `restore` split its decision step (`planRestore`, pure and unit-tested without S3) from its
  I/O loop; `backup` never got the same treatment. `uploadSnapshot`
  ([src/lib/remote.mjs](../src/lib/remote.mjs)) interleaves the upload-set decision —
  `uploadCandidates` (target − latest remote) minus the per-bucket objects cache
  (`knownObjects`, [src/lib/objects.mjs](../src/lib/objects.mjs)), then first-path-wins
  `pathByHash` selection — directly with the `putObject` loop. So only the pure
  `uploadCandidates` diff is unit-tested; the cache-narrowing + path-selection logic is reachable
  only through the gated real-S3 tests. Extract a pure `planUpload(target, remote, cached) →
  Map<hash, path>` and shrink `uploadSnapshot` to *executing* the plan (PUT + `recordObjects` +
  snapshot-last). Then the spec's "how `backup` computes the upload set" is one testable
  function, mirroring the already-accepted `planRestore`. Purely additive — no ADR tension.

- **Lift the file-hashing engine out of the `prop` command into `lib/`.** _(Strong.)_ The
  path→`Props` hashing engine (lstat, the 5 MB slurp/stream boundary, previous-snapshot lookup
  reuse, the empty-file shortcut) lives inside [src/commands/prop.mjs](../src/commands/prop.mjs).
  `snapshot` and `upload` reach into that sibling command for it, and `writeSnapshot`
  ([src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)) can only get it via an **injected
  `getProps`** because `lib` must not import `commands` ([ADR-0023](../docs/adr/0023-porcelain-plumbing-lib-layers.md))
  — that injection is the tell that a `lib/` primitive is trapped in `commands/`. Extract
  `hashFile(path, { lookup }) → Props` to `lib/hash.mjs`; `prop` becomes a thin command that adds
  the CLI-only concerns on top (`hashDuration`, the `File` input, `--lookup <snapshot-file>`).
  Deletion test: delete `prop.mjs` and the hashing logic reappears across its callers — it earns
  its keep, it's just in the wrong layer. **Reopens a sanctioned exception** (CLAUDE.md allows
  "`upload` and `snapshot` call `prop()`"), but the one-export rule's own remedy is "extract it to
  `lib/`."

- **One atomic `downloadToFile` at the S3 seam.** _(Worth exploring — and the one candidate that
  genuinely reduces total lines.)_ `getObject` ([src/lib/objects.mjs](../src/lib/objects.mjs)) and
  `downloadRemoteSnapshots` ([src/lib/remote.mjs](../src/lib/remote.mjs)) each hand-roll the same
  dance — temp-sibling path → `pipeline` → atomic `rename` → `unlink`-on-error in a `try/catch` —
  differing only in that `getObject` taps the stream through a SHA-256 verifier and
  `downloadRemoteSnapshots` copies verbatim. Extract `downloadToFile(uri, destPath, { tap })` at
  the [src/lib/s3.mjs](../src/lib/s3.mjs) seam; `getObject` passes the hashing tap,
  `downloadRemoteSnapshots` passes none. Two real adapters justify the seam, atomicity/cleanup
  live in one place, and callers shrink to the part that varies. (`withSnapshotFile` shares the
  temp+rename shape but streams *out* through zstd — fold it in only if the abstraction stays
  honest; don't stretch one primitive over two different writes.)

- **One snapshot-name authority — and close the two-clock gap.** _(Worth exploring.)_ The snapshot
  timestamp format is spelled in three places:
  [src/commands/snapshot.mjs](../src/commands/snapshot.mjs) renders "now" **twice** — the filename
  `2026-06-12T0915` (no colon) and the `#SNAPSHOT` header `2026-06-12T09:15` (colon) — from two
  separate `Temporal.Now` reads with an `await readSnapshot(previous)` *between* them, and
  [src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)'s `snapshotNames` regex independently
  encodes the no-colon filename shape. If the clock crosses a minute boundary during that `await`,
  the filename disagrees with its own `#SNAPSHOT` header. A `snapshotName` module: one `now()`
  capture → `{ name, datetime }` plus the recognizer, living beside `parseSnapshotStream`. Format
  in one place; name ↔ header consistent by construction; latent skew closed.

- **`compareSnapshots` returns structured diff, not display strings.** _(Speculative.)_ `diff`
  ([src/lib/compare.mjs](../src/lib/compare.mjs)) is exemplary — pure, structured, each rule
  pinned by a test. But `compareSnapshots` wraps it and bakes **presentation** into the returned
  `CompareResult` — root-relative paths (`relativeToRoot`) and the `==` / `→` / `→→` arrow
  rendering — so the lib seam hands callers formatted text, not data. A second consumer (a
  `--json` mode, a TUI) couldn't get the structured relations without re-parsing the arrows. Split:
  `compareSnapshots` returns structured relations; a formatter at the command edge renders the
  display. **Speculative on purpose** — only the terminal renderer consumes this today, so by the
  project's own bar ([ADR-0006](../docs/adr/0006-minimal-code.md) / convention #8) it's a
  hypothetical seam until a second output format actually appears. Listed for when it does.
