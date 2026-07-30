# Snapshot paths stay absolute and OS-native; portability is `restore --output`

**Status:** accepted & implemented. Settles the "relative paths" and "cross-platform restore"
questions the snapshot-format proposal carried. Extends
[0004](0004-tsv-snapshot-manifests.md) (the row grammar) and rests on
[0002](0002-no-lock-in-hard-constraint.md).

## Context

A snapshot row's last field is the file's **absolute path in the OS's native style**
(`C:\Users\me\Photos\beach.jpg`), with the set's member roots recorded as `#DIR` headers.

Storing paths *relative to their member root* was proposed on three grounds: backup roots would
become relocatable (today, renaming a parent makes every file read as moved), snapshot files
would shrink, and snapshots would be portable across machines. A companion question asked for a
"path-translation story" for restoring a Windows backup on Linux — the disaster-recovery case
that is the whole point of the tool.

## Decision

**Keep absolute, OS-native paths.** Portability is handled at **restore time** by
`restore --output <dir>`, not by changing what is stored.

## Why

- **The snapshot is a statement of record.** The original path is part of what is being
  recorded, not an implementation detail of where the bytes came from — and it is potentially
  useful information long after the file has moved. Information isn't discarded without a
  compelling reason.
- **Native spelling is the readable one.** This is [0004](0004-tsv-snapshot-manifests.md)'s own
  argument for TSV over JSON — JSON would force escaping every Windows backslash — applied to
  the path's *form* as well as its encoding.
- **The size saving is nil.** Every row shares a long prefix, which zstd-19 eats. This is
  precisely why 0004 rejected base64url hashes (43 chars vs 64): "the gain is negligible once
  the snapshot file is zstd-compressed."
- **Per-row self-containment is load-bearing for recovery.** format.md's by-hand recovery is
  "find your file's row → it tells you its original path and mtime → download
  `objects/<its-hash>`". Relative rows would require reading the header and joining, and would
  break `grep`ping a snapshot for a path.
- **Multi-root would be genuinely ambiguous.** With two `#DIR` roots, a relative row does not say
  which root it belongs to, and every fix is worse than the problem: prefixing the root basename
  promotes `reroot`'s basename-collision error into a *format* failure (two roots both named
  `Photos` back up fine today); grouping rows under their header makes line order semantic, which
  `parseSnapshotStream` deliberately is not; a root-index column hurts the hand-read.
- **It would desync from the deletion record**, which is `hash → path` spanning sets
  ([0064](0064-path-scoped-delete-deletion-record.md)) and so has no single root to be relative
  to. Two path spellings in one repository.

## Cross-platform restore was already solved

The "path-translation story" exists and is `--output`:

- [`reroot`](../../src/lib/restore.mjs) is **separator-agnostic by construction** — roots and
  paths are split on both `/` and `\` and matched by whole segments, then rebuilt with the
  restoring platform's separator. A Windows snapshot re-roots correctly on POSIX and vice versa.
- **Plain `restore` refuses rather than scattering.** Every target must be `isAbsolute` on *this*
  platform before anything touches disk; otherwise POSIX would cheerfully create a file literally
  named `C:\Users\…` in the working directory. The error names the likely cause and points at
  `--output`.
- It is documented where a user in a disaster will look
  ([guide/restore.md](../../guide/restore.md), "Restoring somewhere else").

## Consequences

- **Relocating a backup root costs one re-hash pass, and nothing else.** The baseline lookup is
  path-keyed, so after a move every file misses and is re-hashed — but the store is
  content-addressed, so **nothing is re-uploaded**. The other visible effect is a `compare` that
  reads as all-added plus all-deleted.
- **A remap remains possible later, outside the format** (at `reattach`, or a `--moved-from`), if
  relocation is ever felt often enough to justify it. Nothing here forecloses that.
- **Path normalization stays split by layer, and that split is correct.** Matching layers
  normalize (`pathMatcher` folds separators and case on Windows; `reroot` splits on both
  separators); keying layers use the exact stored string (`entries` is keyed by it, and `diff` is
  plain `Map`/`Set` membership). Cross-platform, exact-string keying is *right* —
  `C:\Users\me\a.jpg` and `/Users/me/a.jpg` genuinely are different paths on different machines.
- **`reattach` onto a different OS gets a misleading message.** A Windows `dirs.txt` pulled onto
  macOS hits `assertWalkableDirs`, which reports the directories as unavailable — "an unplugged
  drive, a deleted or renamed folder" — none of which is true. The fix (edit `dirs.txt`) is
  right, the diagnosis is not; `assertWalkableDirs` gains a branch for paths that aren't absolute
  on this platform, naming the cause and pointing at `--output` for recovering the data.

### `dirs.txt` entries must be absolute (decided while implementing the above)

**A relative entry is refused outright**, where it previously worked (resolved against the
process's working directory). It has to be: a relative member directory makes **the set's
contents depend on the folder s3cab happened to be run from** — the same `s3cab backup photos`
would walk a different tree from a different prompt. That is not a property a backup tool can
have. `setup` has only ever written absolute paths (via `resolveDirectories`), and both
guide/format.md and the empty-`dirs.txt` error already called for them, so this makes the stated
contract enforced rather than assumed.

**One message covers both causes, deliberately.** `isAbsolute` is false for a relative entry
*and* for a path absolute on another OS, and nothing short of guessing at path shapes
(`/^[A-Za-z]:[\\/]/`) can tell them apart — a heuristic this ADR would rather not carry
([0006](0006-minimal-code.md)). So the error states the *fact* (not a full path to a folder on
this computer), gives the concrete reason a full path is required, and names the cross-OS case as
the other way to arrive here. Claiming one cause when it cannot know is the failure this whole
consequence exists to fix.

It inherits `restore`'s one-way limitation, too: Windows treats a leading `/` as rooted, so a
POSIX `dirs.txt` read on Windows falls through to the generic "aren't available" — still loud,
still pointing at the file to edit.
