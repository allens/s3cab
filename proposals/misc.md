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
- **`upload --dir <path>` — seed priority folders before the initial backup.** For a big first
  backup, push the folders you care about most *first* so their bytes are up soonest; the later
  full `backup` snapshots the whole tree and dedups against everything already stored (content-
  addressing makes the seeded objects free on the second pass). This is the missing **third
  granularity** on `upload`, alongside `--file` (one object) and `--snapshot` (a whole
  manifest's objects) — same "target chosen by a mutually-exclusive flag" shape (ADR-0044), so
  `--dir` is exclusive with the other two. `upload` is the right level because this is pure
  "get objects into the store" plumbing, not a porcelain snapshot operation. Sketch:
  - **Objects-only, no manifest** — walk the subtree, hash each file, conditional-PUT into
    `objects/<sha256>`. No snapshot is written (creating one is the `snapshot` command's job,
    not `upload`'s). Same *safe orphan* direction as the manifest opt-out item above.
  - **Reuse the snapshot walk so it honours the set's `exclude.txt`** — otherwise you can seed
    objects that `backup` would exclude, guaranteeing orphans; respecting excludes makes the
    seeded bytes exactly match what the eventual backup wants.
  - **The one loose thread — the orphan/cleanup window.** Between seeding and the first `backup`,
    the objects are unreferenced (no manifest maps their hashes → paths), so they aren't
    independently restorable yet and a `cleanup` in that window would reap them. In practice you
    seed → backup and wouldn't `cleanup` a never-fully-backed-up set, so this reads as a
    documented footnote, not a blocker — but it's the bit to confirm against real use. (If
    "protected soonest" should mean *recoverable* soonest rather than *bytes up* soonest, that
    argues for writing a partial manifest — judged scope creep on `upload` for now.)
- **`scripts/`: empty-a-versioned-bucket helper for manual testing** (write fresh when asked).
  The deleted `emptyBucket` in s3.mjs was meant for this but never did it — a plain per-key
  `DeleteObjectCommand` only adds delete markers on a versioned bucket. The real thing needs
  `ListObjectVersions` + per-`{Key, VersionId}` deletes so the bucket can actually be emptied
  and removed.
- **A "which snapshots contain this path" query command** (floated in the deletion-rework
  epic, deferred). Standalone value — "where does this file still live?" — but `delete`'s and
  `forget`'s previews already answer most of it in passing, so it earns a command only if the
  standalone question comes up in real use. Revisit on demand.
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