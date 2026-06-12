# Improvement brainstorm (2026-06-12)

A raw list from a full read of the repo — **brainstorming only, nothing here is
committed to or implemented**. Items overlap with CLAUDE.md's "Known gaps" where
noted; the rest is new. Grouped, not prioritized. Some "likely bugs" are unverified
suspicions — check before believing.

> **Note (2026-06-12, later the same day):** several items below were settled by the
> backup-set design in [specs/backup.md](specs/backup.md) — same-minute snapshot
> collisions (error, never overwrite), symlink/non-regular-file policy (regular files
> only), client-side encryption (declared non-goal), garbage collection (`cleanup`
> designed: dry-run default, grace window), the multi-machine/multi-dir bucket
> namespace (`snapshots/<user>@<machine>/<set>/`), and restore fidelity (content +
> mtime, skip-existing). Read those entries as historical input to that design.

---

## Likely bugs / correctness suspicions (verify first)

- **Double `x-amz-meta-` prefix on upload metadata.** `putFile` in
  [src/lib/s3.mjs](src/lib/s3.mjs) passes `Metadata` keys already named
  `x-amz-meta-hostname` etc., but the SDK prefixes `Metadata` keys with
  `x-amz-meta-` itself — stored objects likely carry
  `x-amz-meta-x-amz-meta-hostname`. (Also interacts with `objectExists`, which
  keys off "has custom metadata".)
- **A typo'd `--since`/`--until` silently compares against an empty snapshot.**
  `readSnapshot` returns an empty `Map` for an unknown name, so
  `compare --until 2025-typo` reports *everything deleted*, and a typo'd
  `--since` reports everything added — no error, confidently wrong output.
  Worse: an unknown `--until` makes the `since` default `indexOf(until)+1 → at(0)`,
  i.e. the latest snapshot. Should be a hard "snapshot not found, did you mean…"
  error.
- **Two snapshots in the same minute silently overwrite.** `getTimestamp()` is
  minute-precision and `withSnapshotFile`'s final `rename` replaces an existing
  file — the earlier snapshot is lost without warning, and the post-snapshot
  compare runs against the snapshot itself ("no changes"). Seconds precision,
  a collision suffix, or a pre-rename existence check would all fix it.
- **Symlink handling differs depending on whether `exclude.txt` exists.** With an
  exclude file, the walk callback filters non-file/non-dir dirents to `#EXCLUDED`
  comment lines; without one, `walkFiles` yields a symlink as a file and `prop()`
  throws "Not a regular file", recorded as an error comment. Two different
  behaviours for the same tree. A backup tool needs an explicit symlink policy
  anyway (skip / record target / follow), plus a Windows junction + loop stance.
- **`S3ReadStream` doesn't propagate body-stream errors.** `Body.pipe(this)` —
  `pipe` doesn't forward `error` events, so a mid-download failure may hang or
  end the stream silently. (No caller yet, but `restore` will be built on it.)
- **`readSnapshotFile` trims every field**, so a path with leading/trailing
  whitespace doesn't round-trip. Only the padding columns need trimming; the
  path field should be taken verbatim. Related: a blank line in a hand-edited
  manifest dies on a bare `assert` — hand-editing is the whole no-lock-in story,
  so parse errors deserve friendly messages with file/line context.
- **`diff()` mutates its caller's `currentSnapshot` Map** (`.delete(path)` while
  classifying). Surprising for a library caller who reuses the map; clone or
  track separately.
- **Bare `**` (no trailing `/`) in an exclude pattern degenerates** — the matcher
  only rewrites `**/`; a lone `**` becomes two `[^/]+` runs, i.e. "2+ chars in
  one segment". Either reject the pattern with a clear error or define it.
- **README quick start shows output the tool doesn't produce.** It shows
  `Added: / Moved:` friendly text, but `snapshot`/`compare` print a JSON object.
  Doc-discipline drift — fix the README, or (better, see UX below) make the
  friendly output real.
- **`tree`'s stdout is a JSON array**, but the README/CLAUDE.md pitch is
  `s3cab tree . > files.txt` capturing "just the file list" — a JSON array isn't
  a file list. Line-per-path output (like `objects`) would match the promise.
- Cosmetic: `withSnapshotFile` closes the fd twice (`await fd.close()` inside an
  `await using`); `putFile`'s skip path (`PreconditionFailed`) returns without
  terminating the stderr progress line.

## Technical improvements

