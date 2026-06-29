# The snapshot writer owns the grammar; the walk yields exclusions as data

**Status:** accepted

`writeSnapshot(snapshotDir, name, { identity, dirs, datetime, files, excluded, getProps, overwrite })`
in [`src/lib/snapshot-file.mjs`](../../src/lib/snapshot-file.mjs) is the single deep seam for
"files → snapshot file". It owns the whole write: the `#SNAPSHOT`/`#DIR` header, the
`#EXCLUDED` rows, the props→TSV pipeline (and its `[path, Props | Error]` row type), the
`#ERROR` rows, zstd compression, and the temp-file rename. The grammar formatters
(`formatLine`, `snapshotHeader`, `excludedLine`, `errorLine`) and the `SnapshotRow` type are
**module-private** — they never leave `snapshot-file.mjs`.

The walk ([`src/lib/walk.mjs`](../../src/lib/walk.mjs)) **yields exclusions as data**:
`walkSet(set) → { files, excluded }`, where each exclusion is a `{ fileType, reason, path }`
record (all known from the `Dirent`, no extra `stat`). It no longer imports the snapshot
grammar and no longer threads a write stream down through `walkSet → walkDirs →
createWalkCallbackFn`. `snapshot.mjs` becomes a thin caller: `walkSet → writeSnapshot →
compareSnapshots`.

## Why

"Write a snapshot" was one concept smeared across three modules, and the grammar leaked into
the walk: `walk.mjs` imported `excludedLine` and wrote `#EXCLUDED` rows mid-walk into a stream
threaded in purely to carry them; `snapshot.mjs` glued the header + the props pipeline; and
`snapshot-file.mjs` owned the format — so `SnapshotRow` was defined, produced, and consumed in
three different files. The write path also had **no single seam to test through** (`walkSet`,
`excludedLine`, and `withSnapshotFile` were each untested in isolation). Collapsing the write
behind one interface closes the leak, puts `SnapshotRow` production and consumption in one
module, and gives the write path a testable seam (driven with an injected `getProps`, no disk).

## Considered options

- **The walk's exclusion output: callback vs. return value.** A callback
  (`walkSet(set, onExcluded)`) is the *same* threaded-sink shape the refactor set out to
  remove — just a function instead of a stream — and splits the walk's output across two
  channels (files returned, exclusions pushed). A callback's one real advantage, reacting
  incrementally to a long producer, does not apply: the walk is eager and small in memory (an
  excluded *directory* yields one record — the walk doesn't recurse into it). Return
  `{ files, excluded }` puts both outputs in one value with nothing threaded in. **Chosen:
  return value.**

- **Hashing: inject vs. import vs. move `prop`.** `writeSnapshot` must hash files, but `prop`
  is a command and `lib/` must not import `commands/`
  ([0023](0023-porcelain-plumbing-lib-layers.md)). Moving `prop` into `lib/` was out of scope
  (it would move a command); passing the pre-built row stream in would leave
  `createPropsGenerator` and the error-tuple in the command, re-splitting the `SnapshotRow`
  contract across modules. **Chosen: inject `getProps`** — the command (which legitimately
  imports `prop`) passes `(path) => prop(path, { lookup })`, so the previous-snapshot lookup is
  the command's concern and `lib` receives a function, not a command import.

- **How far to privatize.** `stringifySnapshot` (rows → TSV lines) and `withSnapshotFile`
  (managed compressed atomic write) are **kept exported** as deliberate lower-level seams: the
  compare tests synthesize controlled snapshots (precise size/mtime/hash, including synthetic
  `#ERROR` rows) *without* disk hashing, which routing them through `writeSnapshot` would
  break (Files would have to be written to disk, resetting their mtimes). `withSnapshotFile`
  is genuine layering (the durable-IO primitive beneath `writeSnapshot`); `stringifySnapshot`
  is a consciously-exposed internal seam for its own tests. The **named grammar formatters**
  are what go private — that is the leak that mattered (into the walk and the command), and it
  is fully closed.

## Consequences

- Stays within `lib/`; [0023](0023-porcelain-plumbing-lib-layers.md) and the
  `local/one-export-per-command` rule are untouched — `snapshot.mjs` keeps its single export
  and calls the new `lib` function. `tree` (the walk's other consumer) takes `walkSet(...).files`.
- The same-minute existence check now runs *after* the command's `walkSet` (the walk is no
  longer inside the write callback), so an accidental same-minute re-run wastes the few-second
  walk — but still fails before the expensive hashing. Accepted to keep the progress bar in the
  command rather than baking CLI UI into the `lib` writer.
- Write order is header → excluded → entries (`#ERROR` rows inline with entries): the
  skipped-and-why diagnostics sit near the top, where someone opening the file to ask "why
  wasn't X backed up?" finds them without scrolling past the entries. Parsing is marker-driven,
  so order does not affect correctness.
