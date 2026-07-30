# Misc — unsorted ideas

Ideas that don't fit a theme yet and aren't enough on their own to earn an epic file. When a
cluster here grows, split it out into its own `proposals/<topic>.md` (these two look like a
future "platform / release" epic).

- **Selective bulk restore via a path list on stdin** (`s3cab restore --set <set> -`, the
  `rsync --files-from` pattern; clig.dev's `-` convention). Restoring *many specific files*
  conveniently is an open pain: today's positional filters don't scale past a handful. A
  path-per-line list on stdin composes with the tools that produce such lists —
  `s3cab tree photos | grep 2024 | s3cab restore --set photos -`, or a future compare/`verify`
  output — and a `--files-from <file>` twin would cover the non-pipe case. Would also want
  clig's guard: if stdin is an interactive terminal, don't hang waiting — show help instead.
- **Windows long paths** (`\\?\` prefix, >260 chars) and reserved device names (`CON`,
  `NUL`…) — a photo/video archive will eventually hit one.
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
  Rename `writeSnapshot` ([src/lib/snapshot-file.mjs](../src/lib/snapshot-file.mjs)) to
  `generateSnapshot` (or similar) — *write* sounds like it just writes a file, when it actually
  does the heavy lifting (stat every file, hash the changed ones, format and compress). Pure
  readability renames, no behaviour change; would sweep the callers and doc references.
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
