# `find` matches like POSIX `find`, over local snapshots only

**Status:** accepted — designed in a grilling session 2026-08-22, built the same day. Joins
the local-only browse commands of [0027](0027-compare-local-only-adoption-syncs-manifests.md) and
follows [0062](0062-bulk-operands-positional-addressing-by-flag.md)'s operand/addressing split.
The hash-operand `delete` that consumes its output is [0089](0089-hash-operand-delete.md); only
`find` is decided here.

## Context

"Which snapshot has my file, and what did it hash to" has no answer in the tool today. It is
worth a command on its own, and it is also the read-only half of a destructive operation:
splitting `delete` so it takes **hashes** moves the fuzzy, over-matching-prone step into a
command where a mistake costs nothing.

That makes the matching rules load-bearing. s3cab already has a glob compiler —
`compileExclude` — but exclude patterns are **root-relative and anchored**, which is right for
pruning a subtree and wrong for finding a file. Under exclude's rules `secretsdir/` matches
nothing at all (snapshots have no directory rows) and `*/junkfile.dat` matches only one level
down. A user searching their backups reaches for the semantics of the tool named `find`.

Snapshots are also not local artifacts of *this* machine the way an exclude pattern's inputs
are. A Windows set restored or inspected from Linux is a real case (`restore --output` exists
for it), so a path out of a snapshot may be Windows-shaped while `process.platform` says
`linux`.

## Decision

**`find` borrows POSIX `find`'s anchoring and `compileExclude`'s token grammar**, with the two
kept in one place: `lib/path-match.mjs` exports `globSource` (the token compiler: `*`, `?`,
`**`, `**/`) and `isWindowsPath`, and `exclude.mjs` and `find.mjs` each apply their own
anchoring, normalization and case rule on top. Neither imports the other — importing the
compiler *from exclude* would invite exactly the confusion this ADR exists to prevent.

- **No separator in the pattern → match the basename** (`aws-keys.txt`, `*.mov`). **A separator →
  match the whole path, floating** — an implicit `**/` on the front, so `me/Documents/tax`
  matches at any depth but keeps its segment alignment. **A trailing separator → everything
  beneath that directory** (`secretsdir/`).
- **Case-sensitivity keys on `isWindowsPath` — the shape of the path being tested**, never
  `process.platform`. Separators in the *pattern* key on `process.platform`, because the pattern
  was typed at this machine's shell while the path came out of a snapshot possibly taken on
  another OS.
- **Local snapshots only, no `--remote`, no `--bucket`.** ADR-0027 settled that `reattach` pulls
  a set's entire history precisely so browse commands stay local; `find` joins them and costs
  zero S3 calls. It searches every attached set, `--set` narrows.
- **Two passes.** Pass 1 matches paths and collects their hashes (typically one to five). Pass 2
  re-scans for exactly those hashes and collects every *other* path they back — the dedup
  warning, and why the future `delete` needs no scan of its own. One pass would mean a ~27M-entry
  hash→paths map on a large set; two passes stay bounded by the tiny hash set, and pass 2 is
  skipped outright when pass 1 matched nothing.
- **Output is one hash per line with all context in `#` comments**, identical consecutive
  snapshots collapsed to a span (`--all` expands). A 64-char hash plus size, mtime and a Windows
  path does not fit a terminal line; this is the flat hash-per-line stream `hashes` already
  establishes as the composition medium.

## Consequences

- **`*` means *one or more* characters, not zero or more — a deliberate divergence from POSIX
  `find`.** It is `compileExclude`'s grammar, inherited by sharing the compiler: `*secret1`
  matches `copy-secret1` but **not** `secret1` itself. Pinned by assertion in
  `lib/find.test.mjs` and stated in [guide/find.md](../../guide/find.md). Sharing one compiler
  beats matching POSIX to the character; a user who wants both writes both patterns.
- **A POSIX filename containing a literal backslash cannot be named by a pattern** on Windows,
  since the pattern's separators are translated by `process.platform`. The alternative — deciding
  the pattern's separator from the paths it will meet — is circular.
- **The bucket is named once per set on the `# searched` line**, not on every result, and the
  report warns when the sets that matched span more than one bucket — the only case where feeding
  the file to a single `delete --bucket` would silently drop rows.
- **A snapshot that will not parse is a finding, not an abort**: `find` classifies with
  [0074](0074-referenced-enumeration-vocabulary-module.md)'s `isCorruptSnapshotError`, lists what
  it could not read under a `⚠` block in the header, and searches the other 900. It keeps the
  per-set `{set, snapshot, reason}` records rather than that module's bucket-wide `string[]` view,
  and words its own block rather than reusing `unreadableMessage` — that message is for a
  destructive command it *blocks*, and signs off with `s3cab verify <bucket>` where `find` has no
  single bucket to name.
- `find` returns structured data and renders through the central layer
  ([0043](0043-human-first-output.md)), so `--json` carries the same spans; `--all` changes the
  **data** (one span per snapshot), not the presentation.
- The pattern grammar is now a two-caller abstraction, so a change to `globSource` moves both
  `exclude` and `find`. That is the point — the tokens users learn should be one language — but
  it means an exclude-driven tweak needs a `find` test read.
