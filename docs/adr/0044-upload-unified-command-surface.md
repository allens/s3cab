# Unify `upload`; `backup` = snapshot + upload; retire `backup --snapshot`

**Status:** proposed (settled 2026-07-06 in a grilling + `cli-design` session); **not yet
implemented** — the build is sliced in
[proposals/upload-and-change-detection.md](../../proposals/upload-and-change-detection.md).
This ADR records only the *command-surface* decision and its *why*; the companion
**change-detection** decision (drop the persistent objects cache; local-snapshot baseline +
on-demand `LIST` + conditional-PUT backstop) will get its own ADR when that engine slice lands.
Sits in the [0035](0035-aws-profile-sets-command-rationalization.md)/[0036](0036-setup-mutates-list-shows-drop-sets.md)
command-shape lineage; governed by the `cli-design` skill.

## Context

`upload` began as a porcelain single-file command (`upload <bucket> <file>`) and got thinned to
raw plumbing as `backup` grew. Meanwhile the snapshot-object uploader (`uploadSnapshot`) lives
in `lib` with **no command**, reachable only through `backup` and `backup --snapshot <name>`.
So two "put objects in the store" operations sit at different layers with an asymmetric surface,
and `backup` carries a `--snapshot` *mode flag* that is really plumbing leaking into porcelain.

Revisiting the stale `--if-modified-from` TODO in `upload.mjs` (whose premise — "load-bearing
for `backup`" — turned out false: `backup` never routes through `upload`) surfaced the reshape
below. The guiding frame is the porcelain/plumbing split
([0023](0023-porcelain-plumbing-lib-layers.md)): plumbing should be **explicit and
predictable**; porcelain is allowed to be **smart**.

## Decision

1. **One `upload` plumbing command does both granularities of "get objects into the store,"** at
   either single-object or whole-snapshot scale. It is **set-scoped**: the first (and only)
   positional is a **set**, which resolves to its bucket *and* env layer
   ([0022](0022-prepare-remote-set-front-door.md)).

2. **Mode is chosen by mutually-exclusive target flags, not by a second positional.** The
   `cli-design` pass rejected `upload <set> <snapshot>` — two positionals of *different* kinds,
   and asymmetric with the single-file target — in favour of flags
   ([clig.dev](https://clig.dev): prefer flags to positionals; avoid mixed-kind positionals):
   - `upload <set> --file <path>` — one object (hash + one conditional PUT). No `LIST`, no baseline.
   - `upload <set> --snapshot <name>` — that snapshot's objects (name **required**), then the
     manifest **last** (objects-first/manifest-last invariant).
   - `upload <set>` with **neither** flag → a **usage error** ("specify `--file` or
     `--snapshot`"). `upload` performs **no snapshot lookup** — not the "latest" target, nor the
     "previous" baseline. Which snapshot to upload (or diff against) is porcelain smarts that live
     in `backup` (point 6); plumbing is explicit by nature (cf. git's `hash-object` /
     `write-tree`). clig's "right defaults beat required flags" applies to the user-facing
     *porcelain* (`backup`, which just works with no args), not to this advanced plumbing, where
     explicitness is the contract.

3. **`--bucket <bucket>` is the raw single-file escape hatch** — `upload --bucket <b> --file <p>`
   PUTs one object with no set (ambient / user-env credentials only). It carries forward today's
   `upload <bucket> <file>` primitive for seeding into a bucket that isn't one of your sets. As a
   *flag* it avoids the set-vs-bucket positional ambiguity that killed the old form. Single-file
   only — a snapshot always belongs to a set.

4. **Change detection is supplied explicitly to the plumbing** (the "smart" choice lives in
   `backup`): `--since <snapshot>` gives the diff baseline; with no `--since`, snapshot mode does
   an on-demand objects `LIST`. Deterministic rule, not state-dependent "auto." Single-file mode
   does neither (a whole-store `LIST` to check one object is absurd). Engine detail →
   the companion ADR.

5. **`--force` is single-file-only.** Valid with `--file` (overwrite an object — the repair hatch
   for a corrupt/truncated remote object, since s3cab trusts the hash on write and verifies only
   on read); **rejected in snapshot mode**, where it would tangle with the baseline layer and
   must never override the manifest's immutability (a duplicate snapshot name is a hard error,
   never an overwrite).

6. **`backup [set]` = `snapshot()` + `upload()`, always both.** It resolves the baseline and hands
   `upload` explicit params — `--since <previous>` normally, nothing (→ `LIST`) on a first backup.
   **`backup --snapshot` is retired**: "upload an existing snapshot" is now `upload <set>
   --snapshot <name>`. The `--snapshot` flag existed only because the plumbing wasn't exposed.

7. **Fail-fast validation** ([0011](0011-validation-in-command-functions.md)), before any work:
   exactly one of `<set>` / `--bucket`; `--bucket` and `--force` require `--file`; `--since`
   requires snapshot mode; a named `--snapshot` must exist. And, for responsiveness, snapshot
   mode prints `Scanning existing objects…` to stderr **before** the `LIST` so the tool never
   looks hung.

## Consequences

- **Breaking** (retires `backup --snapshot`, reshapes `upload`) — acceptable pre-1.0 (free rein,
  CLAUDE.md #7). Help topics, `guide/`, README, and the `--if-modified-from` TODO + the CLAUDE.md
  "Known gaps" note all update with the build.
- The objects-first/manifest-last invariant stays in **one** place (`upload`'s snapshot mode);
  `backup` merely composes.
- `--snapshot` as a *target* selector on `upload` does not clash with the retired `backup
  --snapshot` (different command) and is an easy muscle-memory migration.
- Removing the objects cache (companion ADR) also removes `--skip-cache`, which only ever existed
  because it was once `--force` and clashed with `upload --force` — a surface simplification.
