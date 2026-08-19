# Misc — unsorted ideas

Ideas that don't fit a theme yet and aren't enough on their own to earn an epic file. When a
cluster here grows, split it out into its own `proposals/<topic>.md` (Distribution looks like the
seed of a future "platform / release" epic).

- **Selective bulk restore via a path list on stdin** (`s3cab restore --set <set> -`, the
  `rsync --files-from` pattern; clig.dev's `-` convention). Restoring *many specific files*
  conveniently is an open pain: today's positional filters don't scale past a handful. A
  path-per-line list on stdin composes with the tools that produce such lists —
  `s3cab tree photos | grep 2024 | s3cab restore --set photos -`, or a future compare/`verify`
  output — and a `--files-from <file>` twin would cover the non-pipe case. Would also want
  clig's guard: if stdin is an interactive terminal, don't hang waiting — show help instead.
- **Distribution**: winget / scoop / Homebrew manifests once released; a real Windows
  code-signing cert eventually (same class of trust problem as the macOS notarization gap).
- **Use nodejs test runner tags** https://nodejs.org/docs/latest/api/test.html#test-tags
- **`upload --snapshot` manifest opt-out** ("upload the objects but not the snapshot file";
  name TBD — `--no-manifest` / `--objects-only`). Deferred from the upload epic (ADR-0044) per
  #7 — no use has appeared. Harmless if added: orphan objects with no manifest are the *safe*
  direction (wasted space, not corruption).
- **`scripts/`: empty-a-versioned-bucket helper for manual testing** (write fresh when asked).
  The deleted `emptyBucket` in s3.mjs was meant for this but never did it — a plain per-key
  `DeleteObjectCommand` only adds delete markers on a versioned bucket. The real thing needs
  `ListObjectVersions` + per-`{Key, VersionId}` deletes so the bucket can actually be emptied
  and removed.
- **A "which snapshots contain this path" query command** (floated in the deletion-rework
  epic, deferred). Standalone value — "where does this file still live?" — but `delete`'s and
  `forget`'s previews already answer most of it in passing, so it earns a command only if the
  standalone question comes up in real use. Revisit on demand.
- **Naming: make two workhorse names say what they do.** (1) Rename the `walk` module/functions
  (`walkSet`/`walkDirs`/`walkFiles`, [src/lib/walk.mjs](../src/lib/walk.mjs)) to a *findFiles*
  naming — it matches what the phase is and what it prints ("Finding files in…"), and the whole
  point of that phase is to enumerate names as fast as possible before anything changes. (2)
  Rename `writeSnapshot` ([src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)) — *write*
  sounds like it just writes a file, when it actually does the heavy lifting (stat every file,
  hash the changed ones, format and compress). **Not to `generateSnapshot`**, which this entry
  originally proposed: that name is now taken by the fused pass's orchestrator in
  [src/lib/snapshot.mjs](../src/lib/snapshot.mjs) ([ADR-0069](../docs/adr/0069-fused-snapshot-upload-pipeline.md)),
  which *calls* this one — so the rename needs a name that distinguishes the two, not one that
  collides them. Pure readability renames, no behaviour change; would sweep the callers and doc
  references.
- **`delete`'s participating-set scope has a silent completeness gap** (watch in real usage;
  ADR-0064). Because scope is *the sets attached on this machine*, a set of yours you haven't
  `reattach`-ed here **silently protects** its content — `delete` reclaims nothing for it, and
  the only signal is the survivor line naming a set you recognize. This is the deliberate price
  of the "can't break anyone else's restorability by construction" guarantee (an unattached set
  is treated exactly like a stranger's, the fail-safe direction), and the preview does name the
  keeper. But in genuine multi-machine use it will read as "why didn't it delete?", answered
  only by `reattach <set>` + re-run. Only real usage tells whether that loop is acceptable or
  wants smoothing (e.g. the preview naming the *unattached* sets a fuller-scope run would also
  clear, or a `--include-set` escape). Do **not** "fix" it by scoping off the remote set list —
  that would let one machine delete content another still wants, which is exactly what the
  local-attachment-as-consent model prevents.
- **Show upload speed.** When showing upload progress show e.g. 2.3MB/s.
- **Look into deletion record TSV format** Should it be more like the snapshot version?
- **Column ordering and types in snapshot format** Should col1 just be # for non data records and col2 be size or lable (the #EXCLUDE directory/file thing is redundant due to trailing / in the exclude path)
- **Still consider second level snapshot file syntax** e.g. #SNAPSHOT:mysnapshotname. Frees up other columns. We use some of that nice 64 char column space (coincidently nearly set lenght max), reads well and as agreed nobody filters on the #SNAPSHOT row anyway. Keeping it in the bag rather than deciding it: the trigger would be wanting col2 for something else — hostname and user are the candidates that come to mind (but that's the same PII question [metadata-privacy.md](metadata-privacy.md) is open on, so settle it there). Recorded as not-taken-for-now in [ADR-0072](../docs/adr/0072-timestamps-utc-in-files-local-in-names.md).
- **A `s3cab://bucket/set/snapshot` URI scheme, if an input site ever wants one.** Observed while
  settling ADR-0074's `set/snapshot` notation: the hierarchy `bucket → set → snapshot` is real, it
  is the storage layout, and the bottom two levels are now written path-shaped in user-facing text
  — so a full scheme "falls out naturally". Recorded rather than taken, for three reasons. (1)
  **Nothing accepts one as input**: every command takes the bucket as a positional/`--bucket` and
  the set as `--set`, so a scheme would be a second name with no payoff. (2) **`s3://` is already
  the honest URI** — `s3://<bucket>/snapshots/<set>/<name>.tsv.zst` works with `aws s3 cp` and no
  s3cab installed, which is the ADR-0002 no-lock-in pillar; an `s3cab://` form would be *lossier*
  (dropping the literal `snapshots/` segment is dropping what makes it hand-recoverable) and longer
  than what we print. (3) In the messages that print these names the bucket is already stated a line
  later, so a per-line prefix would repeat a constant. **The trigger that would earn it:** a command
  addressing one snapshot in a bucket the machine isn't set up against, in a single token —
  `reattach` is the nearest thing today and it takes `--bucket`.
- **Nothing stops two branches claiming the same ADR number.** #255 shipped as ADR-0074 and had to
  be renumbered to 0076 at review time, because #252 and #253 had merged ahead of it and taken 0074
  and 0075. `docs/adr/README.md` says "take the next number", which is only unambiguous when one
  branch is open at a time — and every session working in its own worktree (CLAUDE.md #7) makes
  concurrent branches the normal case, not the exception. The cost when it bites is small but
  spreads: the file, the index entry, and every `ADR-NNNN` reference in code comments and prose.
  Options, none obviously right: reserve the number by pushing the index entry first (racy in the
  same way); allocate from the PR number instead of a sequence (stable, but the numbers stop being
  ordinal and 0001–0075 are already ordinal); or just keep renumbering at review time and accept it
  as a known chore, since the collision is *visible* — two files with the same prefix sort adjacent
  — and the rename is mechanical. Worth deciding only if it happens a second time.