- **Parallel hashing.** `createPropsGenerator` hashes one file at a time; SHA-256
  is I/O-bound but a small concurrency pool (even 4–8 in-flight `prop()`s, no
  worker threads needed) should speed cold snapshots substantially on SSDs.
- **Stream the walk instead of slurping.** `tree()` builds the full path array
  (and a Set duplicate-check copy) before hashing starts. A streaming walk →
  hash pipeline lowers memory on huge trees and starts useful work immediately.
  (Progress would need a "found so far" denominator or a two-phase count.)
- **Use S3's native SHA-256 checksums on upload** (`ChecksumSHA256`). The object
  key *is* the SHA-256 — having S3 verify the body against it end-to-end is a
  perfect fit (#1/#2), gives free corruption detection on PUT, and gives
  `verify` a server-side primitive (HEAD checksum vs key) without downloading.
  Check S3-compatible-provider support (specs/s3-provider-compatibility.md).
- **`objects` accumulates every hash in memory** then joins one giant string;
  stream lines out as pages arrive (a million-object bucket is plausible for a
  photo library).
- **`emptyBucket` is uncalled, destructive, and deletes one object per request.**
  Either remove until a caller exists or switch to batched `DeleteObjects`
  (1000/request). Its existence in the bundle is risk with no reward today.
- **Stale temp-file recovery.** A crashed snapshot leaves `.snapshot.tsv.zst`
  and every later snapshot fails until the user hand-deletes it. Detect
  staleness (age/PID), offer `--force`, or clean up on error via try/finally —
  ties into the known lock-file TODO.
- **Consider relative paths in manifests.** The base dir is already in the
  `#SNAPSHOT` header; storing paths relative would make backup dirs relocatable
  (today a renamed parent makes *every* file "moved"), shrink manifests, and
  make them portable across machines. Big format decision — weigh against #2/#4
  while the format is still young and uncommitted.
- **Define the TSV tab/newline-in-path rule** (known gap). Simplest honest
  answer: reject such paths at snapshot time with a clear error naming the file.
- **Return structured data from `compare`,** not preformatted strings with
  embedded `→`/`→→`/`==` microsyntax. Presentation belongs in the CLI layer;
  the JSON output is currently neither human-friendly nor machine-friendly.
- **Snapshot timestamps: timezone + precision.** Names use local time with no
  offset — DST fold can produce ambiguous/colliding names, and snapshots taken
  on machines in different zones don't order. UTC (or offset-suffixed) +
  seconds precision is worth deciding before the format freezes.
- **Wire `typecheck` into CI** (already in Known gaps — cheap, do early).
- **Unit-test the S3 boundary.** `s3.mjs`, `upload.mjs`, `objects.mjs` have no
  tests. Options: inject the client (test seam), the SDK's mock client lib, or a
  CI MinIO/LocalStack job for true integration coverage. The double-prefix
  metadata suspicion above is exactly the class of bug these would catch.
- **Decide restore fidelity now, while the format is young.** Manifests store
  hash/size/mtime only: no empty directories, no permissions/owner, no Windows
  attributes. `restore` will be limited by what `snapshot` recorded — even if
  the answer is "content + mtime only, documented", decide it deliberately.
- **Windows long paths** (`\\?\` prefix, >260 chars) and reserved device names
  (`CON`, `NUL`…) — a photo/video archive will eventually hit one.
- **Replace `prop`'s module-level single-slot `_lstatCache`** with an explicit
  stat parameter or per-call structure — hidden mutable global state for a
  micro-optimization.
- Minor: `formatByteValue` hardcodes locale `"en"` while `DurationFormat` uses
  the system default; pick one. Re-measure the 5 MB slurp/stream boundary
  (already in Known gaps). The `compare` at the end of `snapshot` re-reads and
  re-decompresses the manifest it just wrote — fine today, noted for a perf pass.

## UX improvements

- **Human-readable output by default; `--json` for machines.** The single
  biggest consumer-audience win. The README quick start already *shows* the
  desired UX (`Added:` / `Moved:` sections); make it real, keep JSON behind a
  flag (and that also resolves the doc drift above). Stream discipline already
  separates results from progress, so this is purely the stdout formatter.
- **Summary counts**: end every snapshot/compare with
  `3 added, 1 moved, 2 modified, 0 deleted` (and "No changes." when clean).
- **First-snapshot experience.** The first ever snapshot diffs against empty and
  dumps every file as "added" — potentially a 100k-line JSON splash. Say
  `First snapshot: 1,234 files (4.2 GB)` instead.
- **A `doctor`/`info` command**: show which env files were found and applied,
  the resolved bucket/endpoint/region, which credential source won, and try a
  cheap S3 call. Auth misconfiguration is the #1 support question for any S3
  tool, and the layered env model is invisible today without `S3CAB_DEBUG`.
- **"Did you mean…?" for misspelled commands** (edit distance over the registry);
  `s3cab help <unknown-topic>` currently falls back silently to the command list —
  say "unknown topic" and list the valid ones.
- **`--quiet`** to suppress stderr progress (for cron/scripts), and richer
  progress: bytes hashed + ETA, not just file-count percent.
- **Richer `list`**: snapshot date *and* file count / total size (cheap to read
  from the manifest), maybe `list --stat`. Today it's bare names.
- **Flexible snapshot references**: accept unambiguous prefixes
  (`--since 2025-11-11`), `latest`, `latest~1` — anything to avoid typing
  `2025-11-11T0830` exactly (especially given the silent-typo bug above).
- **Snapshot labels** (`snapshot -m "before reorg"`) — a commit-message-like
  note, storable as a header comment line without breaking the TSV format.
- **Exclude-pattern ergonomics**: negation (`!important.log`) to re-include
  under an excluded dir; a `tree --explain <path>` that says *which pattern*
  excluded a file (the `#EXCLUDED` manifest lines almost do this — surface it);
  an optional global `~/.s3cab/exclude.txt` for `Thumbs.db`/`desktop.ini`-class
  junk. Also document that `*` is "one or more" (so `*.log` doesn't match
  `.log`) — a real glob-convention divergence users will trip on.
- **Friendlier failure for "no snapshots found"** — suggest running
  `s3cab snapshot` rather than a bare error.
- **Colors** (plain ANSI per #5): green added / red deleted / yellow modified
  transforms compare output readability for zero deps.
- **Document or replace the arrow microsyntax** — `→` vs `→→` vs `==` in results
  is explained nowhere user-facing; in human output, words ("renamed", "moved",
  "duplicate of") may serve the audience better. Related: README promises
  "renamed" detection but `CompareResult` has no `renamed` key — it's implied by
  the arrow style only.
- **Exit-code doctrine**: document the codes (0/1/127 today); decide whether
  `compare` should signal "differences found" diff-style (probably not, for a
  consumer tool — but decide).
- **Distribution**: winget / scoop / Homebrew manifests once released; a real
  Windows code-signing cert eventually (same class of trust problem as the macOS
  notarization gap).

## Bigger / strategic questions

- **Metadata privacy.** `upload` attaches hostname, username, and the full local
  path to every object — useful provenance, but it's PII sitting in object
  metadata, and the local path reveals structure the content-addressed layout
  otherwise hides. Make it opt-in/opt-out and document it.
- **Client-side encryption.** Deliberate non-goal so far, and in real tension
  with #2 (an encrypted store is by definition not hand-recoverable without the
  tool/key). Even if the answer stays "no — use SSE/provider encryption",
  write the threat model down. (Convergent encryption is the CAS-compatible
  middle ground, with known confirmation-attack tradeoffs.)
- **Garbage collection of unreferenced objects** — the genuinely hard problem of
  CAS backup. Snapshot pruning (`prune --keep-last N` etc.) is easy; deciding
  when an object is unreferenced by *any* snapshot, safely, with concurrent
  writers, is not. Needs a design doc before `backup` ships, even if GC itself
  ships much later.
- **Multi-machine / multi-directory use of one bucket.** The `snapshots/` remote
  layout is still undefined; snapshot names are bare timestamps with the source
  dir only inside the header. Two machines (or two dirs) backing up to one
  bucket need a namespace decision (and the hostname metadata hints this is
  anticipated). One-repo-one-bucket settles the *object* side; the snapshot side
  is open.
- **Network resilience knobs** for `backup`: retry policy, bandwidth limiting,
  resumability of a multi-thousand-file upload run.
- **Storage-class exposure.** `INTELLIGENT_TIERING` is hardcoded for AWS; users
  may want Glacier-class economics — but retrieval latency/cost then bleeds into
  `restore`/`verify` UX. Probably a `setup`-time choice.
- **Cross-platform restore**: manifests store platform-native absolute paths;
  restoring a Windows backup on Linux (disaster-recovery scenario — the whole
  point of the tool) needs a path-translation story. Strengthens the
  relative-paths idea above.
- **TS migration** and **uncompressed-latest-manifest** — both already tracked
  in CLAUDE.md Known gaps; listed here only for completeness.
